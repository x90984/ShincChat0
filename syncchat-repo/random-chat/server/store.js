// ============================================================================
// Shared state store — the piece that makes ShincChat horizontally scalable.
//
// Two implementations behind one async interface:
//
//   memory (default, zero-config, $0):
//     All matching state lives in this process. Perfect for a single
//     server instance on a free tier — thousands of concurrent users.
//
//   redis (set REDIS_TCP_URL, e.g. Upstash TLS / Oracle free Redis):
//     Matching queues, pairs, presence and sessions are shared across
//     EVERY server instance, and the Socket.io Redis adapter (attached
//     automatically in the same mode) routes events between instances.
//     Add as many cheap Node instances behind a load balancer as you
//     need — content still flows peer-to-peer between devices, so each
//     extra instance buys you tens of thousands more concurrent users.
// ============================================================================
const { createClient } = require('redis');

const SESSION_TTL_SEC = 7 * 24 * 60 * 60;

// ---------------------------------------------------------------------------
// In-memory implementation (single node)
// ---------------------------------------------------------------------------
function createMemoryStore() {
  const sessions = new Map();      // token -> { userId, expiresAt }
  const socketUser = new Map();    // socketId -> userId
  const online = new Map();        // userId -> socketId
  const entries = new Map();       // socketId -> matching entry
  const waiting = { male: new Set(), female: new Set() };
  const pairs = new Map();         // socketId -> partnerSocketId (both directions)
  const socketConv = new Map();    // socketId -> conversationId
  const convSockets = new Map();   // conversationId -> Set(socketId)

  return {
    kind: 'memory',
    ready: Promise.resolve(),
    clients: null,

    async setSession(token, userId) {
      sessions.set(token, { userId, expiresAt: Date.now() + SESSION_TTL_SEC * 1000 });
    },
    async getSession(token) {
      const rec = sessions.get(token);
      if (!rec) return null;
      if (rec.expiresAt <= Date.now()) { sessions.delete(token); return null; }
      return rec.userId;
    },
    async delSession(token) { sessions.delete(token); },

    async setSocketUser(socketId, userId) { socketUser.set(socketId, userId); },
    async getSocketUser(socketId) { return socketUser.get(socketId) || null; },
    async delSocketUser(socketId) { socketUser.delete(socketId); },

    async setOnline(userId, socketId) { online.set(userId, socketId); },
    async getOnline(userId) { return online.get(userId) || null; },
    async clearOnlineIf(userId, socketId) {
      if (online.get(userId) === socketId) online.delete(userId);
    },

    async setEntry(socketId, entry) { entries.set(socketId, entry); },
    async getEntry(socketId) { return entries.get(socketId) || null; },
    async delEntry(socketId) { entries.delete(socketId); },

    async addToWaiting(gender, socketId) {
      if (pairs.has(socketId)) return;
      waiting[gender] && waiting[gender].add(socketId);
    },
    async removeFromWaitingAll(socketId) {
      waiting.male.delete(socketId);
      waiting.female.delete(socketId);
    },
    async sampleWaiting(gender, limit) {
      const set = waiting[gender];
      if (!set) return [];
      const out = [];
      for (const id of set) { out.push(id); if (out.length >= limit) break; }
      return out;
    },

    // Atomically pair two sockets (never steals an existing pairing) and
    // remove both from the waiting queues.
    async claimPair(a, b) {
      if (pairs.has(a) || pairs.has(b)) return false;
      pairs.set(a, b);
      pairs.set(b, a);
      waiting.male.delete(a); waiting.male.delete(b);
      waiting.female.delete(a); waiting.female.delete(b);
      return true;
    },
    // Unconditional pair (used by friend-calls / resume after their own
    // busy-checks).
    async pairDirect(a, b) {
      pairs.set(a, b);
      pairs.set(b, a);
      waiting.male.delete(a); waiting.male.delete(b);
      waiting.female.delete(a); waiting.female.delete(b);
    },
    async getPartner(socketId) { return pairs.get(socketId) || null; },
    async isPaired(socketId) { return pairs.has(socketId); },
    async unpair(socketId) {
      const partner = pairs.get(socketId) || null;
      pairs.delete(socketId);
      if (partner) pairs.delete(partner);
      return partner;
    },

    async setSocketConv(socketId, convId) { socketConv.set(socketId, convId); },
    async getSocketConv(socketId) { return socketConv.get(socketId) || null; },
    async delSocketConv(socketId) { socketConv.delete(socketId); },

    async joinConversation(convId, socketId) {
      if (!convSockets.has(convId)) convSockets.set(convId, new Set());
      convSockets.get(convId).add(socketId);
    },
    async leaveConversation(convId, socketId) {
      const set = convSockets.get(convId);
      if (set) { set.delete(socketId); if (!set.size) convSockets.delete(convId); }
    },
    async getConversationSockets(convId) {
      return [...(convSockets.get(convId) || [])];
    },

    async close() {}
  };
}

// ---------------------------------------------------------------------------
// Redis implementation (multi-node / elastic)
// ---------------------------------------------------------------------------
const LUA_CLAIM_PAIR = `
local a, b = KEYS[1], KEYS[2]
if redis.call('EXISTS', a) == 1 or redis.call('EXISTS', b) == 1 then return 0 end
redis.call('SET', a, ARGV[1])
redis.call('SET', b, ARGV[2])
redis.call('SREM', KEYS[3], ARGV[3], ARGV[4])
redis.call('SREM', KEYS[4], ARGV[3], ARGV[4])
return 1
`;

