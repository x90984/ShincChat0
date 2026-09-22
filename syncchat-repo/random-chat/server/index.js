require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const geoip = require('geoip-lite');
const db = require('./db');
const oauth = require('./oauth');

// ---- Country/location matching helpers ----
function getClientIp(socket) {
  const fwd = socket.handshake.headers['x-forwarded-for'];
  if (fwd) return String(fwd).split(',')[0].trim();
  return socket.handshake.address || null;
}

function detectCountry(socket) {
  const ip = getClientIp(socket);
  if (!ip) return null;
  const lookup = geoip.lookup(ip);
  return lookup ? lookup.country : null;
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const VALID_COUNTRY_MODES = ['nearby', 'india', 'random', 'country'];
const NEARBY_RADIUS_KM = 100;
const NEARBY_STRICT_MS = 10_000;
const NEARBY_COUNTRY_MS = 25_000;
const COUNTRY_STRICT_MS = 20_000;

function currentScope(entry, elapsedMs) {
  switch (entry.countryMode) {
    case 'random':
      return { type: 'any' };
    case 'india':
      return elapsedMs < COUNTRY_STRICT_MS ? { type: 'country', country: 'IN' } : { type: 'any' };
    case 'country':
      if (!entry.country) return { type: 'any' };
      return elapsedMs < COUNTRY_STRICT_MS ? { type: 'country', country: entry.country } : { type: 'any' };
    case 'nearby':
      if (entry.lat != null && entry.lon != null && elapsedMs < NEARBY_STRICT_MS) {
        return { type: 'nearby', lat: entry.lat, lon: entry.lon, radius: NEARBY_RADIUS_KM };
      }
      if (elapsedMs < NEARBY_COUNTRY_MS) {
        return entry.detectedCountry ? { type: 'country', country: entry.detectedCountry } : { type: 'any' };
      }
      return { type: 'any' };
    default:
      return { type: 'any' };
  }
}

function scopeAllows(scope, otherEntry) {
  if (scope.type === 'any') return true;
  if (scope.type === 'country') {
    const otherCountry = otherEntry.detectedCountry || otherEntry.country;
    return !!otherCountry && otherCountry === scope.country;
  }
  if (scope.type === 'nearby') {
    if (otherEntry.lat == null || otherEntry.lon == null) return false;
    return haversineKm(scope.lat, scope.lon, otherEntry.lat, otherEntry.lon) <= scope.radius;
  }
  return false;
}

function usersCompatible(a, b, now) {
  return scopeAllows(currentScope(a, now - a.queuedAt), b) && scopeAllows(currentScope(b, now - b.queuedAt), a);
}

const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 8e6 });

app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---- Sessions (in-memory token -> userId) ----
const sessions = new Map();

async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const userId = token && sessions.get(token);
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

function createSession(userId) {
  const token = crypto.randomUUID();
  sessions.set(token, userId);
  return token;
}

// Wraps an async Express handler so a thrown/rejected error becomes a 500
// instead of crashing the process or hanging the request — every route
// below now awaits database calls, so this replaces the implicit safety
// SQLite's synchronous calls used to have (an uncaught throw there still
// unwound normally; an unhandled rejection here would not).
function asyncRoute(handler) {
  return (req, res) => {
    handler(req, res).catch((e) => {
      console.error('Route error:', e);
      if (!res.headersSent) res.status(500).json({ error: 'Server error' });
    });
  };
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

app.get('/health', (req, res) => res.json({ ok: true })); // for cron-job.org keep-awake pings

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
    const token = createSession(user.id);
    res.json({ token, user: db.publicUser(user) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/login', asyncRoute(async (req, res) => {
  const { identifier, password } = req.body || {};
  const user = await db.findUserByIdentifier(identifier || '');
  if (!user || !user.hash || !db.verifyPassword(password || '', user.salt, user.hash)) {
    return res.status(401).json({ error: 'Incorrect username, email, phone or password.' });
  }
  if (user.is_banned) {
    return res.status(403).json({ error: 'This account has been permanently banned.' });
  }
  const token = createSession(user.id);
  res.json({ token, user: db.publicUser(user) });
}));

