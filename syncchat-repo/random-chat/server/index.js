require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');
const geoip = require('geoip-lite');
const db = require('./db');
const oauth = require('./oauth');
const { createStore } = require('./store');

// Shared state (matching queues, pairs, presence, sessions). In-memory by
// default (single instance, zero config); automatically Redis-backed with
// cross-instance Socket.io routing when REDIS_TCP_URL is set — that's what
// lets a fleet of instances act as one matchmaking network.
let store = null;

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

// ---- Sessions (token -> userId; in shared state so any instance can auth) ----
async function requireAuth(req, res, next) {
  try {
    const authHeader = req.headers.authorization || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    const userId = token && await store.getSession(token);
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

async function createSession(userId) {
  const token = crypto.randomUUID();
  await store.setSession(token, userId);
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
    const token = await createSession(user.id);
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
  const token = await createSession(user.id);
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
    matches.push({ ...db.publicUser(u), online: !!(await store.getOnline(u.id)), friendStatus });
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
      online: !!(await store.getOnline(partnerId)),
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
    const otherSocketId = await store.getOnline(otherId);
    if (otherSocketId) io.to(otherSocketId).emit('disappearing-changed', { conversationId: convo.id, mode });
    res.json({ mode });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.post('/api/history/delete-all', requireAuth, asyncRoute(async (req, res) => {
  const cleared = await db.deleteAllConversationsForUser(req.userId);
  for (const { id, otherUserId: otherId } of cleared) {
    const otherSocketId = await store.getOnline(otherId);
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
  const otherSocketId = await store.getOnline(otherId);
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
      partner: { ...db.publicUser(partner), online: !!(await store.getOnline(partnerId)) },
      reviews, summary, messages
    });
  }
  res.json({ partners });
}));

// ---- Block / mute (one-directional, act on the CURRENT user's list) ----
app.post('/api/users/:id/block', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't block yourself." });
  await db.blockUser(req.userId, req.params.id);
  await refreshBlockCache(req.userId);
  io.serverSideEmit('sc:invalidate-blocks', req.userId); // other instances refresh their cache
  // A block always ends any chat currently in progress with that person.
  const mySocketId = await store.getOnline(req.userId);
  if (mySocketId && await store.isPaired(mySocketId)) {
    const partnerSocketId = await store.getPartner(mySocketId);
    if (partnerSocketId && (await store.getSocketUser(partnerSocketId)) === req.params.id) {
      await disconnectPartner(mySocketId);
      await store.removeFromWaitingAll(mySocketId);
    }
  }
  res.json({ ok: true });
}));
app.post('/api/users/:id/unblock', requireAuth, asyncRoute(async (req, res) => {
  await db.unblockUser(req.userId, req.params.id);
  await refreshBlockCache(req.userId);
  io.serverSideEmit('sc:invalidate-blocks', req.userId);
  res.json({ ok: true });
}));
app.post('/api/users/:id/mute', requireAuth, asyncRoute(async (req, res) => {
  if (req.params.id === req.userId) return res.status(400).json({ error: "You can't mute yourself." });
  await db.muteUser(req.userId, req.params.id);
  await refreshMuteCache(req.userId);
  io.serverSideEmit('sc:invalidate-mutes', req.userId);
  res.json({ ok: true });
}));
app.post('/api/users/:id/unmute', requireAuth, asyncRoute(async (req, res) => {
  await db.unmuteUser(req.userId, req.params.id);
  await refreshMuteCache(req.userId);
  io.serverSideEmit('sc:invalidate-mutes', req.userId);
  res.json({ ok: true });
}));

// ---- Users: search + profile ----
app.get('/api/users/search', requireAuth, asyncRoute(async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 1) return res.json({ users: [] });
  const rows = await db.searchUsers(q, req.userId, 20);
  const users = [];
  for (const u of rows) {
    users.push({ ...db.publicUser(u), online: !!(await store.getOnline(u.id)), friendStatus: await db.friendStatusBetween(req.userId, u.id) });
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
      online: !!(await store.getOnline(user.id)),
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
  const suggestions = [];
  for (const u of raw) suggestions.push({ ...u, online: !!(await store.getOnline(u.id)) });
  res.json({ suggestions });
}));

