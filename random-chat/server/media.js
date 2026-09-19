// ============================================================================
// Media storage for voice messages, verification clips and profile photos.
//
// These used to travel as base64 through the Socket.IO connection and were
// stored as base64 TEXT in Postgres (a 2.5s verify clip ≈ 1 MB — the 500 MB
// free Supabase database was full after ~500 clips, and every clip burned
// CPU on every worker relaying it).
//
// New flow:
//   1. client  POST /api/media/upload-url { type, contentType }
//        → { key, url, method, headers }
//   2. client  PUTs/POSTs the raw blob to that URL
//        - S3 mode (S3_* env, e.g. Cloudflare R2 — 10 GB free, zero egress
//          fees): a presigned URL; the blob never touches our servers.
//        - local mode (no S3 env): POST /api/media/upload?sig=... streams
//          to MEDIA_DIR. Zero-config for the Docker deployment.
//   3. client  sends the KEY over the socket (tiny), partner renders it via
//        POST /api/media/urls { keys } → { key: url }
//        - S3 mode: presigned GETs.
//        - local mode: short-lived HMAC-signed /api/media/file/... URLs.
//
// Keys are unguessable capability tokens (media/<type>/<userId>/<uuid>.<ext>)
// — the same security model as presigned S3 URLs: possession of the key is
// access. Objects are only referenced inside conversations.
// ============================================================================
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const S3_ENDPOINT = process.env.S3_ENDPOINT || null;           // e.g. https://<account>.r2.cloudflarestorage.com
const S3_REGION = process.env.S3_REGION || 'auto';
const S3_BUCKET = process.env.S3_BUCKET || null;
const S3_ACCESS_KEY_ID = process.env.S3_ACCESS_KEY_ID || null;
const S3_SECRET_ACCESS_KEY = process.env.S3_SECRET_ACCESS_KEY || null;
const S3_FORCE_PATH_STYLE = process.env.S3_FORCE_PATH_STYLE !== 'false'; // R2/MinIO: true; AWS: set false

const s3Configured = !!(S3_ENDPOINT && S3_BUCKET && S3_ACCESS_KEY_ID && S3_SECRET_ACCESS_KEY);

const MEDIA_DIR = process.env.MEDIA_DIR
  || path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'media');
const MEDIA_URL_TTL_SEC = parseInt(process.env.MEDIA_URL_TTL_SEC, 10) || 600; // 10 min
const MAX_UPLOAD_BYTES = parseInt(process.env.MAX_UPLOAD_BYTES, 10) || 8 * 1024 * 1024;

// Per-type limits (bytes) and the content types we accept per type.
const TYPES = {
  voice: { maxBytes: 3 * 1024 * 1024, contentTypes: { 'audio/webm': '.webm', 'audio/ogg': '.ogg', 'audio/mpeg': '.mp3', 'audio/mp4': '.m4a' } },
  verify: { maxBytes: 6 * 1024 * 1024, contentTypes: { 'video/webm': '.webm', 'video/mp4': '.mp4' } },
  photo: { maxBytes: 4 * 1024 * 1024, contentTypes: { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' } }
};

const KEY_RE = /^media\/(voice|verify|photo)\/[A-Za-z0-9-]{1,64}\/[A-Za-z0-9-]{8,64}\.(webm|ogg|mp3|m4a|mp4|jpg|png|webp)$/;

function isValidKey(key, type) {
  if (typeof key !== 'string' || key.length > 200) return false;
  if (!KEY_RE.test(key)) return false;
  return !type || key.startsWith(`media/${type}/`);
}

function signLocal(payload) {
  const secret = process.env.SESSION_SECRET || 'dev-only-media-secret';
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

// ---- S3 presigning (works with any S3-compatible store: R2, MinIO, AWS) ----
let s3Client = null;
function getS3() {
  if (s3Client) return s3Client;
  const { S3Client } = require('@aws-sdk/client-s3');
  s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: S3_FORCE_PATH_STYLE,
    credentials: { accessKeyId: S3_ACCESS_KEY_ID, secretAccessKey: S3_SECRET_ACCESS_KEY }
  });
  return s3Client;
}

async function presignPut(key, contentType, expiresIn) {
  const { PutObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(getS3(), new PutObjectCommand({ Bucket: S3_BUCKET, Key: key, ContentType: contentType }), { expiresIn });
}
async function presignGet(key, expiresIn) {
  const { GetObjectCommand } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  return getSignedUrl(getS3(), new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }), { expiresIn });
}
async function s3Delete(key) {
  try {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await getS3().send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
  } catch (e) {
    console.error('S3 delete failed (orphaned object left):', e.message);
  }
}

// ---- Local storage mode ----------------------------------------------------
function localPathForKey(key) {
  // Keys are validated by KEY_RE before ever reaching the filesystem, so
  // path traversal isn't possible; belt-and-braces check anyway.
  const safe = path.normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
  const p = path.join(MEDIA_DIR, safe);
  if (!p.startsWith(MEDIA_DIR)) return null;
  return p;
}

