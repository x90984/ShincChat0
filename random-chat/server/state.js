// ============================================================================
// Shared realtime state — the piece that decides whether ShincChat can run
// on more than one process.
//
// Everything that used to live in Maps at the bottom of index.js (presence,
// pairs, matching queues, per-user block/mute mirrors) moved here, behind
// one interface with two backends:
//
//   memory — single process (local dev, free single-dyno deploys). The
//            matching semantics are exactly the old ones.
//   redis  — any number of processes/machines (REDIS_URL). Queues become
//            per-gender × per-bucket sorted sets (member = socket id,
//            payload in a hash), pairing is an atomic Lua claim,
//            presence/pairs expire by TTL so a crashed worker self-heals,
//            and the socket.io Redis adapter carries emits between nodes.
//
// Matching rules preserved from the original implementation:
//   - candidates are the opposite gender, FIFO by time queued
//   - 'india'/'country' modes: same-country only for COUNTRY_STRICT_MS, then anyone
//   - 'nearby': within NEARBY_RADIUS_KM for NEARBY_STRICT_MS, then same country
//     until NEARBY_COUNTRY_MS, then anyone
//   - blocked pairs (either direction) never match
//   - small queues scan EVERY bucket (exactly the original full scan); the
//     bucket pre-filter only kicks in above SMALL_QUEUE_SCAN (a rare
//     cross-chosen-country pair then waits for scope widening instead)
// ============================================================================
'use strict';

const crypto = require('crypto');
const { Redis } = require('ioredis');

// ---- Matching semantics (shared with index.js) ---------------------------
const VALID_COUNTRY_MODES = ['nearby', 'india', 'random', 'country'];
const NEARBY_RADIUS_KM = 100;
const NEARBY_STRICT_MS = 10_000;
const NEARBY_COUNTRY_MS = 25_000;
const COUNTRY_STRICT_MS = 20_000;
const SMALL_QUEUE_SCAN = 500; // below this many waiting per gender, scan everything

function haversineKm(lat1, lon1, lat2, lon2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

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

function oppositeOf(gender) {
  return gender === 'male' ? 'female' : 'male';
}

/** Which queue bucket an entry belongs in *right now* ('ANY' or a country). */
function bucketOf(entry, now) {
  const scope = currentScope(entry, now - entry.queuedAt);
  if (scope.type === 'any') return 'ANY';
  if (scope.type === 'country') return scope.country;
  return entry.detectedCountry || 'ANY'; // nearby → country bucket as a pre-filter
}

// ---- Redis keys ------------------------------------------------------------
const K = {
  live: (s) => `sc:live:${s}`,
  presence: (u) => `sc:presence:${u}`,
  pair: (s) => `sc:pair:${s}`,
  qentry: (s) => `sc:qentry:${s}`,
  queue: (gender, bucket) => `sc:q:${gender}:${bucket}`,
  convSockets: (c) => `sc:conv:${c}`,
  sweepLock: 'sc:lock:sweep',
  pairsGauge: 'sc:gauge:pairs'
};

const LIVE_TTL_SEC = 15 * 60;   // refreshed by heartbeat; a crashed worker's sockets expire within this
const PAIR_TTL_SEC = 5 * 60;    // refreshed by heartbeat; partner loss detected within this
const QENTRY_TTL_SEC = 24 * 60 * 60;
const CONV_TTL_SEC = 24 * 60 * 60;

// Atomic pairing claim. Guards, in order: neither side may already be
// paired; the candidate must still be live; the candidate must still be in
// the bucket the seeker scanned (else another node claimed or the sweeper
// re-bucketed them — retry next round).
//   KEYS: pair:me, pair:cand, live:cand, pairsGauge, qKey_cand, qentry:cand,
//         qKey_me (only touched when ARGV[1] is non-empty), qentry:me
const CLAIM_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[3]) == 0 then return 0 end
if redis.call('ZREM', KEYS[5], ARGV[3]) == 0 then return 0 end
redis.call('HDEL', KEYS[6], 'e')
if ARGV[1] ~= '' then
  redis.call('ZREM', KEYS[7], ARGV[1])
  redis.call('HDEL', KEYS[8], 'e')
