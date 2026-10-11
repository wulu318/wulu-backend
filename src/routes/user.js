'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);

router.get('/profile', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let plan = null;
  if (user.plan_id) {
    plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(user.plan_id);
  }

  const subscription = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND status = ?').get(user.id, 'active');

  res.json({
    code: 0,
    data: {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    role: user.role,
    plan: plan ? { id: plan.id, name: plan.name, features: JSON.parse(plan.features), modelAccess: JSON.parse(plan.model_access) } : null,
    subscription: subscription ? { id: subscription.id, status: subscription.status, expiresAt: subscription.expires_at } : null,
    quota: { remaining: user.quota_remaining, total: user.quota_total },
    createdAt: user.created_at,
    },
  });
});

router.put('/profile', (req, res) => {
  const { displayName, avatarUrl } = req.body;
  const db = getDb();
  db.prepare('UPDATE users SET display_name = ?, avatar_url = ?, updated_at = ? WHERE id = ?')
    .run(displayName || '', avatarUrl || '', Math.floor(Date.now() / 1000), req.user.sub);
  res.json({ code: 0, data: { success: true } });
});

router.get('/quota', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT quota_remaining, quota_total FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    code: 0,
    data: {
    remaining: user.quota_remaining,
    total: user.quota_total,
    percentage: user.quota_total > 0 ? Math.round((user.quota_remaining / user.quota_total) * 100) : 0,
    },
  });
});

router.get('/usage', (req, res) => {
  const { period = '7d' } = req.query;
  const db = getDb();

  let days = 7;
  if (period === '30d') days = 30;
  if (period === '90d') days = 90;

  const sinceTs = Math.floor(Date.now() / 1000) - (days * 86400);

  const usage = db.prepare(`
    SELECT date(created_at, 'unixepoch') as date,
      COUNT(*) as request_count,
      SUM(total_tokens) as total_tokens,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens
    FROM usage_logs
    WHERE user_id = ? AND created_at >= ?
    GROUP BY date(created_at, 'unixepoch')
    ORDER BY date DESC
  `).all(req.user.sub, sinceTs);

  const modelBreakdown = db.prepare(`
    SELECT model,
      COUNT(*) as request_count,
      SUM(total_tokens) as total_tokens
    FROM usage_logs
    WHERE user_id = ? AND created_at >= ?
    GROUP BY model
    ORDER BY total_tokens DESC
  `).all(req.user.sub, sinceTs);

  const featureBreakdown = db.prepare(`
    SELECT request_type, COUNT(*) as request_count,
      SUM(total_tokens) as total_tokens, AVG(latency_ms) as average_latency_ms
    FROM usage_logs
    WHERE user_id = ? AND created_at >= ?
    GROUP BY request_type ORDER BY request_count DESC
  `).all(req.user.sub, sinceTs);

  res.json({ code: 0, data: { period, daily: usage, models: modelBreakdown, features: featureBreakdown } });
});

// Profile summary consumed by the desktop account panel.
router.get('/profile-summary', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, display_name, role, plan_id, quota_remaining, quota_total, created_at FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ code: 1, message: 'User not found' });
  const plan = user.plan_id ? db.prepare('SELECT name FROM plans WHERE id = ?').get(user.plan_id) : null;
  res.json({ code: 0, data: {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    planId: user.plan_id,
    planName: plan?.name || 'Free',
    quota: {
      remaining: user.quota_remaining,
      total: user.quota_total,
      percentage: user.quota_total > 0 ? Math.round((user.quota_remaining / user.quota_total) * 100) : 0,
    },
    createdAt: user.created_at,
  } });
});

module.exports = router;
