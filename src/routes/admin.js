'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(authMiddleware);
router.use(requireRole('admin', 'superadmin'));

// ═══════════════════════════════════════════════════════════════════
// User Management
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/admin/users ─────────────────────────────────────────
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

// ─── PUT /api/admin/users/:id ─────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════
// Stats Overview
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/admin/stats ────────────────────────────────────────
router.get('/stats', (_req, res) => {
  const db = getDb();

  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_active = 1').get().c;
  const totalSubscriptions = db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status = 'active'").get().c;
  const totalQuotaUsed = db.prepare('SELECT COALESCE(SUM(quota_total - quota_remaining), 0) as c FROM users').get().c;
  const totalTokens = db.prepare('SELECT COALESCE(SUM(total_tokens), 0) as c FROM usage_logs').get().c;
  const totalRequests = db.prepare('SELECT COUNT(*) as c FROM usage_logs').get().c;

  res.json({ totalUsers, activeUsers, totalSubscriptions, totalQuotaUsed, totalTokens, totalRequests });
});

// ─── GET /api/admin/users/:id ─────────────────────────────────────
router.get('/users/:id', (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT id, email, display_name, role, plan_id, quota_remaining, quota_total, is_active, created_at, last_login_at FROM users WHERE id = ?').get(req.params.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    role: user.role,
    planId: user.plan_id,
    quotaRemaining: user.quota_remaining,
    quotaTotal: user.quota_total,
    isActive: !!user.is_active,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  });
});

// ─── POST /api/admin/users ───────────────────────────────────────
router.post('/users', (req, res) => {
  const { email, password, displayName, role, quotaRemaining } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already exists' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  db.prepare(`INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, email, hash, displayName || '', role || 'user', quotaRemaining || 100000, quotaRemaining || 100000);

  res.status(201).json({ id, email });
});

