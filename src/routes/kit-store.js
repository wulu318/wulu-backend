'use strict';

const express = require('express');
const { getDb } = require('../db/database');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// Kit Store — Returns marketplace kits in the format the client expects:
// { code: 0, data: { value: { kits: [...] } } }
// Data is read from the store_kits table, managed via the admin dashboard.
//
// Note: The client's main process will inject built-in kits
// (SkinPack + ComputerUse) into the response automatically.
// ═══════════════════════════════════════════════════════════════════

// GET /api/kit-store
router.get('/', (_req, res) => {
  const db = getDb();
  const rows = db.prepare(
    'SELECT * FROM store_kits WHERE is_active = 1 ORDER BY sort_order ASC',
  ).all();

  const kits = rows.map((r) => {
    let tryAsking = [];
    try { tryAsking = JSON.parse(r.try_asking || '[]'); } catch { tryAsking = []; }
    let skills = [];
    try { skills = JSON.parse(r.skills || '[]'); } catch { skills = []; }
    let mcpServers = null;
    try {
      const v = r.mcp_servers === null || r.mcp_servers === undefined || r.mcp_servers === '' || r.mcp_servers === 'null'
        ? null
        : JSON.parse(r.mcp_servers);
      mcpServers = v;
    } catch { mcpServers = null; }
    let connectors = null;
    try {
      const v = r.connectors === null || r.connectors === undefined || r.connectors === '' || r.connectors === 'null'
        ? null
        : JSON.parse(r.connectors);
      connectors = v;
    } catch { connectors = null; }

    return {
      id: r.id,
      name: { en: r.name, zh: r.name_zh },
      description: { en: r.description_en, zh: r.description_zh },
      icon: r.icon || '',
      author: r.author || 'WULU Team',
      version: r.version || '1.0.0',
      downloadCount: r.download_count || '0',
      tryAsking,
      skills: {
        bundle: r.bundle || '',
        ...(r.bundle_sha256 ? { bundleSha256: r.bundle_sha256 } : {}),
        ...(r.bundle_size ? { bundleSizeBytes: Number(r.bundle_size) || 0 } : {}),
        list: skills,
      },
      mcpServers,
      connectors,
    };
  });

  const responseBody = {
    code: 0,
    data: {
      value: {
        kits,
      },
    },
  };

  res.json(responseBody);
});

module.exports = router;
