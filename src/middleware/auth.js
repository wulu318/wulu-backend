'use strict';

const jwt = require('jsonwebtoken');

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