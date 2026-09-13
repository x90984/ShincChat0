/**
 * dev-preview.js — LOCAL UI PREVIEW ONLY. Not used in production, not
 * referenced by `npm start`, and never deployed.
 *
 * The real server (server/index.js) refuses to boot without Supabase
 * Postgres + Upstash Redis credentials, which makes "let me just look at the
 * login page" needlessly expensive. This file serves public/ and fakes the
 * handful of auth endpoints the sign-in screen touches, with users held in
 * memory, so the login/sign-up UI can be exercised end to end offline.
 *
 *   node dev-preview.js            # http://localhost:3000
 *   PORT=4000 node dev-preview.js
 *
 * Anything past the gate (matching, video, history) is intentionally inert.
 */

const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
new Server(server); // serves /socket.io/socket.io.js so app.js can boot

app.use(express.json());

// In-memory "database" — reset on every restart.
const users = new Map(); // username -> { id, username, fullName, identifier, password, ... }
const taken = new Set(['admin', 'syncchat', 'support', 'test']); // pre-seed some collisions
let nextId = 1;

const tokenFor = (u) => `dev-token-${u.id}`;
const publicUser = (u) => ({
  id: u.id, username: u.username, fullName: u.fullName,
  gender: u.gender || null, birthDate: u.birthDate || null, avatarUrl: null
});

app.get('/api/check-username', (req, res) => {
  const u = String(req.query.u || '').trim().toLowerCase();
  if (u.length < 3) return res.json({ available: false, error: 'At least 3 characters' });
  if (!/^[a-z0-9._]+$/.test(u)) return res.json({ available: false, error: 'Letters, numbers, . and _ only' });
  res.json({ available: !taken.has(u) && !users.has(u) });
});

app.post('/api/signup', (req, res) => {
  const { fullName, username, identifier, birthDate, password } = req.body || {};
  const uname = String(username || '').trim().toLowerCase();
  if (!fullName || !uname || !identifier || !password) return res.status(400).json({ error: 'Missing required fields.' });
  if (taken.has(uname) || users.has(uname)) return res.status(409).json({ error: 'That username is taken.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  // 18+ age gate, same rule the real server enforces.
  if (birthDate) {
    const age = (Date.now() - new Date(birthDate).getTime()) / (365.25 * 24 * 3600 * 1000);
    if (age < 18) return res.status(400).json({ error: 'You must be 18 or older to use SyncChat.' });
  }
  const user = { id: nextId++, username: uname, fullName, identifier, birthDate, password };
  users.set(uname, user);
  res.json({ token: tokenFor(user), user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { identifier, password } = req.body || {};
  const key = String(identifier || '').trim().toLowerCase();
  const user = users.get(key) || [...users.values()].find((u) => u.identifier.toLowerCase() === key);
  if (!user || user.password !== password) return res.status(401).json({ error: 'Incorrect username or password.' });
  res.json({ token: tokenFor(user), user: publicUser(user) });
});

// Everything past the gate: answer politely so the UI does not throw.
app.get('/api/oauth-providers', (req, res) => res.json({ providers: [] }));
app.get('/api/me', (req, res) => res.status(401).json({ error: 'Not authenticated' }));
app.all('/api/*splat', (req, res) => res.json({ ok: true, items: [], dev: true }));

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  SyncChat UI preview (mock auth, in-memory) → http://localhost:${PORT}`);
  console.log('  Sign up with any details, then log in with the same username/password.\n');
});