// Social login (Google) — mounts /auth/google, /auth/google/callback, /api/oauth-providers.
oauth.mount(app, db, { createSession });

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
    await db.setBirthDate(req.userId, birthDate);
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
  const matches = [];
  for (const u of users) {
    const friendStatus = await db.friendStatusBetween(req.userId, u.id);
    if (friendStatus === 'friends') continue;
    matches.push({ ...db.publicUser(u), online: onlineUsers.has(u.id), friendStatus });
  }
  res.json({ matches });
}));

// ---- Chat history ----
// P2P mode: message content never reaches this server, so the list is
// built from content-free metadata (type + sender + timestamp of the last
// activity, plus per-side unread counters) that the clients ping in.
// Conversations from before the P2P switch still fall back to their
// stored last message row.
app.get('/api/history', requireAuth, asyncRoute(async (req, res) => {
  const rawConvos = await db.listConversationsForUser(req.userId);
  const conversations = [];
  for (const c of rawConvos) {
    const partnerId = db.otherUserId(c, req.userId);
    const partner = await db.getUser(partnerId);
    let last = null;
    if (c.last_message_type) {
      last = {
        type: c.last_message_type,
        text: null, // content lives only on the participants' devices
        ts: Number(c.last_message_at || 0),
        mine: c.last_message_sender === req.userId
      };
    } else {
      const legacy = await db.getLastMessage(c.id);
      last = legacy ? { type: legacy.type, text: legacy.text, ts: Number(legacy.ts), mine: legacy.sender_id === req.userId } : null;
    }
    const unreadCount = await db.getUnreadCount(c, req.userId);
    conversations.push({
      conversationId: c.id,
      partner: partner ? db.publicUser(partner) : { id: partnerId, username: 'Deleted user', gender: null },
      online: onlineUsers.has(partnerId),
      lastMessage: last,
      unreadCount,
      updatedAt: c.last_message_at || c.created_at
    });
  }
  res.json({ conversations });
}));

app.get('/api/history/:conversationId/messages', requireAuth, asyncRoute(async (req, res) => {
  const convo = await db.getConversation(req.params.conversationId);
  if (!convo || !userInConversation(convo, req.userId)) return res.status(404).json({ error: 'Not found' });
  const beforeTs = req.query.before ? Number(req.query.before) : null;
  // Legacy (pre-P2P) rows only — new message content lives exclusively on
  // the participants' devices. Tombstones are ID-only deletion markers the
  // client applies against its local copy.
  const messages = await db.getMessages(convo.id, req.userId, { beforeTs });
  const tombstones = await db.getTombstones(convo.id);
  res.json({ messages, tombstones, disappearingMode: convo.disappearing_mode });
}));

