'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'superadmin'));

router.get('/users', (req, res) => {
  const { page = 1, limit = 20, search } = req.query;
  const db = getDb();
  const offset = (Number(page) - 1) * Number(limit);

  let sql = 'SELECT id, email, display_name, role, plan_id, quota_remaining, quota_total, is_active, created_at, last_login_at FROM users WHERE 1=1';
  const params = [];
  if (search) { sql += ' AND (email LIKE ? OR display_name LIKE ?)'; params.push(`%${search}%`, `%${search}%`); }
  sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), offset);

  const users = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  res.json({ users, total, page: Number(page), limit: Number(limit) });
});

router.put('/users/:id', (req, res) => {
  const { role, isActive, quotaRemaining, quotaTotal, planId, newPassword } = req.body;
  const db = getDb();

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (role) db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  if (isActive !== undefined) db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(isActive ? 1 : 0, req.params.id);
  if (quotaRemaining !== undefined) db.prepare('UPDATE users SET quota_remaining = ? WHERE id = ?').run(quotaRemaining, req.params.id);
  if (quotaTotal !== undefined) db.prepare('UPDATE users SET quota_total = ? WHERE id = ?').run(quotaTotal, req.params.id);
  if (planId) db.prepare('UPDATE users SET plan_id = ? WHERE id = ?').run(planId, req.params.id);
  if (newPassword) {
    const hash = bcrypt.hashSync(newPassword, 12);
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, req.params.id);
  }

  db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), req.params.id);
  res.json({ success: true });
});

router.delete('/users/:id', (req, res) => {
  const db = getDb();
  if (req.params.id === req.user.sub) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.post('/plans', (req, res) => {
  const { name, description, priceMonthly, priceYearly, quotaMonthly, features, modelAccess, maxContextTokens, sortOrder } = req.body;
  if (!name) return res.status(400).json({ error: 'name required' });

  const db = getDb();
  const id = uuidv4();
  db.prepare(`INSERT INTO plans (id, name, description, price_monthly, price_yearly, quota_monthly, features, model_access, max_context_tokens, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, name, description || '', priceMonthly || 0, priceYearly || 0, quotaMonthly || 0,
    JSON.stringify(features || {}), JSON.stringify(modelAccess || []), maxContextTokens || 4096, sortOrder || 0);

  res.status(201).json({ id, name });
});

router.put('/plans/:id', (req, res) => {
  const db = getDb();
  const plan = db.prepare('SELECT * FROM plans WHERE id = ?').get(req.params.id);
  if (!plan) return res.status(404).json({ error: 'Plan not found' });

  const { name, description, priceMonthly, priceYearly, quotaMonthly, features, modelAccess, maxContextTokens, isActive, sortOrder } = req.body;
  if (name) plan.name = name;
  if (description !== undefined) plan.description = description;
  if (priceMonthly !== undefined) plan.price_monthly = priceMonthly;
  if (priceYearly !== undefined) plan.price_yearly = priceYearly;
  if (quotaMonthly !== undefined) plan.quota_monthly = quotaMonthly;
  if (features) plan.features = JSON.stringify(features);
  if (modelAccess) plan.model_access = JSON.stringify(modelAccess);
  if (maxContextTokens !== undefined) plan.max_context_tokens = maxContextTokens;
  if (isActive !== undefined) plan.is_active = isActive ? 1 : 0;
  if (sortOrder !== undefined) plan.sort_order = sortOrder;

  db.prepare(`UPDATE plans SET name=?, description=?, price_monthly=?, price_yearly=?, quota_monthly=?, features=?, model_access=?, max_context_tokens=?, is_active=?, sort_order=? WHERE id=?`)
    .run(plan.name, plan.description, plan.price_monthly, plan.price_yearly, plan.quota_monthly,
      plan.features, plan.model_access, plan.max_context_tokens, plan.is_active, plan.sort_order, req.params.id);

  res.json({ success: true });
});

router.delete('/plans/:id', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE plans SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

router.get('/analytics/overview', (req, res) => {
  const db = getDb();

  const nowTs = Math.floor(Date.now() / 1000);
  const weekTs = nowTs - 7 * 86400;
  const monthTs = nowTs - 30 * 86400;

  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE last_login_at > ?').get(weekTs).c;
  const totalTokensUsed = db.prepare('SELECT COALESCE(SUM(total_tokens), 0) as c FROM usage_logs WHERE created_at > ?').get(monthTs).c;
  const totalRequests = db.prepare('SELECT COUNT(*) as c FROM usage_logs WHERE created_at > ?').get(monthTs).c;

  const planRevenue = db.prepare(`
    SELECT p.name, COUNT(s.id) as subscribers
    FROM plans p LEFT JOIN subscriptions s ON p.id = s.plan_id AND s.status = 'active'
    GROUP BY p.id
  `).all();

  res.json({ totalUsers, activeUsers, totalTokensUsed, totalRequests, planRevenue });
});

router.get('/analytics/usage', (req, res) => {
  const { days = 30 } = req.query;
  const db = getDb();

  const sinceTs = Math.floor(Date.now() / 1000) - (Number(days) * 86400);

  const dailyUsage = db.prepare(`
    SELECT date(created_at, 'unixepoch') as date,
      COUNT(DISTINCT user_id) as active_users,
      COUNT(*) as requests,
      SUM(total_tokens) as tokens,
      SUM(prompt_tokens) as prompt_tokens,
      SUM(completion_tokens) as completion_tokens
    FROM usage_logs
    WHERE created_at >= ?
    GROUP BY date(created_at, 'unixepoch')
    ORDER BY date DESC
  `).all(sinceTs);

  const topUsers = db.prepare(`
    SELECT u.email, u.display_name, COUNT(*) as requests, SUM(ul.total_tokens) as tokens
    FROM usage_logs ul JOIN users u ON ul.user_id = u.id
    WHERE ul.created_at >= ?
    GROUP BY ul.user_id ORDER BY tokens DESC LIMIT 20
  `).all(sinceTs);

  const topModels = db.prepare(`
    SELECT model, COUNT(*) as requests, SUM(total_tokens) as tokens
    FROM usage_logs
    WHERE created_at >= ?
    GROUP BY model ORDER BY tokens DESC LIMIT 10
  `).all(sinceTs);

  res.json({ dailyUsage, topUsers, topModels });
});

router.get('/config', (_req, res) => {
  const db = getDb();
  const configs = db.prepare('SELECT * FROM system_config').all();
  const result = {};
  for (const c of configs) result[c.key] = c.value;
  res.json(result);
});

router.put('/config', (req, res) => {
  const db = getDb();
  const nowTs = Math.floor(Date.now() / 1000);
  const stmt = db.prepare(`INSERT INTO system_config (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = ?`);

  const insertMany = db.transaction((entries) => {
    for (const [key, value] of Object.entries(entries)) {
      stmt.run(key, String(value), nowTs, nowTs);
    }
  });

  insertMany(req.body);
  res.json({ success: true });
});

module.exports = router;