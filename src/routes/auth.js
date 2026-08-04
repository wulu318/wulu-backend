'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, generateToken } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// Brute-force Protection
// ═══════════════════════════════════════════════════════════════════
const loginAttempts = new Map(); // key: ip, value: { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginLock(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true; // still locked
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    loginAttempts.delete(ip); // lock expired, reset
    return false;
  }
  return false;
}

function recordLoginFailure(ip) {
  let entry = loginAttempts.get(ip);
  if (!entry || (entry.lockedUntil && Date.now() >= entry.lockedUntil)) {
    entry = { count: 0, lockedUntil: null };
  }
  entry.count++;
  if (entry.count >= MAX_LOGIN_ATTEMPTS) {
    entry.lockedUntil = Date.now() + LOCK_DURATION_MS;
  }
  loginAttempts.set(ip, entry);
}

function resetLoginAttempts(ip) {
  loginAttempts.delete(ip);
}

// Cleanup stale entries every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of loginAttempts.entries()) {
    if (entry.lockedUntil && now >= entry.lockedUntil) loginAttempts.delete(ip);
  }
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// Auth Routes
// ═══════════════════════════════════════════════════════════════════

// ─── POST /api/auth/register ─────────────────────────────────────
router.post('/register', (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  // Assign free plan
  const freePlan = db.prepare('SELECT id, quota_monthly FROM plans WHERE name = ? AND is_active = 1').get('Free');
  const planId = freePlan?.id || null;
  const planQuota = freePlan?.quota_monthly || 100000;

  db.prepare(`INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total, plan_id)
    VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`).run(id, email, hash, displayName || '', planQuota, planQuota, planId);

  const token = generateToken({ id, email, role: 'user', display_name: displayName || '' });
  res.status(201).json({ token, user: { id, email, displayName: displayName || '', role: 'user' } });
});

// ─── POST /api/auth/login ────────────────────────────────────────
router.post('/login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;

  // Check brute-force lock
  if (checkLoginLock(clientIp)) {
    const entry = loginAttempts.get(clientIp);
    const remainingMin = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${remainingMin} minutes.` });
  }

  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
  if (!user) {
    recordLoginFailure(clientIp);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    recordLoginFailure(clientIp);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  // Success: reset attempts
  resetLoginAttempts(clientIp);

  // Update last login
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), user.id);

  const token = generateToken(user);
  res.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
      planId: user.plan_id,
      quotaRemaining: user.quota_remaining,
      quotaTotal: user.quota_total,
    },
  });
});

// ─── GET /api/auth/me ────────────────────────────────────────────
router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Include plan details
  let plan = null;
  if (user.plan_id) {
    plan = db.prepare('SELECT id, name, quota_monthly, features, model_access, max_context_tokens FROM plans WHERE id = ?').get(user.plan_id);
  }

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    role: user.role,
    planId: user.plan_id,
    planName: plan?.name || null,
    modelAccess: plan ? JSON.parse(plan.model_access || '[]') : [],
    features: plan ? JSON.parse(plan.features || '{}') : {},
    maxContextTokens: plan?.max_context_tokens || 4096,
    quotaRemaining: user.quota_remaining,
    quotaTotal: user.quota_total,
    quotaPercentage: user.quota_total > 0 ? Math.round((user.quota_remaining / user.quota_total) * 100) : 0,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  });
});

// ─── PUT /api/auth/change-password ──────────────────────────────
router.put('/change-password', authMiddleware, (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword) return res.status(400).json({ error: 'currentPassword and newPassword required' });
  if (newPassword.length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const valid = bcrypt.compareSync(currentPassword, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Current password is incorrect' });

  const hash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?').run(hash, Math.floor(Date.now() / 1000), user.id);
  res.json({ success: true, message: 'Password changed successfully' });
});

// ─── POST /api/auth/refresh ──────────────────────────────────────
router.post('/refresh', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const token = generateToken(user);
  res.json({ token });
});

module.exports = router;
