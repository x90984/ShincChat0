// Shared cache layer used by db.js (user/conversation lookups).
//
// Backends, in order of preference:
//   1. Local Redis (REDIS_URL)  — what the Docker/VM deployment runs. Fast,
//      shared across all app workers on the machine, effectively unlimited.
//   2. Upstash Redis REST        — what a free Render deployment can use.
//      Metered: the free plan allows ~500k commands/month, so only worth it
//      for low-traffic deployments. Requires UPSTASH_REDIS_REST_URL/TOKEN.
//   3. In-process LRU+TTL        — always available, zero-config fallback.
//      Per-process, so slightly stale across instances (TTL bounded).
//
// This replaces the old hard requirement on Upstash (which threw at boot if
// unset) — the app now runs with zero external services beyond Postgres.
'use strict';

const { Redis } = require('ioredis');

const REDIS_URL = process.env.REDIS_URL || null;
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL || null;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || null;

const TTL_SEC = parseInt(process.env.CACHE_TTL_SEC, 10) || 60;

// ---- Backend 3: in-process LRU with TTL -------------------------------
class MemoryCache {
  constructor(max = 20000) {
    this.max = max;
    this.map = new Map(); // insertion-ordered → LRU by re-set
  }
  async get(key) {
    const hit = this.map.get(key);
    if (!hit) return null;
    if (hit.expires < Date.now()) { this.map.delete(key); return null; }
    this.map.delete(key); this.map.set(key, hit); // refresh LRU position
    return hit.value;
  }
  async set(key, value) {
    if (this.map.size >= this.max) {
      const oldest = this.map.keys().next().value;
      this.map.delete(oldest);
    }
    this.map.set(key, { value, expires: Date.now() + TTL_SEC * 1000 });
  }
  async del(key) { this.map.delete(key); }
}

// ---- Backend 1: local Redis (ioredis) ---------------------------------
class IoredisCache {
  constructor(client) { this.client = client; }
  async get(key) {
    const raw = await this.client.get(key);
    if (raw === null) return null;
    try { return JSON.parse(raw); } catch (e) { return raw; }
  }
  async set(key, value) {
    await this.client.set(key, JSON.stringify(value), 'EX', TTL_SEC);
  }
  async del(key) { await this.client.del(key); }
}

// ---- Backend 2: Upstash REST ------------------------------------------
function createUpstash() {
  // Lazy-require: keeps deployments that don't use Upstash from paying for
  // the import (it's already a dependency, so this is just hygiene).
  const { Redis: Upstash } = require('@upstash/redis');
  const redis = new Redis({ url: UPSTASH_URL, token: UPSTASH_TOKEN });
  return {
    async get(key) {
      try { return await redis.get(key); } catch (e) { return null; }
    },
    async set(key, value) {
      try { await redis.set(key, value, { ex: TTL_SEC }); } catch (e) { /* metered — ignore */ }
    },
    async del(key) {
      try { await redis.del(key); } catch (e) { /* ignore */ }
    }
  };
}

// Shared ioredis connection (the state layer uses the same pool — see
// state.js, which owns the connection and hands it to us).
let sharedClient = null;
function useSharedRedis(client) { sharedClient = client; }

function createCache() {
  if (REDIS_URL && sharedClient) return new IoredisCache(sharedClient);
  if (REDIS_URL) return new IoredisCache(new Redis(REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 }));
  if (UPSTASH_URL && UPSTASH_TOKEN) return createUpstash();
  return new MemoryCache();
}

let impl = null;
function cache() {
  if (!impl) impl = createCache();
  return impl;
}

function backendName() {
  if (REDIS_URL) return 'redis';
  if (UPSTASH_URL && UPSTASH_TOKEN) return 'upstash';
  return 'memory';
}

module.exports = {
  cacheGet: (k) => cache().get(k),
  cacheSet: (k, v) => cache().set(k, v),
  cacheDel: (k) => cache().del(k),
  useSharedRedis,
  backendName
};