end
redis.call('SET', KEYS[1], ARGV[4], 'EX', ARGV[6])
redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[6])
redis.call('INCR', KEYS[4])
return 1
`;

// Pair two specific sockets (friend calls / resume-chat — no queue involved).
//   KEYS: pair:a, pair:b, pairsGauge
const PAIRUP_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
if redis.call('EXISTS', KEYS[2]) == 1 then return 0 end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[3])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('INCR', KEYS[3])
return 1
`;

// Tear down one side of a pair ATOMICALLY. Both sides of a pair can hit
// endPair at the same moment (mass disconnect, both users skip at once) —
// with separate GET/DEL/DECR round-trips both would see their own key and
// both would decrement the gauge. Here, exactly one caller wins.
//   KEYS: pair:me, pair:partner, pairsGauge, convSocketSet (or 'sc:noop')
//   ARGV: mySocketId, partnerSocketId
const ENDPAIR_SCRIPT = `
if redis.call('GET', KEYS[1]) == false then return 0 end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
redis.call('SREM', KEYS[4], ARGV[1], ARGV[2])
redis.call('DECR', KEYS[3])
return 1
`;

// ============================================================================
// The state manager
// ============================================================================
const state = {
  io: null,
  backend: 'memory',
  redis: null,          // ioredis client when backend === 'redis'
  loaders: null,        // { blocked(userId)->ids, muted(userId)->ids } from db
  sweepTimer: null,
  _blockCache: new Map(),   // userId -> { set, expires }
  _muteCache: new Map(),
  _queueKeyCache: []        // bucket keys seen recently (redis scan cache)
};

// -- memory backend storage --------------------------------------------------
const mem = {
  entries: new Map(),      // socketId -> entry
  queues: new Map(),       // `${gender}:${bucket}` -> Map(socketId -> entry)
  pairs: new Map(),        // socketId -> { partnerSocketId, convId, roomId, userId }
  presence: new Map(),     // userId -> socketId
  live: new Set(),         // socketIds currently connected (this process)
  convSockets: new Map()   // convId -> Set(socketId)
};

function memQueue(gender, bucket) {
  const key = `${gender}:${bucket}`;
  let q = mem.queues.get(key);
  if (!q) { q = new Map(); mem.queues.set(key, q); }
  return q;
}

// ============================================================================
// Init / shutdown
// ============================================================================
state.init = async function init(io, { redisUrl = process.env.REDIS_URL, loaders, onMatch } = {}) {
  state.io = io;
  state.loaders = loaders || null;
  // Called when the periodic sweep forms a pair (arrival-driven matches are
  // handled by the caller of tryMatch directly). Signature:
  //   onMatch(seekerEntry, partnerEntry, partnerSocketId)
  // If it throws, the pair is unwound and both sides re-queued.
  state.onMatch = onMatch || null;
  if (redisUrl) {
    state.redis = new Redis(redisUrl, { maxRetriesPerRequest: 3 });
    state.redis.on('error', (e) => console.error('Redis error (state):', e.message));
    await state.redis.ping().catch((e) => {
      throw new Error(`Cannot reach Redis at REDIS_URL: ${e.message}`);
    });
    state.backend = 'redis';
    require('./cache').useSharedRedis(state.redis);
  }
  state.sweepTimer = setInterval(() => state.sweep().catch((e) => console.error('sweep failed:', e.message)), 5000);
  state.sweepTimer.unref();
};

state.close = function close() {
  if (state.sweepTimer) clearInterval(state.sweepTimer);
  if (state.redis) { try { state.redis.disconnect(); } catch (e) { /* already closed */ } }
};

