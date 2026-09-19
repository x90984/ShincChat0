// ShincChat Admin Panel — a separate application from the main random-chat
// app. It is not imported by or linked to that app; both simply point at the
// same Postgres database (DATABASE_URL), which is how ban/report/
// monetization data written here takes effect in the main app.
//
// (It used to share a SQLite file on disk — that only worked when both apps
// ran on the same machine, which is never true on a host like Render, and
// it broke entirely when the main app moved to Postgres.)
'use strict';

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const PORT = process.env.PORT || process.env.ADMIN_PORT || 4000;

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set — point it at the same Postgres the main app uses.');
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PG_SSL === 'false' ? false : { rejectUnauthorized: false },
  max: parseInt(process.env.PG_POOL_MAX, 10) || 5
});
pool.on('error', (err) => console.error('Unexpected Postgres pool error:', err));

async function query(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function queryOne(sql, params = []) {
  return (await query(sql, params))[0] || null;
}
// Runs every statement; creates the tables this panel needs if the main app
// hasn't created them yet (fresh database, panel started first).
async function initSchema() {
  await query(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, username_lower TEXT NOT NULL UNIQUE,
      salt TEXT, hash TEXT, gender TEXT, created_at BIGINT NOT NULL,
      is_premium INTEGER NOT NULL DEFAULT 0, is_banned INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, user_a TEXT NOT NULL, user_b TEXT NOT NULL, created_at BIGINT NOT NULL, last_message_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, sender_id TEXT NOT NULL, type TEXT NOT NULL,
      text TEXT, audio TEXT, ts BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY, reporter_id TEXT NOT NULL, reported_id TEXT NOT NULL, reason TEXT NOT NULL,
      details TEXT, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ads (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, body TEXT, image_url TEXT, link_url TEXT,
      placement TEXT NOT NULL DEFAULT 'gate', enabled INTEGER NOT NULL DEFAULT 1,
      impressions INTEGER NOT NULL DEFAULT 0, clicks INTEGER NOT NULL DEFAULT 0, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS premium_plans (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, price_cents INTEGER NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'USD',
      interval TEXT NOT NULL DEFAULT 'monthly', features TEXT NOT NULL DEFAULT '[]', enabled INTEGER NOT NULL DEFAULT 1, created_at BIGINT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS admins (
      id TEXT PRIMARY KEY, username TEXT NOT NULL UNIQUE, salt TEXT NOT NULL, hash TEXT NOT NULL, created_at BIGINT NOT NULL
    );
  `);
  // `status` on reports is written by this panel; the main app's schema
  // doesn't have it. Harmless if it already exists.
  await query(`ALTER TABLE reports ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'auto_banned'`);
}

const DEFAULT_SETTINGS = {
  auto_ban_on_report: true,
  video_unlock_threshold_per_side: 10,
  // Platform-wide default for the chat app's top-bar country/nearby
  // picker — applies to first-time visitors before they've picked
  // anything themselves. mode: 'nearby' | 'india' | 'random' | 'country';
  // country is only used when mode === 'country' (ISO 3166-1 alpha-2).
  country_match_defaults: { mode: 'india', country: null },
  monetization_methods: {
    banner_ads: { enabled: false, label: 'Banner Ads', note: 'Shown on the onboarding/gate screen and history panel.' },
    premium_subscription: { enabled: false, label: 'Premium Subscription', note: 'Recurring plans, managed under Premium Plans.' },
    pay_per_minute_video: { enabled: false, rateCents: 0, label: 'Pay-per-Minute Video', note: 'Charge per minute of video chat.' },
    coin_gifting: { enabled: false, coinPriceCents: 0, label: 'Coins / Gifting', note: 'In-app currency users can send each other or spend on perks.' },
    referral_program: { enabled: false, bonusCents: 0, label: 'Referral Program', note: 'Reward for inviting new users.' }
  }
};

async function seedSettings() {
  for (const [key, value] of Object.entries(DEFAULT_SETTINGS)) {
    await query(
      `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [key, JSON.stringify(value)]
    );
  }
}

// ---- Password hashing (same scheme as the main app, duplicated on
// purpose — this codebase is intentionally standalone) ----
const scryptAsync = require('util').promisify(crypto.scrypt);
async function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = (await scryptAsync(password, salt, 64)).toString('hex');
  return { salt, hash };
}
async function verifyPassword(password, salt, hash) {
  try {
    const check = (await scryptAsync(password, salt, 64)).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(check, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}

const app = express();
app.set('trust proxy', 1); // hosts sit behind a TLS-terminating proxy
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Admin auth (in-memory sessions — single small process, fine) ----
const sessions = new Map(); // token -> adminId
setInterval(() => {
  // No expiry is tracked; just cap the map so it can't grow forever.
  if (sessions.size > 1000) sessions.clear();
}, 60 * 60 * 1000).unref();

function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const adminId = token && sessions.get(token);
  if (!adminId) return res.status(401).json({ error: 'Not authenticated' });
  req.adminId = adminId;
  next();
}

const wrap = (handler) => (req, res) => handler(req, res).catch((e) => {
  console.error('Admin route error:', e);
  if (!res.headersSent) res.status(500).json({ error: 'Server error' });
});

app.get('/api/admin/bootstrap-status', wrap(async (req, res) => {
  const row = await queryOne(`SELECT COUNT(*) AS c FROM admins`);
  res.json({ hasAdmin: Number(row.c) > 0 });
}));

// Only works while there are zero admins — prevents anyone from creating
// extra admin accounts through this endpoint later.
app.post('/api/admin/bootstrap', wrap(async (req, res) => {
  const row = await queryOne(`SELECT COUNT(*) AS c FROM admins`);
  if (Number(row.c) > 0) return res.status(403).json({ error: 'An admin account already exists. Log in instead.' });
  const { username, password } = req.body || {};
  if (!username || !password || password.length < 8) {
    return res.status(400).json({ error: 'Username and an 8+ character password are required.' });
  }
  const { salt, hash } = await hashPassword(password);
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO admins (id, username, salt, hash, created_at) VALUES ($1, $2, $3, $4, $5)`,
    [id, username.trim(), salt, hash, Date.now()]
  );
  const token = crypto.randomUUID();
  sessions.set(token, id);
  res.json({ token, username: username.trim() });
}));

app.post('/api/admin/login', wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await queryOne(`SELECT * FROM admins WHERE username = $1`, [(username || '').trim()]);
  if (!admin || !(await verifyPassword(password || '', admin.salt, admin.hash))) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  const token = crypto.randomUUID();
  sessions.set(token, admin.id);
  res.json({ token, username: admin.username });
}));

// ---- Dashboard ----
app.get('/api/dashboard', requireAdmin, wrap(async (req, res) => {
  const c = async (sql) => Number((await queryOne(sql)).c);
  res.json({
    totalUsers: await c(`SELECT COUNT(*) AS c FROM users`),
    bannedUsers: await c(`SELECT COUNT(*) AS c FROM users WHERE is_banned = 1`),
    premiumUsers: await c(`SELECT COUNT(*) AS c FROM users WHERE is_premium = 1`),
    totalConversations: await c(`SELECT COUNT(*) AS c FROM conversations`),
    totalMessages: await c(`SELECT COUNT(*) AS c FROM messages`),
    totalReports: await c(`SELECT COUNT(*) AS c FROM reports`),
    activeAds: await c(`SELECT COUNT(*) AS c FROM ads WHERE enabled = 1`),
    activePlans: await c(`SELECT COUNT(*) AS c FROM premium_plans WHERE enabled = 1`)
  });
}));

// ---- Users ----
app.get('/api/users', requireAdmin, wrap(async (req, res) => {
  const { filter, q } = req.query;
  let sql = `SELECT id, username, gender, created_at, is_premium, is_banned FROM users WHERE 1=1`;
  const params = [];
  if (filter === 'banned') sql += ` AND is_banned = 1`;
  if (filter === 'premium') sql += ` AND is_premium = 1`;
  if (q) { params.push(`%${q.toLowerCase()}%`); sql += ` AND username_lower LIKE $${params.length}`; }
  sql += ` ORDER BY created_at DESC LIMIT 200`;
  res.json({ users: await query(sql, params) });
}));

app.post('/api/users/:id/ban', requireAdmin, wrap(async (req, res) => {
  await query(`UPDATE users SET is_banned = 1 WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/users/:id/unban', requireAdmin, wrap(async (req, res) => {
  await query(`UPDATE users SET is_banned = 0 WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

app.post('/api/users/:id/premium', requireAdmin, wrap(async (req, res) => {
  const { isPremium } = req.body || {};
  await query(`UPDATE users SET is_premium = $1 WHERE id = $2`, [isPremium ? 1 : 0, req.params.id]);
  res.json({ ok: true });
}));

// ---- Reports ----
app.get('/api/reports', requireAdmin, wrap(async (req, res) => {
  const rows = await query(`
    SELECT r.id, r.reason, r.details, r.created_at, r.status,
           ru.username AS reporter_username, ru.id AS reporter_id,
           tu.username AS reported_username, tu.id AS reported_id, tu.is_banned AS reported_is_banned
    FROM reports r
    LEFT JOIN users ru ON ru.id = r.reporter_id
    LEFT JOIN users tu ON tu.id = r.reported_id
    ORDER BY r.created_at DESC LIMIT 200
  `);
  res.json({ reports: rows });
}));

// Admin override: unban someone despite an auto-ban (e.g. a bad-faith report)
app.post('/api/reports/:reportedId/reverse-ban', requireAdmin, wrap(async (req, res) => {
  await query(`UPDATE users SET is_banned = 0 WHERE id = $1`, [req.params.reportedId]);
  res.json({ ok: true });
}));

// ---- Ads ----
app.get('/api/ads', requireAdmin, wrap(async (req, res) => {
  res.json({ ads: await query(`SELECT * FROM ads ORDER BY created_at DESC`) });
}));
app.post('/api/ads', requireAdmin, wrap(async (req, res) => {
  const { title, body, imageUrl, linkUrl, placement, enabled } = req.body || {};
  if (!title) return res.status(400).json({ error: 'Title is required.' });
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO ads (id, title, body, image_url, link_url, placement, enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, title, body || null, imageUrl || null, linkUrl || null, placement || 'gate', enabled === false ? 0 : 1, Date.now()]
  );
  res.json({ id });
}));
app.put('/api/ads/:id', requireAdmin, wrap(async (req, res) => {
  const { title, body, imageUrl, linkUrl, placement, enabled } = req.body || {};
  await query(
    `UPDATE ads SET title = $1, body = $2, image_url = $3, link_url = $4, placement = $5, enabled = $6 WHERE id = $7`,
    [title, body || null, imageUrl || null, linkUrl || null, placement || 'gate', enabled ? 1 : 0, req.params.id]
  );
  res.json({ ok: true });
}));
app.delete('/api/ads/:id', requireAdmin, wrap(async (req, res) => {
  await query(`DELETE FROM ads WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---- Premium plans ----
app.get('/api/premium-plans', requireAdmin, wrap(async (req, res) => {
  const plans = (await query(`SELECT * FROM premium_plans ORDER BY created_at DESC`))
    .map(p => ({ ...p, features: JSON.parse(p.features || '[]') }));
  res.json({ plans });
}));
app.post('/api/premium-plans', requireAdmin, wrap(async (req, res) => {
  const { name, priceCents, currency, interval, features, enabled } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const id = crypto.randomUUID();
  await query(
    `INSERT INTO premium_plans (id, name, price_cents, currency, interval, features, enabled, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, name, priceCents || 0, currency || 'USD', interval || 'monthly', JSON.stringify(features || []), enabled === false ? 0 : 1, Date.now()]
  );
  res.json({ id });
}));
app.put('/api/premium-plans/:id', requireAdmin, wrap(async (req, res) => {
  const { name, priceCents, currency, interval, features, enabled } = req.body || {};
  await query(
    `UPDATE premium_plans SET name = $1, price_cents = $2, currency = $3, interval = $4, features = $5, enabled = $6 WHERE id = $7`,
    [name, priceCents || 0, currency || 'USD', interval || 'monthly', JSON.stringify(features || []), enabled ? 1 : 0, req.params.id]
  );
  res.json({ ok: true });
}));
app.delete('/api/premium-plans/:id', requireAdmin, wrap(async (req, res) => {
  await query(`DELETE FROM premium_plans WHERE id = $1`, [req.params.id]);
  res.json({ ok: true });
}));

// ---- Settings / monetization methods ----
app.get('/api/settings', requireAdmin, wrap(async (req, res) => {
  const rows = await query(`SELECT key, value FROM settings`);
  const settings = {};
  for (const row of rows) { try { settings[row.key] = JSON.parse(row.value); } catch { settings[row.key] = row.value; } }
  res.json({ settings });
}));
app.put('/api/settings/:key', requireAdmin, wrap(async (req, res) => {
  const { value } = req.body || {};
  await query(
    `INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [req.params.key, JSON.stringify(value)]
  );
  res.json({ ok: true });
}));

initSchema()
  .then(seedSettings)
  .then(() => {
    app.listen(PORT, () => {
      console.log(`SyncChat Admin Panel running on port ${PORT}`);
      console.log(`Database: ${process.env.DATABASE_URL.replace(/:[^:@/]+@/, ':***@')}`);
    });
  })
  .catch((e) => {
    console.error('Failed to start — database not ready:', e.message);
    process.exit(1);
  });
