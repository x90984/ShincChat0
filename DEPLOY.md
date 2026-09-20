# Deploying ShincChat

Two supported paths:

1. **The $0 VM stack (recommended)** — Docker Compose on an Oracle Always
   Free VM (or any Linux box): app workers + Postgres + Redis + Caddy in
   one command. This is the path that scales; see **[SCALING.md](./SCALING.md)**
   for capacity numbers and the free-tier map.
2. **Render free** — zero-ops single dyno. Fine for demos and soft
   launches; understand the free-plan limits below first.

Both run the same code. The difference is only environment variables:
the VM stack sets `REDIS_URL` (→ multi-worker, Redis state backend);
Render leaves it unset (→ single process, in-memory state) and uses
external Supabase/Upstash/R2.

---

## Path 1 — the Docker stack (Oracle VM / any Linux server)

```bash
# 1. On the VM: install Docker
curl -fsSL https://get.docker.com | sh

# 2. Get the code
git clone https://github.com/<you>/ShincChat0.git && cd ShincChat0

# 3. Configure
cp .env.example .env
# At minimum set SESSION_SECRET (openssl rand -hex 32).
# Set DOMAIN when you have a hostname pointed at the VM.

# 4. Launch (Postgres + Redis + 2 app workers + Caddy TLS)
docker compose up -d --build
curl localhost/health        # {"ok":true,"db":true,"state":"redis",...}
```

Then, before real traffic:

- **Media → Cloudflare R2** (10 GB free, zero egress fees, survives
  redeploys): bucket + S3 token + CORS rule, then the `S3_*` vars in
  `.env`. The frontend is unchanged — the server decodes the base64 voice
  messages it receives into R2 and re-inlines them on history reads.
  Full walkthrough in SCALING.md §5.
- **TURN for video** (`TURN_URLS`/`TURN_SECRET`): without it, users behind
  symmetric NATs (a large share of mobile data connections) can't do
  video. Cloudflare Realtime TURN includes 1 TB/month free.
- **Backups**: the `pgdata` volume is not a backup — add the `pg_dump`
  cron from SCALING.md §5.
- **Scale**: `docker compose up -d --scale app=4` — workers coordinate
  through Redis automatically.

Admin panel (same database, kept off the public internet):

```bash
docker compose --profile admin up -d admin
# reach it without exposing it:
docker compose exec admin node server.js   # or SSH-tunnel to it
```

Updating:

```bash
git pull && docker compose up -d --build
# Workers restart one at a time; clients reconnect and stay logged in
# (JWT sessions are stateless). Media and the database are untouched.
```

---

## Path 2 — Render (free tier, one service)

**Read this first:** a Render free workspace includes **750 instance-hours
per month**, and one always-on web service burns ~744. So exactly **one**
free service can run 24/7 — deploying the admin panel as a second free
service (as an older version of this repo did) suspends *both* mid-month.
`render.yaml` therefore deploys only the chat app.

Free-plan realities: 512 MB RAM / 0.1 CPU, single instance, **sleeps after
15 idle minutes** (~1 min cold start on the next visit; a cron-job.org ping
to `/health` keeps it awake), no persistent disk, realistic ceiling of a
few thousand concurrent connections.

1. Push this repo to GitHub.
2. Render → New → Blueprint → pick the repo → Apply.
3. Set the prompted environment variables:
   - `DATABASE_URL` — Supabase Postgres, **Transaction pooler** string
     (port 6543). Free tier: 500 MB, pauses after 7 idle days.
   - `SESSION_SECRET` — `openssl rand -hex 32`
   - `UPSTASH_REDIS_REST_URL` / `..._TOKEN` — Upstash Redis REST creds
     (the cache backend when there's no local Redis; free tier is
     ~500k commands/month, fine for small traffic)
   - Optionally `S3_*` (Cloudflare R2 — strongly recommended; without it
     voice messages fall back to inline base64 in Postgres, and the free
     Supabase DB fills after a few hundred of them), `TURN_*`,
     `GOOGLE_CLIENT_*` + `OAUTH_BASE_URL` (set after the first deploy
     gives you the URL).
4. Custom domain: Render → Settings → Custom Domain (HTTPS automatic);
   update `OAUTH_BASE_URL` + Google redirect URI to match.

The admin panel against this deployment: run it locally with
`DATABASE_URL` pointed at the same Supabase pooler string.

---

## Local development

```bash
# services (any Postgres + Redis)
docker run -d -p 5432:5432 -e POSTGRES_USER=shinc -e POSTGRES_PASSWORD=shinc \
  -e POSTGRES_DB=shincchat postgres:16-alpine
docker run -d -p 6379:6379 redis:7-alpine

# app
cd random-chat
cp .env.example .env   # defaults match the containers above
npm install
npm start              # single process, in-memory state
REDIS_URL=redis://localhost:6379 npm start   # Redis state (multi-worker mode)
WEB_CONCURRENCY=4 npm run start:cluster      # 4 workers on one port

# tests
node tests/smoke.js                          # 36 end-to-end checks
BASE=http://a:3000 BASE2=http://b:3000 node tests/smoke.js   # cross-node
node tests/verify-expiry.js                  # verify-clip TTL retention
                                             # (spawns its own server)
```

HTTPS matters in production: camera/microphone access (video mode) and
reliable WebRTC require a secure origin. Caddy handles it automatically.