// ============================================================================
// Block / mute mirrors (TTL-bounded caches over db loaders; matching reads
// these hot, so they must not hit Postgres per candidate).
// ============================================================================
async function cachedSet(cache, userId, loader) {
  const hit = cache.get(userId);
  if (hit && hit.expires > Date.now()) return hit.set;
  const ids = await loader(userId);
  const set = new Set(ids);
  cache.set(userId, { set, expires: Date.now() + 60_000 });
  return set;
}
state.blockedSet = (userId) => cachedSet(state._blockCache, userId, (id) => state.loaders.blocked(id));
state.mutedSet = (userId) => cachedSet(state._muteCache, userId, (id) => state.loaders.muted(id));
state.invalidateBlocks = (userId) => { state._blockCache.delete(userId); };
state.invalidateMutes = (userId) => { state._muteCache.delete(userId); };

state.isBlockedPair = async function isBlockedPair(a, b) {
  if (!a || !b) return false;
  const [aBlocks, bBlocks] = await Promise.all([state.blockedSet(a), state.blockedSet(b)]);
  return aBlocks.has(b) || bBlocks.has(a);
};

// ============================================================================
// Presence
// ============================================================================
state.bindUser = async function bindUser(socketId, userId) {
  if (state.backend === 'redis') {
    await state.redis.multi()
      .set(K.live(socketId), '1', 'EX', LIVE_TTL_SEC)
      .set(K.presence(userId), socketId, 'EX', LIVE_TTL_SEC)
      .exec();
  } else {
    mem.live.add(socketId);
    mem.presence.set(userId, socketId);
  }
};

state.unbindUser = async function unbindUser(socketId, userId) {
  if (state.backend === 'redis') {
    const current = await state.redis.get(K.presence(userId));
    const multi = state.redis.multi().del(K.live(socketId));
    if (current === socketId) multi.del(K.presence(userId));
    await multi.exec();
  } else {
    mem.live.delete(socketId);
    if (mem.presence.get(userId) === socketId) mem.presence.delete(userId);
  }
};

state.socketOf = async function socketOf(userId) {
  if (state.backend === 'redis') return await state.redis.get(K.presence(userId));
  return mem.presence.get(userId) || null;
};

state.isOnline = async function isOnline(userId) {
  return (await state.socketOf(userId)) != null;
};

/** Batch presence for REST lists (history, friends, search results). */
state.onlineSet = async function onlineSet(userIds) {
  const ids = [...new Set(userIds)].filter(Boolean);
  if (ids.length === 0) return new Set();
  if (state.backend === 'redis') {
    const vals = await state.redis.mget(ids.map(K.presence));
    const online = new Set();
    ids.forEach((id, i) => { if (vals[i] != null) online.add(id); });
    return online;
  }
  const online = new Set();
  for (const id of ids) if (mem.presence.has(id)) online.add(id);
  return online;
};

/** Heartbeat: keep this socket's presence alive. */
state.refreshPresence = async function refreshPresence(socketId, userId) {
  if (!userId) return;
  if (state.backend === 'redis') {
    await state.redis.multi()
      .set(K.live(socketId), '1', 'EX', LIVE_TTL_SEC)
      .set(K.presence(userId), socketId, 'EX', LIVE_TTL_SEC)
      .exec();
  }
};

// ============================================================================
// Pairs
// ============================================================================
state.pairOf = async function pairOf(socketId) {
  if (state.backend === 'redis') {
    const raw = await state.redis.get(K.pair(socketId));
    return raw ? JSON.parse(raw) : null;
  }
  return mem.pairs.get(socketId) || null;
};
state.isPaired = async function isPaired(socketId) {
  return (await state.pairOf(socketId)) != null;
};

/**
 * Pair two specific sockets (friend calls, resume-chat — not the matcher).
 * Returns false (and pairs nothing) if either side is already paired.
 */
