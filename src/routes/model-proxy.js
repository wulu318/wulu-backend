'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

const NEWAPI_BASE = () => process.env.NEWAPI_BASE_URL || '';
const NEWAPI_KEY = () => process.env.NEWAPI_API_KEY || '';

const PROXY_PATHS = [
  '/chat/completions',
  '/completions',
  '/images/generations',
  '/embeddings',
  '/models',
  '/audio/speech',
  '/audio/transcriptions',
];

async function proxyRequest(req, res) {
  const basePath = NEWAPI_BASE();
  const apiKey = NEWAPI_KEY();
  if (!basePath) return res.status(503).json({ error: 'NewAPI not configured on backend' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user || !user.is_active) return res.status(403).json({ error: 'Account inactive' });

  if (user.quota_remaining <= 0) {
    return res.status(429).json({ error: 'Quota exhausted. Please upgrade your plan.' });
  }

  const reqModel = req.body?.model;
  if (reqModel && user.plan_id) {
    const plan = db.prepare('SELECT model_access FROM plans WHERE id = ?').get(user.plan_id);
    if (plan) {
      const allowed = JSON.parse(plan.model_access || '[]');
      if (allowed.length > 0 && !allowed.includes(reqModel) && !allowed.includes('*')) {
        return res.status(403).json({ error: `Model '${reqModel}' not available in your plan. Available: ${allowed.join(', ')}` });
      }
    }
  }

  const startTime = Date.now();
  const path = req.path;
  const targetUrl = `${basePath}/v1${path}`;

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${apiKey}`,
  };

  if (user.newapi_token) {
    headers['Authorization'] = `Bearer ${user.newapi_token}`;
  }

  const isStream = req.body?.stream === true;

  try {
    const fetch = (await import('node-fetch')).default;
    const response = await fetch(targetUrl, {
      method: req.method,
      headers,
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return res.status(response.status).json({ error: 'Upstream error', detail: errorBody });
    }

    if (isStream && response.headers.get('content-type')?.includes('text/event-stream')) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      let totalContent = '';
      response.body.on('data', (chunk) => {
        const str = chunk.toString();
        totalContent += str;
        res.write(chunk);
      });

      response.body.on('end', () => {
        res.end();
        const usageMatch = totalContent.match(/"usage":\s*\{[^}]*"prompt_tokens":\s*(\d+)[^}]*"completion_tokens":\s*(\d+)[^}]*"total_tokens":\s*(\d+)/);
        if (usageMatch) {
          const pt = parseInt(usageMatch[1], 10);
          const ct = parseInt(usageMatch[2], 10);
          const tt = parseInt(usageMatch[3], 10);
          recordUsage(db, user.id, reqModel || 'unknown', pt, ct, tt, Date.now() - startTime, true);
        }
      });

      response.body.on('error', (err) => {
        console.error('[Proxy] Stream error:', err.message);
        res.end();
      });

      return;
    }

    const data = await response.json();
    res.json(data);

    const usage = data.usage;
    if (usage) {
      recordUsage(db, user.id, reqModel || data.model || 'unknown',
        usage.prompt_tokens || 0, usage.completion_tokens || 0, usage.total_tokens || 0,
        Date.now() - startTime, false);
    }
  } catch (err) {
    console.error('[Proxy] Error:', err.message);
    res.status(502).json({ error: 'Failed to connect to model provider', detail: err.message });
  }
}

function recordUsage(db, userId, model, promptTokens, completionTokens, totalTokens, latencyMs, isStream) {
  db.prepare(`INSERT INTO usage_logs (user_id, model, prompt_tokens, completion_tokens, total_tokens, request_type, latency_ms, is_stream)
    VALUES (?, ?, ?, ?, ?, 'chat', ?, ?)`).run(userId, model, promptTokens, completionTokens, totalTokens, latencyMs, isStream ? 1 : 0);

  if (totalTokens > 0) {
    db.prepare('UPDATE users SET quota_remaining = MAX(0, quota_remaining - ?), updated_at = ? WHERE id = ?')
      .run(totalTokens, Math.floor(Date.now() / 1000), userId);
  }
}

for (const p of PROXY_PATHS) {
  router.post(p, proxyRequest);
  if (p === '/models') {
    router.get(p, proxyRequest);
  }
}

module.exports = router;