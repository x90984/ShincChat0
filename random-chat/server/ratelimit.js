// Rate limiting — token buckets, per node.
//
// Per-node is deliberate: the Docker deployment runs N workers behind one
// Caddy load balancer, so an abusive client's traffic spreads across
// workers and each sees 1/N of it. The effective global limit is
// max × N, which is still enough to stop a single script from burning CPU
// (scrypt logins), database connections or the Upstash command quota.
// For strict global limits put a WAF/rate rule in front (Cloudflare does
// this for free — see SCALING.md).
'use strict';

class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.tokens = capacity;
    this.refillPerSec = refillPerSec;
    this.updated = Date.now();
  }
  tryRemove(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.updated) / 1000) * this.refillPerSec);
    this.updated = now;
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

class BucketRegistry {
  constructor(maxKeys = 50000) {
    this.maxKeys = maxKeys;
    this.buckets = new Map();
    // Occasional sweep so a flood of one-off IPs can't grow the map forever.
    this.sweepTimer = setInterval(() => {
      if (this.buckets.size > this.maxKeys) this.buckets.clear();
    }, 10 * 60 * 1000);
    this.sweepTimer.unref();
  }
  take(key, n = 1) {
    let b = this.buckets.get(key);
    if (!b) {
      b = new TokenBucket(this.capacity, this.refill);
      this.buckets.set(key, b);
    }
    return b.tryRemove(n);
  }
  config(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    return this;
  }
}

/** Express middleware: rate limit by client IP. */
function ipLimiter({ capacity = 120, refillPerSec = 2, keyPrefix = 'api' } = {}) {
  const registry = new BucketRegistry().config(capacity, refillPerSec);
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    if (!registry.take(`${keyPrefix}:${ip}`)) {
      res.set('Retry-After', '5');
      return res.status(429).json({ error: 'Too many requests. Slow down.' });
    }
    next();
  };
}

/** Stricter limiter for auth routes (each attempt costs an scrypt hash). */
function authLimiter() {
  const perIp = new BucketRegistry().config(15, 0.1);           // 15 attempts, +1 per 10s per IP
  const perId = new BucketRegistry().config(10, 0.033);          // 10 attempts per identifier
  return (req, res, next) => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const identifier = String((req.body || {}).identifier || '').toLowerCase().slice(0, 200) || ip;
    if (!perIp.take(`auth:${ip}`) || !perId.take(`authid:${identifier}`)) {
      res.set('Retry-After', '30');
      return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
    }
    next();
  };
}

/**
 * Socket-level limiter. Returns a function to call per event; kicks the
 * socket off when a client floods (a modified client can emit hundreds of
 * events per second and each one costs relay work).
 */
function socketLimiter(socket, { capacity = 30, refillPerSec = 5, kickAfter = 3 } = {}) {
  const bucket = new TokenBucket(capacity, refillPerSec);
  let strikes = 0;
  return () => {
    if (bucket.tryRemove(1)) return true;
    if (++strikes >= kickAfter) {
      try { socket.disconnect(true); } catch (e) { /* already gone */ }
    }
    return false;
  };
}

module.exports = { ipLimiter, authLimiter, socketLimiter };