state.pairUp = async function pairUp(socketIdA, socketIdB, { userA, userB } = {}) {
  const roomId = crypto.randomUUID();
  const valA = JSON.stringify({ partnerSocketId: socketIdB, convId: null, roomId, userId: (userA && userA.id) || null });
  const valB = JSON.stringify({ partnerSocketId: socketIdA, convId: null, roomId, userId: (userB && userB.id) || null });
  if (state.backend === 'redis') {
    const res = await state.redis.eval(PAIRUP_SCRIPT, 3,
      K.pair(socketIdA), K.pair(socketIdB), K.pairsGauge, valA, valB, String(PAIR_TTL_SEC));
    return res === 1;
  }
  if (mem.pairs.has(socketIdA) || mem.pairs.has(socketIdB)) return false;
  mem.pairs.set(socketIdA, JSON.parse(valA));
  mem.pairs.set(socketIdB, JSON.parse(valB));
  return true;
};

/** Record the conversation on an existing pair (called after the DB create). */
state.setPairConv = async function setPairConv(socketIdA, socketIdB, convId) {
  if (state.backend === 'redis') {
    const [ra, rb] = await state.redis.mget([K.pair(socketIdA), K.pair(socketIdB)]);
    const multi = state.redis.multi();
    if (ra) multi.set(K.pair(socketIdA), JSON.stringify({ ...JSON.parse(ra), convId }), 'EX', PAIR_TTL_SEC);
    if (rb) multi.set(K.pair(socketIdB), JSON.stringify({ ...JSON.parse(rb), convId }), 'EX', PAIR_TTL_SEC);
    if (convId) {
      multi.sadd(K.convSockets(convId), socketIdA, socketIdB);
      multi.expire(K.convSockets(convId), CONV_TTL_SEC);
    }
    await multi.exec();
  } else {
    for (const s of [socketIdA, socketIdB]) {
      const p = mem.pairs.get(s);
      if (p) p.convId = convId;
    }
    if (convId) {
      let set = mem.convSockets.get(convId);
      if (!set) { set = new Set(); mem.convSockets.set(convId, set); }
      set.add(socketIdA); set.add(socketIdB);
    }
  }
};

/**
 * Tear down a pair from one side. Returns the partner's socket id (so the
 * caller can emit 'partner-left' — works cross-node via the adapter), or
 * null if this socket wasn't paired (or the partner's side won the race).
 */
state.endPair = async function endPair(socketId) {
  if (state.backend === 'redis') {
    const raw = await state.redis.get(K.pair(socketId));
    if (!raw) return null;
    const mine = JSON.parse(raw);
    const partner = mine.partnerSocketId;
    const won = await state.redis.eval(
      ENDPAIR_SCRIPT, 4,
      K.pair(socketId), K.pair(partner), K.pairsGauge,
      mine.convId ? K.convSockets(mine.convId) : 'sc:noop',
      socketId, partner
    );
    return won === 1 ? partner : null;
  }
  const mine = mem.pairs.get(socketId);
  if (!mine) return null;
  const partner = mem.pairs.get(mine.partnerSocketId);
  mem.pairs.delete(socketId);
  mem.pairs.delete(mine.partnerSocketId);
  const convId = (partner && partner.convId) || mine.convId;
  if (convId) {
    const set = mem.convSockets.get(convId);
    if (set) {
      set.delete(socketId); set.delete(mine.partnerSocketId);
      if (set.size === 0) mem.convSockets.delete(convId);
    }
  }
  return mine.partnerSocketId;
};

/**
 * Heartbeat for a paired socket: refresh both pair keys' TTL and detect a
 * partner whose side already expired (their worker crashed). Returns
 * 'expired' when the partner is gone, null when unpaired, 'ok' otherwise.
 */
