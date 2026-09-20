# ShincChat — Verified Random Chat

Gender-matched random chat (text + video) with built-in blurred verification, live voice, and voice messages.

## Run locally
```
npm install
node server/index.js
```
Open http://localhost:3000 in two tabs/devices to test matching.

## Social login (Google / Facebook / X)

The sign-up/login screen shows Google, Facebook, and X buttons. Each one only
works once you've registered a real app with that provider and set its
credentials as environment variables — see the comment at the top of
`server/oauth.js` for exact variable names and the callback URL to register.
Until a provider's client ID is set, its button shows as disabled with a
"not set up yet" tooltip instead of breaking — username/password login
always works regardless.

Gender is no longer asked at signup — it's asked once, right after login,
on the landing screen, and locked after that (same ban policy as before if
it's later reported as inaccurate).

## Deploy
Plain Node.js + Express + Socket.IO app — deployable anywhere Node 18+ runs.
1. Push this folder to a repo (or upload directly to your host).
2. Start command: `node server/index.js` (single process) or
   `WEB_CONCURRENCY=4 node server/boot.js` (cluster: one worker per CPU,
   shared state via Redis).
3. Set `PORT` env var if your host requires it (defaults to 3000).
4. **Use HTTPS in production** — required for camera/mic access and reliable WebRTC.

The full one-VM stack (this app + Postgres + Redis + Caddy TLS/LB) is one
command from the repo root — see the root `docker-compose.yml`,
[DEPLOY.md](../DEPLOY.md) and [SCALING.md](../SCALING.md).

## Scale characteristics (what's already handled)
- **Stateless sessions** — HS256 JWTs (`server/session.js`); restarts and
  multi-worker deployments don't log anyone out.
- **Redis-backed realtime state** (`server/state.js`) — matching queues,
  pairs and presence live in Redis when `REDIS_URL` is set, so any number
  of workers (or machines) share one matcher; pairing is an atomic Lua
  claim. Without `REDIS_URL` it falls back to in-memory (single process,
  same matching semantics).
- **Media offload, backend-only (frontend untouched)** — the stock client
  still sends voice messages as base64 data URLs and renders data URLs
  back; the server decodes them into object storage (S3/R2,
  `server/media.js`) or a local disk fallback and re-inlines them as data
  URLs whenever history is read, so Postgres stores ~40-byte keys instead
  of MB-sized base64. Presigned uploads are also available for API clients.
  Verify clips are relay-only (never stored with the stock client; API
  uploads auto-delete after `VERIFY_CLIP_TTL_SEC`, default 1 h). Profile
  photos stay inline in Postgres, exactly as the original app stored them.
  Voice messages and photos are never auto-deleted.
- **Rate limiting** — per-IP buckets on REST routes, a stricter bucket on
  login/signup (each attempt costs an async scrypt hash), per-socket event
  limits that kick flooding clients.
- **Metrics** — `/metrics` (Prometheus text: connections, queue depth,
  pairs, event-loop lag, heap) and `/health` (checks the DB).
- **TURN support** — `GET /api/ice` serves time-limited TURN credentials
  when `TURN_URLS`/`TURN_SECRET` are set (Cloudflare Realtime TURN or
  coturn use-auth-secret).

Load-tested with `../loadtest/`: 600 concurrent sockets, 300 pairs, 3k
messages, 0 errors, 5 ms event-loop lag on modest shared hardware (see
SCALING.md for the methodology and bigger-VM expectations).

## Before this handles real public traffic
- Gender verification (blurred clip) is a deterrent, not cryptographic proof.
- The 18+ gate is a birth-date field at signup — enforce it properly (ID
  checks, or at least a real consent screen) before scaling up.
- No content moderation beyond the report system — the auto-ban policy
  **will** be weaponized at scale; budget for a moderation queue (the admin
  panel's report review is the starting point).
- Voice messages are unencrypted at rest in R2 — add a lifecycle rule and
  decide on a retention policy that matches your privacy claims (verify
  clips aren't stored with the stock client; API uploads expire after 1 h).

## Layout & features
- **Accounts & chat history**: sign up / log in (username + password) right when you land. Your account, past conversations, and every text/voice message are stored server-side in a local SQLite database (`server/data/syncchat.db`) — not in the browser — so history follows your login rather than the device. Click the **History** button (top bar, after logging in) to open a Telegram-style side panel of past conversations; click one to reopen it with prior messages restored. If that stranger is currently online, you're paired directly and can keep chatting live; if they're offline, you see the saved messages read-only with a banner explaining they're not currently reachable.
- All controls (Verify, Voice, Switch mode, Skip, Report, Stop) live in the top bar.
- **Reporting**: Report opens a modal with fixed reasons (incorrect/misrepresented gender, inappropriate behavior, fraud/scam, or other + details). By default, any submitted report results in an **immediate permanent ban** of the reported account — they're disconnected on the spot and can't log back in. This is a real, enforced policy (not just logged), backed by the gender self-declaration shown at signup. Reports are stored permanently for review.
- **Admin panel**: a separate, standalone application (`../admin-panel`) manages users/bans, reviews reports (including reversing a ban if a report turns out to be bad-faith), and can turn the auto-ban policy off in favor of manual review. It also manages ads, premium plans, and other monetization settings. It's a different codebase and process from this app — see `admin-panel/README.md`.
- Video mode: two equal, slightly rounded panels (You / Stranger). The stranger's screen only ever shows, one at a time: the blurred preview (Continue/Skip), plain overlaid chat text (no bubble background), the switch-mode Agree/Decline card, and a single fading status toast (for general status like "Connected" or "Partner left"). Verify clips, voice-call cards, and voice messages never appear there — only in the text-chat log.
- Text mode: same shell, no video panels; full chat log with normal bordered bubbles, verify clips, voice-call cards, and voice messages all visible.
- A bordered, slightly rounded panel holds the message list in both modes.
- Verify (text mode): sends a short (~2.5s) blurred video clip automatically to both sides, fixed-size and center-cropped so both clips display identically; unblurring ("reveal") is a separate, consent-gated step.
- Voice (text mode): live audio-only call alongside text, consent-gated; becomes "End Voice" while active, and properly notifies your partner if you switch to video mid-call.
- Hold-to-record voice messages: press and hold the mic icon, release to send (text mode only, hidden in video mode).
- Full-width pill message input under the panels.
