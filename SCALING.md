# ShincChat at scale — architecture, capacity, and the honest $0 math

This document is the map: what the app can actually hold, what each free
tier really gives you, what was changed to get here, and what to do when a
ceiling is hit. Numbers marked **[verified]** were measured in this repo with
`loadtest/` (see "Run the load test yourself").

---

## 1. The one-paragraph reality check

"Millions of simultaneous users for free" does not exist. A million
concurrent WebSocket connections means tens of GB of RAM and dozens of CPU
cores across many machines — roughly **$5–15k/month** on any cloud, at any
provider. What *is* achievable for $0 today, with this codebase:

| Deployment | Concurrent capacity | Notes |
|---|---|---|
| Render free (single 512 MB / 0.1 CPU dyno) | ~1–3k sockets, sleeps after 15 min idle | zero-ops, good for launch-day validation |
| Oracle Always Free VM (2 OCPU / 12 GB ARM) + this docker-compose stack | **~30–60k sockets** (estimate — verify with the load test) | the most free compute available anywhere |
| Same stack on a $5–10/mo VPS (4–8 GB) | ~50–150k sockets | the first paid step |
| "Millions" | 20–60× the free VM | ~$5–15k+/month — see §7 |

Everything between those rows is now a **config change** (worker count,
`--scale app=N`, a bigger VM), not a rewrite. That is what this round of
work bought: the app's state no longer lives in one process.

---

## 2. What changed (architecture)

```
                       ┌──────────────────────────────────────┐
                       │  Caddy (TLS, HTTP + WebSocket LB)    │
                       └───────┬──────────────┬───────────────┘
                               │              │
                       ┌───────▼─────┐ ┌──────▼──────┐      N app workers
                       │ app worker 1│ │ app worker n│      (docker compose
                       │  (Node)     │ │  (Node)     │       --scale app=N)
                       └──┬───────┬──┘ └──┬───────┬──┘
                          │       │       │       │
          matching/pairs/presence  │       │       user/profile/message
          (shared state)           │       │       data (Postgres)
                                  ▼       ▼
                          ┌──────────┐  ┌──────────┐   ┌──────────────┐
                          │  Redis   │  │ Postgres │   │ R2 / S3      │
                          │ queues,  │  │ users,   │   │ voice msgs,  │
                          │ pairs,   │  │ convos,  │   │ verify clips │
                          │ presence │  │ messages │   │ (presigned)  │
                          └──────────┘  └──────────┘   └──────────────┘
                                 video calls: peer-to-peer WebRTC
                                 (TURN relay only when NATs force it)
```