state.refreshPair = async function refreshPair(socketId) {
  if (state.backend === 'redis') {
    const raw = await state.redis.get(K.pair(socketId));
    if (!raw) return null;
    const mine = JSON.parse(raw);
    const partnerRaw = await state.redis.get(K.pair(mine.partnerSocketId));
    if (!partnerRaw) {
      // Partner's side is gone (their worker crashed and the key expired).
      // endPair handles the conversation-socket cleanup and the gauge.
      await state.endPair(socketId);
      return 'expired';
    }
    const multi = state.redis.multi()
      .set(K.pair(socketId), raw, 'EX', PAIR_TTL_SEC)
      .set(K.pair(mine.partnerSocketId), partnerRaw, 'EX', PAIR_TTL_SEC);
    if (mine.convId) multi.expire(K.convSockets(mine.convId), CONV_TTL_SEC);
    await multi.exec();
    return 'ok';
  }
  return mem.pairs.has(socketId) ? 'ok' : null;
};

// ============================================================================
// Queues + matching
// ============================================================================

/** All queue bucket keys for a gender (redis SCAN, cached briefly). */
state.queueKeys = async function queueKeys(gender) {
  if (state.backend !== 'redis') return [];
  const pattern = gender ? `sc:q:${gender}:*` : 'sc:q:*';
  const keys = [];
  let cursor = '0';
  do {
    const [next, batch] = await state.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 200);
    cursor = next;
    keys.push(...batch);
  } while (cursor !== '0');
  return [...new Set(keys)];
};

/**
 * Put a socket into the waiting queue (idempotent; moves buckets if the
 * entry changed). The canonical entry lives in Redis (qentry hash) when
 * clustered, so any node can read it.
 */
state.enqueue = async function enqueue(socketId, entry) {
  const now = Date.now();
  entry.socketId = socketId;
  entry.queuedAt = entry.queuedAt || now;
  entry.bucket = bucketOf(entry, now);

  if (state.backend === 'redis') {
    // Read the current entry to know which bucket to remove the socket from.
    const raw = await state.redis.hget(K.qentry(socketId), 'e');
    const prev = raw ? JSON.parse(raw) : null;
    const sameBucket = prev && prev.bucket === entry.bucket &&
      prev.countryMode === entry.countryMode && prev.country === entry.country &&
      prev.lat === entry.lat && prev.lon === entry.lon;
    const multi = state.redis.multi()
      .hset(K.qentry(socketId), 'e', JSON.stringify(entry))
      .expire(K.qentry(socketId), QENTRY_TTL_SEC)
      .zadd(K.queue(entry.gender, entry.bucket), entry.queuedAt, socketId);
    if (prev && !sameBucket) multi.zrem(K.queue(prev.gender, prev.bucket), socketId);
    await multi.exec();
  } else {
    const old = mem.entries.get(socketId);
    if (old) memQueue(old.gender, old.bucket).delete(socketId);
    mem.entries.set(socketId, entry);
    memQueue(entry.gender, entry.bucket).set(socketId, entry);
  }
};

/** Remove a socket from the waiting queue (skip/cancel/pair-up/disconnect). */
state.dequeue = async function dequeue(socketId) {
  if (state.backend === 'redis') {
    const raw = await state.redis.hget(K.qentry(socketId), 'e');
    if (!raw) return;
    const entry = JSON.parse(raw);
    await state.redis.multi()
      .zrem(K.queue(entry.gender, entry.bucket), socketId)
      .del(K.qentry(socketId))
      .exec();
  } else {
    const old = mem.entries.get(socketId);
    if (!old) return;
    mem.entries.delete(socketId);
    memQueue(old.gender, old.bucket).delete(socketId);
  }
};

/** Total waiting users of one gender. */
async function queuedCount(gender) {
  if (state.backend === 'redis') {
    const keys = await state.queueKeys(gender);
    let n = 0;
    for (const key of keys) n += await state.redis.zcard(key);
    return n;
  }
  let n = 0;
  for (const [key, q] of mem.queues) if (key.startsWith(`${gender}:`)) n += q.size;
  return n;
}

