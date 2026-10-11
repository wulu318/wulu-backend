'use strict';

const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

function expireSubscriptions(userId) {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);
  const expired = db.prepare(`SELECT plan_id FROM subscriptions
    WHERE user_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`).all(userId, now);
  if (expired.length === 0) return;

  const expireAndDowngrade = db.transaction(() => {
    db.prepare(`UPDATE subscriptions SET status = 'expired'
      WHERE user_id = ? AND status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?`).run(userId, now);
    const user = db.prepare('SELECT plan_id FROM users WHERE id = ?').get(userId);
    const hasRenewal = user && db.prepare(`SELECT 1 FROM subscriptions
      WHERE user_id = ? AND plan_id = ? AND status = 'active'
        AND (expires_at IS NULL OR expires_at > ?) LIMIT 1`).get(userId, user.plan_id, now);
    if (user && !hasRenewal && expired.some((sub) => sub.plan_id === user.plan_id)) {
      const free = db.prepare("SELECT id, quota_monthly FROM plans WHERE name = 'Free' AND is_active = 1").get();
      if (free) db.prepare('UPDATE users SET plan_id = ?, quota_remaining = ?, quota_total = ?, updated_at = ? WHERE id = ?')
        .run(free.id, free.quota_monthly, free.quota_monthly, now, userId);
    }
  });
  expireAndDowngrade();
}

function authMiddleware(req, res, next) {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }
  const token = header.slice(7);
  try {
    const secret = process.env.JWT_SECRET || 'dev-secret';
    const decoded = jwt.verify(token, secret);
    req.user = decoded;
    expireSubscriptions(decoded.sub);
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

function generateToken(user, expiresIn) {
  const secret = process.env.JWT_SECRET || 'dev-secret';
  const exp = expiresIn || process.env.JWT_EXPIRES_IN || '7d';
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role, displayName: user.display_name },
    secret,
    { expiresIn: exp }
  );
}

module.exports = { authMiddleware, requireRole, generateToken };
