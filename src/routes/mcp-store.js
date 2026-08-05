'use strict';

const express = require('express');
const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// MCP Store — Returns marketplace MCP servers in the format the client expects:
// { code: 0, data: { value: { servers: [...], categories: [...] } } }
// ═══════════════════════════════════════════════════════════════════

const MCP_SERVERS = [
  // ── Search ──────────────────────────────────────────────
  {
    id: 'tavily',
    name: 'Tavily',
    description_zh: '通过 Tavily 搜索 API 获取实时网络搜索结果。',
    description_en: 'Search the web for real-time results using the Tavily search API.',
    category: 'search',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', 'tavily-mcp@latest'],
    requiredEnvKeys: ['TAVILY_API_KEY'],
  },
  {
    id: 'brave-search',
    name: 'Brave Search',
    description_zh: '使用 Brave Search API 进行网络搜索。',
    description_en: 'Perform web searches using the Brave Search API.',
    category: 'search',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-brave-search'],
    requiredEnvKeys: ['BRAVE_API_KEY'],
  },

  // ── Browser ─────────────────────────────────────────────
  {
    id: 'playwright',
    name: 'Playwright',
    description_zh: '通过 Playwright 自动化控制浏览器。',
    description_en: 'Automate and control a browser using Playwright.',
    category: 'browser',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@playwright/mcp@latest'],
  },
  {
    id: 'puppeteer',
    name: 'Puppeteer',
    description_zh: '通过 Puppeteer 控制 Chrome/Chromium 浏览器。',
    description_en: 'Control Chrome/Chromium browsers using Puppeteer.',
    category: 'browser',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-puppeteer'],
  },

  // ── Developer Tools ─────────────────────────────────────
  {
    id: 'github',
    name: 'GitHub',
    description_zh: '管理 GitHub 仓库、Issue、PR 和代码。',
    description_en: 'Manage GitHub repositories, issues, PRs, and code.',
    category: 'developer',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-github'],
    requiredEnvKeys: ['GITHUB_PERSONAL_ACCESS_TOKEN'],
  },
  {
    id: 'gitlab',
    name: 'GitLab',
    description_zh: '管理 GitLab 项目、Issue 和合并请求。',
    description_en: 'Manage GitLab projects, issues, and merge requests.',
    category: 'developer',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-gitlab'],
    requiredEnvKeys: ['GITLAB_PERSONAL_ACCESS_TOKEN'],
    optionalEnvKeys: ['GITLAB_API_URL'],
  },
  {
    id: 'context7',
    name: 'Context7',
    description_zh: '获取最新库文档和 API 参考，提供准确的上游文档上下文。',
    description_en: 'Fetch up-to-date library docs and API references for accurate context.',
    category: 'developer',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@upstash/context7-mcp@latest'],
  },
  {
    id: 'sqlite',
    name: 'SQLite',
    description_zh: '连接和查询 SQLite 数据库。',
    description_en: 'Connect to and query SQLite databases.',
    category: 'developer',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-sqlite'],
    requiredEnvKeys: [],
  },
  {
    id: 'postgres',
    name: 'PostgreSQL',
    description_zh: '连接和查询 PostgreSQL 数据库。',
    description_en: 'Connect to and query PostgreSQL databases.',
    category: 'developer',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-postgres'],
    requiredEnvKeys: ['DATABASE_URL'],
  },
  {
    id: 'redis',
    name: 'Redis',
    description_zh: '连接和操作 Redis 缓存与数据结构。',
    description_en: 'Connect to and operate Redis caches and data structures.',
    category: 'developer',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-redis'],
    requiredEnvKeys: ['REDIS_URL'],
  },

  // ── Productivity ────────────────────────────────────────
  {
    id: 'google-drive',
    name: 'Google Drive',
    description_zh: '浏览和操作 Google Drive 文件。',
    description_en: 'Browse and manage files on Google Drive.',
    category: 'productivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-gdrive'],
    optionalEnvKeys: ['GDRIVE_CREDENTIALS_PATH'],
  },
  {
    id: 'gmail',
    name: 'Gmail',
    description_zh: '读取和发送 Gmail 邮件。',
    description_en: 'Read and send emails through Gmail.',
    category: 'productivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@gongrzhe/server-gmail-autoauth-mcp'],
    requiredEnvKeys: ['GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'GMAIL_REDIRECT_URI'],
  },
  {
    id: 'notion',
    name: 'Notion',
    description_zh: '访问和编辑 Notion 工作区页面。',
    description_en: 'Access and edit pages in a Notion workspace.',
    category: 'productivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-notion'],
    requiredEnvKeys: ['NOTION_TOKEN'],
  },
  {
    id: 'slack',
    name: 'Slack',
    description_zh: '读取和发送 Slack 工作区消息。',
    description_en: 'Read and send messages in a Slack workspace.',
    category: 'productivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-slack'],
    requiredEnvKeys: ['SLACK_BOT_TOKEN', 'SLACK_TEAM_ID'],
  },
  {
    id: 'excel',
    name: 'Excel',
    description_zh: '创建和编辑 Excel 电子表格。',
    description_en: 'Create and edit Excel spreadsheets.',
    category: 'productivity',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@harshcut/mcp-excel'],
    requiredEnvKeys: [],
  },

  // ── Filesystem ──────────────────────────────────────────
  {
    id: 'filesystem',
    name: 'Filesystem',
    description_zh: '安全地读写本地文件系统。',
    description_en: 'Read and write the local filesystem safely.',
    category: 'developer',
    transportType: 'stdio',
    command: 'npx',
    defaultArgs: ['-y', '@modelcontextprotocol/server-filesystem'],
    argPlaceholders: ['/path/to/directory'],
  },
];

const MCP_CATEGORIES = [
  { id: 'search', name_zh: '搜索', name_en: 'Search' },
  { id: 'browser', name_zh: '浏览器', name_en: 'Browser' },
  { id: 'developer', name_zh: '开发者工具', name_en: 'Developer Tools' },
  { id: 'productivity', name_zh: '效率工具', name_en: 'Productivity' },
];

// GET /api/mcp-store
router.get('/', (_req, res) => {
  const responseBody = {
    code: 0,
    data: {
      value: {
        servers: MCP_SERVERS,
        categories: MCP_CATEGORIES,
      },
    },
  };

  res.json(responseBody);
});

module.exports = router;