/** Which buckets a seeker scans, given its own current scope. */
function candidateBucketsFor(entry, now) {
  const scope = currentScope(entry, now - entry.queuedAt);
  if (scope.type === 'country') return [...new Set([scope.country, 'ANY'])];
  return [...new Set([entry.detectedCountry, 'ANY'])]; // 'any' + 'nearby'
}

/**
 * Fetch waiting candidates of `gender`, oldest first.
 * `buckets` = null → every bucket (exact original behaviour; used while
 * queues are small). Entries whose qentry hash vanished are skipped.
 */
async function scanCandidates(gender, buckets) {
  if (state.backend === 'redis') {
    const keys = buckets
      ? buckets.map((b) => K.queue(gender, b))
      : (await state.queueKeys(gender));
    return fetchRedisEntries(gender, keys);
  }
  const seen = new Set();
  const entries = [];
  const iterBuckets = buckets || [...mem.queues.keys()].filter((k) => k.startsWith(`${gender}:`)).map((k) => k.split(':')[1]);
  for (const b of iterBuckets) {
    const q = mem.queues.get(`${gender}:${b}`);
    if (!q) continue;
    for (const e of q.values()) if (!seen.has(e.socketId)) { seen.add(e.socketId); entries.push(e); }
  }
  entries.sort((a, b) => a.queuedAt - b.queuedAt);
  return entries;
}

/** Redis helper: entries for a list of queue keys, oldest first, deduped. */
async function fetchRedisEntries(gender, keys) {
  const entries = [];
  for (const key of keys) {
    const ids = await state.redis.zrange(key, 0, -1);
    if (ids.length === 0) continue;
    // One pipeline: HMGET qentry:<id> e for every id in this bucket.
    const pipe = state.redis.pipeline();
    for (const id of ids) pipe.hget(K.qentry(id), 'e');
    const results = await pipe.exec();
    results.forEach(([err, raw], i) => {
      if (err || !raw) return; // vanished between ZRANGE and HGET — skip
      try {
        const e = JSON.parse(raw);
        e.socketId = ids[i];
        entries.push(e);
      } catch (err2) { /* corrupt entry — the sweep will reap it */ }
    });
  }
  entries.sort((a, b) => a.queuedAt - b.queuedAt);
  return entries;
}

/**
 * Attempt to pair `socketId` with a compatible waiting partner.
 * Returns { socketId, entry } of the claimed partner, or null (in which
 * case the seeker is left in the queue for future attempts).
 */
state.tryMatch = async function tryMatch(socketId, myEntry) {
  const now = Date.now();
  myEntry.socketId = socketId;
  myEntry.queuedAt = myEntry.queuedAt || now;

  const oppGender = oppositeOf(myEntry.gender);
  // Small queues: scan every bucket (original full-scan behaviour).
  const totalWaiting = await queuedCount(oppGender);
  const buckets = totalWaiting < SMALL_QUEUE_SCAN ? null : candidateBucketsFor(myEntry, now);
  const candidates = await scanCandidates(oppGender, buckets);

  for (const cand of candidates) {
    if (cand.socketId === socketId) continue;
    if (!usersCompatible(myEntry, cand, now)) continue;
    if (await state.isBlockedPair(myEntry.userId, cand.userId)) continue;
    const claimed = await claimPair(socketId, myEntry, cand);
    if (claimed) return { socketId: cand.socketId, entry: cand };
    // Claim lost the race — the next candidate may still be free.
  }

  await state.enqueue(socketId, myEntry);
  return null;
};