// ─── DELETE /api/admin/users/:id ──────────────────────────────────
router.delete('/users/:id', (req, res) => {
  const db = getDb();
  if (req.params.id === req.user.sub) return res.status(400).json({ error: 'Cannot delete yourself' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// Subscription Management
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/admin/subscriptions ─────────────────────────────────
router.get('/subscriptions', (req, res) => {
  const { page = 1, limit = 50, status } = req.query;
  const db = getDb();
  const offset = (Number(page) - 1) * Number(limit);

  let sql = `SELECT s.id, s.user_id, s.plan_id, s.status, s.started_at, s.expires_at, s.cancelled_at, s.created_at,
    u.email as userEmail, u.display_name as userName, p.name as planName
    FROM subscriptions s
    LEFT JOIN users u ON s.user_id = u.id
    LEFT JOIN plans p ON s.plan_id = p.id WHERE 1=1`;
  const params = [];
  if (status) { sql += ' AND s.status = ?'; params.push(status); }
  sql += ' ORDER BY s.created_at DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), offset);

  const subs = db.prepare(sql).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM subscriptions').get().c;
  res.json({ subscriptions: subs, total, page: Number(page), limit: Number(limit) });
});

// ─── PUT /api/admin/subscriptions/:id ────────────────────────────
router.put('/subscriptions/:id', (req, res) => {
  const { status, expiresAt } = req.body;
  const db = getDb();
  const sub = db.prepare('SELECT * FROM subscriptions WHERE id = ?').get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'Subscription not found' });

  if (status) db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?').run(status, req.params.id);
  if (expiresAt) db.prepare('UPDATE subscriptions SET expires_at = ? WHERE id = ?').run(expiresAt, req.params.id);

  res.json({ success: true });
});

// ─── DELETE /api/admin/subscriptions/:id ─────────────────────────
router.delete('/subscriptions/:id', (req, res) => {
  const db = getDb();
  db.prepare('DELETE FROM subscriptions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// Plan Management
// ═══════════════════════════════════════════════════════════════════

// ─── POST /api/admin/plans ────────────────────────────────────────
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

// ─── PUT /api/admin/plans/:id ─────────────────────────────────────
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

// ─── DELETE /api/admin/plans/:id ──────────────────────────────────
router.delete('/plans/:id', (req, res) => {
  const db = getDb();
  db.prepare('UPDATE plans SET is_active = 0 WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// Usage Analytics
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/admin/analytics/overview ────────────────────────────
router.get('/analytics/overview', (req, res) => {
  const db = getDb();

  const nowTs = Math.floor(Date.now() / 1000);
  const weekTs = nowTs - 7 * 86400;
  const monthTs = nowTs - 30 * 86400;

  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const activeUsers = db.prepare('SELECT COUNT(*) as c FROM users WHERE last_login_at > ?').get(weekTs).c;
  const totalTokensUsed = db.prepare('SELECT COALESCE(SUM(total_tokens), 0) as c FROM usage_logs WHERE created_at > ?').get(monthTs).c;
  const totalRequests = db.prepare('SELECT COUNT(*) as c FROM usage_logs WHERE created_at > ?').get(monthTs).c;

  // Revenue by plan
  const planRevenue = db.prepare(`
    SELECT p.name, COUNT(s.id) as subscribers
    FROM plans p LEFT JOIN subscriptions s ON p.id = s.plan_id AND s.status = 'active'
    GROUP BY p.id
  `).all();

  res.json({ totalUsers, activeUsers, totalTokensUsed, totalRequests, planRevenue });
});

// ─── GET /api/admin/analytics/usage ───────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════════════
// System Config
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/admin/config ────────────────────────────────────────
router.get('/config', (_req, res) => {
  const db = getDb();
  const configs = db.prepare('SELECT * FROM system_config').all();
  const result = {};
  for (const c of configs) result[c.key] = c.value;
  res.json(result);
});

// ─── PUT /api/admin/config ────────────────────────────────────────
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

// ═══════════════════════════════════════════════════════════════════
// Skill Store Management
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/admin/skills ────────────────────────────────────────
router.get('/skills', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM store_skills ORDER BY sort_order ASC').all();
  res.json({ skills: rows });
});

// ─── POST /api/admin/skills ───────────────────────────────────────
router.post('/skills', (req, res) => {
  const db = getDb();
  const nowTs = Math.floor(Date.now() / 1000);
  const { id, name, name_zh, description_en, description_zh, tags, url, version, author, source_url, sort_order } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });

  const existing = db.prepare('SELECT id FROM store_skills WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'Skill id already exists' });

  db.prepare(
    `INSERT INTO store_skills (id, name, name_zh, description_en, description_zh, tags, url, version, author, source_url, sort_order, is_active, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ).run(
    id,
    name || '',
    name_zh || '',
    description_en || '',
    description_zh || '',
    Array.isArray(tags) ? JSON.stringify(tags) : (tags || '[]'),
    url || '',
    version || '1.0.0',
    author || 'WULU Team',
    source_url || '',
    sort_order || 0,
    nowTs,
    nowTs,
  );
  res.json({ success: true });
});

// ─── PUT /api/admin/skills/:id ────────────────────────────────────
router.put('/skills/:id', (req, res) => {
  const db = getDb();
  const nowTs = Math.floor(Date.now() / 1000);
  const { name, name_zh, description_en, description_zh, tags, url, version, author, source_url, sort_order, is_active } = req.body;
  const existing = db.prepare('SELECT id FROM store_skills WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Skill not found' });

  db.prepare(
    `UPDATE store_skills SET name = ?, name_zh = ?, description_en = ?, description_zh = ?, tags = ?, url = ?, version = ?, author = ?, source_url = ?, sort_order = ?, is_active = ?, updated_at = ? WHERE id = ?`,
  ).run(
    name ?? '',
    name_zh ?? '',
    description_en ?? '',
    description_zh ?? '',
    Array.isArray(tags) ? JSON.stringify(tags) : (tags ?? '[]'),
    url ?? '',
    version ?? '1.0.0',
    author ?? 'WULU Team',
    source_url ?? '',
    sort_order ?? 0,
    is_active === undefined ? 1 : (is_active ? 1 : 0),
    nowTs,
    req.params.id,
  );
  res.json({ success: true });
});

// ─── DELETE /api/admin/skills/:id ─────────────────────────────────
router.delete('/skills/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM store_skills WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Skill not found' });
  db.prepare('DELETE FROM store_skills WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════════════
// Kit Store Management
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/admin/kits ──────────────────────────────────────────
router.get('/kits', (_req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM store_kits ORDER BY sort_order ASC').all();
  res.json({ kits: rows });
});

// ─── POST /api/admin/kits ─────────────────────────────────────────
router.post('/kits', (req, res) => {
  const db = getDb();
  const nowTs = Math.floor(Date.now() / 1000);
  const { id, name, name_zh, description_en, description_zh, icon, author, version, download_count, try_asking, skills, bundle, bundle_sha256, bundle_size, mcp_servers, connectors, sort_order } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id and name are required' });

  const existing = db.prepare('SELECT id FROM store_kits WHERE id = ?').get(id);
  if (existing) return res.status(409).json({ error: 'Kit id already exists' });

  db.prepare(
    `INSERT INTO store_kits (id, name, name_zh, description_en, description_zh, icon, author, version, download_count, try_asking, skills, bundle, bundle_sha256, bundle_size, mcp_servers, connectors, is_active, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
  ).run(
    id,
    name || '',
    name_zh || '',
    description_en || '',
    description_zh || '',
    icon || '',
    author || 'WULU Team',
    version || '1.0.0',
    String(download_count || '0'),
    JSON.stringify(try_asking || []),
    JSON.stringify(skills || []),
    bundle || '',
    bundle_sha256 || '',
    bundle_size ? String(bundle_size) : '',
    mcp_servers === null || mcp_servers === undefined ? 'null' : JSON.stringify(mcp_servers),
    connectors === null || connectors === undefined ? 'null' : JSON.stringify(connectors),
    sort_order || 0,
    nowTs,
    nowTs,
  );
  res.json({ success: true });
});

// ─── PUT /api/admin/kits/:id ──────────────────────────────────────
router.put('/kits/:id', (req, res) => {
  const db = getDb();
  const nowTs = Math.floor(Date.now() / 1000);
  const { name, name_zh, description_en, description_zh, icon, author, version, download_count, try_asking, skills, bundle, bundle_sha256, bundle_size, mcp_servers, connectors, is_active, sort_order } = req.body;
  const existing = db.prepare('SELECT id FROM store_kits WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Kit not found' });

  db.prepare(
    `UPDATE store_kits SET name = ?, name_zh = ?, description_en = ?, description_zh = ?, icon = ?, author = ?, version = ?, download_count = ?, try_asking = ?, skills = ?, bundle = ?, bundle_sha256 = ?, bundle_size = ?, mcp_servers = ?, connectors = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
  ).run(
    name ?? '',
    name_zh ?? '',
    description_en ?? '',
    description_zh ?? '',
    icon ?? '',
    author ?? 'WULU Team',
    version ?? '1.0.0',
    String(download_count ?? '0'),
    JSON.stringify(try_asking ?? []),
    JSON.stringify(skills ?? []),
    bundle ?? '',
    bundle_sha256 ?? '',
    bundle_size ? String(bundle_size) : '',
    mcp_servers === null || mcp_servers === undefined ? 'null' : JSON.stringify(mcp_servers),
    connectors === null || connectors === undefined ? 'null' : JSON.stringify(connectors),
    is_active === undefined ? 1 : (is_active ? 1 : 0),
    sort_order ?? 0,
    nowTs,
    req.params.id,
  );
  res.json({ success: true });
});

// ─── DELETE /api/admin/kits/:id ───────────────────────────────────
router.delete('/kits/:id', (req, res) => {
  const db = getDb();
  const existing = db.prepare('SELECT id FROM store_kits WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Kit not found' });
  db.prepare('DELETE FROM store_kits WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

module.exports = router;
