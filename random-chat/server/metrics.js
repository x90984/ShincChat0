// Lightweight Prometheus-style metrics + event-loop lag gauge.
// Zero dependencies: counters are plain numbers, /metrics renders text.
// Scrape it with any collector (or just curl it) — see SCALING.md.
'use strict';

const counters = {
  http_requests_total: 0,
  http_429_total: 0,
  socket_connections_total: 0,
  socket_messages_relayed_total: 0,
  matches_made_total: 0,
  media_uploads_total: 0,
  db_errors_total: 0
};

const gauges = {
  socket_connections_active: 0,
  event_loop_lag_ms: 0,
  heap_used_mb: 0,
  rss_mb: 0
};

function inc(name, n = 1) {
  if (name in counters) counters[name] += n;
}
function setGauge(name, value) {
  // Gauges may be registered dynamically (queue depth, pairs, ...).
  if (typeof value === 'number' && Number.isFinite(value)) gauges[name] = value;
}

// Event-loop lag: how long a timer had to wait past its deadline. The best
// single number for "is this node saturated".
let lastLagCheck = Date.now();
setInterval(() => {
  const start = lastLagCheck = Date.now();
  setImmediate(() => {
    setGauge('event_loop_lag_ms', Math.max(0, Date.now() - start));
    const m = process.memoryUsage();
    setGauge('heap_used_mb', Math.round(m.heapUsed / 1048576 * 10) / 10);
    setGauge('rss_mb', Math.round(m.rss / 1048576 * 10) / 10);
  });
}, 5000).unref();

// Live gauges the app registers (sockets online, queue depth per gender).
const liveGauges = {}; // name -> () => number
function registerGauge(name, fn) { liveGauges[name] = fn; }

function render() {
  const lines = [];
  lines.push('# ShincChat metrics');
  for (const [k, v] of Object.entries(counters)) {
    lines.push(`# TYPE ${k} counter`, `${k} ${v}`);
  }
  for (const [k, v] of Object.entries(gauges)) {
    lines.push(`# TYPE ${k} gauge`, `${k} ${v}`);
  }
  for (const [name, fn] of Object.entries(liveGauges)) {
    let v = 0;
    try { v = fn(); } catch (e) { /* gauge source unavailable */ }
    lines.push(`# TYPE ${name} gauge`, `${name} ${v}`);
  }
  return lines.join('\n') + '\n';
}

module.exports = { inc, setGauge, registerGauge, render };
