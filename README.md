# ShincChat0

ShincChat — verified random chat (text + video) with blurred verification, live
voice, voice messages, friends and profiles.

## Repository layout

| Path | What it is |
| --- | --- |
| `landing/` | The marketing landing page — static, dependency-free, production-ready. See [`landing/README.md`](landing/README.md). |
| `tools/preview-server.js` | Zero-dependency Node static server used to preview `landing/` locally. |
| `syncchat-repo-updated (6).zip` | The application itself (`random-chat/` live site + `admin-panel/` internal moderation & monetization tool). Unzip to run it. |

## Preview the landing page

```bash
node tools/preview-server.js          # → http://localhost:3000
```

No build step and no dependencies: `landing/index.html`, `landing/styles.css`
and `landing/main.js` are the whole page. Point the call-to-action buttons at
the deployed app by setting `APP_URL` at the top of `landing/main.js`
(while it is empty they open an on-page instant-match preview instead).

## Run the app

```bash
unzip "syncchat-repo-updated (6).zip"
cd syncchat-repo/random-chat
npm install
node server/index.js                  # → http://localhost:3000
```

Use HTTPS in production — camera and microphone access (and therefore video
mode) require a secure origin.
