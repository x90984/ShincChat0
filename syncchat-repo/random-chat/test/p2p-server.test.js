// Integration test for the P2P-mode server surface, run against the real
// server with faked Postgres/Redis (see server-with-fakes.js):
//
//   1. Two users sign up and get matched.
//   2. matched payloads carry client ICE config (STUN + optional TURN).
//   3. The chat-message / voice-message fallback relays forward content to
//      the partner WITHOUT storing it.
//   4. conv-activity pings update unread counters + content-free previews.
//   5. mark-seen clears only the caller's unread counter.
//   6. delete-for-everyone writes an ID-only tombstone, surfaced on resume.
//
// Usage: node test/p2p-server.test.js   (exits non-zero on failure)

const { spawn } = require('child_process');
const path = require('path');
const { io } = require('socket.io-client');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}${extra ? ' — ' + JSON.stringify(extra) : ''}`); }
}

function waitForSocketEvent(socket, event, ms = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for "${event}"`)), ms);
    socket.once(event, (payload) => { clearTimeout(timer); resolve(payload); });
  });
}

async function signup(name, genderBirth) {
  const res = await fetch(`${BASE}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: name,
      username: name.toLowerCase() + Math.floor(Math.random() * 9999),
      identifier: `${name}${Date.now()}@example.com`,
      password: 'secret123',
      birthDate: '1995-01-01',
      ...genderBirth
    })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`signup failed: ${data.error}`);
  return data.token;
}

async function setGender(token, gender) {
  const res = await fetch(`${BASE}/api/set-gender`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ gender })
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`set-gender failed: ${data.error}`);
}

async function history(token) {
  const res = await fetch(`${BASE}/api/history`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function messages(token, convId) {
  const res = await fetch(`${BASE}/api/history/${convId}/messages`, { headers: { Authorization: `Bearer ${token}` } });
  return res.json();
}

async function main() {
  console.log('Starting server with faked Postgres/Redis...');
  const server = spawn(process.execPath, [path.join(__dirname, 'server-with-fakes.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let serverOut = '';
  server.stdout.on('data', d => { serverOut += d; });
  server.stderr.on('data', d => { serverOut += d; });

  try {
    // Wait for the listen log line.
    await new Promise((resolve, reject) => {
      const started = setInterval(() => {
        if (serverOut.includes('running on port')) { clearInterval(started); resolve(); }
        if (server.exitCode !== null) { clearInterval(started); reject(new Error('server exited early: ' + serverOut)); }
      }, 100);
      setTimeout(() => { clearInterval(started); reject(new Error('server boot timeout: ' + serverOut)); }, 15000);
    });
    console.log('Server is up.\n');

    const tokenA = await signup('Alice', {});
    const tokenB = await signup('Bob', {});
    await setGender(tokenA, 'female');
    await setGender(tokenB, 'male');

    const a = io(BASE, { transports: ['websocket'] });
    const b = io(BASE, { transports: ['websocket'] });
    await Promise.all([waitForSocketEvent(a, 'connect'), waitForSocketEvent(b, 'connect')]);
    a.emit('auth', { token: tokenA });
    b.emit('auth', { token: tokenB });
    await new Promise(r => setTimeout(r, 500)); // let server-side auth finish

    console.log('--- Matching ---');
    const matchA = waitForSocketEvent(a, 'matched');
    const matchB = waitForSocketEvent(b, 'matched');
    a.emit('find-partner', { gender: 'female', lookingFor: 'male', countryMode: 'random' });
    b.emit('find-partner', { gender: 'male', lookingFor: 'female', countryMode: 'random' });
    const [mA, mB] = await Promise.all([matchA, matchB]);
    check('both sides matched with same conversation', !!mA.conversationId && mA.conversationId === mB.conversationId);
    check('matched carries ICE config (STUN at minimum)', !!(mA.rtcConfig && Array.isArray(mA.rtcConfig.iceServers) && mA.rtcConfig.iceServers.length), mA.rtcConfig);
    const convId = mA.conversationId;

    console.log('\n--- Fallback relay (content-blind) ---');
    const incoming = waitForSocketEvent(b, 'chat-message');
    a.emit('chat-message', { id: 'msg-1', ts: Date.now(), text: 'hello over fallback', replyTo: null });
    const got = await incoming;
    check('partner receives fallback-relayed text', got.text === 'hello over fallback' && got.id === 'msg-1');

    const incomingVoice = waitForSocketEvent(b, 'voice-message');
    a.emit('voice-message', { id: 'voice-1', ts: Date.now(), audio: 'data:audio/webm;base64,AAAA' });
    const gotVoice = await incomingVoice;
    check('partner receives fallback-relayed voice message', gotVoice.id === 'voice-1');

    console.log('\n--- Content-free metadata ---');
    a.emit('conv-activity', { type: 'text' });
    a.emit('conv-activity', { type: 'voice' });
    await new Promise(r => setTimeout(r, 300));

    const histB = await history(tokenB);
    const convoB = histB.conversations.find(c => c.conversationId === convId);
    check('partner chat list has the conversation', !!convoB);
    check('unread counter incremented for receiver', convoB && convoB.unreadCount === 2, convoB && convoB.unreadCount);
    check('preview is content-free (type + sender, no text)', convoB && convoB.lastMessage && convoB.lastMessage.type === 'voice' && convoB.lastMessage.text === null && convoB.lastMessage.mine === false, convoB && convoB.lastMessage);

    const histA = await history(tokenA);
    const convoA = histA.conversations.find(c => c.conversationId === convId);
    check('sender has zero unread', convoA && convoA.unreadCount === 0, convoA && convoA.unreadCount);

    console.log('\n--- mark-seen clears receiver unread only ---');
    b.emit('mark-seen');
    await new Promise(r => setTimeout(r, 300));
    const histB2 = await history(tokenB);
    check('receiver unread cleared', histB2.conversations.find(c => c.conversationId === convId).unreadCount === 0);

    console.log('\n--- Delete-for-everyone → ID-only tombstone ---');
    const deletedAtPartner = waitForSocketEvent(b, 'message-deleted');
    a.emit('delete-message', { messageId: 'msg-1', mode: 'everyone' });
    const delEvt = await deletedAtPartner;
    check('partner notified of deletion', delEvt.messageId === 'msg-1');
    const msgsResp = await messages(tokenB, convId);
    check('tombstone present, no message content stored anywhere', Array.isArray(msgsResp.tombstones) && msgsResp.tombstones.includes('msg-1') && msgsResp.messages.length === 0, msgsResp);

    console.log('\n--- WebRTC signaling relay still works ---');
    const offerAtB = waitForSocketEvent(b, 'webrtc-offer');
    a.emit('webrtc-offer', { sdp: { type: 'offer', sdp: 'fake-sdp' } });
    const offer = await offerAtB;
    check('offer relayed opaquely', offer.sdp.sdp === 'fake-sdp');

    console.log(failures === 0 ? '\nAll checks passed ✔' : `\n${failures} check(s) FAILED ✘`);
  } catch (e) {
    failures++;
    console.error('\nTest error:', e.message);
    console.error(serverOut.split('\n').slice(-20).join('\n'));
  } finally {
    server.kill('SIGTERM');
    setTimeout(() => process.exit(failures === 0 ? 0 : 1), 500);
  }
}

main();
