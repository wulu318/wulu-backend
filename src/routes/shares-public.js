'use strict';

// Public serving for shared artifacts at /s/<shareId>/.
// User-supplied HTML is served from a unique origin (CSP sandbox) so it cannot read
// our cookies or call authenticated APIs.
const express = require('express');
const fs = require('fs');
const path = require('path');

const { getDb } = require('../db/database');
const storage = require('../services/shareStorage');

const router = express.Router();

const TYPE_FALLBACK = new Map(Object.entries({
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.pdf': 'application/pdf',
}));

const SPA_TYPES = new Set(['html_file', 'static_service_deployment', 'mermaid_file']);

function contentTypeFor(filePath) {
  return TYPE_FALLBACK.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ));
}

function codeGate(res, shareId, message) {
  res.status(401).type('html').send(`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>需要访问码</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;background:#0f1115;color:#e8eaed}
form{background:#171a21;padding:32px;border-radius:16px;width:min(360px,90vw);box-shadow:0 20px 60px rgba(0,0,0,.45)}
h1{font-size:18px;margin:0 0 8px}p{color:#9aa0a6;font-size:13px;margin:0 0 20px}
input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #2a2f3a;background:#0f1115;color:#e8eaed;font-size:15px}
button{width:100%;margin-top:12px;padding:12px;border:0;border-radius:10px;background:#4f7cff;color:#fff;font-size:15px;cursor:pointer}
.err{color:#ff6b6b;font-size:13px;margin-top:12px}</style></head>
<body><form method="get" action="">
<h1>此分享需要访问码</h1><p>请输入分享者提供的访问码。</p>
<input name="code" autocomplete="off" autofocus placeholder="访问码">
<button type="submit">打开</button>
${message ? `<div class="err">${escapeHtml(message)}</div>` : ''}
</form></body></html>`);
}

function sendFileSafe(res, filePath, share) {
  const type = contentTypeFor(filePath);
  res.setHeader('Content-Type', type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Unique origin: the page cannot read our cookies or call our APIs.
  res.setHeader('Content-Security-Policy',
    "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads allow-popups-to-escape-sandbox");
  if (type.startsWith('text/html')) {
    res.setHeader('Cache-Control', 'no-cache');
  } else {
    res.setHeader('Cache-Control', 'public, max-age=300');
  }
  res.sendFile(filePath, { headers: { 'Content-Type': type } }, (err) => {
    if (err && !res.headersSent) {
      res.status(500).type('text').send('Failed to read share content');
    }
  });
}

function handleShareRequest(req, res) {
  const shareId = String(req.params.shareId || '');
  const db = getDb();
  const share = db.prepare('SELECT * FROM html_shares WHERE id = ?').get(shareId);
  if (!share) return res.status(404).type('text').send('Share not found');
  if (share.status === 'disabled') return res.status(410).type('text').send('This share has been disabled');
  if (share.status === 'failed') return res.status(502).type('text').send('This share is not available yet');

  if (share.access_mode === 'code') {
    const cookieName = `wulu_share_${share.id}`;
    const cookies = String(req.headers.cookie || '');
    const cookieValue = cookies.split(';').map((c) => c.trim())
      .find((c) => c.startsWith(`${cookieName}=`))?.split('=')[1];
    const provided = String(req.query.code || '') || (cookieValue ? decodeURIComponent(cookieValue) : '');
    if (!provided || provided !== share.share_code) {
      return codeGate(res, share.id, provided ? '访问码不正确' : '');
    }
    if (provided === share.share_code && cookieValue !== provided) {
      res.setHeader('Set-Cookie',
        `${cookieName}=${encodeURIComponent(provided)}; Path=/s/${share.id}/; Max-Age=2592000; HttpOnly; SameSite=Lax`);
    }
  }

  const root = storage.contentDir(share.id);
  const rawRest = req.params.rest;
  const relative = (Array.isArray(rawRest) ? rawRest.join('/') : String(rawRest || '')).replace(/^\/+/, '');

  let target = null;
  if (relative) {
    try {
      target = storage.resolveInside(root, relative);
    } catch {
      return res.status(400).type('text').send('Invalid path');
    }
    if (fs.existsSync(target)) {
      const stat = fs.statSync(target);
      if (stat.isFile()) {
        db.prepare('UPDATE html_shares SET last_accessed_at = ? WHERE id = ?')
          .run(Math.floor(Date.now() / 1000), share.id);
        return sendFileSafe(res, target, share);
      }
      if (stat.isDirectory()) {
        const indexFile = path.join(target, 'index.html');
        if (fs.existsSync(indexFile)) return sendFileSafe(res, indexFile, share);
      }
    }
  }

  // SPA fallback for HTML-like shares so client-side routes keep working.
  if (SPA_TYPES.has(share.source_type)) {
    for (const candidate of [share.entry_file, 'index.html']) {
      if (!candidate) continue;
      try {
        const entry = storage.resolveInside(root, candidate);
        if (fs.existsSync(entry) && fs.statSync(entry).isFile()) {
          return sendFileSafe(res, entry, share);
        }
      } catch {
        // Keep trying the next candidate.
      }
    }
  }

  return res.status(404).type('text').send('Not found');
}

router.get('/:shareId', (req, res) => {
  if (!String(req.originalUrl || '').endsWith('/')) {
    return res.redirect(301, `${req.originalUrl.split('?')[0]}/${req.url.includes('?') ? `?${req.url.split('?')[1]}` : ''}`);
  }
  handleShareRequest(req, res);
});

router.get('/:shareId/*rest', handleShareRequest);

module.exports = router;
