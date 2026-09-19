// Cluster bootstrap — one process per CPU core, sharing the port.
//
// Why this exists: a single Node process uses one core. On the free-tier VM
// targets (e.g. Oracle Always Free, 2 OCPU) that halves the machine; on
// bigger boxes it wastes almost all of it. With the Redis-backed state
// layer (server/state.js) the workers coordinate matching, presence and
// pairing, so scaling out is just a worker count.
//
//   WEB_CONCURRENCY=4 node server/boot.js
//
// Render/free single-dyno hosts should keep using `npm start`
// (server/index.js) — one process, in-memory state backend.
'use strict';

const cluster = require('cluster');
const os = require('os');

const WORKERS = Math.max(1, Math.min(16,
  parseInt(process.env.WEB_CONCURRENCY, 10) || os.cpus().length
));

if (cluster.isPrimary) {
  console.log(`ShincChat cluster: starting ${WORKERS} worker(s)`);
  for (let i = 0; i < WORKERS; i++) cluster.fork();
  let shuttingDown = false;
  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;
    // A worker that dies takes its sockets with it — clients reconnect and
    // their JWT sessions still work (stateless), so this is self-healing.
    console.error(`Worker ${worker.process.pid} died (${signal || code}) — restarting`);
    cluster.fork();
  });
  process.on('SIGTERM', () => {
    shuttingDown = true;
    for (const id in cluster.workers) cluster.workers[id].process.kill('SIGTERM');
    setTimeout(() => process.exit(0), 5000);
  });
  process.on('SIGINT', () => {
    shuttingDown = true;
    for (const id in cluster.workers) cluster.workers[id].process.kill('SIGINT');
    setTimeout(() => process.exit(0), 5000);
  });
} else {
  require('./index.js');
}
