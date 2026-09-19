require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Redis } = require('ioredis');
const path = require('path');
const crypto = require('crypto');
const geoip = require('geoip-lite');
const db = require('./db');
const oauth = require('./oauth');
const session = require('./session');
const { state, VALID_COUNTRY_MODES } = require('./state');
const { ipLimiter, authLimiter, socketLimiter } = require('./ratelimit');
const media = require('./media');
const metrics = require('./metrics');

// ---- Country/location matching helpers ----
function getClientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return socket.handshake.address || null;
}

function detectCountry(socket) {
  const ip = getClientIp(socket);
  if (!ip) return null;
  try {
    const lookup = geoip.lookup(ip);
    return lookup ? lookup.country : null;
  } catch (e) { return null; }
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);

// ---- Socket.IO: tuned for a many-connections-per-process deployment ----
//   transports: websocket only — the HTTP long-polling fallback doubles the
//     connection work per client and is the first thing to fall over.
//   perMessageDeflate off — compression costs ~30% CPU per message for chat
//     payloads that are tiny anyway.
//   maxHttpBufferSize: 64 KB — text chat needs a fraction of this. (Media
//     used to ride through here as base64; it now goes to object storage —
//     see media.js.)
const io = new Server(server, {
  transports: ['websocket'],
  maxHttpBufferSize: 64 * 1024,
  perMessageDeflate: false,
  pingInterval: 25_000,
  pingTimeout: 20_000
});

// Cross-worker broadcasts/pairing state when Redis is configured.
if (process.env.REDIS_URL) {
  const { createAdapter } = require('@socket.io/redis-adapter');
  const pub = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 3 });
  const sub = pub.duplicate();
  pub.on('error', (e) => console.error('Redis adapter error:', e.message));
  sub.on('error', (e) => console.error('Redis adapter error:', e.message));
  io.adapter(createAdapter(pub, sub));
}

app.use(express.json({ limit: '1mb' }));

// Rate limits: cheap global bucket for every /api route, a stricter one for
// the auth routes (each login attempt costs an scrypt hash on the CPU).
app.use('/api', ipLimiter({ capacity: 600, refillPerSec: 30, keyPrefix: 'api' }));
app.use(['/api/login', '/api/signup'], authLimiter());

app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Sessions (stateless signed JWTs — see session.js) ----
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const userId = token && session.verifySession(token);
    const user = userId ? await db.getUser(userId) : null;
    if (!user) return res.status(401).json({ error: 'Not authenticated' });
    if (user.is_banned) return res.status(403).json({ error: 'This account has been permanently banned.' });
    req.userId = userId;
    next();
  } catch (e) {
    console.error('requireAuth error:', e);
    res.status(500).json({ error: 'Server error' });
  }
}

// Wraps an async Express handler so a thrown/rejected error becomes a 500
// instead of crashing the process or hanging the request.
function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((e) => {
      console.error('Route error:', e);
      metrics.inc('db_errors_total');
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    });
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/health', async (req, res) => {
  let dbOk = false, stateBackend = 'memory';
  try { dbOk = await db.ping(); } catch (e) { dbOk = false; }
  try { stateBackend = (await state.stats()).backend; } catch (e) { /* default */ }
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, db: dbOk, state: stateBackend, uptime: process.uptime() });
});

if (process.env.METRICS_ENABLED !== 'false') {
  app.get('/metrics', (req, res) => res.type('text/plain').send(metrics.render()));
}

app.get('/api/check-username', asyncRoute(async (req, res) => {
  const u = String(req.query.u || '');
  const formatErr = db.usernameFormatError(u);
  const available = !formatErr && await db.isUsernameAvailable(u);
  res.json({ available, error: formatErr || null });
}));