async function claimPair(mySocketId, myEntry, cand) {
  const roomId = crypto.randomUUID();
  const myValue = JSON.stringify({ partnerSocketId: cand.socketId, convId: null, roomId, userId: myEntry.userId });
  const candValue = JSON.stringify({ partnerSocketId: mySocketId, convId: null, roomId, userId: cand.userId });

  if (state.backend === 'redis') {
    // Am I already queued? (Retry case: the sweeper calls tryMatch for
    // users that are already waiting.) If so the claim also removes me.
    const myRaw = await state.redis.hget(K.qentry(mySocketId), 'e');
    const myQueuedEntry = myRaw ? JSON.parse(myRaw) : null;
    const res = await state.redis.eval(
      CLAIM_SCRIPT,
      8,
      K.pair(mySocketId), K.pair(cand.socketId), K.live(cand.socketId), K.pairsGauge,
      K.queue(cand.gender, cand.bucket), K.qentry(cand.socketId),
      myQueuedEntry ? K.queue(myEntry.gender, myQueuedEntry.bucket) : 'sc:noop',
      K.qentry(mySocketId),
      myQueuedEntry ? mySocketId : '',   // ARGV[1]: my socket id ('' = not queued)
      '',                                 // ARGV[2]: reserved
      cand.socketId,                      // ARGV[3]: candidate socket id
      myValue, candValue,                 // ARGV[4..5]: pair payloads
      String(PAIR_TTL_SEC)                // ARGV[6]: ttl
    );
    return res === 1;
  }

  // Memory backend: single-threaded, no races — just re-check synchronously.
  if (mem.pairs.has(mySocketId) || mem.pairs.has(cand.socketId)) return false;
  if (!mem.entries.has(cand.socketId)) return false;
  memQueue(cand.gender, cand.bucket).delete(cand.socketId);
  mem.entries.delete(cand.socketId);
  const old = mem.entries.get(mySocketId);
  if (old) memQueue(old.gender, old.bucket).delete(mySocketId);
  mem.entries.delete(mySocketId);
  mem.pairs.set(mySocketId, { partnerSocketId: cand.socketId, convId: null, roomId, userId: myEntry.userId });
  mem.pairs.set(cand.socketId, { partnerSocketId: mySocketId, convId: null, roomId, userId: cand.userId });
  return true;
}

/**
 * Sweep-initiated retry: claim a partner and hand the pair to the app's
 * onMatch callback (which creates the conversation and emits 'matched' to
 * both sockets — possibly on other nodes, via the adapter). If the callback
 * fails, unwind the pair and re-queue both sides.
 */
async function retryMatchWithNotify(entry) {
  const match = await state.tryMatch(entry.socketId, entry).catch(() => null);
  if (!match) return;
  if (typeof state.onMatch !== 'function') {
    // No callback configured — a claimed-but-unnotified pair would strand
    // both users, so undo it.
    await state.endPair(entry.socketId).catch(() => {});
    await state.enqueue(entry.socketId, entry).catch(() => {});
    await state.enqueue(match.socketId, match.entry).catch(() => {});
    return;
  }
  try {
    await state.onMatch(entry, match.entry, match.socketId);
  } catch (e) {
    console.error('sweep match notification failed:', e.message);
    await state.endPair(entry.socketId).catch(() => {});
    await state.enqueue(entry.socketId, entry).catch(() => {});
    await state.enqueue(match.socketId, match.entry).catch(() => {});
  }
}

/**
 * Periodic housekeeping (every 5s; a Redis lock makes exactly one node the
 * coordinator per round):
 *   - drop queue entries whose socket is no longer live (crashed worker)
 *   - re-bucket entries whose scope widened (strict country → anyone)
 *   - retry matching for everyone still waiting
 */
