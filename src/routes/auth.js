'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const { getDb } = require('../db/database');
const { authMiddleware, generateToken } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// Input Validation Helpers
// ═══════════════════════════════════════════════════════════════════
const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const PASSWORD_MIN_LENGTH = 8;

function validateEmail(email) {
  if (!email || typeof email !== 'string') return false;
  return EMAIL_REGEX.test(email.trim().toLowerCase());
}

function validatePassword(password) {
  if (!password || typeof password !== 'string') return false;
  if (password.length < PASSWORD_MIN_LENGTH) return false;
  if (password.length > 128) return false;
  // Must contain at least one letter and one number
  if (!/[a-zA-Z]/.test(password) || !/[0-9]/.test(password)) return false;
  return true;
}

function sanitizeString(str, maxLen = 255) {
  if (!str || typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen);
}

// ═══════════════════════════════════════════════════════════════════
// Brute-force Protection
// ═══════════════════════════════════════════════════════════════════
const loginAttempts = new Map(); // key: ip, value: { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5;
const LOCK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function checkLoginLock(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return false;
  if (entry.lockedUntil && Date.now() < entry.lockedUntil) return true;
  if (entry.lockedUntil && Date.now() >= entry.lockedUntil) {
    loginAttempts.delete(ip);
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
// Auth Code Store (for OAuth browser flow)
// ═══════════════════════════════════════════════════════════════════
// In production, use Redis. For now, in-memory with TTL.
const authCodeStore = new Map(); // code -> { userId, createdAt }
const AUTH_CODE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function generateAuthCode(userId) {
  const code = crypto.randomBytes(32).toString('hex');
  authCodeStore.set(code, { userId, createdAt: Date.now() });
  // Auto-cleanup
  setTimeout(() => authCodeStore.delete(code), AUTH_CODE_TTL_MS);
  return code;
}

function consumeAuthCode(code) {
  const entry = authCodeStore.get(code);
  if (!entry) return null;
  if (Date.now() - entry.createdAt > AUTH_CODE_TTL_MS) {
    authCodeStore.delete(code);
    return null;
  }
  authCodeStore.delete(code); // one-time use
  return entry;
}

// Cleanup expired auth codes every minute
setInterval(() => {
  const now = Date.now();
  for (const [code, entry] of authCodeStore.entries()) {
    if (now - entry.createdAt > AUTH_CODE_TTL_MS) authCodeStore.delete(code);
  }
}, 60 * 1000);

// ═══════════════════════════════════════════════════════════════════
// Auth Routes
// ═══════════════════════════════════════════════════════════════════

// ─── GET /api/auth/login-url ─────────────────────────────────────
// Returns the Portal login page URL for the Electron client to open.
router.get('/login-url', (_req, res) => {
  const baseUrl = process.env.SERVER_BASE_URL || 'https://ai.005656.xyz';
  res.json({ code: 0, data: { value: `${baseUrl}/portal#/login` } });
});

// ─── POST /api/auth/exchange ──────────────────────────────────────
// Exchange a one-time auth code for access + refresh tokens.
// Client (main.ts) sends: { authCode: code }
// Expects response: { code: 0, data: { accessToken, refreshToken, user, quota } }
router.post('/exchange', (req, res) => {
  const { authCode } = req.body;
  if (!authCode || typeof authCode !== 'string') {
    return res.status(400).json({ code: 1, message: 'authCode is required' });
  }

  const entry = consumeAuthCode(authCode);
  if (!entry) {
    return res.status(400).json({ code: 1, message: 'Invalid or expired auth code' });
  }

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(entry.userId);
  if (!user) {
    return res.status(404).json({ code: 1, message: 'User not found' });
  }

  const accessToken = generateToken(user, '7d');
  const refreshToken = generateToken(user, '30d');

  // Get plan details
  let plan = null;
  if (user.plan_id) {
    plan = db.prepare('SELECT name, quota_monthly, features, model_access, max_context_tokens FROM plans WHERE id = ?').get(user.plan_id);
  }

  res.json({
    code: 0,
    data: {
      accessToken,
      refreshToken,
      user: {
        id: user.id,
        email: user.email,
        displayName: user.display_name,
        avatarUrl: user.avatar_url,
        role: user.role,
        planId: user.plan_id,
        planName: plan?.name || null,
        modelAccess: plan ? JSON.parse(plan.model_access || '[]') : [],
        features: plan ? JSON.parse(plan.features || '{}') : {},
      },
      quota: {
        quotaRemaining: user.quota_remaining,
        quotaTotal: user.quota_total,
        quotaPercentage: user.quota_total > 0 ? Math.round((user.quota_remaining / user.quota_total) * 100) : 0,
        subscriptionStatus: user.plan_id ? 'active' : 'free',
      },
    },
  });
});

// ─── POST /api/auth/register ─────────────────────────────────────
router.post('/register', (req, res) => {
  const { email, password, displayName } = req.body;

  // Validate email
  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }

  // Validate password
  if (!validatePassword(password)) {
    return res.status(400).json({
      error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters, containing both letters and numbers`,
    });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanDisplayName = sanitizeString(displayName);

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(409).json({ error: 'This email is already registered' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  // Assign free plan
  const freePlan = db.prepare('SELECT id, quota_monthly FROM plans WHERE name = ? AND is_active = 1').get('Free');
  const planId = freePlan?.id || null;
  const planQuota = freePlan?.quota_monthly || 100000;

  db.prepare(`INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total, plan_id)
    VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`).run(id, cleanEmail, hash, cleanDisplayName, planQuota, planQuota, planId);

  const token = generateToken({ id, email: cleanEmail, role: 'user', display_name: cleanDisplayName });
  res.status(201).json({ token, user: { id, email: cleanEmail, displayName: cleanDisplayName, role: 'user' } });
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

  const cleanEmail = email.trim().toLowerCase();

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(cleanEmail);
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

// ─── POST /api/auth/portal-login ─────────────────────────────────
// Portal Web page login: returns authCode instead of tokens.
// The browser redirects to the Electron callback URL with the code.
router.post('/portal-login', (req, res) => {
  const clientIp = req.ip || req.connection.remoteAddress;

  if (checkLoginLock(clientIp)) {
    const entry = loginAttempts.get(clientIp);
    const remainingMin = Math.ceil((entry.lockedUntil - Date.now()) / 60000);
    return res.status(429).json({ error: `Too many failed attempts. Try again in ${remainingMin} minutes.` });
  }

  const { email, password, redirect_uri, state } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const cleanEmail = email.trim().toLowerCase();

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(cleanEmail);
  if (!user) {
    recordLoginFailure(clientIp);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    recordLoginFailure(clientIp);
    return res.status(401).json({ error: 'Invalid email or password' });
  }

  resetLoginAttempts(clientIp);
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), user.id);

  // Generate one-time auth code
  const authCode = generateAuthCode(user.id);

  // Build redirect URL
  let redirectUrl = redirect_uri || '';
  if (redirectUrl) {
    const separator = redirectUrl.includes('?') ? '&' : '?';
    redirectUrl = `${redirectUrl}${separator}code=${authCode}&state=${encodeURIComponent(state || '')}`;
  }

  res.json({
    success: true,
    code: authCode,
    redirectUrl,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.display_name,
      role: user.role,
    },
  });
});

// ─── POST /api/auth/portal-register ──────────────────────────────
// Portal Web page registration: creates user and returns authCode.
router.post('/portal-register', (req, res) => {
  const { email, password, displayName, redirect_uri, state } = req.body;

  if (!validateEmail(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address' });
  }
  if (!validatePassword(password)) {
    return res.status(400).json({
      error: `Password must be at least ${PASSWORD_MIN_LENGTH} characters, containing both letters and numbers`,
    });
  }

  const cleanEmail = email.trim().toLowerCase();
  const cleanDisplayName = sanitizeString(displayName);

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(cleanEmail);
  if (existing) return res.status(409).json({ error: 'This email is already registered' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  const freePlan = db.prepare('SELECT id, quota_monthly FROM plans WHERE name = ? AND is_active = 1').get('Free');
  const planId = freePlan?.id || null;
  const planQuota = freePlan?.quota_monthly || 100000;

  db.prepare(`INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total, plan_id)
    VALUES (?, ?, ?, ?, 'user', ?, ?, ?)`).run(id, cleanEmail, hash, cleanDisplayName, planQuota, planQuota, planId);

  const authCode = generateAuthCode(id);

  let redirectUrl = redirect_uri || '';
  if (redirectUrl) {
    const separator = redirectUrl.includes('?') ? '&' : '?';
    redirectUrl = `${redirectUrl}${separator}code=${authCode}&state=${encodeURIComponent(state || '')}`;
  }

  res.status(201).json({
    success: true,
    code: authCode,
    redirectUrl,
    user: { id, email: cleanEmail, displayName: cleanDisplayName, role: 'user' },
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

  if (!validatePassword(newPassword)) {
    return res.status(400).json({
      error: `New password must be at least ${PASSWORD_MIN_LENGTH} characters, containing both letters and numbers`,
    });
  }

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