app.post('/api/history/:conversationId/disappearing', requireAuth, asyncRoute(async (req, res) => {
  const convo = await db.getConversation(req.params.conversationId);
  if (!convo || !userInConversation(convo, req.userId)) return res.status(404).json({ error: 'Not found' });
  try {
    const mode = await db.setDisappearingMode(convo.id, req.body && req.body.mode);
    const otherId = db.otherUserId(convo, req.userId);
    const otherSocketId = onlineUsers.get(otherId);
    if (otherSocketId) io.to(otherSocketId).emit('disappearing-changed', { conversationId: convo.id, mode });
    res.json({ mode });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/history/delete-all', requireAuth, asyncRoute(async (req, res) => {
  const cleared = await db.deleteAllConversationsForUser(req.userId);
  for (const { id, otherUserId: otherId } of cleared) {
    const otherSocketId = onlineUsers.get(otherId);
    if (otherSocketId) io.to(otherSocketId).emit('conversation-deleted', { conversationId: id });
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
  const otherSocketId = onlineUsers.get(otherId);
  if (otherSocketId) io.to(otherSocketId).emit('conversation-deleted', { conversationId: convo.id });
  res.json({ ok: true });
}));

// Bundle for the "Reviews" popup — your 10 most recent chat partners, each
// with their public reviews and your past messages with them, in one call.
app.get('/api/history/recent-partners', requireAuth, asyncRoute(async (req, res) => {
  const rawConvos = (await db.listConversationsForUser(req.userId)).slice(0, 10);
  const partners = [];
  for (const c of rawConvos) {
    const partnerId = db.otherUserId(c, req.userId);
    const partner = await db.getUser(partnerId);
    if (!partner) continue;
    const [reviews, summary, messages] = await Promise.all([
      db.getReviewsForUser(partnerId),
      db.getReviewSummary(partnerId),
      db.getMessages(c.id, req.userId, { limit: 50 })
    ]);
    partners.push({
      conversationId: c.id,
      partner: { ...db.publicUser(partner), online: onlineUsers.has(partnerId) },
      reviews, summary, messages
    });
  }
  res.json({ partners });
}));

// ---- Block / mute (one-directional, act on the CURRENT user's list) ----
app.post('/api/users/:id/block', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't block yourself." });
  await db.blockUser(req.userId, req.params.id);
  refreshBlockCache(req.userId).catch(() => {});
  // A block always ends any chat currently in progress with that person.
  const mySocketId = onlineUsers.get(req.userId);
  const myLiveSocketId = mySocketId && pairs.has(mySocketId) ? mySocketId : null;
  if (myLiveSocketId && socketUser.get(pairs.get(myLiveSocketId)) === req.params.id) {
    disconnectPartner(myLiveSocketId);
    removeFromQueues(myLiveSocketId);
  }
  res.json({ ok: true });
}));
app.post('/api/users/:id/unblock', requireAuth, asyncRoute(async (req, res) => {
  await db.unblockUser(req.userId, req.params.id);
  refreshBlockCache(req.userId).catch(() => {});
  res.json({ ok: true });
}));
app.post('/api/users/:id/mute', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't mute yourself." });
  await db.muteUser(req.userId, req.params.id);
  refreshMuteCache(req.userId).catch(() => {});
  res.json({ ok: true });
}));
app.post('/api/users/:id/unmute', requireAuth, asyncRoute(async (req, res) => {
  await db.unmuteUser(req.userId, req.params.id);
  refreshMuteCache(req.userId).catch(() => {});
  res.json({ ok: true });
}));

// ---- Users: search + profile ----
app.get('/api/users/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  const rows = await db.searchUsers(q, req.userId, 20);
  const users = [];
  for (const u of rows) {
    users.push({ ...db.publicUser(u), online: onlineUsers.has(u.id), friendStatus: await db.friendStatusBetween(req.userId, u.id) });
  }
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
      online: onlineUsers.has(user.id),
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
  const suggestions = raw.map(u => ({ ...u, online: onlineUsers.has(u.id) }));
  res.json({ suggestions });
}));

