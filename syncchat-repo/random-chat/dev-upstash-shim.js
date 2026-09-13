/**
 * Minimal local stand-in for the Upstash Redis REST API, so the real
 * server/db.js (@upstash/redis client) can run offline. Implements only
 * GET / SET (with EX) / DEL, which is all the cache-aside layer uses.
 */
const http = require('http');

const store = new Map(); // key -> { value, expiresAt }

function get(key) {
  const e = store.get(key);
  if (!e) return null;
  if (e.expiresAt && Date.now() > e.expiresAt) { store.delete(key); return null; }
  return e.value;
}

function exec(cmd) {
  const op = String(cmd[0] || '').toLowerCase();
  if (op === 'get') return get(cmd[1]);
  if (op === 'set') {
    let ttl = null;
    for (let i = 3; i < cmd.length; i++) {
      if (String(cmd[i]).toLowerCase() === 'ex') ttl = Number(cmd[i + 1]);
    }
    store.set(cmd[1], { value: cmd[2], expiresAt: ttl ? Date.now() + ttl * 1000 : null });
    return 'OK';
  }
  if (op === 'del') { let n = 0; for (const k of cmd.slice(1)) if (store.delete(k)) n++; return n; }
  if (op === 'ping') return 'PONG';
  return null;
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    res.setHeader('Content-Type', 'application/json');
    try {
      let cmds;
      if (body && body.trim()) cmds = JSON.parse(body);
      else cmds = decodeURIComponent(req.url).split('/').filter(Boolean);
      // Pipeline (array of arrays) vs single command
      const result = Array.isArray(cmds[0])
        ? cmds.map((c) => ({ result: exec(c) }))
        : { result: exec(cmds) };
      res.end(JSON.stringify(result));
    } catch (e) {
      res.statusCode = 400;
      res.end(JSON.stringify({ error: e.message }));
    }
  });
}).listen(8079, '127.0.0.1', () => console.log('UPSTASH_SHIM_UP on 8079'));