app.post('/api/signup', asyncRoute(async (req, res) => {
  const { fullName, username, identifier, password, birthDate, youtubeLink } = req.body || {};
  if (!fullName || !String(fullName).trim()) {
    return res.status(400).json({ error: 'Enter your name.' });
  }
  if (!username || !String(username).trim()) {
    return res.status(400).json({ error: 'Choose a username.' });
  }
  const idTrimmed = String(identifier || '').trim();
  if (!idTrimmed) {
    return res.status(400).json({ error: 'Enter a mobile number or email address.' });
  }
  const isEmail = idTrimmed.includes('@');
  const email = isEmail ? idTrimmed : null;
  const phone = isEmail ? null : idTrimmed;
  if (isEmail && !EMAIL_RE.test(idTrimmed)) {
    return res.status(400).json({ error: 'Enter a valid email address.' });
  }
  if (!isEmail && idTrimmed.replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Enter a valid mobile number or email address.' });
  }
  if (!password || password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }
  try {
    const user = await db.createUser({ email, password, phone, username, displayName: fullName, birthDate, youtubeLink });
    const token = session.createSession(user.id);
    res.json({ token, user: db.publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { identifier, password } = req.body || {};
  const user = await db.findUserByIdentifier(identifier || '');
  if (!user || !user.hash || !(await db.verifyPassword(password || '', user.salt, user.hash))) {
    return res.status(401).json({ error: 'Incorrect username, email, phone or password.' });
  }
  if (user.is_banned) {
    return res.status(403).json({ error: 'This account has been permanently banned.' });
  }
  const token = session.createSession(user.id);
  res.json({ token, user: db.publicUser(user) });
}));

// Social login (Google) — mounts /auth/google, /auth/google/callback, /api/oauth-providers.
oauth.mount(app, db, { createSession: session.createSession });

app.get('/api/me', requireAuth, asyncRoute(async (req, res) => {
  res.json({ user: db.publicUser(await db.getUser(req.userId)) });
}));

app.post('/api/set-gender', requireAuth, asyncRoute(async (req, res) => {
  const { gender } = req.body || {};
  if (!['male', 'female'].includes(gender)) {
    return res.status(400).json({ error: 'Select male or female.' });
  }
  const user = await db.getUser(req.userId);
  if (user.gender) {
    return res.status(400).json({ error: 'Gender is already set on this account.' });
  }
  await db.setGender(req.userId, gender);
  res.json({ user: db.publicUser(await db.getUser(req.userId)) });
}));

app.post('/api/set-phone', requireAuth, asyncRoute(async (req, res) => {
  const { phone } = req.body || {};
  if (!phone || String(phone).replace(/\D/g, '').length < 7) {
    return res.status(400).json({ error: 'Enter a valid phone number.' });
  }
  const user = await db.getUser(req.userId);
  if (user.phone_hash) {
    return res.status(400).json({ error: 'Phone number is already set on this account.' });
  }
  try {
    await db.setPhone(req.userId, phone);
    res.json({ user: db.publicUser(await db.getUser(req.userId)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/set-birthdate', requireAuth, asyncRoute(async (req, res) => {
  const { birthDate } = req.body || {};
  const user = await db.getUser(req.userId);
  if (user.birth_date) {
    return res.status(400).json({ error: 'Date of birth is already set on this account.' });
  }
  try {
    await db.setBirthdate(req.userId, birthDate);
    res.json({ user: db.publicUser(await db.getUser(req.userId)) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/contacts/match', requireAuth, asyncRoute(async (req, res) => {
  const { hashes } = req.body || {};
  if (!Array.isArray(hashes) || hashes.length === 0) return res.json({ matches: [] });
  const capped = hashes.slice(0, 2000).filter(h => typeof h === 'string');
  const users = await db.findUsersByPhoneHashes(capped, req.userId);
  const friendStatuses = await db.friendStatusBatch(req.userId, users.map(u => u.id));
  const online = await state.onlineSet(users.map(u => u.id));
  const matches = [];
  for (const u of users) {
    const friendStatus = friendStatuses.get(u.id) || 'none';
    if (friendStatus === 'friends') continue;
    matches.push({ ...db.publicUser(u), online: online.has(u.id), friendStatus });
  }
  res.json({ matches });
}));

// ---- Chat history ----
app.get('/api/history', requireAuth, asyncRoute(async (req, res) => {
  const raw = await db.listConversationsDetailed(req.userId);
  const partnerIds = raw.map(c => c.partnerId).filter(Boolean);
  const online = await state.onlineSet(partnerIds);
  const conversations = raw.map((c) => ({
    conversationId: c.conversationId,
    partner: c.partner || { id: c.partnerId, username: 'Deleted user', gender: null },
    online: online.has(c.partnerId),
    lastMessage: c.lastMessage || null,
    unreadCount: c.unreadCount,
    updatedAt: c.updatedAt
  }));
  res.json({ conversations });
}));

app.get('/api/history/:conversationId/messages', requireAuth, asyncRoute(async (req, res) => {
  const convo = await db.getConversation(req.params.conversationId);
  if (!convo || !userInConversation(convo, req.userId)) return res.status(404).json({ error: 'Not found' });
  const beforeTs = req.query.before ? Number(req.query.before) : null;
  const messages = await db.getMessages(convo.id, req.userId, { beforeTs });
  res.json({ messages, disappearingMode: convo.disappearing_mode });
}));

app.post('/api/history/:conversationId/disappearing', requireAuth, asyncRoute(async (req, res) => {
  const convo = await db.getConversation(req.params.conversationId);
  if (!convo || !userInConversation(convo, req.userId)) return res.status(404).json({ error: 'Not found' });
  try {
    const mode = await db.setDisappearingMode(convo.id, req.body && req.body.mode);
    const otherId = db.otherUserId(convo, req.userId);
    await state.emitToUser(otherId, 'disappearing-changed', { conversationId: convo.id, mode });
    res.json({ mode });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/history/delete-all', requireAuth, asyncRoute(async (req, res) => {
  const cleared = await db.deleteAllConversationsForUser(req.userId);
  for (const { id, otherUserId: otherId } of cleared) {
    await state.emitToUser(otherId, 'conversation-deleted', { conversationId: id });
  }
  res.json({ deletedCount: cleared.length });
}));

// "Clear chat" — wipes one conversation's history (both sides), used from
// the top-bar "more" (⋮) menu while chatting with someone.
app.post('/api/history/:conversationId/clear', requireAuth, asyncRoute(async (req, res) => {
  const convo = await db.getConversation(req.params.conversationId);
  if (!convo || !userInConversation(convo, req.userId)) return res.status(404).json({ error: 'Not found' });
  const otherId = db.otherUserId(convo, req.userId);
  await db.deleteConversation(convo.id);
  await state.emitToUser(otherId, 'conversation-deleted', { conversationId: convo.id });
  res.json({ ok: true });
}));

// Bundle for the "Reviews" popup — your 10 most recent chat partners, each
// with their public reviews and your past messages with them, in one call.
app.get('/api/history/recent-partners', requireAuth, asyncRoute(async (req, res) => {
  const rawConvos = (await db.listConversationsForUser(req.userId)).slice(0, 10);
  const partnerRows = await Promise.all(rawConvos.map(async (c) => {
    const partnerId = db.otherUserId(c, req.userId);
    const partner = await db.getUser(partnerId);
    if (!partner) return null;
    return { conversationId: c.id, partnerId, partner };
  }));
  const valid = partnerRows.filter(Boolean);
  const partnerIds = valid.map(r => r.partnerId);
  const [online, reviewsByUser, summaryByUser] = await Promise.all([
    state.onlineSet(partnerIds),
    db.getReviewsForUsers(partnerIds),
    db.getReviewSummaries(partnerIds)
  ]);
  const partners = await Promise.all(valid.map(async (r) => ({
    conversationId: r.conversationId,
    partner: { ...db.publicUser(r.partner), online: online.has(r.partnerId) },
    reviews: reviewsByUser.get(r.partnerId) || [],
    summary: summaryByUser.get(r.partnerId) || { count: 0, average: 0, tagCounts: { genuine: 0, fake: 0, suspicious: 0 } },
    messages: await db.getMessages(r.conversationId, req.userId, { limit: 50 })
  })));
  res.json({ partners });
}));

// ---- Block / mute (one-directional, act on the CURRENT user's list) ----
app.post('/api/users/:id/block', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't block yourself." });
  await db.blockUser(req.userId, req.params.id);
  state.invalidateBlocks(req.userId);
  // A block always ends any chat currently in progress with that person.
  const mySocketId = await state.socketOf(req.userId);
  if (mySocketId) {
    const pair = await state.pairOf(mySocketId);
    if (pair && pair.userId === req.params.id) {
      await state.emitToUser(req.params.id, 'partner-left');
      await state.endPair(mySocketId);
      await state.dequeue(mySocketId);
    }
  }
  res.json({ ok: true });
}));
app.post('/api/users/:id/unblock', requireAuth, asyncRoute(async (req, res) => {
  await db.unblockUser(req.userId, req.params.id);
  state.invalidateBlocks(req.userId);
  res.json({ ok: true });
}));
app.post('/api/users/:id/mute', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't mute yourself." });
  await db.muteUser(req.userId, req.params.id);
  state.invalidateMutes(req.userId);
  res.json({ ok: true });
}));
app.post('/api/users/:id/unmute', requireAuth, asyncRoute(async (req, res) => {
  await db.unmuteUser(req.userId, req.params.id);
  state.invalidateMutes(req.userId);
  res.json({ ok: true });
}));

// ---- Users: search + profile ----
app.get('/api/users/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  const rows = await db.searchUsers(q, req.userId, 20);
  const [statuses, online] = await Promise.all([
    db.friendStatusBatch(req.userId, rows.map(u => u.id)),
    state.onlineSet(rows.map(u => u.id))
  ]);
  const users = rows.map(u => ({
    ...db.publicUser(u), online: online.has(u.id), friendStatus: statuses.get(u.id) || 'none'
  }));
  res.json({ users });
}));

app.get('/api/users/:id', requireAuth, asyncRoute(async (req, res) => {
  const user = await db.getUser(req.params.id);
  if (!user || user.is_banned) return res.status(404).json({ error: 'Not found' });
  const isSelf = req.params.id === req.userId;
  const reviewSummary = await db.getReviewSummary(user.id);
  res.json({
    user: {
      ...db.publicUser(user),
      online: await state.isOnline(user.id),
      friendStatus: isSelf ? 'self' : await db.friendStatusBetween(req.userId, user.id),
      ...await db.getFollowCounts(user.id),
      isFollowing: isSelf ? false : await db.isFollowing(req.userId, user.id),
      reviewSummary,
      canReview: isSelf ? false : await db.hasChattedWith(req.userId, user.id),
      isBlocked: isSelf ? false : await db.isBlockedByMe(req.userId, user.id),
      isMuted: isSelf ? false : await db.isMuted(req.userId, user.id)
    }
  });
}));

// ---- Profile reviews (public "genuine/fake/suspicious" ratings) ----
app.get('/api/users/:id/reviews', requireAuth, asyncRoute(async (req, res) => {
  const [reviews, summary, myReview] = await Promise.all([
    db.getReviewsForUser(req.params.id),
    db.getReviewSummary(req.params.id),
    req.params.id === req.userId ? null : db.getMyReviewFor(req.userId, req.params.id)
  ]);
  res.json({ reviews, summary, myReview });
}));

app.post('/api/users/:id/reviews', requireAuth, asyncRoute(async (req, res) => {
  const { rating, tag, comment } = req.body || {};
  try {
    await db.upsertReview(req.userId, req.params.id, { rating, tag, comment });
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/reviews/:reviewId/report', requireAuth, asyncRoute(async (req, res) => {
  try {
    await db.reportReview(req.params.reviewId, req.userId, req.body && req.body.reason);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

// ---- Follows ----
app.post('/api/users/:id/follow', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't follow yourself." });
  const target = await db.getUser(req.params.id);
  if (!target || target.is_banned) return res.status(404).json({ error: 'Not found' });
  await db.followUser(req.userId, req.params.id);
  res.json({ ...await db.getFollowCounts(req.params.id), isFollowing: true });
}));
app.post('/api/users/:id/unfollow', requireAuth, asyncRoute(async (req, res) => {
  await db.unfollowUser(req.userId, req.params.id);
  res.json({ ...await db.getFollowCounts(req.params.id), isFollowing: false });
}));

// ---- Profile ----
app.post('/api/profile', requireAuth, asyncRoute(async (req, res) => {
  const { displayName, bio, photo, youtubeLink } = req.body || {};
  // `photo` may be a storage key (media/photo/... — new flow) or a legacy
  // data URL (client-side compressed). Keep the data-URL path bounded.
  if (photo && typeof photo === 'string' && photo.startsWith('data:') && photo.length > 500_000) {
    return res.status(400).json({ error: 'Photo too large — please re-upload.' });
  }
  try {
    const user = await db.updateProfile(req.userId, { displayName, bio, photo, youtubeLink });
    res.json({ user: db.publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/location', requireAuth, asyncRoute(async (req, res) => {
  const { lat, lon } = req.body || {};
  if (typeof lat !== 'number' || typeof lon !== 'number') return res.status(400).json({ error: 'lat/lon required.' });
  await db.setLastLocation(req.userId, lat, lon);
  res.json({ ok: true });
}));

// ---- Suggested friends ----
app.get('/api/users/suggestions', requireAuth, asyncRoute(async (req, res) => {
  const raw = await db.suggestFriends(req.userId, 20);
  const online = await state.onlineSet(raw.map(u => u.id));
  const suggestions = raw.map(u => ({ ...u, online: online.has(u.id) }));
  res.json({ suggestions });
}));

// ---- Friends ----
app.get('/api/friends', requireAuth, asyncRoute(async (req, res) => {
  const rows = await db.listFriendUsers(req.userId);
  const online = await state.onlineSet(rows.map(u => u.id));
  res.json({ friends: rows.map(u => ({ ...db.publicUser(u), online: online.has(u.id) })) });
}));

app.get('/api/friends/requests', requireAuth, asyncRoute(async (req, res) => {
  const rows = await db.listIncomingRequests(req.userId);
  const requests = [];
  for (const r of rows) {
    const u = await db.getUser(r.otherUser);
    requests.push({ id: r.id, createdAt: r.created_at, from: u ? db.publicUser(u) : { id: r.otherUser, username: 'Deleted user', displayName: 'Deleted user' } });
  }
  res.json({ requests });
}));

app.post('/api/friends/request', requireAuth, asyncRoute(async (req, res) => {
  const { userId: toUserId } = req.body || {};
  const target = toUserId && await db.getUser(toUserId);
  if (!target || target.is_banned) return res.status(404).json({ error: 'User not found.' });
  try {
    const result = await db.sendFriendRequest(req.userId, toUserId);
    res.json(result);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/friends/requests/:id/accept', requireAuth, asyncRoute(async (req, res) => {
  const result = await db.respondFriendRequest(req.params.id, req.userId, 'accept');
  if (!result) return res.status(404).json({ error: 'Request not found.' });
  res.json({ status: result.status });
}));

app.post('/api/friends/requests/:id/reject', requireAuth, asyncRoute(async (req, res) => {
  const result = await db.respondFriendRequest(req.params.id, req.userId, 'reject');
  if (!result) return res.status(404).json({ error: 'Request not found.' });
  res.json({ status: result.status });
}));

app.delete('/api/friends/:userId', requireAuth, asyncRoute(async (req, res) => {
  await db.unfriend(req.userId, req.params.userId);
  res.json({ ok: true });
}));

app.get('/api/match-settings', asyncRoute(async (req, res) => {
  const defaults = await db.getSetting('country_match_defaults', { mode: 'india', country: null });
  res.json({ defaults });
}));

// ---- Push notification subscriptions ----
app.post('/api/push/subscribe', requireAuth, asyncRoute(async (req, res) => {
  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    return res.status(400).json({ error: 'Invalid subscription.' });
  }
  await db.savePushSubscription(req.userId, subscription);
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', requireAuth, asyncRoute(async (req, res) => {
  const { endpoint } = req.body || {};
  if (endpoint) await db.removePushSubscription(endpoint);
  res.json({ ok: true });
}));

// ---- Media (voice messages, verify clips, profile photos) ----
media.mount(app, { requireAuth, asyncRoute, metrics });

// ---- WebRTC ICE servers (STUN + optional TURN) ----
// TURN is what makes video work for users behind symmetric NATs (mobile
// carriers, strict office firewalls). Configure either static credentials
// or the time-limited HMAC scheme (Cloudflare Realtime TURN / coturn
// use-auth-secret use the same username=timestamp + HMAC-SHA1 scheme).
app.get('/api/ice', (req, res) => {
  const iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }];
  const urls = (process.env.TURN_URLS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (urls.length) {
    const ttl = parseInt(process.env.TURN_TTL_SEC, 10) || 86400;
    const staticUser = process.env.TURN_STATIC_USER || null;
    const staticCred = process.env.TURN_STATIC_CRED || null;
    const secret = process.env.TURN_SECRET || null;
    if (staticUser && staticCred) {
      iceServers.push({ urls, username: staticUser, credential: staticCred });
    } else if (secret) {
      const username = String(Math.floor(Date.now() / 1000) + ttl);
      const credential = crypto.createHmac('sha1', secret).update(username).digest('base64');
      iceServers.push({ urls, username, credential });
    }
  }
  res.json({ iceServers });
});

function userInConversation(convo, userId) {
  return convo.user_a === userId || convo.user_b === userId;
}

// ============================================================================
// Realtime: matching, pairing, relaying.
// ============================================================================

// Local, per-process maps (each socket's owning worker knows these).
// Global state (presence, pairs, queues) lives in ./state.js.
const localUsers = new Map();    // socketId -> matching entry (see buildEntry)
const socketUser = new Map();    // socketId -> userId

async function startConversation(socketIdA, socketIdB, { resumed, conversationId, userA, userB }) {
  const pairA = await state.pairOf(socketIdA);
  const roomId = (pairA && pairA.roomId) || crypto.randomUUID();
  const [aMutedB, bMutedA] = await Promise.all([
    userB && userA ? state.mutedSet(userA.id).then(s => s.has(userB.id)) : Promise.resolve(false),
    userA && userB ? state.mutedSet(userB.id).then(s => s.has(userA.id)) : Promise.resolve(false)
  ]);

  const convo = conversationId
    ? await db.getConversation(conversationId)
    : (userA && userB ? await db.findOrCreateConversation(userA.id, userB.id) : null);
  if (convo) await state.setPairConv(socketIdA, socketIdB, convo.id);

  io.to(socketIdA).emit('matched', {
    roomId, initiator: true, partnerGender: userB ? userB.gender : null, resumed: !!resumed,
    conversationId: convo ? convo.id : null, partnerId: userB ? userB.id : null, partnerMuted: aMutedB
  });
  io.to(socketIdB).emit('matched', {
    roomId, initiator: false, partnerGender: userA ? userA.gender : null, resumed: !!resumed,
    conversationId: convo ? convo.id : null, partnerId: userA ? userA.id : null, partnerMuted: bMutedA
  });

  io.in(socketIdA).socketsJoin(roomId);
  io.in(socketIdB).socketsJoin(roomId);
  metrics.inc('matches_made_total');
}

// Ends any live chat for this socket; notifies the partner.
async function disconnectPartner(socketId) {
  const partner = await state.endPair(socketId);
  if (partner) io.to(partner).emit('partner-left');
}

// Housekeeping for 24h-disappearing conversations.
setInterval(async () => {
  try {
    const cleared = await db.sweepExpiredMessages();
    for (const { conversationId, id } of cleared) {
      for (const socketId of await state.convSockets(conversationId)) {
        io.to(socketId).emit('message-deleted', { messageId: id });
      }
    }
  } catch (e) {
    console.error('sweepExpiredMessages failed:', e);
  }
}, 60 * 1000);

// Refresh the global gauges shown on /metrics.
setInterval(async () => {
  try {
    const s = await state.stats();
    metrics.setGauge('queue_waiting_male', s.queuedMale);
    metrics.setGauge('queue_waiting_female', s.queuedFemale);
    metrics.setGauge('pairs_active', s.pairs);
  } catch (e) { /* metrics only */ }
}, 5_000).unref();

io.on('connection', (socket) => {
  metrics.inc('socket_connections_total');
  metrics.setGauge('socket_connections_active', io.engine.clientsCount);
  const allowEvent = socketLimiter(socket);

  let heartbeat = null;

  socket.on('auth', ({ token }) => {
    (async () => {
      const userId = session.verifySession(token);
      const user = userId ? await db.getUser(userId) : null;
      if (!user) {
        socket.emit('auth-error');
        return;
      }
      if (user.is_banned) {
        socket.emit('banned');
        socket.disconnect(true);
        return;
      }
      socketUser.set(socket.id, userId);
      await state.bindUser(socket.id, userId);
      if (detectedCountry && user.last_country !== detectedCountry) {
        await db.setLastCountry(userId, detectedCountry);
      }

      // Heartbeat: keeps presence/pair TTLs alive and detects a partner
      // whose worker died (their pair key expires) so the user isn't left
      // chatting into the void.
      heartbeat = setInterval(() => {
        (async () => {
          await state.refreshPresence(socket.id, userId);
          const pairStatus = await state.refreshPair(socket.id);
          if (pairStatus === 'expired') socket.emit('partner-left');
        })().catch(e => console.error('heartbeat failed:', e.message));
      }, 60_000);
      heartbeat.unref();
    })().catch(e => console.error('auth handler failed:', e));
  });

  const detectedCountry = detectCountry(socket);

  function buildEntry(gender, lookingFor, { countryMode, country, lat, lon } = {}) {
    const mode = VALID_COUNTRY_MODES.includes(countryMode) ? countryMode : 'random';
    return {
      gender,
      lookingFor,
      countryMode: mode,
      country: mode === 'country' && typeof country === 'string' ? country.toUpperCase().slice(0, 2) : null,
      lat: mode === 'nearby' && typeof lat === 'number' ? lat : null,
      lon: mode === 'nearby' && typeof lon === 'number' ? lon : null,
      detectedCountry,
      userId: socketUser.get(socket.id) || null,
      queuedAt: Date.now()
    };
  }

  socket.on('find-partner', ({ gender, lookingFor, countryMode, country, lat, lon }) => {
    if (!allowEvent()) return;
    if (!['male', 'female'].includes(gender)) return;
    (async () => {
      await disconnectPartner(socket.id);
      await state.dequeue(socket.id);
      const entry = buildEntry(gender, lookingFor, { countryMode, country, lat, lon });
      localUsers.set(socket.id, entry);
      const match = await state.tryMatch(socket.id, entry);
      if (match) {
        const me = await db.getUser(socketUser.get(socket.id));
        await startConversation(socket.id, match.socketId, {
          resumed: false, conversationId: null,
          userA: me ? { id: me.id, gender: me.gender } : null,
          userB: { id: match.entry.userId, gender: match.entry.gender }
        }).catch(e => console.error('startConversation failed:', e));
      }
    })().catch(e => console.error('find-partner failed:', e.message));
  });

  socket.on('set-country-mode', ({ countryMode, country, lat, lon }) => {
    if (!allowEvent()) return;
    (async () => {
      if (await state.isPaired(socket.id)) return;
      const entry = localUsers.get(socket.id) || buildEntry(null, null, {});
      const mode = VALID_COUNTRY_MODES.includes(countryMode) ? countryMode : 'random';
      entry.countryMode = mode;
      entry.country = mode === 'country' && typeof country === 'string' ? country.toUpperCase().slice(0, 2) : null;
      entry.lat = mode === 'nearby' && typeof lat === 'number' ? lat : null;
      entry.lon = mode === 'nearby' && typeof lon === 'number' ? lon : null;
      entry.queuedAt = Date.now();
      localUsers.set(socket.id, entry);
      await state.enqueue(socket.id, entry);
      const match = await state.tryMatch(socket.id, entry);
      if (match) {
        const me = await db.getUser(socketUser.get(socket.id));
        await startConversation(socket.id, match.socketId, {
          resumed: false, conversationId: null,
          userA: me ? { id: me.id, gender: me.gender } : null,
          userB: { id: match.entry.userId, gender: match.entry.gender }
        }).catch(e => console.error('startConversation failed:', e));
      }
    })().catch(e => console.error('set-country-mode failed:', e.message));
  });

  socket.on('call-friend', ({ friendUserId }) => {
    if (!allowEvent()) return;
    (async () => {
      const myUserId = socketUser.get(socket.id);
      if (!myUserId) return socket.emit('call-failed', { reason: 'not-authenticated' });
      if (!friendUserId || !await db.areFriends(myUserId, friendUserId)) {
        return socket.emit('call-failed', { reason: 'not-friends' });
      }
      const friendSocketId = await state.socketOf(friendUserId);
      if (!friendSocketId || !(await state.isLive(friendSocketId))) return socket.emit('call-failed', { reason: 'offline' });
      if (await state.isPaired(socket.id) || await state.isPaired(friendSocketId)) return socket.emit('call-failed', { reason: 'busy' });

      const myUser = await db.getUser(myUserId);
      const friendUser = await db.getUser(friendUserId);
      await state.dequeue(socket.id);
      await state.dequeue(friendSocketId);
      localUsers.set(socket.id, buildEntry(myUser.gender, friendUser.gender));
      const convo = await db.findOrCreateConversation(myUserId, friendUserId);
      const paired = await state.pairUp(socket.id, friendSocketId, { userA: { id: myUserId }, userB: { id: friendUserId } });
      if (!paired) return socket.emit('call-failed', { reason: 'busy' });
      await startConversation(socket.id, friendSocketId, {
        resumed: false, conversationId: convo.id,
        userA: { id: myUser.id, gender: myUser.gender },
        userB: { id: friendUser.id, gender: friendUser.gender }
      });
    })().catch(e => { console.error('call-friend failed:', e); socket.emit('call-failed', { reason: 'server-error' }); });
  });

  socket.on('skip', () => {
    if (!allowEvent()) return;
    (async () => {
      await disconnectPartner(socket.id);
      await state.dequeue(socket.id);
      const entry = localUsers.get(socket.id);
      if (entry) {
        entry.queuedAt = Date.now();
        const match = await state.tryMatch(socket.id, entry);
        if (match) {
          const me = await db.getUser(socketUser.get(socket.id));
          await startConversation(socket.id, match.socketId, {
            resumed: false, conversationId: null,
            userA: me ? { id: me.id, gender: me.gender } : null,
            userB: { id: match.entry.userId, gender: match.entry.gender }
          }).catch(e => console.error('startConversation failed:', e));
        }
      }
    })().catch(e => console.error('skip failed:', e.message));
  });

  socket.on('cancel-search', () => {
    if (!allowEvent()) return;
    state.dequeue(socket.id).catch(e => console.error('cancel-search failed:', e.message));
  });

  socket.on('leave-chat', () => {
    if (!allowEvent()) return;
    (async () => {
      await disconnectPartner(socket.id);
      await state.dequeue(socket.id);
    })().catch(e => console.error('leave-chat failed:', e.message));
  });

  socket.on('resume-chat', ({ conversationId }) => {
    if (!allowEvent()) return;
    (async () => {
      const myUserId = socketUser.get(socket.id);
      if (!myUserId) return;
      const convo = await db.getConversation(conversationId);
      if (!convo || !userInConversation(convo, myUserId)) {
        socket.emit('resume-failed', { reason: 'not-found' });
        return;
      }
      const partnerId = db.otherUserId(convo, myUserId);
      const partnerSocketId = await state.socketOf(partnerId);
      if (!partnerSocketId || !(await state.isLive(partnerSocketId))) {
        socket.emit('resume-failed', { reason: 'offline' });
        return;
      }
      if (await state.isPaired(socket.id) || await state.isPaired(partnerSocketId)) {
        socket.emit('resume-failed', { reason: 'busy' });
        return;
      }
      const partnerUser = await db.getUser(partnerId);
      const myUser = await db.getUser(myUserId);
      await state.dequeue(socket.id);
      await state.dequeue(partnerSocketId);
      localUsers.set(socket.id, buildEntry(myUser.gender, partnerUser.gender));
      const paired = await state.pairUp(socket.id, partnerSocketId, { userA: { id: myUserId }, userB: { id: partnerId } });
      if (!paired) return socket.emit('resume-failed', { reason: 'busy' });
      await startConversation(socket.id, partnerSocketId, {
        resumed: true, conversationId: convo.id,
        userA: { id: myUser.id, gender: myUser.gender },
        userB: { id: partnerUser.id, gender: partnerUser.gender }
      });
    })().catch(e => { console.error('resume-chat failed:', e); socket.emit('resume-failed', { reason: 'server-error' }); });
  });

  const MAX_MESSAGE_LENGTH = 1000;
  socket.on('chat-message', ({ text, replyToId }) => {
    if (!allowEvent()) return;
    if (typeof text !== 'string') return;
    const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!trimmed) return;
    (async () => {
      const pair = await state.pairOf(socket.id);
      if (!pair) return;
      const senderId = socketUser.get(socket.id);

      let payload = { id: null, ts: Date.now(), text: trimmed, replyTo: null };
      if (pair.convId && senderId) {
        const msg = await db.addMessage(pair.convId, { senderId, type: 'text', text: trimmed, replyToId: typeof replyToId === 'string' ? replyToId : null });
        const recent = await db.getMessages(pair.convId, senderId, { limit: 1 });
        const shaped = recent.find(m => m.id === msg.id);
        payload = { id: msg.id, ts: msg.ts, text: trimmed, replyTo: shaped ? shaped.replyTo : null };
      }
      socket.emit('chat-message', { ...payload, self: true });
      io.to(pair.partnerSocketId).emit('chat-message', { ...payload, self: false });
      metrics.inc('socket_messages_relayed_total');
    })().catch(e => console.error('chat-message failed:', e.message));
  });

  socket.on('delete-message', ({ messageId, mode }) => {
    if (!allowEvent()) return;
    const userId = socketUser.get(socket.id);
    if (!userId || typeof messageId !== 'string') return;
    (async () => {
      const pair = await state.pairOf(socket.id);
      try {
        if (mode === 'everyone') {
          await db.deleteMessageForEveryone(messageId, userId);
          socket.emit('message-deleted', { messageId });
          if (pair) io.to(pair.partnerSocketId).emit('message-deleted', { messageId });
        } else {
          await db.deleteMessageForMe(messageId, userId);
          socket.emit('message-deleted', { messageId, onlyForMe: true });
        }
      } catch (e) {
        socket.emit('delete-message-failed', { messageId, reason: e.message });
      }
    })();
  });

  socket.on('set-disappearing', ({ mode }) => {
    if (!allowEvent()) return;
    (async () => {
      const pair = await state.pairOf(socket.id);
      if (!pair || !pair.convId) return;
      try {
        await db.setDisappearingMode(pair.convId, mode);
        socket.emit('disappearing-changed', { mode });
        io.to(pair.partnerSocketId).emit('disappearing-changed', { mode });
      } catch (e) { /* invalid mode from a modified client — ignore silently */ }
    })();
  });

  socket.on('mark-seen', () => {
    if (!allowEvent()) return;
    (async () => {
      const pair = await state.pairOf(socket.id);
      const userId = socketUser.get(socket.id);
      if (!pair || !pair.convId || !userId) return;
      const { seenIds, deletedIds } = await db.markSeen(pair.convId, userId);
      if (seenIds.length) io.to(pair.partnerSocketId).emit('messages-seen', { messageIds: seenIds });
      for (const messageId of deletedIds) {
        socket.emit('message-deleted', { messageId });
        io.to(pair.partnerSocketId).emit('message-deleted', { messageId });
      }
    })().catch(e => console.error('mark-seen failed:', e.message));
  });

  // ---- Pure relay events (WebRTC signaling + consent handshakes). The
  // rate limiter is the only server-side cost control here; payloads are
  // bounded by maxHttpBufferSize. ----
  const relay = (event, fn) => {
    socket.on(event, (payload) => {
      if (!allowEvent()) return;
      state.pairOf(socket.id)
        .then((pair) => { if (pair) fn(pair, payload); })
        .catch((e) => console.error(`relay ${event} failed:`, e.message));
    });
  };

  relay('webrtc-offer', (pair, payload) => io.to(pair.partnerSocketId).emit('webrtc-offer', payload));
  relay('webrtc-answer', (pair, payload) => io.to(pair.partnerSocketId).emit('webrtc-answer', payload));
  relay('webrtc-ice-candidate', (pair, payload) => io.to(pair.partnerSocketId).emit('webrtc-ice-candidate', payload));
  relay('verify-request', (pair) => io.to(pair.partnerSocketId).emit('verify-request'));
  relay('viewing-profile', (pair, payload) => io.to(pair.partnerSocketId).emit('partner-viewing-profile', { viewing: !!(payload && payload.viewing) }));
  relay('verify-video', (pair, payload) => {
    // New flow: { key } (a storage key from media.js). Legacy data-URL
    // relaying is closed — clips are far too big to route through every
    // worker's event loop.
    if (payload && typeof payload.key === 'string' && media.isValidKey(payload.key, 'verify')) {
      io.to(pair.partnerSocketId).emit('verify-video', { key: payload.key });
    }
  });
  relay('reveal-request', (pair) => io.to(pair.partnerSocketId).emit('reveal-request'));
  relay('reveal-response', (pair, payload) => io.to(pair.partnerSocketId).emit('reveal-response', payload));
  relay('switch-mode-request', (pair, payload) => io.to(pair.partnerSocketId).emit('switch-mode-request', payload));
  relay('switch-mode-response', (pair, payload) => io.to(pair.partnerSocketId).emit('switch-mode-response', payload));
  relay('voice-request', (pair) => io.to(pair.partnerSocketId).emit('voice-request'));
  relay('voice-response', (pair, payload) => io.to(pair.partnerSocketId).emit('voice-response', payload));
  relay('voice-end', (pair) => io.to(pair.partnerSocketId).emit('voice-end'));

  socket.on('voice-message', ({ key }) => {
    if (!allowEvent()) return;
    (async () => {
      if (typeof key !== 'string' || !media.isValidKey(key, 'voice')) return;
      const pair = await state.pairOf(socket.id);
      if (!pair) return;
      const senderId = socketUser.get(socket.id);

      let payload = { id: null, ts: Date.now(), audio: key };
      if (pair.convId && senderId) {
        const msg = await db.addMessage(pair.convId, { senderId, type: 'voice', audio: key });
        payload = { id: msg.id, ts: msg.ts, audio: key };
      }
      socket.emit('voice-message', { ...payload, self: true });
      io.to(pair.partnerSocketId).emit('voice-message', { ...payload, self: false });
      metrics.inc('socket_messages_relayed_total');
    })().catch(e => console.error('voice-message failed:', e.message));
  });

  const VALID_REPORT_REASONS = ['incorrect_gender', 'inappropriate', 'fraud', 'other'];
  socket.on('report', ({ reason, details }) => {
    if (!allowEvent()) return;
    (async () => {
      const pair = await state.pairOf(socket.id);
      if (!pair) return;
      const reporterId = socketUser.get(socket.id);
      const reportedId = pair.userId;
      if (!reporterId || !reportedId) return;
      const safeReason = VALID_REPORT_REASONS.includes(reason) ? reason : 'other';

      await db.addReport({ reporterId, reportedId, reason: safeReason, details: details ? String(details).slice(0, 500) : null });

      const autoBan = await db.getSetting('auto_ban_on_report', true);
      if (autoBan) {
        await db.banUser(reportedId);
        socket.emit('report-ack', { banned: true });
        const reportedSocketId = await state.socketOf(reportedId);
        if (reportedSocketId) {
          io.to(reportedSocketId).emit('banned');
          await disconnectPartner(reportedSocketId);
          await state.dequeue(reportedSocketId);
          io.sockets.sockets.get(reportedSocketId)?.disconnect(true);
        }
      } else {
        socket.emit('report-ack', { banned: false });
      }
    })().catch(e => console.error('report handler failed:', e.message));
  });

  // ---- Block / mute from the in-chat "more" (⋮) menu ----
  socket.on('block-user', ({ userId: targetUserId } = {}) => {
    if (!allowEvent()) return;
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId || targetUserId === myUserId) return;
    (async () => {
      await db.blockUser(myUserId, targetUserId);
      state.invalidateBlocks(myUserId);
      socket.emit('block-ack', { userId: targetUserId, blocked: true });
      const pair = await state.pairOf(socket.id);
      if (pair && pair.userId === targetUserId) {
        await disconnectPartner(socket.id);
        await state.dequeue(socket.id);
      }
    })().catch(e => console.error('block-user failed:', e.message));
  });

  socket.on('unblock-user', ({ userId: targetUserId } = {}) => {
    if (!allowEvent()) return;
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId) return;
    (async () => {
      await db.unblockUser(myUserId, targetUserId);
      state.invalidateBlocks(myUserId);
      socket.emit('block-ack', { userId: targetUserId, blocked: false });
    })().catch(e => console.error('unblock-user failed:', e.message));
  });

  socket.on('mute-user', ({ userId: targetUserId } = {}) => {
    if (!allowEvent()) return;
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId || targetUserId === myUserId) return;
    (async () => {
      await db.muteUser(myUserId, targetUserId);
      state.invalidateMutes(myUserId);
      socket.emit('mute-ack', { userId: targetUserId, muted: true });
    })().catch(e => console.error('mute-user failed:', e.message));
  });

  socket.on('unmute-user', ({ userId: targetUserId } = {}) => {
    if (!allowEvent()) return;
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId) return;
    (async () => {
      await db.unmuteUser(myUserId, targetUserId);
      state.invalidateMutes(myUserId);
      socket.emit('mute-ack', { userId: targetUserId, muted: false });
    })().catch(e => console.error('unmute-user failed:', e.message));
  });

  socket.on('disconnect', () => {
    if (heartbeat) clearInterval(heartbeat);
    (async () => {
      await disconnectPartner(socket.id);
      await state.dequeue(socket.id);
      const userId = socketUser.get(socket.id);
      localUsers.delete(socket.id);
      socketUser.delete(socket.id);
      if (userId) await state.unbindUser(socket.id, userId);
    })().catch(e => console.error('disconnect cleanup failed:', e.message));
    metrics.setGauge('socket_connections_active', io.engine.clientsCount);
  });
});

const PORT = process.env.PORT || 3000;

// Wait for the Postgres schema to exist before accepting any traffic.
(async () => {
  try {
    await db.ready;
    await state.init(io, {
      redisUrl: process.env.REDIS_URL,
      loaders: {
        blocked: (id) => db.getBlockedUserIds(id),
        muted: (id) => db.getMutedUserIds(id)
      },
      // Pairs formed by the periodic sweep (rather than by a user pressing
      // "find"): create the conversation and notify both sockets — the
      // adapter carries the emits to whichever workers own them.
      onMatch: async (seekerEntry, partnerEntry, partnerSocketId) => {
        const [uA, uB] = await Promise.all([
          db.getUser(seekerEntry.userId),
          db.getUser(partnerEntry.userId)
        ]);
        await startConversation(seekerEntry.socketId, partnerSocketId, {
          resumed: false,
          conversationId: null,
          userA: uA ? { id: uA.id, gender: uA.gender } : { id: seekerEntry.userId, gender: seekerEntry.gender },
          userB: uB ? { id: uB.id, gender: uB.gender } : { id: partnerEntry.userId, gender: partnerEntry.gender }
        });
      }
    });
    server.listen(PORT, () => {
      console.log(`Random chat server running on port ${PORT} (state: ${state.backend})`);
    });
  } catch (e) {
    console.error('Failed to start:', e);
    process.exit(1);
  }
})();

// Flush any batched-but-not-yet-written DB updates before the process
// exits, so a deploy/restart never silently drops a queued write.
function gracefulShutdown() {
  db.flushPendingWrites()
    .catch(e => console.error('Flush on shutdown failed:', e))
    .finally(() => {
      state.close();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
