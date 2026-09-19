# ShincChat load test

Spins up real users against a running server: signup → socket connect →
match → message exchange, with latencies and the server's own gauges
reported at the end. **Run it against staging, never production** — it
creates real database rows.

```bash
npm install

# full flow: 100 pairs (200 users), 20 messages each
node load.js --url http://127.0.0.1:3000 --pairs 100 --msg 20

# connection soak: 500 pairs connect+match, then hold idle for 60s
node load.js --url http://127.0.0.1:3000 --pairs 500 --msg 0 --hold 60000
```

| Flag | Default | Meaning |
|---|---|---|
| `--url` | `http://127.0.0.1:3100` | server to test |
| `--pairs` | 50 | user pairs to create (2× this many users) |
| `--msg` | 20 | messages each pair exchanges |
| `--ramp` | 15000 | connection ramp window (ms) |
| `--hold` | 0 | hold sockets open this long after matching (idle-socket soak) |

Each virtual user presents its own `X-Forwarded-For` address, like real
traffic behind a proxy (otherwise the server's per-IP rate limiter —
correctly — throttles the whole generator to one bucket).

## Reading the results

- **matched should equal pairs×2.** Less means the matcher is falling
  behind — check `queue_waiting_*` in `/metrics`.
- **errors / connectErrors should be 0.** Connect errors at scale usually
  mean fd limits or a proxy timeout, not the app.
- Watch `/metrics` on the server while it runs:
  - `event_loop_lag_ms` — healthy is < 50 ms sustained; hundreds means the
    worker is CPU-saturated → add workers.
  - `rss_mb` vs the container limit → memory ceiling.
  - `pairs_active` / `queue_waiting_*` should match the run.
- Heap per worker in this repo's test runs: ~33 MB at 300 pairs — memory
  is not the first ceiling, CPU is.

## Cleanup

Test users are prefixed `lt_<run id>`:

```sql
DELETE FROM users WHERE username LIKE 'lt\_%';
```

(On a throwaway/staging DB you can skip this.)
