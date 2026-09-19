# ShincChat0

ShincChat — verified random chat (text + video) with blurred verification, live
voice, voice messages, friends and profiles. **Built to scale horizontally:
stateless sessions, Redis-backed matching/presence, object-storage media.**

> Read **[SCALING.md](./SCALING.md)** for the architecture, real capacity
> numbers, the free-tier map, and the honest math on "millions of users
> for free".

## Repository layout

| Path | What it is |
| --- | --- |
| `random-chat/` | The live site (Express + Socket.IO). Runs single-process or as a Redis-coordinated worker cluster — same code. See its [README](random-chat/README.md). |
| `admin-panel/` | Internal moderation & monetization tool (separate app, same Postgres via `DATABASE_URL`). |
| `landing/` | The marketing landing page — static, dependency-free. See [`landing/README.md`](landing/README.md). |
| `loadtest/` | Load generator: sign up / connect / match / message N pairs and report latencies + gauges. |
| `deploy/Caddyfile` | TLS + WebSocket load balancer config used by docker compose. |
| `docker-compose.yml` | The whole stack (app workers + Postgres + Redis + Caddy) for one VM. |
| `render.yaml` | Zero-ops single-service deployment for Render (free tier). |
| `tools/preview-server.js` | Zero-dependency Node static server for `landing/`. |
| `syncchat-repo-updated (6).zip` | Archived pre-extraction snapshot of the app (kept for reference; the extracted `random-chat/` + `admin-panel/` are the source of truth). |

## Quick start (full stack on one machine)

```bash
cp .env.example .env           # set SESSION_SECRET (openssl rand -hex 32)
docker compose up -d --build   # postgres + redis + app workers + caddy
curl localhost/health
```

Details, scaling, backups, media/TURN setup: **[SCALING.md](./SCALING.md)** ·
Render path: **[DEPLOY.md](./DEPLOY.md)**.

## Quick start (local dev, no Docker for the app)

```bash
cd random-chat && cp .env.example .env && npm install
npm start                       # http://localhost:3000 — single process
```

Needs a Postgres (any) via `DATABASE_URL`; Redis is optional — without
`REDIS_URL` the app runs single-process with in-memory state, exactly like
before.

## Preview the landing page

```bash
node tools/preview-server.js          # → http://localhost:3000
```

No build step and no dependencies: `landing/index.html`, `landing/styles.css`
and `landing/main.js` are the whole page. Point the call-to-action buttons at
the deployed app by setting `APP_URL` at the top of `landing/main.js`
(while it is empty they open an on-page instant-match preview instead).

Use HTTPS in production — camera and microphone access (and therefore video
mode) require a secure origin.