// ---- Friends ----
app.get('/api/friends', requireAuth, asyncRoute(async (req, res) => {
  const ids = await db.listFriendIds(req.userId);
  const friends = [];
  for (const id of ids) {
    const u = await db.getUser(id);
    if (u) friends.push({ ...db.publicUser(u), online: !!(await store.getOnline(id)) });
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
// Everything below lives in the shared store (in-memory for a single
// instance, Redis for a fleet) — this is what lets multiple server
// instances act as one matchmaking network.

// In-memory mirrors of the blocks/mutes tables, keyed by userId, so the
// matching loop (which runs many times a second) never has to hit the DB.
// Populated on auth, kept fresh via refreshBlockCache/refreshMuteCache and
// cross-instance invalidation events (sc:invalidate-*).
const blockedByUser = new Map(); // userId -> Set(userIds they blocked)
const mutedByUser = new Map();   // userId -> Set(userIds they muted)

io.on('sc:invalidate-blocks', (userId) => { refreshBlockCache(String(userId)).catch(() => {}); });
io.on('sc:invalidate-mutes', (userId) => { refreshMuteCache(String(userId)).catch(() => {}); });

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

// Pairing must already be established in the store before this runs
// (claimPair for queue matches, pairDirect for friend-calls/resumes).
async function startConversation(socketIdA, socketIdB, resumed, conversationId) {
  const userIdA = await store.getSocketUser(socketIdA);
  const userIdB = await store.getSocketUser(socketIdB);
  const convo = conversationId
    ? await db.getConversation(conversationId)
    : (userIdA && userIdB ? await db.findOrCreateConversation(userIdA, userIdB) : null);
  if (convo) {
    await store.setSocketConv(socketIdA, convo.id);
    await store.setSocketConv(socketIdB, convo.id);
    await store.joinConversation(convo.id, socketIdA);
    await store.joinConversation(convo.id, socketIdB);
  }

  const roomId = crypto.randomUUID();
  const userA = await store.getEntry(socketIdA);
  const userB = await store.getEntry(socketIdB);
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

  // Rooms are a local-instance convenience only; all routing goes via
  // socket ids, which the Redis adapter delivers cross-instance.
  io.sockets.sockets.get(socketIdA)?.join(roomId);
  io.sockets.sockets.get(socketIdB)?.join(roomId);
}

async function tryMatch(socketId) {
  const entry = await store.getEntry(socketId);
  if (!entry) return false;
  if (await store.isPaired(socketId)) return false;
  if (!entry.queuedAt) { entry.queuedAt = Date.now(); await store.setEntry(socketId, entry); }

  const now = Date.now();
  const candidates = await store.sampleWaiting(oppositeOf(entry.gender), 25);

  for (const candidateId of candidates) {
    if (candidateId === socketId) continue;
    const candidateEntry = await store.getEntry(candidateId);
    if (!candidateEntry || await store.isPaired(candidateId)) {
      await store.removeFromWaitingAll(candidateId);
      continue;
    }
    if (!usersCompatible(entry, candidateEntry, now)) continue;
    const myUserId = await store.getSocketUser(socketId);
    const theirUserId = await store.getSocketUser(candidateId);
    if (isBlockedPairSync(myUserId, theirUserId)) continue;

    // Atomic across instances: exactly one matcher wins this pair.
    const claimed = await store.claimPair(socketId, candidateId);
    if (!claimed) continue;
    startConversation(socketId, candidateId, false, null).catch(e => console.error('startConversation failed:', e));
    return true;
  }

  await store.addToWaiting(entry.gender, socketId);
  return false;
}

// Periodic rematch sweep — safe to run on every instance simultaneously
// (claimPair is atomic), so paired-up stragglers get picked up no matter
// which node they're connected to.
setInterval(async () => {
  try {
    for (const gender of ['male', 'female']) {
      const queued = await store.sampleWaiting(gender, 100);
      for (const socketId of queued) {
        if (await store.isPaired(socketId)) continue;
        await tryMatch(socketId);
      }
    }
  } catch (e) {
    console.error('match sweep failed:', e);
  }
}, 5000);

// Housekeeping: legacy 24h-disappearing message rows, plus ID-only
// tombstones (kept for 7 days so an offline partner has time to come
// back and apply pending deletions, then dropped).
setInterval(async () => {
  try {
    const cleared = await db.sweepExpiredMessages();
    for (const { conversationId, id } of cleared) {
      for (const socketId of await store.getConversationSockets(conversationId)) {
        io.to(socketId).emit('message-deleted', { messageId: id });
      }
    }
    await db.pruneTombstones(7 * 24 * 60 * 60 * 1000);
  } catch (e) {
    console.error('sweep failed:', e);
  }
}, 60 * 1000);

async function disconnectPartner(socketId) {
  const convId = await store.getSocketConv(socketId);
  if (convId) await store.leaveConversation(convId, socketId);
  const partnerId = await store.unpair(socketId);
  if (partnerId) {
    io.to(partnerId).emit('partner-left');
    const partnerConv = await store.getSocketConv(partnerId);
    if (partnerConv) await store.leaveConversation(partnerConv, partnerId);
    await store.delSocketConv(partnerId);
  }
  await store.delSocketConv(socketId);
}

io.on('connection', (socket) => {

  socket.on('auth', ({ token }) => {
    (async () => {
      const userId = await store.getSession(token);
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
      await store.setSocketUser(socket.id, userId);
      await store.setOnline(userId, socket.id);
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
    (async () => {
      await store.setEntry(socket.id, buildEntry(gender, lookingFor, { countryMode, country, lat, lon }));
      await store.removeFromWaitingAll(socket.id);
      await disconnectPartner(socket.id);
      await tryMatch(socket.id);
    })().catch(e => console.error('find-partner failed:', e));
  });

  socket.on('set-country-mode', ({ countryMode, country, lat, lon }) => {
    (async () => {
      const entry = await store.getEntry(socket.id);
      if (!entry) return;
      const mode = VALID_COUNTRY_MODES.includes(countryMode) ? countryMode : 'random';
      entry.countryMode = mode;
      entry.country = mode === 'country' && typeof country === 'string' ? country.toUpperCase().slice(0, 2) : null;
      entry.lat = mode === 'nearby' && typeof lat === 'number' ? lat : null;
      entry.lon = mode === 'nearby' && typeof lon === 'number' ? lon : null;
      await store.setEntry(socket.id, entry);
      if (!await store.isPaired(socket.id)) await tryMatch(socket.id);
    })().catch(e => console.error('set-country-mode failed:', e));
  });

  socket.on('call-friend', ({ friendUserId }) => {
    (async () => {
      const myUserId = await store.getSocketUser(socket.id);
      if (!myUserId) return socket.emit('call-failed', { reason: 'not-authenticated' });
      if (!friendUserId || !await db.areFriends(myUserId, friendUserId)) {
        return socket.emit('call-failed', { reason: 'not-friends' });
      }
      // Presence is shared across instances, so the friend can be online
      // on a different server than us — io.to() still reaches them.
      const friendSocketId = await store.getOnline(friendUserId);
      if (!friendSocketId) return socket.emit('call-failed', { reason: 'offline' });
      if (await store.isPaired(socket.id) || await store.isPaired(friendSocketId)) {
        return socket.emit('call-failed', { reason: 'busy' });
      }

      const myUser = await db.getUser(myUserId);
      const friendUser = await db.getUser(friendUserId);
      await store.removeFromWaitingAll(socket.id);
      await store.removeFromWaitingAll(friendSocketId);
      await store.setEntry(socket.id, buildEntry(myUser.gender, friendUser.gender));
      await store.setEntry(friendSocketId, buildEntry(friendUser.gender, myUser.gender));
      await store.pairDirect(socket.id, friendSocketId);
      const convo = await db.findOrCreateConversation(myUserId, friendUserId);
      await startConversation(socket.id, friendSocketId, false, convo.id);
    })().catch(e => { console.error('call-friend failed:', e); socket.emit('call-failed', { reason: 'server-error' }); });
  });

  socket.on('skip', () => {
    (async () => {
      await disconnectPartner(socket.id);
      await store.removeFromWaitingAll(socket.id);
      const entry = await store.getEntry(socket.id);
      if (entry) { entry.queuedAt = Date.now(); await store.setEntry(socket.id, entry); }
      await tryMatch(socket.id);
    })().catch(e => console.error('skip failed:', e));
  });

  socket.on('cancel-search', () => {
    store.removeFromWaitingAll(socket.id).catch(() => {});
  });

  socket.on('leave-chat', () => {
    (async () => {
      await disconnectPartner(socket.id);
      await store.removeFromWaitingAll(socket.id);
    })().catch(e => console.error('leave-chat failed:', e));
  });

  socket.on('resume-chat', ({ conversationId }) => {
    (async () => {
      const myUserId = await store.getSocketUser(socket.id);
      if (!myUserId) return;
      const convo = await db.getConversation(conversationId);
      if (!convo || !userInConversation(convo, myUserId)) {
        socket.emit('resume-failed', { reason: 'not-found' });
        return;
      }
      const partnerId = db.otherUserId(convo, myUserId);
      const partnerSocketId = await store.getOnline(partnerId);
      if (!partnerSocketId) {
        socket.emit('resume-failed', { reason: 'offline' });
        return;
      }
      if (await store.isPaired(socket.id) || await store.isPaired(partnerSocketId)) {
        socket.emit('resume-failed', { reason: 'busy' });
        return;
      }
      const partnerUser = await db.getUser(partnerId);
      const myUser = await db.getUser(myUserId);
      await store.removeFromWaitingAll(socket.id);
      await store.removeFromWaitingAll(partnerSocketId);
      await store.setEntry(socket.id, buildEntry(myUser.gender, partnerUser.gender));
      await store.setEntry(partnerSocketId, buildEntry(partnerUser.gender, myUser.gender));
      await store.pairDirect(socket.id, partnerSocketId);
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
    (async () => {
      const partnerId = await store.getPartner(socket.id);
      if (!partnerId) return;
      io.to(partnerId).emit('chat-message', {
        id, ts: typeof ts === 'number' ? ts : Date.now(), text: trimmed,
        replyTo: replyTo && typeof replyTo.id === 'string' ? { id: replyTo.id, text: typeof replyTo.text === 'string' ? replyTo.text.slice(0, 200) : null } : null
      });
    })().catch(e => console.error('chat-message relay failed:', e));
  });

  // Content-free activity ping, sent once per message the client sends
  // (over whichever transport). Carries only the message TYPE so the
  // partner's chat list can show unread badges, ordering and a generic
  // "Message" / "Voice message" preview — never the content itself.
  socket.on('conv-activity', ({ type }) => {
    (async () => {
      const convId = await store.getSocketConv(socket.id);
      const senderId = await store.getSocketUser(socket.id);
      if (!convId || !senderId) return;
      await db.noteConversationActivity(convId, senderId, type === 'voice' ? 'voice' : 'text');
    })().catch(e => console.error('conv-activity failed:', e));
  });

  socket.on('delete-message', ({ messageId, mode }) => {
    if (typeof messageId !== 'string') return;
    (async () => {
      const userId = await store.getSocketUser(socket.id);
      if (!userId) return;
      const convId = await store.getSocketConv(socket.id);
      const partnerId = await store.getPartner(socket.id);
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
    (async () => {
      const convId = await store.getSocketConv(socket.id);
      if (!convId) return;
      const partnerId = await store.getPartner(socket.id);
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
    (async () => {
      const convId = await store.getSocketConv(socket.id);
      const userId = await store.getSocketUser(socket.id);
      if (!convId || !userId) return;
      await db.clearUnread(convId, userId);
    })().catch(e => console.error('mark-seen failed:', e));
  });

  // WebRTC signaling relay
  socket.on('webrtc-offer', async (payload) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-offer', payload);
  });

  socket.on('webrtc-answer', async (payload) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-answer', payload);
  });

  socket.on('webrtc-ice-candidate', async (payload) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('webrtc-ice-candidate', payload);
  });

  socket.on('verify-request', async () => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('verify-request');
  });

  // One side viewing the other's profile mid-video-call — tell the other
  // side so it can blur its view of the departed person's video feed.
  socket.on('viewing-profile', async (payload) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('partner-viewing-profile', { viewing: !!(payload && payload.viewing) });
  });

  socket.on('verify-video', async ({ video }) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('verify-video', { video });
  });

  socket.on('reveal-request', async () => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('reveal-request');
  });

  socket.on('reveal-response', async ({ accepted }) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('reveal-response', { accepted });
  });

  socket.on('switch-mode-request', async ({ toMode }) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('switch-mode-request', { toMode });
  });

  socket.on('switch-mode-response', async ({ accepted, toMode }) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('switch-mode-response', { accepted, toMode });
  });

  socket.on('voice-request', async () => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('voice-request');
  });

  socket.on('voice-response', async ({ accepted }) => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('voice-response', { accepted });
  });

  socket.on('voice-end', async () => {
    const partnerId = await store.getPartner(socket.id);
    if (partnerId) io.to(partnerId).emit('voice-end');
  });

  // Fallback relay for voice messages — see the chat-message comment.
  // Forwards the audio to the partner untouched, stores nothing.
  socket.on('voice-message', async ({ id, ts, audio }) => {
    const partnerId = await store.getPartner(socket.id);
    if (!partnerId || typeof id !== 'string' || typeof audio !== 'string') return;
    io.to(partnerId).emit('voice-message', { id, ts: typeof ts === 'number' ? ts : Date.now(), audio });
  });

  const VALID_REPORT_REASONS = ['incorrect_gender', 'inappropriate', 'fraud', 'other'];
  socket.on('report', async ({ reason, details }) => {
    const partnerId = await store.getPartner(socket.id);
    if (!partnerId) return;
    const reporterId = await store.getSocketUser(socket.id);
    const reportedId = await store.getSocketUser(partnerId);
    if (!reporterId || !reportedId) return;
    const safeReason = VALID_REPORT_REASONS.includes(reason) ? reason : 'other';

    (async () => {
      await db.addReport({ reporterId, reportedId, reason: safeReason, details: details ? String(details).slice(0, 500) : null });

      const autoBan = await db.getSetting('auto_ban_on_report', true);
      if (autoBan) {
        await db.banUser(reportedId);
        socket.emit('report-ack', { banned: true });
        const reportedSocketId = await store.getOnline(reportedId);
        if (reportedSocketId) {
          io.to(reportedSocketId).emit('banned');
          await disconnectPartner(reportedSocketId);
          await store.removeFromWaitingAll(reportedSocketId);
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
    (async () => {
      const myUserId = await store.getSocketUser(socket.id);
      if (!myUserId || !targetUserId || targetUserId === myUserId) return;
      await db.blockUser(myUserId, targetUserId);
      await refreshBlockCache(myUserId);
      io.serverSideEmit('sc:invalidate-blocks', myUserId);
      socket.emit('block-ack', { userId: targetUserId, blocked: true });
      const partnerSocketId = await store.getPartner(socket.id);
      if (partnerSocketId && (await store.getSocketUser(partnerSocketId)) === targetUserId) {
        await disconnectPartner(socket.id);
        await store.removeFromWaitingAll(socket.id);
      }
    })().catch(e => console.error('block-user failed:', e));
  });

  socket.on('unblock-user', ({ userId: targetUserId } = {}) => {
    (async () => {
      const myUserId = await store.getSocketUser(socket.id);
      if (!myUserId || !targetUserId) return;
      await db.unblockUser(myUserId, targetUserId);
      await refreshBlockCache(myUserId);
      io.serverSideEmit('sc:invalidate-blocks', myUserId);
      socket.emit('block-ack', { userId: targetUserId, blocked: false });
    })().catch(e => console.error('unblock-user failed:', e));
  });

  socket.on('mute-user', ({ userId: targetUserId } = {}) => {
    (async () => {
      const myUserId = await store.getSocketUser(socket.id);
      if (!myUserId || !targetUserId || targetUserId === myUserId) return;
      await db.muteUser(myUserId, targetUserId);
      await refreshMuteCache(myUserId);
      io.serverSideEmit('sc:invalidate-mutes', myUserId);
      socket.emit('mute-ack', { userId: targetUserId, muted: true });
    })().catch(e => console.error('mute-user failed:', e));
  });

  socket.on('unmute-user', ({ userId: targetUserId } = {}) => {
    (async () => {
      const myUserId = await store.getSocketUser(socket.id);
      if (!myUserId || !targetUserId) return;
      await db.unmuteUser(myUserId, targetUserId);
      await refreshMuteCache(myUserId);
      io.serverSideEmit('sc:invalidate-mutes', myUserId);
      socket.emit('mute-ack', { userId: targetUserId, muted: false });
    })().catch(e => console.error('unmute-user failed:', e));
  });

  socket.on('disconnect', () => {
    (async () => {
      const userId = await store.getSocketUser(socket.id);
      await disconnectPartner(socket.id);
      await store.removeFromWaitingAll(socket.id);
      await store.delEntry(socket.id);
      if (userId) await store.clearOnlineIf(userId, socket.id);
      await store.delSocketUser(socket.id);
    })().catch(e => console.error('disconnect cleanup failed:', e));
  });
});

const PORT = process.env.PORT || 3000;

// Wait for the Postgres schema AND the shared state store before accepting
// any traffic — otherwise the very first requests after a deploy could race
// initialization and fail.
(async () => {
  store = await createStore(io); // in-memory by default; Redis + cross-instance adapter when REDIS_TCP_URL is set
  await db.ready;
  server.listen(PORT, () => {
    console.log(`Random chat server running on port ${PORT} (store: ${store.kind})`);
  });
})().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});

// Flush any batched-but-not-yet-written DB updates before the process
// exits, so a deploy/restart never silently drops a queued write.
function gracefulShutdown() {
  db.flushPendingWrites()
    .catch(e => console.error('Flush on shutdown failed:', e))
    .finally(async () => {
      try { store && await store.close(); } catch {}
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 3000).unref();
    });
}
process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
