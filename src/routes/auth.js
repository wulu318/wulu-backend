'use strict';

const express = require('express');
const bcrypt = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../db/database');
const { authMiddleware, generateToken } = require('../middleware/auth');

const router = express.Router();

router.post('/register', (req, res) => {
  const { email, password, displayName } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = getDb();
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
  if (existing) return res.status(409).json({ error: 'Email already registered' });

  const id = uuidv4();
  const hash = bcrypt.hashSync(password, 12);
  const freePlan = db.prepare('SELECT id FROM plans WHERE name = ? AND is_active = 1').get('Free');

  db.prepare(`INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total, plan_id)
    VALUES (?, ?, ?, ?, 'user', 100000, 100000, ?)`).run(id, email, hash, displayName || '', freePlan?.id || null);

  const token = generateToken({ id, email, role: 'user', display_name: displayName || '' });
  res.status(201).json({ token, user: { id, email, displayName: displayName || '', role: 'user' } });
});

router.post('/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE email = ? AND is_active = 1').get(email);
  if (!user) return res.status(401).json({ error: 'Invalid email or password' });

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

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

router.get('/me', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });

  res.json({
    id: user.id,
    email: user.email,
    displayName: user.display_name,
    avatarUrl: user.avatar_url,
    role: user.role,
    planId: user.plan_id,
    quotaRemaining: user.quota_remaining,
    quotaTotal: user.quota_total,
    createdAt: user.created_at,
    lastLoginAt: user.last_login_at,
  });
});

router.post('/refresh', authMiddleware, (req, res) => {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE id = ? AND is_active = 1').get(req.user.sub);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const token = generateToken(user);
  res.json({ token });
});

module.exports = router;