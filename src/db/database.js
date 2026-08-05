'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

let db = null;

function getDb() {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

async function initDb(dbPath) {
  // Ensure directory exists
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // ─── Users ─────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    display_name TEXT DEFAULT '',
    avatar_url TEXT DEFAULT '',
    role TEXT DEFAULT 'user' CHECK(role IN ('user','admin','superadmin')),
    newapi_token TEXT DEFAULT '',
    quota_remaining INTEGER DEFAULT 0,
    quota_total INTEGER DEFAULT 0,
    plan_id TEXT,
    stripe_customer_id TEXT DEFAULT '',
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0,
    last_login_at INTEGER,
    is_active INTEGER DEFAULT 1
  )`);

  // ─── Plans ─────────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    price_monthly REAL DEFAULT 0,
    price_yearly REAL DEFAULT 0,
    quota_monthly INTEGER DEFAULT 0,
    features TEXT DEFAULT '{}',
    model_access TEXT DEFAULT '[]',
    max_context_tokens INTEGER DEFAULT 4096,
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0
  )`);

  // ─── Subscriptions ─────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS subscriptions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    plan_id TEXT NOT NULL REFERENCES plans(id),
    status TEXT DEFAULT 'active' CHECK(status IN ('active','past_due','canceled','expired')),
    started_at INTEGER DEFAULT 0,
    expires_at INTEGER,
    cancelled_at INTEGER,
    created_at INTEGER DEFAULT 0
  )`);

  // ─── Usage Logs ────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS usage_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    model TEXT NOT NULL,
    prompt_tokens INTEGER DEFAULT 0,
    completion_tokens INTEGER DEFAULT 0,
    total_tokens INTEGER DEFAULT 0,
    request_type TEXT DEFAULT 'chat',
    latency_ms INTEGER DEFAULT 0,
    is_stream INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0
  )`);

  // ─── Memory Entries ────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS memory_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    layer TEXT DEFAULT 'working' CHECK(layer IN ('core','working','knowledge','diary-index')),
    content TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0,
    metadata TEXT DEFAULT '{}'
  )`);

  // ─── Diary Entries ─────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS diary_entries (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    date TEXT NOT NULL,
    title TEXT DEFAULT '',
    content TEXT NOT NULL,
    tags TEXT DEFAULT '[]',
    mood TEXT DEFAULT '',
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
  )`);

  // ─── Future Messages ───────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS future_messages (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id),
    deliver_after INTEGER NOT NULL,
    content TEXT NOT NULL,
    is_delivered INTEGER DEFAULT 0,
    delivered_at INTEGER,
    created_at INTEGER DEFAULT 0
  )`);

  // ─── System Config ─────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS system_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at INTEGER DEFAULT 0
  )`);

  // ─── Analytics Events ──────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT DEFAULT '',
    app_version TEXT DEFAULT '',
    os_platform TEXT DEFAULT '',
    os_arch TEXT DEFAULT '',
    language TEXT DEFAULT '',
    uuid TEXT DEFAULT '',
    user_id TEXT DEFAULT '',
    created_at INTEGER DEFAULT 0
  )`);

  // ─── Indexes ───────────────────────────────────────────────────
  db.exec(`CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_user ON usage_logs(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_usage_created ON usage_logs(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_memory_user ON memory_entries(user_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_diary_user_date ON diary_entries(user_id, date)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_future_user ON future_messages(user_id, is_delivered)`);

  // ─── Seed admin user ───────────────────────────────────────────
  const adminEmail = process.env.ADMIN_EMAIL || 'ai@ai.005656.xyz';
  const adminPass = process.env.ADMIN_PASSWORD || 'changeme';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    const { v4: uuidv4 } = require('uuid');
    const hash = bcrypt.hashSync(adminPass, 12);
    db.prepare(`INSERT INTO users (id, email, password_hash, display_name, role, quota_remaining, quota_total)
      VALUES (?, ?, ?, 'Admin', 'superadmin', 999999999, 999999999)`).run(uuidv4(), adminEmail, hash);
    console.log(`[DB] Seeded admin user: ${adminEmail}`);
  }

  // ─── Seed default plans ─────────────────────────────────────────
  const planCount = db.prepare('SELECT COUNT(*) as c FROM plans').get().c;
  if (planCount === 0) {
    const { v4: uuidv4 } = require('uuid');
    const insertPlan = db.prepare(`INSERT INTO plans (id, name, description, price_monthly, price_yearly, quota_monthly, features, model_access, max_context_tokens, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const plans = [
      [uuidv4(), 'Free', 'Basic access with limited quota', 0, 0, 100000, '{"support":"community","diary":true,"future_messages":5}', '["gpt-4o-mini"]', 4096, 0],
      [uuidv4(), 'Pro', 'Professional plan with higher limits', 29, 290, 2000000, '{"support":"priority","diary":true,"future_messages":50,"tag_association":true}', '["gpt-4o-mini","gpt-4o","claude-3-5-sonnet"]', 16384, 1],
      [uuidv4(), 'Max', 'Maximum plan with all features', 99, 990, 10000000, '{"support":"dedicated","diary":true,"future_messages":999,"tag_association":true,"env_awareness":true,"layered_memory":true}', '["gpt-4o-mini","gpt-4o","claude-3-5-sonnet","claude-3-opus","o1-pro"]', 128000, 2],
    ];
    for (const p of plans) insertPlan.run(...p);
    console.log('[DB] Seeded default plans: Free, Pro, Max');
  }

  console.log(`[DB] Initialized: ${dbPath}`);
  return db;
}

module.exports = { initDb, getDb };