state.sweep = async function sweep() {
  if (!state.io) return;
  if (state.backend === 'redis') {
    const lock = await state.redis.set(K.sweepLock, '1', 'EX', 4, 'NX');
    if (!lock) return; // another node is coordinating this round
    try {
      for (const gender of ['male', 'female']) {
        const keys = await state.queueKeys(gender);
        for (const key of keys) {
          const ids = await state.redis.zrange(key, 0, -1);
          for (const id of ids) {
            const raw = await state.redis.hget(K.qentry(id), 'e');
            if (!raw) { await state.redis.zrem(key, id); continue; } // orphaned member
            const e = JSON.parse(raw);
            const live = (await state.redis.exists(K.live(id))) === 1;
            if (!live) {
              await state.redis.multi().zrem(key, id).del(K.qentry(id)).exec();
              continue;
            }
            const nowB = bucketOf(e, Date.now());
            if (nowB !== e.bucket) {
              e.bucket = nowB;
              await state.redis.multi()
                .zrem(key, id)
                .zadd(K.queue(e.gender, nowB), e.queuedAt, id)
                .hset(K.qentry(id), 'e', JSON.stringify(e))
                .expire(K.qentry(id), QENTRY_TTL_SEC)
                .exec();
            }
          }
        }
      }
      // Retry matching, oldest first, both genders.
      for (const gender of ['male', 'female']) {
        const keys = await state.queueKeys(gender);
        const entries = await fetchRedisEntries(gender, keys);
        for (const e of entries) {
          if ((await state.redis.exists(K.pair(e.socketId))) === 1) continue;
          if ((await state.redis.exists(K.live(e.socketId))) === 0) continue;
          await retryMatchWithNotify(e).catch(() => {});
        }
      }
    } finally {
      await state.redis.del(K.sweepLock).catch(() => {});
    }
    return;
  }

  // Memory backend
  const dead = [];
  for (const [socketId, entry] of mem.entries) {
    if (!state.io.sockets.sockets.has(socketId)) { dead.push(socketId); continue; }
    const nowB = bucketOf(entry, Date.now());
    if (nowB !== entry.bucket) {
      memQueue(entry.gender, entry.bucket).delete(socketId);
      entry.bucket = nowB;
      memQueue(entry.gender, nowB).set(socketId, entry);
    }
  }
  for (const socketId of dead) {
    const old = mem.entries.get(socketId);
    mem.entries.delete(socketId);
    if (old) memQueue(old.gender, old.bucket).delete(socketId);
  }
  const queued = [...mem.entries.values()].sort((a, b) => a.queuedAt - b.queuedAt);
  for (const e of queued) {
    if (mem.pairs.has(e.socketId)) continue;
    if (!state.io.sockets.sockets.has(e.socketId)) continue;
    await retryMatchWithNotify(e).catch(() => {});
  }
};

// ============================================================================
// Conversation → live sockets (for the disappearing-message sweeper)
// ============================================================================
state.convSockets = async function convSockets(convId) {
  if (state.backend === 'redis') {
    return await state.redis.smembers(K.convSockets(convId));
  }
  const set = mem.convSockets.get(convId);
  return set ? [...set] : [];
};

// ============================================================================
// Cross-node helpers
// ============================================================================
state.emitToUser = async function emitToUser(userId, event, payload) {
  const socketId = await state.socketOf(userId);
  if (socketId) state.io.to(socketId).emit(event, payload);
  return socketId != null;
};

// ============================================================================
// Stats for /metrics
// ============================================================================
state.stats = async function stats() {
  if (state.backend === 'redis') {
    let male = 0, female = 0;
    for (const gender of ['male', 'female']) {
      for (const key of await state.queueKeys(gender)) {
        const n = await state.redis.zcard(key);
        if (gender === 'male') male += n; else female += n;
      }
    }
    const pairs = parseInt(await state.redis.get(K.pairsGauge) || '0', 10);
    return { backend: 'redis', queuedMale: male, queuedFemale: female, pairs };
  }
  let male = 0, female = 0;
  for (const [key, q] of mem.queues) {
    if (key.startsWith('male:')) male += q.size; else female += q.size;
  }
  return { backend: 'memory', queuedMale: male, queuedFemale: female, pairs: mem.pairs.size };
};

module.exports = {
  state,
  // matching semantics re-exported for index.js
  VALID_COUNTRY_MODES, currentScope, scopeAllows, usersCompatible, oppositeOf, haversineKm,
  NEARBY_RADIUS_KM, NEARBY_STRICT_MS, NEARBY_COUNTRY_MS, COUNTRY_STRICT_MS
};
