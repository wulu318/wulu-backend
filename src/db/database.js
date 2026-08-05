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

  // ─── Skill Store ───────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS store_skills (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_zh TEXT DEFAULT '',
    description_en TEXT DEFAULT '',
    description_zh TEXT DEFAULT '',
    tags TEXT DEFAULT '[]',
    url TEXT DEFAULT '',
    version TEXT DEFAULT '1.0.0',
    author TEXT DEFAULT 'WULU Team',
    source_url TEXT DEFAULT '',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
  )`);

  // ─── Kit Store ─────────────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS store_kits (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    name_zh TEXT DEFAULT '',
    description_en TEXT DEFAULT '',
    description_zh TEXT DEFAULT '',
    icon TEXT DEFAULT '',
    author TEXT DEFAULT 'WULU Team',
    version TEXT DEFAULT '1.0.0',
    download_count TEXT DEFAULT '0',
    try_asking TEXT DEFAULT '[]',
    skills TEXT DEFAULT '[]',
    bundle TEXT DEFAULT '',
    bundle_sha256 TEXT DEFAULT '',
    bundle_size TEXT DEFAULT '',
    mcp_servers TEXT DEFAULT 'null',
    connectors TEXT DEFAULT 'null',
    is_active INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
  )`);

  // ─── Update Versions ───────────────────────────────────────────
  db.exec(`CREATE TABLE IF NOT EXISTS update_versions (
    version TEXT PRIMARY KEY,
    title TEXT DEFAULT '',
    release_notes TEXT DEFAULT '',
    date TEXT DEFAULT '',
    is_latest INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    -- Full package URLs per platform
    windows_x64_url TEXT DEFAULT '',
    windows_x64_size TEXT DEFAULT '',
    windows_x64_sha256 TEXT DEFAULT '',
    mac_arm_url TEXT DEFAULT '',
    mac_arm_size TEXT DEFAULT '',
    mac_arm_sha256 TEXT DEFAULT '',
    mac_intel_url TEXT DEFAULT '',
    mac_intel_size TEXT DEFAULT '',
    mac_intel_sha256 TEXT DEFAULT '',
    linux_x64_url TEXT DEFAULT '',
    linux_x64_size TEXT DEFAULT '',
    linux_x64_sha256 TEXT DEFAULT '',
    linux_arm64_url TEXT DEFAULT '',
    linux_arm64_size TEXT DEFAULT '',
    linux_arm64_sha256 TEXT DEFAULT '',
    -- Incremental patch from a base version to this version
    incremental_base_version TEXT DEFAULT '',
    incremental_url TEXT DEFAULT '',
    incremental_size TEXT DEFAULT '',
    incremental_sha256 TEXT DEFAULT '',
    created_at INTEGER DEFAULT 0,
    updated_at INTEGER DEFAULT 0
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

  // ─── Seed skill store ───────────────────────────────────────────
  const skillCount = db.prepare('SELECT COUNT(*) as c FROM store_skills').get().c;
  if (skillCount === 0) {
    const nowTs = Math.floor(Date.now() / 1000);
    const insertSkill = db.prepare(
      `INSERT INTO store_skills (id, name, name_zh, description_en, description_zh, tags, url, version, author, source_url, sort_order, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
    );
    const skills = [
      ['web-search', 'Web Search', '网页搜索', 'Search the web for real-time information using multiple search engines.', '使用多个搜索引擎搜索实时网络信息。', '["search","web"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 0],
      ['news-aggregator', 'News Aggregator', '新闻聚合', 'Fetch and analyze news from multiple sources including HN, GitHub, Product Hunt, and more.', '从多个来源（HN、GitHub、Product Hunt 等）获取和分析新闻。', '["news","search"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 1],
      ['document-creator', 'Document Creator', '文档创建', 'Create professional documents including DOCX, PDF, and presentations with formatting and templates.', '创建专业文档，包括 DOCX、PDF 和演示文稿，支持格式化和模板。', '["document","productivity"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 2],
      ['spreadsheet-analyst', 'Spreadsheet Analyst', '表格分析', 'Create, edit, and analyze spreadsheets with formulas, charts, and data visualization.', '创建、编辑和分析电子表格，支持公式、图表和数据可视化。', '["document","productivity","data"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 3],
      ['diagram-drawing', 'Diagram Drawing', '图表绘制', 'Generate professional diagrams from natural language — flowcharts, architectures, mindmaps, and more.', '从自然语言生成专业图表——流程图、架构图、思维导图等。', '["visual","productivity"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 4],
      ['infographic-designer', 'Infographic Designer', '信息图设计', 'Generate professional infographics with multiple layout types and visual styles.', '使用多种布局类型和视觉风格生成专业信息图。', '["visual","design"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 5],
      ['deep-research', 'Deep Research', '深度研究', 'Conduct comprehensive multi-source research with citation tracking and structured reporting.', '进行多源综合研究，支持引用追踪和结构化报告。', '["research","search"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 6],
      ['contract-review', 'Contract Review', '合同审查', 'Review contracts with structured issue annotations, risk assessment, and revision suggestions.', '审查合同，提供结构化问题标注、风险评估和修订建议。', '["legal","document"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 7],
      ['scheduler', 'Scheduler', '定时任务', 'Create, manage, and run scheduled tasks with cron and one-time execution support.', '创建、管理和运行定时任务，支持 cron 和一次性执行。', '["automation","productivity"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 8],
      ['canvas-design', 'Canvas Design', '画布设计', 'Create beautiful visual art, posters, and designs using AI image generation.', '使用 AI 图像生成创建精美的视觉艺术、海报和设计。', '["visual","design","creative"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 9],
      ['pptx-creator', 'PPT Creator', 'PPT 创建', 'Create, edit, and manage PowerPoint presentations for reports, proposals, and courseware.', '创建、编辑和管理 PPT 演示文稿，用于汇报、提案和课件。', '["document","productivity","presentation"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 10],
      ['memory-manager', 'Memory Manager', '记忆管理', 'Manage long-term memory — store preferences, recall past context, and review daily logs.', '管理长期记忆——存储偏好、回忆过往上下文、查看每日日志。', '["memory","productivity"]', '', '1.0.0', 'WULU Team', 'https://ai.005656.xyz', 11],
    ];
    for (const [id, name, nameZh, descEn, descZh, tags, url, version, author, sourceUrl, sortOrder] of skills) {
      insertSkill.run(id, name, nameZh, descEn, descZh, tags, url, version, author, sourceUrl, sortOrder, nowTs, nowTs);
    }
    console.log(`[DB] Seeded ${skills.length} store skills`);
  }

  // ─── Seed kit store ─────────────────────────────────────────────
  const kitCount = db.prepare('SELECT COUNT(*) as c FROM store_kits').get().c;
  if (kitCount === 0) {
    const nowTs = Math.floor(Date.now() / 1000);
    const insertKit = db.prepare(
      `INSERT INTO store_kits (id, name, name_zh, description_en, description_zh, icon, author, version, download_count, try_asking, skills, bundle, mcp_servers, connectors, is_active, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    );
    const kits = [
      ['wulu-productivity-pack', 'Productivity Pack', '效率套件', 'Essential productivity skills bundled together — document creation, spreadsheets, scheduling, and deep research.', '必备效率技能打包——文档创建、电子表格、定时任务和深度研究。', 'https://ai.005656.xyz/runtime/computer-use-kit.png', 'WULU Team', '1.0.0', '0',
        '[{"en":"Create a project report in DOCX format","zh":"用 DOCX 格式创建项目报告"},{"en":"Analyze this Excel data and create a summary chart","zh":"分析这份 Excel 数据并创建汇总图表"},{"en":"Schedule a daily news briefing at 8 AM","zh":"设置每天早上8点的新闻简报定时任务"}]',
        '[{"id":"document-creator","name":{"en":"Document Creator","zh":"文档创建"},"description":{"en":"Create DOCX/PDF documents","zh":"创建 DOCX/PDF 文档"}},{"id":"spreadsheet-analyst","name":{"en":"Spreadsheet Analyst","zh":"表格分析"},"description":{"en":"Analyze and create spreadsheets","zh":"分析和创建电子表格"}},{"id":"scheduler","name":{"en":"Scheduler","zh":"定时任务"},"description":{"en":"Manage scheduled tasks","zh":"管理定时任务"}},{"id":"deep-research","name":{"en":"Deep Research","zh":"深度研究"},"description":{"en":"Multi-source research","zh":"多源研究"}}]',
        '', 'null', 'null', 0],
      ['wulu-visual-pack', 'Visual Design Pack', '视觉设计套件', 'All visual creation tools in one kit — diagrams, infographics, presentations, and canvas art.', '所有视觉创作工具打包——图表、信息图、演示文稿和画布设计。', 'https://ai.005656.xyz/runtime/computer-use-kit.png', 'WULU Team', '1.0.0', '0',
        '[{"en":"Draw a system architecture diagram","zh":"画一个系统架构图"},{"en":"Create an infographic about AI trends","zh":"创建一个关于 AI 趋势的信息图"},{"en":"Design a presentation for product launch","zh":"设计一个产品发布的演示文稿"}]',
        '[{"id":"diagram-drawing","name":{"en":"Diagram Drawing","zh":"图表绘制"},"description":{"en":"Generate professional diagrams","zh":"生成专业图表"}},{"id":"infographic-designer","name":{"en":"Infographic Designer","zh":"信息图设计"},"description":{"en":"Design infographics","zh":"设计信息图"}},{"id":"pptx-creator","name":{"en":"PPT Creator","zh":"PPT 创建"},"description":{"en":"Create presentations","zh":"创建演示文稿"}},{"id":"canvas-design","name":{"en":"Canvas Design","zh":"画布设计"},"description":{"en":"Create visual art","zh":"创建视觉艺术"}}]',
        '', 'null', 'null', 1],
      ['wulu-analysis-pack', 'Analysis & Research Pack', '分析研究套件', 'Professional analysis toolkit — contract review, deep research, and memory management for complex tasks.', '专业分析工具包——合同审查、深度研究和记忆管理，应对复杂任务。', 'https://ai.005656.xyz/runtime/computer-use-kit.png', 'WULU Team', '1.0.0', '0',
        '[{"en":"Review this contract for potential risks","zh":"审查这份合同的潜在风险"},{"en":"Research the latest trends in quantum computing","zh":"调研量子计算的最新趋势"},{"en":"Remember that I prefer concise summaries","zh":"记住我喜欢简洁的摘要"}]',
        '[{"id":"contract-review","name":{"en":"Contract Review","zh":"合同审查"},"description":{"en":"Review contracts with risk analysis","zh":"审查合同并进行风险分析"}},{"id":"deep-research","name":{"en":"Deep Research","zh":"深度研究"},"description":{"en":"Multi-source research with citations","zh":"带引用的多源研究"}},{"id":"memory-manager","name":{"en":"Memory Manager","zh":"记忆管理"},"description":{"en":"Manage long-term memory","zh":"管理长期记忆"}},{"id":"web-search","name":{"en":"Web Search","zh":"网页搜索"},"description":{"en":"Search the web","zh":"搜索网络"}}]',
        '', 'null', 'null', 2],
    ];
    for (const [id, name, nameZh, descEn, descZh, icon, author, version, downloadCount, tryAsking, skills, bundle, mcpServers, connectors, sortOrder] of kits) {
      insertKit.run(id, name, nameZh, descEn, descZh, icon, author, version, downloadCount, tryAsking, skills, bundle, mcpServers, connectors, sortOrder, nowTs, nowTs);
    }
    console.log(`[DB] Seeded ${kits.length} store kits`);
  }

  // ─── Seed update versions ───────────────────────────────────────
  const updateVersionCount = db.prepare('SELECT COUNT(*) as c FROM update_versions').get().c;
  if (updateVersionCount === 0) {
    const nowTs = Math.floor(Date.now() / 1000);
    db.prepare(
      `INSERT INTO update_versions (version, title, release_notes, date, is_latest, is_active, windows_x64_url, windows_x64_size, mac_arm_url, mac_arm_size, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 1, ?, ?, ?, ?, ?, ?)`,
    ).run(
      '2026.7.23',
      'WULU SuperAgent v2026.7.23',
      '初始公开版本。\n- 全场景 AI 办公助手\n- IM 机器人接入（微信/钉钉/飞书/企微/QQ/Telegram/Discord）\n- 定时任务与自动化\n- 长期记忆系统\n- 多平台支持（Windows/macOS/Linux）',
      '2026-08-04',
      'https://github.com/wulu318/wulu-superagent/releases/download/v2026.7.23/WULU-Setup-x64-2026.7.23-official.exe',
      '262226143',
      'https://github.com/wulu318/wulu-superagent/releases/download/v2026.7.23/wulu-darwin-arm64-2026.7.23-official.dmg',
      '332410789',
      nowTs,
      nowTs,
    );
    console.log('[DB] Seeded initial update version 2026.7.23');
  }

  console.log(`[DB] Initialized: ${dbPath}`);
  return db;
}

module.exports = { initDb, getDb };