function ensureMediaDir() {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
}

function mount(app, { requireAuth, asyncRoute, metrics }) {
  const express = require('express');

  /**
   * Begin an upload. Returns where to PUT/POST the bytes.
   * The key embeds the uploader's id — a client can only create media
   * objects under its own namespace.
   */
  app.post('/api/media/upload-url', requireAuth, asyncRoute(async (req, res) => {
    const { type, contentType } = req.body || {};
    const spec = TYPES[type];
    if (!spec) return res.status(400).json({ error: 'Unknown media type.' });
    if (!contentType || !spec.contentTypes[contentType]) {
      return res.status(400).json({ error: 'Unsupported content type for this media type.' });
    }
    const ext = spec.contentTypes[contentType];
    const key = `media/${type}/${req.userId}/${crypto.randomUUID()}${ext}`;

    if (s3Configured) {
      const url = await presignPut(key, contentType, 900);
      res.json({ key, url, method: 'PUT', headers: { 'Content-Type': contentType } });
    } else {
      ensureMediaDir();
      const exp = Date.now() + 900_000;
      const sig = signLocal(`upload|${key}|${exp}`);
      res.json({
        key,
        url: `/api/media/upload?key=${encodeURIComponent(key)}&exp=${exp}&sig=${encodeURIComponent(sig)}`,
        method: 'POST',
        headers: { 'Content-Type': contentType }
      });
    }
  }));

  /**
   * Local-mode upload sink (streams to disk; size-capped).
   * The signature ties the URL to this exact key and a 15-minute window.
   */
  app.post('/api/media/upload', express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), (req, res) => {
    const { key, exp, sig } = req.query;
    if (!isValidKey(key) || String(sig) !== signLocal(`upload|${key}|${exp}`) || Number(exp) < Date.now()) {
      return res.status(403).json({ error: 'Invalid or expired upload URL.' });
    }
    const type = key.split('/')[1];
    if (!req.body || !req.body.length) return res.status(400).json({ error: 'Empty upload.' });
    if (req.body.length > TYPES[type].maxBytes) return res.status(413).json({ error: 'File too large.' });
    const p = localPathForKey(key);
    if (!p) return res.status(400).json({ error: 'Bad key.' });
    ensureMediaDir();
    fs.mkdir(path.dirname(p), { recursive: true }, (err) => {
      if (err) return res.status(500).json({ error: 'Storage error.' });
      fs.writeFile(p, req.body, (err2) => {
        if (err2) return res.status(500).json({ error: 'Storage error.' });
        metrics.inc('media_uploads_total');
        res.json({ ok: true, key });
      });
    });
  });

  /**
   * Exchange keys for fetchable URLs (batch — a chat page restoring history
   * may need dozens at once). Bounded to 50 keys per call.
   */
  app.post('/api/media/urls', requireAuth, asyncRoute(async (req, res) => {
    const keys = Array.isArray(req.body && req.body.keys) ? req.body.keys.slice(0, 50) : [];
    const urls = {};
    for (const key of keys) {
      if (!isValidKey(key)) continue;
      if (s3Configured) {
        urls[key] = await presignGet(key, MEDIA_URL_TTL_SEC);
      } else {
        const exp = Date.now() + MEDIA_URL_TTL_SEC * 1000;
        const sig = signLocal(`get|${key}|${exp}`);
        urls[key] = `/api/media/file/${key}?exp=${exp}&sig=${encodeURIComponent(sig)}`;
      }
    }
    res.json({ urls, ttlSec: MEDIA_URL_TTL_SEC });
  }));

  /**
   * Local-mode file serving (signature-checked, no auth header needed —
   * <audio>/<video> tags can't send one).
   */
  app.get('/api/media/file/*splat', (req, res) => {
    const key = req.path.replace(/^\/api\/media\/file\//, '');
    const { exp, sig } = req.query;
    if (!isValidKey(key) || String(sig) !== signLocal(`get|${key}|${exp}`) || Number(exp) < Date.now()) {
      return res.status(403).json({ error: 'Invalid or expired URL.' });
    }
    const p = localPathForKey(key);
    if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Not found.' });
    const ext = path.extname(p).toLowerCase();
    const mime = { '.webm': 'video/webm', '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' }[ext] || 'application/octet-stream';
    res.setHeader('Cache-Control', 'private, max-age=600');
    res.setHeader('Content-Type', mime);
    fs.createReadStream(p).pipe(res);
  });

  console.log(`Media storage: ${s3Configured ? `S3 (${S3_ENDPOINT})` : `local disk (${MEDIA_DIR})`}`);
}

/** Best-effort object deletion (called when a message is deleted for everyone). */
async function deleteObject(key) {
  if (!isValidKey(key)) return;
  if (s3Configured) { await s3Delete(key); return; }
  const p = localPathForKey(key);
  if (p) fs.unlink(p, () => { /* best effort */ });
}

module.exports = { mount, isValidKey, deleteObject, s3Configured };
