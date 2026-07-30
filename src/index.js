'use strict';

require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');

const { initDb } = require('./db/database');
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/user');
const planRoutes = require('./routes/plan');
const modelProxyRoutes = require('./routes/model-proxy');
const memoryRoutes = require('./routes/memory');
const adminRoutes = require('./routes/admin');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'https://ai.005656.xyz',
  credentials: true,
}));
app.use(express.json({ limit: '10mb' }));

app.use(rateLimit({
  windowMs: 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
}));

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', version: '1.0.0', timestamp: Date.now() });
});

app.use('/api/auth', authRoutes);
app.use('/api/user', userRoutes);
app.use('/api/plans', planRoutes);
app.use('/api/v1', modelProxyRoutes);
app.use('/api/memory', memoryRoutes);
app.use('/api/admin', adminRoutes);

app.use((err, _req, res, _next) => {
  console.error('[ERROR]', err.message || err);
  const status = err.status || 500;
  res.status(status).json({ error: err.message || 'Internal server error' });
});

async function main() {
  const dbPath = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'wulu.db');
  await initDb(dbPath);
  app.listen(PORT, () => {
    console.log(`[WULU Backend] Listening on port ${PORT}`);
    console.log(`[WULU Backend] CORS origin: ${process.env.CORS_ORIGIN || 'https://ai.005656.xyz'}`);
  });
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});