// ---- Friends ----
app.get('/api/friends', requireAuth, asyncRoute(async (req, res) => {
  const ids = await db.listFriendIds(req.userId);
  const friends = [];
  for (const id of ids) {
    const u = await db.getUser(id);
    if (u) friends.push({ ...db.publicUser(u), online: onlineUsers.has(id) });
  }
  res.json({ friends });
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

// ---- Push notification subscriptions (new) ----
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

function userInConversation(convo, userId) {
  return convo.user_a === userId || convo.user_b === userId;
}

// ---- WebRTC ICE configuration handed to clients at match time ----
// Google's public STUN server covers most network topologies. For the
// strict NATs (symmetric NAT, mobile carriers, corporate firewalls) where
// a direct peer-to-peer path can't be punched through, set the TURN_*
// environment variables (e.g. a self-hosted coturn box) and every match
// will connect reliably — media and data still flow device-to-device,
// TURN just relays the encrypted packets it can't see into plaintext.
function buildIceServers() {
  const servers = [{ urls: 'stun:stun.l.google.com:19302' }];
  if (process.env.TURN_URL) {
    servers.push({
      urls: process.env.TURN_URL,
      username: process.env.TURN_USERNAME || '',
      credential: process.env.TURN_CREDENTIAL || ''
    });
  }
  return servers;
}
const rtcConfigForClients = { iceServers: buildIceServers() };

// ---- Matching state ----
const waiting = { male: [], female: [] };
const pairs = new Map();
const users = new Map();
const onlineUsers = new Map();
const socketUser = new Map();
const socketConv = new Map();

// In-memory mirrors of the blocks/mutes tables, keyed by userId, so the
// matching loop (which runs many times a second) never has to hit the DB.
// Populated on auth, kept fresh via refreshBlockCache/refreshMuteCache.
const blockedByUser = new Map(); // userId -> Set(userIds they blocked)
const mutedByUser = new Map();   // userId -> Set(userIds they muted)

async function refreshBlockCache(userId) {
  blockedByUser.set(userId, new Set(await db.getBlockedUserIds(userId)));
}
async function refreshMuteCache(userId) {
  mutedByUser.set(userId, new Set(await db.getMutedUserIds(userId)));
}
// Blocking is treated as mutual for matching purposes: if either side has
// blocked the other, they should never be paired again.
function isBlockedPairSync(userIdA, userIdB) {
  if (!userIdA || !userIdB) return false;
  const aBlocks = blockedByUser.get(userIdA);
  const bBlocks = blockedByUser.get(userIdB);
  return !!(aBlocks && aBlocks.has(userIdB)) || !!(bBlocks && bBlocks.has(userIdA));
}

function oppositeOf(gender) {
  return gender === 'male' ? 'female' : 'male';
}

async function startConversation(socketIdA, socketIdB, resumed, conversationId) {
  pairs.set(socketIdA, socketIdB);
  pairs.set(socketIdB, socketIdA);

  const userIdA = socketUser.get(socketIdA);
  const userIdB = socketUser.get(socketIdB);
  const convo = conversationId
    ? await db.getConversation(conversationId)
    : (userIdA && userIdB ? await db.findOrCreateConversation(userIdA, userIdB) : null);
  if (convo) {
    socketConv.set(socketIdA, convo.id);
    socketConv.set(socketIdB, convo.id);
  }

  const roomId = crypto.randomUUID();
  const userA = users.get(socketIdA);
  const userB = users.get(socketIdB);
  if (!userA || !userB) return; // one side disconnected mid-setup

  const aMutedB = !!(mutedByUser.get(userIdA) && userIdB && mutedByUser.get(userIdA).has(userIdB));
  const bMutedA = !!(mutedByUser.get(userIdB) && userIdA && mutedByUser.get(userIdB).has(userIdA));

  io.to(socketIdA).emit('matched', {
    roomId, initiator: true, partnerGender: userB.gender, resumed: !!resumed,
    conversationId: convo ? convo.id : null, partnerId: userIdB || null, partnerMuted: aMutedB,
    rtcConfig: rtcConfigForClients
  });
  io.to(socketIdB).emit('matched', {
    roomId, initiator: false, partnerGender: userA.gender, resumed: !!resumed,
    conversationId: convo ? convo.id : null, partnerId: userIdA || null, partnerMuted: bMutedA,
    rtcConfig: rtcConfigForClients
  });

  io.sockets.sockets.get(socketIdA)?.join(roomId);
  io.sockets.sockets.get(socketIdB)?.join(roomId);
}

function tryMatch(socketId) {
  const entry = users.get(socketId);
  if (!entry) return false;
  if (!entry.queuedAt) entry.queuedAt = Date.now();

  const targetQueue = waiting[oppositeOf(entry.gender)];
  const now = Date.now();

  for (let i = 0; i < targetQueue.length; i++) {
    const candidateId = targetQueue[i];
    if (candidateId === socketId) continue;
    const candidateSocket = io.sockets.sockets.get(candidateId);
    const candidateEntry = users.get(candidateId);
    if (!candidateSocket || !candidateEntry || pairs.has(candidateId)) {
      targetQueue.splice(i, 1);
      i--;
      continue;
    }
    if (!usersCompatible(entry, candidateEntry, now)) continue;
    if (isBlockedPairSync(socketUser.get(socketId), socketUser.get(candidateId))) continue;

    targetQueue.splice(i, 1);
    removeFromQueues(socketId);
    startConversation(socketId, candidateId, false, null).catch(e => console.error('startConversation failed:', e));
    return true;
  }

  if (!waiting[entry.gender].includes(socketId)) waiting[entry.gender].push(socketId);
  return false;
}

setInterval(() => {
  const queued = [...waiting.male, ...waiting.female];
  for (const socketId of queued) {
    if (pairs.has(socketId)) continue;
    if (!waiting.male.includes(socketId) && !waiting.female.includes(socketId)) continue;
    tryMatch(socketId);
  }
}, 5000);

// Housekeeping: legacy 24h-disappearing message rows, plus ID-only
// tombstones (kept for 7 days so an offline partner has time to come
// back and apply pending deletions, then dropped).
setInterval(async () => {
  try {
    const cleared = await db.sweepExpiredMessages();
    for (const { conversationId, id } of cleared) {
      for (const [socketId, convId] of socketConv.entries()) {
        if (convId === conversationId) io.to(socketId).emit('message-deleted', { messageId: id });
      }
    }
    await db.pruneTombstones(7 * 24 * 60 * 60 * 1000);
  } catch (e) {
    console.error('sweep failed:', e);
  }
}, 60 * 1000);

function removeFromQueues(socketId) {
  waiting.male = waiting.male.filter(id => id !== socketId);
  waiting.female = waiting.female.filter(id => id !== socketId);
}

function disconnectPartner(socketId) {
  const partnerId = pairs.get(socketId);
  if (partnerId) {
    io.to(partnerId).emit('partner-left');
    pairs.delete(partnerId);
    socketConv.delete(partnerId);
  }
  pairs.delete(socketId);
  socketConv.delete(socketId);
}

io.on('connection', (socket) => {

  socket.on('auth', ({ token }) => {
    (async () => {
      const userId = sessions.get(token);
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
      onlineUsers.set(userId, socket.id);
      await db.setLastCountry(userId, detectedCountry);
      await Promise.all([refreshBlockCache(userId), refreshMuteCache(userId)]);
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
      queuedAt: Date.now()
    };
  }

  socket.on('find-partner', ({ gender, lookingFor, countryMode, country, lat, lon }) => {
    if (!['male', 'female'].includes(gender)) return;
    users.set(socket.id, buildEntry(gender, lookingFor, { countryMode, country, lat, lon }));
    removeFromQueues(socket.id);
    disconnectPartner(socket.id);
    tryMatch(socket.id);
  });

  socket.on('set-country-mode', ({ countryMode, country, lat, lon }) => {
    const entry = users.get(socket.id);
    if (!entry) return;
    const mode = VALID_COUNTRY_MODES.includes(countryMode) ? countryMode : 'random';
    entry.countryMode = mode;
    entry.country = mode === 'country' && typeof country === 'string' ? country.toUpperCase().slice(0, 2) : null;
    entry.lat = mode === 'nearby' && typeof lat === 'number' ? lat : null;
    entry.lon = mode === 'nearby' && typeof lon === 'number' ? lon : null;
    if (!pairs.has(socket.id)) tryMatch(socket.id);
  });

  socket.on('call-friend', ({ friendUserId }) => {
    (async () => {
      const myUserId = socketUser.get(socket.id);
      if (!myUserId) return socket.emit('call-failed', { reason: 'not-authenticated' });
      if (!friendUserId || !await db.areFriends(myUserId, friendUserId)) {
        return socket.emit('call-failed', { reason: 'not-friends' });
      }
      const friendSocketId = onlineUsers.get(friendUserId);
      const friendSocket = friendSocketId && io.sockets.sockets.get(friendSocketId);
      if (!friendSocket) return socket.emit('call-failed', { reason: 'offline' });
      if (pairs.has(socket.id) || pairs.has(friendSocketId)) return socket.emit('call-failed', { reason: 'busy' });

      const myUser = await db.getUser(myUserId);
      const friendUser = await db.getUser(friendUserId);
      removeFromQueues(socket.id);
      removeFromQueues(friendSocketId);
      users.set(socket.id, buildEntry(myUser.gender, friendUser.gender));
      users.set(friendSocketId, buildEntry(friendUser.gender, myUser.gender));
      const convo = await db.findOrCreateConversation(myUserId, friendUserId);
      await startConversation(socket.id, friendSocketId, false, convo.id);
    })().catch(e => { console.error('call-friend failed:', e); socket.emit('call-failed', { reason: 'server-error' }); });
  });

  socket.on('skip', () => {
    disconnectPartner(socket.id);
    removeFromQueues(socket.id);
    const entry = users.get(socket.id);
    if (entry) entry.queuedAt = Date.now();
    tryMatch(socket.id);
  });

  socket.on('cancel-search', () => {
    removeFromQueues(socket.id);
  });

  socket.on('leave-chat', () => {
    disconnectPartner(socket.id);
    removeFromQueues(socket.id);
  });

  socket.on('resume-chat', ({ conversationId }) => {
    (async () => {
      const myUserId = socketUser.get(socket.id);
      if (!myUserId) return;
      const convo = await db.getConversation(conversationId);
      if (!convo || !userInConversation(convo, myUserId)) {
        socket.emit('resume-failed', { reason: 'not-found' });
        return;
      }
      const partnerId = db.otherUserId(convo, myUserId);
      const partnerSocketId = onlineUsers.get(partnerId);
      const partnerSocket = partnerSocketId && io.sockets.sockets.get(partnerSocketId);
      if (!partnerSocket) {
        socket.emit('resume-failed', { reason: 'offline' });
        return;
      }
      if (pairs.has(socket.id) || pairs.has(partnerSocketId)) {
        socket.emit('resume-failed', { reason: 'busy' });
        return;
      }
      const partnerUser = await db.getUser(partnerId);
      const myUser = await db.getUser(myUserId);
      removeFromQueues(socket.id);
      removeFromQueues(partnerSocketId);
      users.set(socket.id, buildEntry(myUser.gender, partnerUser.gender));
      users.set(partnerSocketId, buildEntry(partnerUser.gender, myUser.gender));
      await startConversation(socket.id, partnerSocketId, true, convo.id);
    })().catch(e => { console.error('resume-chat failed:', e); socket.emit('resume-failed', { reason: 'server-error' }); });
  });

  // ---- P2P content transport ----
  // In normal operation chat messages travel directly between the two
  // devices over an encrypted WebRTC data channel and never reach this
  // server at all. The handlers below exist purely as a FALLBACK relay
  // for the rare case where a direct P2P path can't be established
  // (strict NAT with no TURN server): they forward the payload to the
  // partner untouched and store NOTHING — no text, no audio, ever.
  const MAX_MESSAGE_LENGTH = 1000;
  socket.on('chat-message', ({ id, ts, text, replyTo }) => {
    if (typeof text !== 'string' || typeof id !== 'string') return;
    const trimmed = text.trim().slice(0, MAX_MESSAGE_LENGTH);
    if (!trimmed) return;
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;
    io.to(partnerId).emit('chat-message', {
      id, ts: typeof ts === 'number' ? ts : Date.now(), text: trimmed,
      replyTo: replyTo && typeof replyTo.id === 'string' ? { id: replyTo.id, text: typeof replyTo.text === 'string' ? replyTo.text.slice(0, 200) : null } : null
    });
  });

  // Content-free activity ping, sent once per message the client sends
  // (over whichever transport). Carries only the message TYPE so the
  // partner's chat list can show unread badges, ordering and a generic
  // "Message" / "Voice message" preview — never the content itself.
  socket.on('conv-activity', ({ type }) => {
    const convId = socketConv.get(socket.id);
    const senderId = socketUser.get(socket.id);
    if (!convId || !senderId) return;
    db.noteConversationActivity(convId, senderId, type === 'voice' ? 'voice' : 'text')
      .catch(e => console.error('conv-activity failed:', e));
  });

  socket.on('delete-message', ({ messageId, mode }) => {
    const userId = socketUser.get(socket.id);
    if (!userId || typeof messageId !== 'string') return;
    const convId = socketConv.get(socket.id);
    const partnerId = pairs.get(socket.id);
    (async () => {
      if (mode === 'everyone') {
        // The deletion itself is applied device-to-device; the tombstone
        // (message ID only) makes it stick for an offline partner too.
        if (convId) await db.addTombstone(convId, messageId);
        socket.emit('message-deleted', { messageId });
        if (partnerId) io.to(partnerId).emit('message-deleted', { messageId });
      } else {
        // "Delete for me" is purely local to the requester's device.
        socket.emit('message-deleted', { messageId, onlyForMe: true });
      }
    })().catch(e => {
      socket.emit('delete-message-failed', { messageId, reason: e.message });
    });
  });

  socket.on('set-disappearing', ({ mode }) => {
    const convId = socketConv.get(socket.id);
    const partnerId = pairs.get(socket.id);
    if (!convId) return;
    (async () => {
      try {
        await db.setDisappearingMode(convId, mode);
        socket.emit('disappearing-changed', { mode });
        if (partnerId) io.to(partnerId).emit('disappearing-changed', { mode });
      } catch (e) { /* invalid mode from a modified client — ignore silently */ }
    })();
  });

  socket.on('mark-seen', () => {
    // P2P mode: read receipts themselves travel device-to-device over the
    // data channel; the server's only job left here is clearing the
    // content-free unread counter that powers the chat-list badge.
    const convId = socketConv.get(socket.id);
    const userId = socketUser.get(socket.id);
    if (!convId || !userId) return;
    db.clearUnread(convId, userId).catch(e => console.error('mark-seen failed:', e));
  });

  // WebRTC signaling relay
  socket.on('webrtc-offer', (payload) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-offer', payload);
  });

  socket.on('webrtc-answer', (payload) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-answer', payload);
  });

  socket.on('webrtc-ice-candidate', (payload) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-ice-candidate', payload);
  });

  socket.on('verify-request', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('verify-request');
  });

  // One side viewing the other's profile mid-video-call — tell the other
  // side so it can blur its view of the departed person's video feed.
  socket.on('viewing-profile', (payload) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('partner-viewing-profile', { viewing: !!(payload && payload.viewing) });
  });

  socket.on('verify-video', ({ video }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('verify-video', { video });
  });

  socket.on('reveal-request', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('reveal-request');
  });

  socket.on('reveal-response', ({ accepted }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('reveal-response', { accepted });
  });

  socket.on('switch-mode-request', ({ toMode }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('switch-mode-request', { toMode });
  });

  socket.on('switch-mode-response', ({ accepted, toMode }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('switch-mode-response', { accepted, toMode });
  });

  socket.on('voice-request', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('voice-request');
  });

  socket.on('voice-response', ({ accepted }) => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('voice-response', { accepted });
  });

  socket.on('voice-end', () => {
    const partnerId = pairs.get(socket.id);
    if (partnerId) io.to(partnerId).emit('voice-end');
  });

  // Fallback relay for voice messages — see the chat-message comment.
  // Forwards the audio to the partner untouched, stores nothing.
  socket.on('voice-message', ({ id, ts, audio }) => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId || typeof id !== 'string' || typeof audio !== 'string') return;
    io.to(partnerId).emit('voice-message', { id, ts: typeof ts === 'number' ? ts : Date.now(), audio });
  });

  const VALID_REPORT_REASONS = ['incorrect_gender', 'inappropriate', 'fraud', 'other'];
  socket.on('report', ({ reason, details }) => {
    const partnerId = pairs.get(socket.id);
    if (!partnerId) return;
    const reporterId = socketUser.get(socket.id);
    const reportedId = socketUser.get(partnerId);
    if (!reporterId || !reportedId) return;
    const safeReason = VALID_REPORT_REASONS.includes(reason) ? reason : 'other';

    (async () => {
      await db.addReport({ reporterId, reportedId, reason: safeReason, details: details ? String(details).slice(0, 500) : null });

      const autoBan = await db.getSetting('auto_ban_on_report', true);
      if (autoBan) {
        await db.banUser(reportedId);
        socket.emit('report-ack', { banned: true });
        const reportedSocketId = onlineUsers.get(reportedId);
        if (reportedSocketId) {
          io.to(reportedSocketId).emit('banned');
          disconnectPartner(reportedSocketId);
          removeFromQueues(reportedSocketId);
          io.sockets.sockets.get(reportedSocketId)?.disconnect(true);
        }
      } else {
        socket.emit('report-ack', { banned: false });
      }
    })().catch(e => console.error('report handler failed:', e));
  });

  // ---- Block / mute (real-time counterparts to the REST endpoints above,
  // used from the in-chat "more" (⋮) menu so a Block ends the live chat
  // immediately without waiting on a page refresh). ----
  socket.on('block-user', ({ userId: targetUserId } = {}) => {
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId || targetUserId === myUserId) return;
    (async () => {
      await db.blockUser(myUserId, targetUserId);
      await refreshBlockCache(myUserId);
      socket.emit('block-ack', { userId: targetUserId, blocked: true });
      const partnerSocketId = pairs.get(socket.id);
      if (partnerSocketId && socketUser.get(partnerSocketId) === targetUserId) {
        disconnectPartner(socket.id);
        removeFromQueues(socket.id);
      }
    })().catch(e => console.error('block-user failed:', e));
  });

  socket.on('unblock-user', ({ userId: targetUserId } = {}) => {
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId) return;
    (async () => {
      await db.unblockUser(myUserId, targetUserId);
      await refreshBlockCache(myUserId);
      socket.emit('block-ack', { userId: targetUserId, blocked: false });
    })().catch(e => console.error('unblock-user failed:', e));
  });

  socket.on('mute-user', ({ userId: targetUserId } = {}) => {
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId || targetUserId === myUserId) return;
    (async () => {
      await db.muteUser(myUserId, targetUserId);
      await refreshMuteCache(myUserId);
      socket.emit('mute-ack', { userId: targetUserId, muted: true });
    })().catch(e => console.error('mute-user failed:', e));
  });

  socket.on('unmute-user', ({ userId: targetUserId } = {}) => {
    const myUserId = socketUser.get(socket.id);
    if (!myUserId || !targetUserId) return;
    (async () => {
      await db.unmuteUser(myUserId, targetUserId);
      await refreshMuteCache(myUserId);
      socket.emit('mute-ack', { userId: targetUserId, muted: false });
    })().catch(e => console.error('unmute-user failed:', e));
  });

  socket.on('disconnect', () => {
    disconnectPartner(socket.id);
    removeFromQueues(socket.id);
    users.delete(socket.id);
    const userId = socketUser.get(socket.id);
    if (userId && onlineUsers.get(userId) === socket.id) onlineUsers.delete(userId);
    socketUser.delete(socket.id);
  });
});

const PORT = process.env.PORT || 3000;

// Wait for the Postgres schema to exist before accepting any traffic —
// otherwise the very first requests after a deploy could race the schema
// creation in db.js and fail.
db.ready.then(() => {
  server.listen(PORT, () => {
    console.log(`Random chat server running on port ${PORT}`);
  });
}).catch((e) => {
  console.error('Failed to start — database not ready:', e);
  process.exit(1);
});

// Flush any batched-but-not-yet-written DB updates before the process
// exits, so a deploy/restart never silently drops a queued write.
function gracefulShutdown() {
  db.flushPendingWrites()
    .catch(e => console.error('Flush on shutdown failed:', e))
    .finally(() => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
