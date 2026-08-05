'use strict';

const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// Skill Store — Returns marketplace skills in the format the client expects:
// { code: 0, data: { value: { marketplace: [...], marketTags: [...], localSkill: [] } } }
// Data is read from the store_skills table, managed via the admin dashboard.
// ═══════════════════════════════════════════════════════════════════

// GET /api/skill-store
router.get('/', (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM store_skills WHERE is_active = 1 ORDER BY sort_order ASC',
  ).all();

  const marketplace = rows.map((r) => {
    let tags = [];
    try { tags = JSON.parse(r.tags || '[]'); } catch { tags = []; }
    return {
      id: r.id,
      name: r.name,
      description: { en: r.description_en, zh: r.description_zh },
      tags,
      url: r.url || '',
      version: r.version || '1.0.0',
      source: { from: r.author || 'WULU', url: r.source_url || 'https://ai.005656.xyz', author: r.author || 'WULU Team' },
    };
  });

  const responseBody = {
    code: 0,
    data: {
      value: {
        marketplace,
        marketTags: [
          { id: 'search', en: 'Search', zh: '搜索' },
          { id: 'web', en: 'Web', zh: '网络' },
          { id: 'news', en: 'News', zh: '新闻' },
          { id: 'document', en: 'Document', zh: '文档' },
          { id: 'productivity', en: 'Productivity', zh: '效率' },
          { id: 'data', en: 'Data', zh: '数据' },
          { id: 'visual', en: 'Visual', zh: '可视化' },
          { id: 'design', en: 'Design', zh: '设计' },
          { id: 'creative', en: 'Creative', zh: '创意' },
          { id: 'research', en: 'Research', zh: '研究' },
          { id: 'legal', en: 'Legal', zh: '法律' },
          { id: 'automation', en: 'Automation', zh: '自动化' },
          { id: 'memory', en: 'Memory', zh: '记忆' },
          { id: 'presentation', en: 'Presentation', zh: '演示' },
        ],
        localSkill: [],
      },
    },
  };

  res.json(responseBody);
});

module.exports = router;
