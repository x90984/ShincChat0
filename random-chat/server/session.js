// Stateless signed sessions (HS256 JWTs) — replaces the old in-memory
// token → userId Map.
//
// Why: the Map meant (a) every server restart logged everyone out, and (b)
// the app could never run more than one process, because sessions lived in
// exactly one process's memory. A signed token works on every instance and
// survives restarts.
//
// Deliberately hand-rolled instead of pulling in `jsonwebtoken`: we only
// need HS256, and the classic JWT pitfalls are avoided by construction —
// the algorithm is pinned (never read from the token), and the signature
// compare is timing-safe.
'use strict';

const crypto = require('crypto');

// SESSION_SECRET must be the same on every instance (env var). If unset we
// generate an ephemeral one per process: sessions still work, but restarts
// log everyone out and multi-instance setups break — so we warn loudly.
const SESSION_SECRET = process.env.SESSION_SECRET || null;
let ephemeralSecret = null;
function secret() {
  if (SESSION_SECRET) return SESSION_SECRET;
  if (!ephemeralSecret) {
    console.warn('WARNING: SESSION_SECRET is not set — using an ephemeral secret. Sessions will not survive restarts and WILL NOT work across multiple instances. Set SESSION_SECRET in production.');
    ephemeralSecret = crypto.randomBytes(32).toString('hex');
  }
  return ephemeralSecret;
}

const TTL_SEC = parseInt(process.env.SESSION_TTL_SEC, 10) || 60 * 60 * 24 * 30; // 30 days

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlJSON(obj) {
  return b64url(JSON.stringify(obj));
}
function fromB64url(s) {
  return JSON.parse(Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
}
function hmac(data) {
  return b64url(crypto.createHmac('sha256', secret()).update(data).digest());
}

/** Sign a session token for a user id. Same shape as the old createSession(). */
function createSession(userId) {
  const header = b64urlJSON({ alg: 'HS256', typ: 'JWT' });
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlJSON({ uid: userId, iat: now, exp: now + TTL_SEC });
  return `${header}.${payload}.${hmac(`${header}.${payload}`)}`;
}

/**
 * Verify a token → userId, or null if invalid/expired/tampered.
 * The alg is pinned to HS256; anything else (including "none") is rejected
 * before any signature work happens.
 */
function verifySession(token) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, payload, sig] = parts;
  let h;
  try {
    h = fromB64url(header);
  } catch (e) { return null; }
  if (!h || h.alg !== 'HS256') return null; // pinned — no alg confusion
  const expected = hmac(`${header}.${payload}`);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let p;
  try {
    p = fromB64url(payload);
  } catch (e) { return null; }
  if (!p || typeof p.uid !== 'string') return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof p.exp !== 'number' || p.exp < now - 30) return null; // 30s clock skew grace
  return p.uid;
}

module.exports = { createSession, verifySession, TTL_SEC };
