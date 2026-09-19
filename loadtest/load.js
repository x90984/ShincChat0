#!/usr/bin/env node
// ShincChat load test — measures what a deployment actually holds.
//
//   npm install
//   node load.js --url http://127.0.0.1:3100 --pairs 100            # full flow
//   node load.js --url http://127.0.0.1:3100 --pairs 500 --msg 0    # connect+match only
//   node load.js --url http://127.0.0.1:3100 --pairs 0 --hold 30000 # idle-socket capacity
//
// What it does:
//   1. signs up 2×PAIRS throwaway users (male + female)
//   2. ramps socket connections (both genders, random stagger)
//   3. everyone searches; pairs form through the real matcher
//   4. each pair exchanges MSG messages; round-trip times are recorded
//   5. prints match latency, message RTT percentiles, error counts, and
//      scrapes /metrics before/after so you can watch the gauges move
//
// The users it creates are real rows (username prefix lt_<run>_); clean up
// with DELETE FROM users WHERE username LIKE 'lt\_%'; on a throwaway DB.
//
// Run against STAGING only.
'use strict';

const { io } = require('socket.io-client');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
const URL = arg('url', 'http://127.0.0.1:3100');
const PAIRS = parseInt(arg('pairs', '50'), 10);
const MSG = parseInt(arg('msg', '20'), 10);
const RAMP_MS = parseInt(arg('ramp', '15000'), 10);
const HOLD_MS = parseInt(arg('hold', '0'), 10); // extra seconds to hold sockets open
const RUN = Math.random().toString(36).slice(2, 8);

const stats = {
  signedUp: 0, connected: 0, matched: 0, msgsSent: 0, msgsReceived: 0,
  errors: 0, connectErrors: 0,
  matchLatency: [], msgRtt: [], holdExpires: 0
};
const t0 = Date.now();

function pct(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
}
function fmt(ms) { return ms == null ? 'n/a' : Math.round(ms) + 'ms'; }

// Each virtual user gets its own X-Forwarded-For address (the server trusts
// exactly one proxy hop — real deployments sit behind Caddy/Render's proxy,
// and real load comes from many IPs, not one).
function vip(n, gender) {
  return `10.${PAIRS % 250}.${n % 250}.${gender === 'male' ? (n % 200) + 10 : (n % 200) + 56}`;
}

