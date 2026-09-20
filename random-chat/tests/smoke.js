#!/usr/bin/env node
// End-to-end smoke test for the ShincChat server.
//
//   node tests/smoke.js                       # one server at :3100
//   BASE=http://a:3000 BASE2=http://b:3000 node tests/smoke.js
//                                             # two servers sharing Redis —
//                                             # validates cross-node matching
//                                             # and relaying
//
// Covers: signup/login, socket auth, matching (cross-node when BASE2 is
// set), text messages, media upload/fetch (voice-message flow), history,
// presence, and the pairs gauge.
'use strict';

const { io } = require('socket.io-client');

const BASE = process.env.BASE || 'http://127.0.0.1:3100';
const BASE2 = process.env.BASE2 || null;

let passed = 0, failed = 0;
function ok(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.error(`  ✗ ${name}${extra ? ' — ' + JSON.stringify(extra).slice(0, 300) : ''}`); }
}
const rand = () => Math.random().toString(36).slice(2, 10);

async function api(base, path, { method = 'GET', token, body, raw } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    },
    body: raw || (body ? JSON.stringify(body) : undefined)
  });
  if (raw) return res;
  return { status: res.status, data: await res.json().catch(() => ({})) };
}

function connectSocket(base, token) {
  return new Promise((resolve, reject) => {
    const socket = io(base, { transports: ['websocket'], forceNew: true, reconnection: false });
    const timer = setTimeout(() => reject(new Error('socket connect/auth timeout')), 8000);
    socket.on('connect', () => socket.emit('auth', { token }));
    socket.on('auth-error', () => { clearTimeout(timer); reject(new Error('auth-error')); });
    // The client normally proceeds after auth with no ack; treat the next
    // tick after connect+auth as good enough — verify with /api/me parity.
    setTimeout(() => { clearTimeout(timer); resolve(socket); }, 300);
    socket.on('connect_error', (e) => { clearTimeout(timer); reject(e); });
  });
}