| Before | After |
|---|---|
| Sessions in a `Map` — every restart logged everyone out; a second process broke logins | Stateless HS256 JWTs (`server/session.js`) — survive restarts, work across N workers |
| Matching queues/pairs/presence in process memory — **the app could only ever be one process** | `server/state.js` with two backends: in-memory (single process, exact old semantics) and Redis (any number of workers; atomic Lua pairing claims; per-gender × per-country bucket ZSETs; FIFO like before) |
| Socket.IO emits only reached sockets on the same process | `@socket.io/redis-adapter` carries every emit cross-worker |
| Voice messages / verify clips / photos as base64 **through the socket and into Postgres TEXT** (≈1 MB per verify clip; a 500 MB free DB is full after ~500 clips) | Presigned uploads to S3-compatible storage (Cloudflare R2: 10 GB free, **zero egress fees**) with a signed local-disk fallback; sockets carry ~40-byte keys; `maxHttpBufferSize` cut from 8 MB to 64 KB |
| Upstash Redis **required at boot** — but free tier is ~500k commands/**month**, exhausted in a day by the per-request user cache | Cache layer picks the best backend: local Redis → Upstash (if that's all you have) → in-process LRU. Nothing external is required on the VM stack |
| `scryptSync` on login blocked the event loop ~50 ms per attempt | Async scrypt (plus per-IP + per-identifier login rate limits) |
| `/api/history`: 3 DB queries per conversation (60+ round-trips for 20 chats); same N+1 pattern in friends/search/contacts/recent-partners | Single-query batched versions (`listConversationsDetailed`, `friendStatusBatch`, `getReviewsForUsers`, …) |
| OAuth login state in a `Map` — fails ~50% of the time behind a load balancer | Signed short-lived httpOnly cookie — any worker can complete the callback |
| Admin panel still on SQLite (`better-sqlite3`) — broken since the Postgres move | Ported to `pg`, points at the same `DATABASE_URL` |
| WebRTC STUN-only — video silently fails behind symmetric NAT (very common on mobile data in India) | `GET /api/ice` serves STUN + TURN credentials (HMAC time-limited scheme — Cloudflare Realtime TURN or coturn `use-auth-secret`) |
| HTTP long-polling allowed (2× connection overhead), `perMessageDeflate` burning ~30% CPU | WebSocket-only transport, compression off, 25s/20s ping timeouts |
| No metrics, no rate limits, no cluster mode | `/metrics` (Prometheus text), `/health` (DB-aware), token-bucket limiters per IP/event, `server/boot.js` cluster bootstrap, Dockerfile + compose + Caddy |

**Matching semantics preserved** (verified by test): opposite-gender FIFO by
wait time; `india`/`country` modes strict same-country for 20 s then anyone;
`nearby` within 100 km for 10 s, then same country until 25 s, then anyone;
blocked pairs never match. Small queues (<500/gender) scan every bucket —
identical to the original full scan. Above that, the bucket pre-filter
kicks in; the only behavioral difference: two *nearby*-mode users within
radius but detected in different countries (a border case) match after
widening instead of immediately.

### Known trade-offs (deliberate)

- **Verify clips auto-expire** (default 1 h, `VERIFY_CLIP_TTL_SEC`): they're
  ephemeral by design — relayed live, never part of chat history — so their
  objects are deleted by a background sweeper (`media_sweep` in media.js;
  storage stays bounded no matter how many clips are exchanged). Only edge
  affected: a verify card still on screen in a session *longer* than the TTL
  may stop re-buffering its loop. Voice messages and profile photos are
  **never** auto-deleted (they belong to history/profiles).
- **Crash detection ≤ ~5 min.** A worker that dies takes its sockets with
  it; partners detect the dead side via pair-key TTL + heartbeat, and stale
  queue entries are swept. No client sees a hang longer than that.
- **Rate limits are per worker.** Behind round-robin LB the effective global
  limit is `limit × N` — still stops single-script floods; strict global
  limits need a WAF rule in front (Cloudflare does this free).
- **`pairs_active` gauge** is exact in normal operation but can drift if a
  worker dies with both sides of pairs on it (both TTL out without a
  decrement). It's a monitoring gauge, not billing.
- **S3 upload size** is enforced at URL issuance and (hard) in local mode;
  a presigned PUT can technically carry more — set a bucket lifecycle rule
  and monitor usage.
- **Disappearing-message sweeper** runs on every worker (idempotent DB
  updates); at very high message volume, make it a single cron worker.

---

## 3. Verified results (this repo, modest CI hardware)

`loadtest/` against a 2-worker cluster + local Redis + local Postgres
(2 shared vCPU container):

| Run | Signups | Sockets | Matched | Messages | Errors | Event-loop lag | Heap/worker |
|---|---|---|---|---|---|---|---|
| smoke (2 nodes, cross-node match+relay) **[verified]** | 2 | 2 | 2 | 2 + voice/seen | 0 | — | — |
| 150 pairs | 300/300 | 300/300 | 300/300 | 3,000 | 0 | 6 ms | 33 MB |
| 300 pairs **[verified]** | 600/600 | 600/600 | 600/600 | 3,000 | 0 | 5 ms | 33 MB |

These are correctness-and-shape runs, not ceiling runs — the sandbox shares
its CPU with Postgres, Redis, and the load generator. On a dedicated
2-OCPU/12 GB VM, expect an order of magnitude more; run the same commands
there to get *your* number before telling anyone a capacity figure.

### Run the load test yourself (against staging, never production)

```bash
cd loadtest && npm install
node load.js --url https://staging.example.com --pairs 100            # full flow
node load.js --url https://staging.example.com --pairs 0 --hold 60000 # idle-socket ceiling
```

Watch `/metrics` while it runs (`curl .../metrics`): the numbers that tell
you a worker is saturated are `event_loop_lag_ms` (healthy: < 50 ms
sustained; trouble: hundreds) and `rss_mb` vs the container limit. Clean
test users afterwards with
`DELETE FROM users WHERE username LIKE 'lt\_%';`.

---

## 4. The free-tier map (what's actually free, 2026)

| Service | Free allowance | Use it for | The catch |
|---|---|---|---|
| **Oracle Cloud Always Free** | ARM VM: **2 OCPU / 12 GB** (cut from 4/24 in June 2026) + 200 GB disk, 10 TB/mo egress | the whole stack (app + Postgres + Redis + Caddy) | signup verification is picky (often needs card + retries); capacity in popular regions is scarce; one broken VM = your whole outage |
| **Cloudflare (free plan)** | unlimited DNS/DDoS proxy, WAF rate rules, STUN | fronting the VM, basic bot defense | proxied WebSockets are fine; don't proxy the DB |
| **Cloudflare R2** | 10 GB storage, 1M Class A / 10M Class B ops/mo, **zero egress fees** | voice messages, verify clips, photos | enable CORS on the bucket (see §5); add a lifecycle rule |
| **Cloudflare Realtime TURN** | 1 TB/mo relayed | video behind symmetric NATs | billed per GB after (remove the card or set a limit if paranoid) |
| **Render free** | 512 MB / 0.1 CPU, 750 instance-hours/workspace/mo, sleeps after 15 min | zero-ops demo tier | **one** always-on free service max (2 services = both suspend mid-month); no disk, no SSH |
| **Supabase free** | 500 MB Postgres, ~200 connections, 5 GB egress, pauses after 7 idle days | the DB for the Render path | tiny; moves to the VM's local Postgres when you outgrow it |
| **Upstash free** | 500k Redis commands/**month** | cache-only for the Render path | useless as a hot per-request cache at any real traffic; the VM stack doesn't need it at all |
| **cron-job.org** | free pings | keeping the Render free dyno awake | adds ~1 min cold starts anyway |

Golden rule for the $0 stack: **Oracle VM for compute, Cloudflare for edge
+ storage + TURN, self-hosted Postgres/Redis on the VM.** The only metered
dependency left is R2 ops, and chat media won't approach 1M writes/month
until you're far past ~10k concurrent users.

---

## 5. Deploy the $0 stack (Oracle VM or any Linux box)

```bash
# on the VM (Ubuntu works; ARM or x86 both fine)
curl -fsSL https://get.docker.com | sh
git clone <your-repo> && cd ShincChat0
cp .env.example .env && nano .env        # set SESSION_SECRET (openssl rand -hex 32)
docker compose up -d --build             # postgres + redis + 2 app workers + caddy
curl localhost/health                    # {"ok":true,...}
docker compose up -d --scale app=4       # more workers any time
```

DNS: point `chat.yourdomain.com` A/AAAA at the VM, set `DOMAIN=` in `.env`,
`docker compose restart caddy` — certificates are automatic. Put Cloudflare
in front (orange cloud) for free DDoS protection and cache the static
assets.

**Before real traffic — media off the VM disk:**

1. Cloudflare dashboard → R2 → create bucket `shincchat-media`
2. R2 → Manage API Tokens → create S3-style credentials
3. Bucket → Settings → CORS:
   ```json
   [{ "AllowedOrigins": ["https://chat.yourdomain.com"],
      "AllowedMethods": ["PUT", "GET"],
      "AllowedHeaders": ["content-type"], "MaxAgeSeconds": 3600 }]
   ```
4. Belt-and-braces retention rule (Settings → Object lifecycle rules):
   expire objects with the prefix `media/verify/` after **1 day**. The app
   already deletes verify clips itself (default 1 h), but a bucket rule is
   restart-proof and costs nothing. **Do not** add lifecycle rules for
   `media/voice/` or `media/photo/` — those are chat history and profiles.
5. Put the values in `.env` (`S3_ENDPOINT` is the S3 API endpoint shown in
   the bucket overview), `docker compose up -d` again.

**TURN for video (do this — a large share of mobile users need it):**
Cloudflare Zero Trust → Realtime → TURN, copy the URL(s) + token secret into
`TURN_URLS` / `TURN_SECRET` in `.env`. Verify with
`curl localhost/api/ice` — the response should list a `turn:` entry.

**Backups** (Postgres runs on the VM disk; the volume is not a backup):

```bash
0 4 * * * docker compose -f /root/ShincChat0/docker-compose.yml exec -T postgres \
  pg_dump -U shinc shincchat | gzip > /root/backups/shincchat-$(date +\%F).sql.gz
```

(Oracle's 200 GB free block storage also lets you snapshot the boot volume.)

---

## 6. Runbook — what breaks first, and the fix

| Symptom / ceiling | Cause | Fix |
|---|---|---|
| `event_loop_lag_ms` sustained > ~100 ms per worker | CPU saturation | add workers (`--scale app=N`), then bigger VM |
| Sockets start dropping at ~60–65k per VM | ephemeral port / fd limits (`ulimit -n`, `net.ipv4.ip_local_port_range`, `somaxconn`) | raise limits; add a second VM behind one Caddy/LB |
| `queue_waiting_*` growing, matches slowing | matcher scanning is fine to ~10k/gender; beyond that bucket pre-filter does the work | it already does — if still slow, shard queues by region (state.js isolates this) |
| Postgres connections exhausted (`PG_POOL_MAX × workers > max_connections`) | pool math | keep `PG_POOL_MAX × N ≤ ~80`; add PgBouncer if you must go higher |
| Postgres disk/IO ceiling | messages table growth | scale VM disk first (free to 200 GB on Oracle); then partition `messages` by month |
| Redis memory > ~70% of container | queues/pairs are small; the cache is what grows | it's LRU-evicting already; raise `--maxmemory` with the VM |
| Video quality/connect complaints | TURN not configured, or Cloudflare proxy interfering with WS | set TURN vars; ensure WS upgrade headers pass through |
| Deploys drop everyone's chats mid-message | by design (sockets reconnect; JWT keeps them logged in) | do it off-peak; `docker compose up -d --build` replaces workers one at a time |

**Scaling sequence:** workers on the VM → bigger VM ($5–10) → second VM +
shared Redis/Postgres (already supported: point `REDIS_URL`/`DATABASE_URL`
at the shared hosts) → regional shards. No code rewrite at any step.

---

## 7. The honest path to "millions"

If ShincChat actually gets there, you have revenue, and this is what it
costs (rough, 2026 pricing):

| Concurrent users | Infra | Est. cost |
|---|---|---|
| ~50k | 2× big VMs or 4 medium, managed Postgres, R2 | ~$100–250/mo |
| ~100–200k | ~10–20 app nodes, HA Postgres + replicas, Redis cluster, TURN egress | ~$500–1.5k/mo |
| ~1M+ | 100+ nodes / managed k8s, multi-region, TURN becomes a major line item (video-heavy ≈ 1 GB/user-hour relayed), media CDN, moderation team | **$5–15k+/mo** — plus the trust & safety headcount that a platform like this really needs at that size |

The architecture committed here is the first column of that table. The
second column needs only infrastructure work (PgBouncer, HA Postgres). The
third additionally wants region sharding — which the per-country queue
buckets in `state.js` deliberately make easy.

---

## 8. Security notes

- `SESSION_SECRET` rotates → all sessions + media URLs die (that's the
  blast radius; keep it in a password manager).
- Keys are unguessable capability tokens (128-bit UUIDs) — same model as
  presigned S3 URLs. Messages only deliver keys to participants.
- **Retention:** verify clips (the most sensitive media — actual video of
  users) auto-delete after `VERIFY_CLIP_TTL_SEC` (default 1 h), and a
  bucket lifecycle rule can cap that at 1 day as a backstop. Voice messages
  and photos persist until the user deletes the message / clears the chat
  (or you add an explicit retention policy — decide what your privacy
  policy claims and set both accordingly).
- Admin panel: run it under the compose `admin` profile and keep it
  unexposed (SSH tunnel), or front it with Cloudflare Access.
- The report → auto-ban policy is one click = permanent ban. At scale this
  *will* be weaponized by bad actors; the admin panel can reverse bans, but
  plan for a moderation queue before you're big enough to need it.
- `/metrics` exposes counters only (no PII) — set `METRICS_ENABLED=false` if
  you don't want it public.
