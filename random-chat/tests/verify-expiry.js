#!/usr/bin/env node
// Verify-clip retention test — proves that:
//   1. a freshly uploaded verify clip is served normally (behaviour unchanged)
//   2. after VERIFY_CLIP_TTL_SEC it is deleted from storage and its URL 404s
//   3. a voice message uploaded at the same time is NOT touched
//      (voice messages belong to chat history; verify clips are ephemeral)
//
// Spawns its own server instance on a scratch port + scratch MEDIA_DIR, so
// it doesn't disturb a running one. Requires a Postgres (DATABASE_URL) and,
// optionally, a Redis (REDIS_URL) — defaults below match the local dev
// setup documented in README.md.
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PORT = 3199;
const BASE = `http://127.0.0.1:${PORT}`;
const TTL_SEC = 1;        // server env: verify clips die after 1s
const SWEEP_SEC = 5;      // server env: sweeper runs every 5s (code floor)

const SERVER_ENV = {
  ...process.env,
  PORT: String(PORT),
  DATABASE_URL: process.env.DATABASE_URL || 'postgres://shinc:shinc@127.0.0.1:5433/shincchat',
  PG_SSL: 'false',
  REDIS_URL: process.env.REDIS_URL || 'redis://127.0.0.1:6380',
  SESSION_SECRET: process.env.SESSION_SECRET || 'verify-expiry-test-secret',
  VERIFY_CLIP_TTL_SEC: String(TTL_SEC),
  MEDIA_SWEEP_SEC: String(SWEEP_SEC),
  MEDIA_DIR: null // filled in below
};

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function api(p, { method = 'GET', token, body } = {}) {
  const res = await fetch(BASE + p, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function waitForHealth(tries = 30) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(BASE + '/health');
      if (r.ok) return true;
    } catch (e) { /* not up yet */ }
    await sleep(500);
  }
  return false;
}

async function uploadType(token, type, bytes) {
  const up = await api('/api/media/upload-url', { method: 'POST', token, body: { type, contentType: type === 'verify' ? 'video/webm' : 'audio/webm' } });
  if (up.status !== 200) throw new Error('upload-url failed: ' + JSON.stringify(up.data));
  const u = new URL(up.data.url, BASE);
  const put = await fetch(u.toString(), { method: 'POST', headers: { 'Content-Type': up.data.headers['Content-Type'] }, body: bytes });
  if (!put.ok) throw new Error('upload failed: ' + put.status);
  return up.data.key;
}

async function fetchUrlFor(token, key) {
  const urls = await api('/api/media/urls', { method: 'POST', token, body: { keys: [key] } });
  const url = urls.data.urls[key];
  if (!url) return null;
  const u = new URL(url, BASE);
  return fetch(u.toString());
}

async function main() {
  const mediaDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-verify-test-'));
  SERVER_ENV.MEDIA_DIR = mediaDir;
  console.log(`Verify-clip retention test (MEDIA_DIR=${mediaDir})`);

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: SERVER_ENV, stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverLog = '';
  child.stdout.on('data', d => { serverLog += d; });
  child.stderr.on('data', d => { serverLog += d; });

  try {
    ok('server started', await waitForHealth());

    // user
    const sufx = Math.random().toString(36).slice(2, 8);
    const signup = await api('/api/signup', {
      method: 'POST',
      body: { fullName: 'Expiry Test', username: `exp_${sufx}`, identifier: `exp${sufx}@example.com`, password: 'secret123', birthDate: '1995-01-01' }
    });
    ok('signup', signup.status === 200 && !!signup.data.token, signup.data);
    const token = signup.data.token;

    // uploads: one verify clip (should die) + one voice message (should live)
    const verifyBytes = Buffer.from('RIFF-fake-verify-clip-' + sufx);
    const voiceBytes = Buffer.from('RIFF-fake-voice-message-' + sufx);
    const verifyKey = await uploadType(token, 'verify', verifyBytes);
    const voiceKey = await uploadType(token, 'voice', voiceBytes);

    const diskPath = (key) => path.join(mediaDir, key);
    ok('verify clip on disk right after upload', fs.existsSync(diskPath(verifyKey)));
    ok('voice message on disk right after upload', fs.existsSync(diskPath(voiceKey)));

    const verifyRes1 = await fetchUrlFor(token, verifyKey);
    ok('verify clip served before TTL', verifyRes1 && verifyRes1.status === 200 &&
      Buffer.from(await verifyRes1.arrayBuffer()).equals(verifyBytes));

    // wait for TTL + a sweep round (+ margin)
    console.log(`  waiting ${TTL_SEC + SWEEP_SEC + 4}s for the sweeper...`);
    await sleep((TTL_SEC + SWEEP_SEC + 4) * 1000);

    ok('verify clip deleted from disk after TTL', !fs.existsSync(diskPath(verifyKey)));
    const verifyRes2 = await fetchUrlFor(token, verifyKey);
    ok('verify clip URL no longer serves the object', verifyRes2 && verifyRes2.status === 404, verifyRes2 && verifyRes2.status);

    ok('voice message still on disk', fs.existsSync(diskPath(voiceKey)));
    const voiceRes = await fetchUrlFor(token, voiceKey);
    ok('voice message still served', voiceRes && voiceRes.status === 200 &&
      Buffer.from(await voiceRes.arrayBuffer()).equals(voiceBytes));

    // sweeper log line present (proves the sweeper actually started)
    ok('sweeper started (log line)', /Verify-clip sweeper:/.test(serverLog), serverLog.slice(-400));
  } finally {
    child.kill('SIGTERM');
    await sleep(500);
    child.kill('SIGKILL');
    fs.rmSync(mediaDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error('TEST CRASHED:', e); process.exit(1); });
