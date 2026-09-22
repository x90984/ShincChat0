// Unit tests for the shared-state store's concurrency-critical semantics
// (pair claiming, queue guards, presence clearing). Runs against the
// in-memory implementation; the Redis implementation mirrors the exact
// same semantics via Lua scripts.
//
// Usage: node test/store.test.js   (exits non-zero on failure)

const { createMemoryStore } = require('../server/store');

let failures = 0;
function check(name, cond, extra) {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.error(`  FAIL ${name}${extra !== undefined ? ' — ' + JSON.stringify(extra) : ''}`); }
}

async function main() {
  const s = createMemoryStore();

  console.log('--- sessions ---');
  await s.setSession('t1', 'user-a');
  check('session round-trip', (await s.getSession('t1')) === 'user-a');
  check('unknown session is null', (await s.getSession('nope')) === null);

  console.log('--- pair claiming ---');
  check('claimPair succeeds on free sockets', await s.claimPair('s1', 's2'));
  check('partner visible both ways', (await s.getPartner('s1')) === 's2' && (await s.getPartner('s2')) === 's1');
  check('claimPair refuses an already-paired socket', !(await s.claimPair('s1', 's3')));
  check('refused claim leaves original pairing intact', (await s.getPartner('s1')) === 's2');

  console.log('--- waiting queue guards ---');
  await s.addToWaiting('female', 's9');
  check('waiting entry visible', (await s.sampleWaiting('female', 10)).includes('s9'));
  await s.claimPair('s9', 's8');
  check('claimPair removes both from waiting queues', !(await s.sampleWaiting('female', 10)).includes('s9'));
  await s.addToWaiting('female', 's9');
  check('addToWaiting refuses a paired socket', !(await s.sampleWaiting('female', 10)).includes('s9'));

  console.log('--- unpair ---');
  await s.pairDirect('s5', 's6');
  check('pairDirect pairs', (await s.getPartner('s5')) === 's6');
  const ex = await s.unpair('s5');
  check('unpair returns former partner', ex === 's6');
  check('unpair clears both directions', !(await s.isPaired('s5')) && !(await s.isPaired('s6')));
  check('unpair on unpaired socket returns null', (await s.unpair('s5')) === null);

  console.log('--- presence ---');
  await s.setOnline('u1', 'sock-a');
  await s.clearOnlineIf('u1', 'sock-b'); // stale socket — must NOT clear
  check('stale socket cannot clear presence', (await s.getOnline('u1')) === 'sock-a');
  await s.clearOnlineIf('u1', 'sock-a');
  check('current socket clears presence', (await s.getOnline('u1')) === null);

  console.log('--- concurrent claim race (simulated) ---');
  // Two matchers racing for the same candidate: exactly one must win.
  const results = await Promise.all([s.claimPair('a1', 'target'), s.claimPair('a2', 'target')]);
  check('exactly one racer wins', results.filter(Boolean).length === 1, results);

  console.log('--- conversation socket tracking ---');
  await s.joinConversation('c1', 's1');
  await s.joinConversation('c1', 's2');
  check('both sockets tracked', (await s.getConversationSockets('c1')).length === 2);
  await s.leaveConversation('c1', 's1');
  check('leave removes socket', (await s.getConversationSockets('c1')).join(',') === 's2');

  console.log(failures === 0 ? '\nAll store checks passed ✔' : `\n${failures} store check(s) FAILED ✘`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(e => { console.error(e); process.exit(1); });