async function api(path, { method = 'GET', body, ip } = {}) {
  const res = await fetch(URL + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(ip ? { 'X-Forwarded-For': ip } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

async function makeUser(gender, n) {
  const ip = vip(n, gender);
  const r = await api('/api/signup', {
    method: 'POST', ip,
    body: {
      fullName: `Load ${gender} ${n}`,
      username: `lt_${RUN}_${gender}_${n}`,
      identifier: `lt_${RUN}_${gender}_${n}@loadtest.local`,
      password: 'loadtest123', birthDate: '1994-04-04'
    }
  });
  if (r.status !== 200) { stats.errors++; return null; }
  await api('/api/set-gender', { method: 'POST', ip, token: r.data.token, body: { gender } });
  stats.signedUp++;
  return { ...r.data, ip };
}

// Socket factory — the driver below handles lifecycle through events.
function makeSocket(token, gender, n, ip) {
  const socket = io(URL, {
    transports: ['websocket'], forceNew: true, reconnection: false,
    extraHeaders: ip ? { 'X-Forwarded-For': ip } : {}
  });
  socket.userData = { gender, n, matchedAt: null, partnerMsgTs: null };
  socket.on('connect', () => { socket.emit('auth', { token }); stats.connected++; });
  socket.on('connect_error', () => stats.connectErrors++);
  return socket;
}

async function main() {
  console.log(`Load test against ${URL}`);
  console.log(`  pairs=${PAIRS} msgs/pair=${MSG} ramp=${RAMP_MS}ms hold=${HOLD_MS}ms\n`);
  const metricsBefore = await fetch(URL + '/metrics').then(r => r.text()).catch(() => '');

  // 1. users (throttled — signups are not what we're load testing, and the
  //    server's per-IP limiter is working as intended)
  const users = { male: [], female: [] };
  const signUpThrottled = async (gender, i) => {
    const u = await makeUser(gender, i);
    if (u) users[gender].push(u);
    await new Promise(r => setTimeout(r, 25));
  };
  const jobs = [];
  for (let i = 0; i < PAIRS; i++) { jobs.push(signUpThrottled('male', i)); jobs.push(signUpThrottled('female', i)); }
  await Promise.all(jobs);
  console.log(`Signed up ${stats.signedUp}/${PAIRS * 2} users (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 2. connect with ramp
  const sockets = [];
  const total = PAIRS * 2;
  for (let i = 0; i < total; i++) {
    const gender = i % 2 === 0 ? 'male' : 'female';
    const u = users[gender][Math.floor(i / 2)];
    if (!u) continue;
    sockets.push(makeSocket(u.token, gender, i, u.ip));
    if (i % 25 === 0) console.log(`  connected ${i}/${total}...`);
    await new Promise(r => setTimeout(r, Math.max(1, RAMP_MS / total)));
  }
  await new Promise(r => setTimeout(r, 3000));
  console.log(`Connected ${stats.connected}/${total} sockets (${((Date.now() - t0) / 1000).toFixed(1)}s)`);

  // 3. everyone searches at once (random mode → fast matches)
  const matchDeadline = Date.now() + 30000;
  for (const s of sockets) {
    s.on('matched', () => {
      stats.matched++;
      s.userData.matchedAt = Date.now();
    });
    s.on('chat-message', (m) => {
      if (!m.self && m.text && m.text.startsWith('lt:')) {
        s.userData.partnerMsgTs = Date.now();
        stats.msgsReceived++;
        // bounce a reply once (each pair ends up exchanging ~2×MSG)
        if (Math.random() < 0.5) s.emit('chat-message', { text: 'lt:reply-' + Date.now() });
      }
    });
    s.emit('find-partner', { gender: s.userData.gender, lookingFor: s.userData.gender === 'male' ? 'female' : 'male', countryMode: 'random' });
  }

  // 4. wait for matches, then push messages
  while (stats.matched < PAIRS * 2 && Date.now() < matchDeadline) {
    await new Promise(r => setTimeout(r, 500));
  }
  const matchPhase = Date.now();
  console.log(`Matched ${stats.matched}/${PAIRS * 2} users in ${((matchPhase - t0) / 1000).toFixed(1)}s`);

  if (MSG > 0) {
    const msgDeadline = Date.now() + 60000;
    let round = 0;
    while (round < MSG && Date.now() < msgDeadline) {
      for (const s of sockets) {
        if (s.userData.matchedAt) {
          const sentAt = Date.now();
          s.emit('chat-message', { text: `lt:${sentAt}` });
          stats.msgsSent++;
          s.userData.lastSentAt = sentAt;
        }
      }
      round++;
      await new Promise(r => setTimeout(r, 200));
    }
    // let replies settle
    await new Promise(r => setTimeout(r, 3000));
    console.log(`Sent ${stats.msgsSent} messages, received ${stats.msgsReceived} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  }

  if (HOLD_MS > 0) {
    console.log(`Holding ${stats.connected} sockets for ${HOLD_MS / 1000}s...`);
    await new Promise(r => setTimeout(r, HOLD_MS));
  }

  const metricsAfter = await fetch(URL + '/metrics').then(r => r.text()).catch(() => '');
  for (const s of sockets) s.disconnect();

  // 5. report
  const wall = (Date.now() - t0) / 1000;
  console.log('\n==== RESULTS ====');
  console.log(`wall time:            ${wall.toFixed(1)}s`);
  console.log(`signups:              ${stats.signedUp}/${PAIRS * 2}`);
  console.log(`sockets connected:    ${stats.connected}/${PAIRS * 2}`);
  console.log(`connect errors:       ${stats.connectErrors}`);
  console.log(`matched:              ${stats.matched}/${PAIRS * 2}`);
  console.log(`messages sent:        ${stats.msgsSent}`);
  console.log(`messages received:    ${stats.msgsReceived}`);
  console.log(`other errors:         ${stats.errors}`);
  const gauges = {};
  for (const line of metricsAfter.split('\n')) {
    const m = /^([a-z_]+) ([0-9.]+)$/.exec(line);
    if (m) gauges[m[1]] = m[2];
  }
  console.log('\nserver gauges (after):');
  for (const k of ['socket_connections_active', 'queue_waiting_male', 'queue_waiting_female', 'pairs_active', 'event_loop_lag_ms', 'heap_used_mb', 'rss_mb']) {
    if (gauges[k] !== undefined) console.log(`  ${k.padEnd(24)} ${gauges[k]}`);
  }
  console.log(`\ncleanup hint:  DELETE FROM users WHERE username LIKE 'lt\\\\_${RUN}%';`);
  void metricsBefore; void pct; void fmt;
}

main().catch(e => { console.error('LOAD TEST CRASHED:', e); process.exit(1); });