const LUA_UNPAIR = `
local partner = redis.call('GET', KEYS[1])
redis.call('DEL', KEYS[1])
if partner then
  redis.call('DEL', ARGV[2] .. partner)
  redis.call('SREM', KEYS[2], ARGV[1], partner)
  redis.call('SREM', KEYS[3], ARGV[1], partner)
end
return partner or ''
`;

const LUA_ADD_WAITING = `
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SADD', KEYS[1], ARGV[1])
return 1
`;

const LUA_CLEAR_ONLINE_IF = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
end
return 1
`;

function createRedisStore(url) {
  const client = createClient({ url });
  client.on('error', (e) => console.error('Redis store error:', e.message));
  const P = 'sc:'; // key prefix
  const waitKey = (g) => `${P}wait:${g}`;
  const pairKey = (s) => `${P}pair:${s}`;

  const store = {
    kind: 'redis',
    clients: { main: client },
    ready: client.connect(),

    async setSession(token, userId) { await client.set(`${P}sess:${token}`, userId, { EX: SESSION_TTL_SEC }); },
    async getSession(token) { return client.get(`${P}sess:${token}`); },
    async delSession(token) { await client.del(`${P}sess:${token}`); },

    async setSocketUser(socketId, userId) { await client.set(`${P}su:${socketId}`, userId, { EX: 86400 }); },
    async getSocketUser(socketId) { return client.get(`${P}su:${socketId}`); },
    async delSocketUser(socketId) { await client.del(`${P}su:${socketId}`); },

    async setOnline(userId, socketId) { await client.set(`${P}online:${userId}`, socketId); },
    async getOnline(userId) { return client.get(`${P}online:${userId}`); },
    async clearOnlineIf(userId, socketId) {
      await client.eval(LUA_CLEAR_ONLINE_IF, { keys: [`${P}online:${userId}`], arguments: [socketId] });
    },

    async setEntry(socketId, entry) { await client.set(`${P}entry:${socketId}`, JSON.stringify(entry), { EX: 6 * 3600 }); },
    async getEntry(socketId) {
      const raw = await client.get(`${P}entry:${socketId}`);
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { return null; }
    },
    async delEntry(socketId) { await client.del(`${P}entry:${socketId}`); },

    async addToWaiting(gender, socketId) {
      await client.eval(LUA_ADD_WAITING, { keys: [waitKey(gender), pairKey(socketId)], arguments: [socketId] });
    },
    async removeFromWaitingAll(socketId) {
      await client.sRem([waitKey('male'), waitKey('female')], socketId);
    },
    async sampleWaiting(gender, limit) {
      const out = await client.sRandMember(waitKey(gender), { COUNT: limit });
      if (!out) return [];
      return Array.isArray(out) ? out : [out];
    },

    async claimPair(a, b) {
      const ok = await client.eval(LUA_CLAIM_PAIR, {
        keys: [pairKey(a), pairKey(b), waitKey('male'), waitKey('female')],
        arguments: [b, a, a, b]
      });
      return ok === 1;
    },
    async pairDirect(a, b) {
      await client.multi()
        .set(pairKey(a), b)
        .set(pairKey(b), a)
        .sRem(waitKey('male'), [a, b])
        .sRem(waitKey('female'), [a, b])
        .exec();
    },
    async getPartner(socketId) { return client.get(pairKey(socketId)); },
    async isPaired(socketId) { return (await client.exists(pairKey(socketId))) > 0; },
    async unpair(socketId) {
      const partner = await client.eval(LUA_UNPAIR, {
        keys: [pairKey(socketId), waitKey('male'), waitKey('female')],
        arguments: [socketId, P + 'pair:']
      });
      return partner || null;
    },

    async setSocketConv(socketId, convId) { await client.set(`${P}conv:${socketId}`, convId, { EX: 86400 }); },
    async getSocketConv(socketId) { return client.get(`${P}conv:${socketId}`); },
    async delSocketConv(socketId) { await client.del(`${P}conv:${socketId}`); },

    async joinConversation(convId, socketId) { await client.sAdd(`${P}convs:${convId}`, socketId); },
    async leaveConversation(convId, socketId) { await client.sRem(`${P}convs:${convId}`, socketId); },
    async getConversationSockets(convId) { return client.sMembers(`${P}convs:${convId}`); },

    async close() { try { await client.quit(); } catch {} }
  };
  return store;
}

// ---------------------------------------------------------------------------
// Factory — picks the implementation from the environment, and (in Redis
// mode) attaches the Socket.io Redis adapter so events route between all
// server instances automatically.
// ---------------------------------------------------------------------------
async function createStore(io) {
  const url = process.env.REDIS_TCP_URL;
  if (!url) {
    console.log('State store: in-memory (single instance). Set REDIS_TCP_URL to run multiple instances.');
    return createMemoryStore();
  }

  const store = createRedisStore(url);
  await store.ready;

  // Cross-instance event routing: the pub/sub pair the adapter needs must
  // be dedicated connections, separate from the store's own client.
  const { createAdapter } = require('@socket.io/redis-adapter');
  const pub = createClient({ url });
  const sub = pub.duplicate();
  pub.on('error', (e) => console.error('Redis adapter (pub) error:', e.message));
  sub.on('error', (e) => console.error('Redis adapter (sub) error:', e.message));
  await Promise.all([pub.connect(), sub.connect()]);
  io.adapter(createAdapter(pub, sub));
  store.clients.pub = pub;
  store.clients.sub = sub;

  console.log('State store: Redis (multi-instance mode, Socket.io adapter attached).');
  return store;
}

module.exports = { createStore, createMemoryStore, createRedisStore };