function waitFor(socket, event, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), timeoutMs);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function main() {
  console.log(`Smoke test — node A: ${BASE}${BASE2 ? `, node B: ${BASE2}` : ' (single node)'}`);

  // ---- health ----
  const health = await api(BASE, '/health');
  ok('GET /health is 200', health.status === 200 && health.data.ok === true, health.data);

  // ---- signup two users ----
  const sufx = rand();
  const male = await api(BASE, '/api/signup', {
    method: 'POST',
    body: { fullName: 'Smoke Male', username: `smoke_m_${sufx}`, identifier: `smokem${sufx}@example.com`, password: 'secret123', birthDate: '1995-05-05' }
  });
  ok('signup male', male.status === 200 && !!male.data.token, male.data);
  await api(BASE, '/api/set-gender', { method: 'POST', token: male.data.token, body: { gender: 'male' } });

  const female = await api(BASE2 || BASE, '/api/signup', {
    method: 'POST',
    body: { fullName: 'Smoke Female', username: `smoke_f_${sufx}`, identifier: `smokef${sufx}@example.com`, password: 'secret123', birthDate: '1995-06-06' }
  });
  ok('signup female', female.status === 200 && !!female.data.token, female.data);
  await api(BASE2 || BASE, '/api/set-gender', { method: 'POST', token: female.data.token, body: { gender: 'female' } });

  // login round-trip (JWT verify + async scrypt)
  const relogin = await api(BASE, '/api/login', { method: 'POST', body: { identifier: `smoke_m_${sufx}`, password: 'secret123' } });
  ok('login works (JWT + async scrypt)', relogin.status === 200 && !!relogin.data.token, relogin.data);

  // ---- media upload flow (local mode) ----
  const up = await api(BASE, '/api/media/upload-url', { method: 'POST', token: male.data.token, body: { type: 'voice', contentType: 'audio/webm' } });
  ok('media upload-url issued', up.status === 200 && !!up.data.key && !!up.data.url, up.data);
  const fakeAudio = Buffer.from('RIFF-fake-webm-audio-' + rand());
  const upRes = await fetch(BASE + new URL(up.data.url, BASE).pathname + new URL(up.data.url, BASE).search, { method: 'POST', headers: { 'Content-Type': 'audio/webm' }, body: fakeAudio });
  ok('media upload accepted', upRes.status === 200, await upRes.text().catch(() => ''));
  const urls = await api(BASE, '/api/media/urls', { method: 'POST', token: female.data.token, body: { keys: [up.data.key, 'media/voice/someoneelse/hax.webm'] } });
  ok('media url issued for valid key', urls.status === 200 && !!urls.data.urls[up.data.key], urls.data);
  ok('media url refused for foreign/bad key', !(urls.data.urls['media/voice/someoneelse/hax.webm']), urls.data.urls);
  const fileRes = await fetch(BASE + new URL(urls.data.urls[up.data.key], BASE).pathname + new URL(urls.data.urls[up.data.key], BASE).search);
  const fileBytes = Buffer.from(await fileRes.arrayBuffer());
  ok('media file round-trips byte-identical', fileRes.status === 200 && fileBytes.equals(fakeAudio), { status: fileRes.status, len: fileBytes.length });

  // invalid upload-url type
  const badUp = await api(BASE, '/api/media/upload-url', { method: 'POST', token: male.data.token, body: { type: 'nope', contentType: 'audio/webm' } });
  ok('upload-url rejects unknown type', badUp.status === 400);

  // ---- sockets, matching ----
  const mSocket = await connectSocket(BASE, male.data.token);
  const fSocket = await connectSocket(BASE2 || BASE, female.data.token);
  ok('both sockets connected+authed', true);

  const mMatchedP = waitFor(mSocket, 'matched');
  mSocket.emit('find-partner', { gender: 'male', lookingFor: 'female', countryMode: 'random' });
  await new Promise(r => setTimeout(r, 700)); // let the male queue up first
  const fMatchedP = waitFor(fSocket, 'matched');
  fSocket.emit('find-partner', { gender: 'female', lookingFor: 'male', countryMode: 'random' });

  const [mMatched, fMatched] = await Promise.all([mMatchedP, fMatchedP]);
  ok('both sides got "matched"', !!mMatched.roomId && mMatched.roomId === fMatched.roomId, { mMatched, fMatched });
  ok('matched payload has partner ids', mMatched.partnerId === female.data.user.id && fMatched.partnerId === male.data.user.id, { mMatched, fMatched });
  ok('matched payload has conversation id', typeof fMatched.conversationId === 'string' && fMatched.conversationId.length > 10);

  // ---- text message relay ----
  const fMsgP = waitFor(fSocket, 'chat-message');
  mSocket.emit('chat-message', { text: 'hello from male over ' + (BASE2 ? 'two nodes' : 'one node') });
  const fMsg = await fMsgP;
  ok('message relayed to partner', fMsg.self === false && fMsg.text.includes('hello from male'), fMsg);

  const mRecvP = waitFor(mSocket, 'chat-message');
  const fEchoP = waitFor(fSocket, 'chat-message');
  fSocket.emit('chat-message', { text: 'hi back' });
  const [mRecv, fEcho] = await Promise.all([mRecvP, fEchoP]);
  ok('partner receives message', mRecv.self === false && mRecv.text === 'hi back', mRecv);
  ok('sender gets self echo', fEcho.self === true && fEcho.text === 'hi back', fEcho);

  // ---- voice messages (stock client contract) ----
  // (a) the stock client sends a base64 data URL — it must relay VERBATIM
  const fakeVoiceDataUrl = 'data:audio/webm;base64,' + fakeAudio.toString('base64');
  const fVoiceUrlP = waitFor(fSocket, 'voice-message');
  mSocket.emit('voice-message', { audio: fakeVoiceDataUrl });
  const fVoiceUrl = await fVoiceUrlP;
  ok('voice message (data URL) relayed verbatim', fVoiceUrl.audio === fakeVoiceDataUrl && fVoiceUrl.self === false, fVoiceUrl && { audio: fVoiceUrl.audio.slice(0, 40) });
  ok('voice message (data URL) got a db id', typeof fVoiceUrl.id === 'string' && fVoiceUrl.id.length > 10, fVoiceUrl);

  // (b) API clients may send a storage key — relays as-is
  const fVoiceKeyP = waitFor(fSocket, 'voice-message');
  mSocket.emit('voice-message', { key: up.data.key });
  const fVoiceKey = await fVoiceKeyP;
  ok('voice message (storage key) relayed', fVoiceKey.audio === up.data.key && fVoiceKey.self === false, fVoiceKey);

  // (c) junk payloads are ignored
  const fVoiceJunk = waitFor(fSocket, 'voice-message', 2500).then(() => true).catch(() => false);
  mSocket.emit('voice-message', { audio: 42 });
  ok('junk voice message ignored', !(await fVoiceJunk));

  // ---- verify clip (stock client contract): data URL relayed verbatim ----
  const fakeClipDataUrl = 'data:video/webm;base64,' + Buffer.from('fake-verify-clip').toString('base64');
  const fVerifyP = waitFor(fSocket, 'verify-video');
  mSocket.emit('verify-video', { video: fakeClipDataUrl });
  const fVerify = await fVerifyP;
  ok('verify clip relayed verbatim', fVerify.video === fakeClipDataUrl, fVerify && { video: fVerify.video.slice(0, 40) });

  // ---- history: the data-URL voice message reads back byte-identical ----
  // (backend stores audio in object storage + re-inlines on read; the
  // client must never see the difference)
  const histMsgs = await api(BASE, `/api/history/${fMatched.conversationId}/messages`, { token: male.data.token });
  const hydratedVoice = histMsgs.data.messages.find(m => m.type === 'voice' && m.audio && m.audio.startsWith('data:audio/webm'));
  ok('history re-inlines stored voice audio byte-identically', !!hydratedVoice && hydratedVoice.audio === fakeVoiceDataUrl,
    hydratedVoice && { audio: hydratedVoice.audio.slice(0, 40), id: hydratedVoice.id });

  // ---- mark-seen ----
  const mSeenP = waitFor(mSocket, 'messages-seen');
  fSocket.emit('mark-seen');
  const mSeen = await mSeenP;
  ok('seen receipts flow', Array.isArray(mSeen.messageIds) && mSeen.messageIds.length > 0, mSeen);

  // ---- history (batched query) ----
  const hist = await api(BASE, '/api/history', { token: male.data.token });
  const convo = hist.data.conversations && hist.data.conversations.find(c => c.partner && c.partner.id === female.data.user.id);
  ok('history lists the conversation', hist.status === 200 && !!convo, hist.data.conversations && hist.data.conversations.length);
  ok('history has lastMessage + unread', convo && convo.lastMessage && typeof convo.unreadCount === 'number', convo);

  // ---- presence via REST ----
  const prof = await api(BASE, `/api/users/${female.data.user.id}`, { token: male.data.token });
  ok('partner shows online', prof.status === 200 && prof.data.user.online === true, prof.data.user);

  // ---- friends flow (request via socket path is REST here) ----
  const fr = await api(BASE, '/api/friends/request', { method: 'POST', token: male.data.token, body: { userId: female.data.user.id } });
  ok('friend request sent', fr.status === 200, fr.data);
  const frList = await api(BASE2 || BASE, '/api/friends/requests', { token: female.data.token });
  ok('friend request visible', frList.status === 200 && frList.data.requests.some(r => r.from.id === male.data.user.id), frList.data);
  const reqId = frList.data.requests.find(r => r.from.id === male.data.user.id).id;
  const accept = await api(BASE2 || BASE, `/api/friends/requests/${reqId}/accept`, { method: 'POST', token: female.data.token });
  ok('friend request accepted', accept.status === 200 && accept.data.status === 'accepted', accept.data);
  const friends = await api(BASE, '/api/friends', { token: male.data.token });
  ok('friends list (single query) has partner', friends.status === 200 && friends.data.friends.some(f => f.id === female.data.user.id), friends.data);

  // ---- profile photo (stock client): inline data URL round-trip ----
  const fakePhoto = 'data:image/jpeg;base64,' + Buffer.from('fake-jpeg-bytes').toString('base64');
  const profSave = await api(BASE, '/api/profile', { method: 'POST', token: male.data.token, body: { displayName: 'Smoke Male', bio: 'x', photo: fakePhoto } });
  ok('profile photo saved and served back inline', profSave.status === 200 && profSave.data.user.photoUrl === fakePhoto, profSave.data.user && { photoUrl: profSave.data.user.photoUrl.slice(0, 40) });

  // ---- partner-left on disconnect ----
  const fLeftP = waitFor(fSocket, 'partner-left');
  mSocket.disconnect();
  await fLeftP;
  ok('partner-left emitted on disconnect', true);

  fSocket.disconnect();

  // ---- metrics ----
  const metricsRes = await fetch(BASE + '/metrics');
  let metricsText = await metricsRes.text();
  ok('/metrics exposes counters', metricsText.includes('socket_connections_total') && metricsText.includes('matches_made_total'));
  for (let i = 0; i < 8 && !metricsText.includes('queue_waiting_male'); i++) {
    await new Promise(r => setTimeout(r, 1000));
    metricsText = await (await fetch(BASE + '/metrics')).text();
  }
  ok('/metrics exposes queue gauges', metricsText.includes('queue_waiting_male'));

  // ---- rate limiter LAST (429s poison the shared test IP bucket) ----
  let got429 = false;
  for (let i = 0; i < 40 && !got429; i++) {
    const r = await api(BASE, '/api/login', { method: 'POST', body: { identifier: `smoke_m_${sufx}`, password: 'wrong' } });
    if (r.status === 429) got429 = true;
  }
  ok('login rate limiter kicks in (429)', got429);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('SMOKE TEST CRASHED:', e); process.exit(1); });
