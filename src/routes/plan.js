'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

router.get('/', (req, res) => {
  const db = getDb();
  const plans = db.prepare('SELECT * FROM plans WHERE is_active = 1 ORDER BY sort_order').all();
  res.json(plans.map(p => ({
    ...p,
    features: JSON.parse(p.features || '{}'),
    modelAccess: JSON.parse(p.model_access || '[]'),
  })));
});

router.get('/my-subscription', authMiddleware, (req, res) => {
  const db = getDb();
  const sub = db.prepare(`
    SELECT s.*, p.name as plan_name, p.features, p.model_access, p.quota_monthly
    FROM subscriptions s
    LEFT JOIN plans p ON s.plan_id = p.id
    WHERE s.user_id = ? AND s.status = 'active'
    ORDER BY s.created_at DESC LIMIT 1
  `).get(req.user.sub);

  if (!sub) return res.json({ active: false });

  if (!sub.plan_name) {
    return res.json({
      active: true,
      id: sub.id,
      planName: 'Unknown Plan',
      features: {},
      modelAccess: [],
      quotaMonthly: 0,
      startedAt: sub.started_at,
      expiresAt: sub.expires_at,
    });
  }

  res.json({
    active: true,
    id: sub.id,
    planName: sub.plan_name,
    features: JSON.parse(sub.features || '{}'),
    modelAccess: JSON.parse(sub.model_access || '[]'),
    quotaMonthly: sub.quota_monthly,
    startedAt: sub.started_at,
    expiresAt: sub.expires_at,
  });
});

router.get('/:id', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });
  res.json({ ...plan, features: JSON.parse(plan.features || '{}'), modelAccess: JSON.parse(plan.model_access || '[]') });
});

router.post('/subscribe', authMiddleware, (req, res) => {
  const { planId } = req.body;
  if (!planId) return res.status(400).json({ error: 'planId required' });

  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ? AND is_active = 1').get(planId);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const existing = db.prepare('SELECT * FROM subscriptions WHERE user_id = ? AND status = ?').get(req.user.sub, 'active');
  if (existing) {
    db.prepare('UPDATE subscriptions SET status = ?, cancelled_at = ? WHERE id = ?')
      .run('canceled', Math.floor(Date.now() / 1000), existing.id);
  }

  const subId = uuidv4();
  const expiresAt = Math.floor(Date.now() / 1000) + 30 * 24 * 3600;
  db.prepare(`INSERT INTO subscriptions (id, user_id, plan_id, status, expires_at) VALUES (?, ?, ?, 'active', ?)`)
    .run(subId, req.user.sub, planId, expiresAt);

  db.prepare('UPDATE users SET plan_id = ?, quota_remaining = ?, quota_total = ?, updated_at = ? WHERE id = ?')
    .run(planId, plan.quota_monthly, plan.quota_monthly, Math.floor(Date.now() / 1000), req.user.sub);

  res.json({ success: true, subscriptionId: subId, expiresAt });
});

module.exports = router;