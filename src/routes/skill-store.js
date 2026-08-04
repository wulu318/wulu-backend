'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// Skill Store — Returns marketplace skills in the format the client expects:
// { code: 0, data: { value: { marketplace: [...], marketTags: [...], localSkill: [] } } }
// ═══════════════════════════════════════════════════════════════════

// Default built-in marketplace skills
const BUILTIN_SKILLS = [
  {
    id: 'web-search',
    name: 'Web Search',
    description: { en: 'Search the web for real-time information using multiple search engines.', zh: '使用多个搜索引擎搜索实时网络信息。' },
    tags: ['search', 'web'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'news-aggregator',
    name: 'News Aggregator',
    description: { en: 'Fetch and analyze news from multiple sources including HN, GitHub, Product Hunt, and more.', zh: '从多个来源（HN、GitHub、Product Hunt 等）获取和分析新闻。' },
    tags: ['news', 'search'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'document-creator',
    name: 'Document Creator',
    description: { en: 'Create professional documents including DOCX, PDF, and presentations with formatting and templates.', zh: '创建专业文档，包括 DOCX、PDF 和演示文稿，支持格式化和模板。' },
    tags: ['document', 'productivity'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'spreadsheet-analyst',
    name: 'Spreadsheet Analyst',
    description: { en: 'Create, edit, and analyze spreadsheets with formulas, charts, and data visualization.', zh: '创建、编辑和分析电子表格，支持公式、图表和数据可视化。' },
    tags: ['document', 'productivity', 'data'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'diagram-drawing',
    name: 'Diagram Drawing',
    description: { en: 'Generate professional diagrams from natural language — flowcharts, architectures, mindmaps, and more.', zh: '从自然语言生成专业图表——流程图、架构图、思维导图等。' },
    tags: ['visual', 'productivity'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'infographic-designer',
    name: 'Infographic Designer',
    description: { en: 'Generate professional infographics with multiple layout types and visual styles.', zh: '使用多种布局类型和视觉风格生成专业信息图。' },
    tags: ['visual', 'design'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'deep-research',
    name: 'Deep Research',
    description: { en: 'Conduct comprehensive multi-source research with citation tracking and structured reporting.', zh: '进行多源综合研究，支持引用追踪和结构化报告。' },
    tags: ['research', 'search'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'contract-review',
    name: 'Contract Review',
    description: { en: 'Review contracts with structured issue annotations, risk assessment, and revision suggestions.', zh: '审查合同，提供结构化问题标注、风险评估和修订建议。' },
    tags: ['legal', 'document'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'scheduler',
    name: 'Scheduler',
    description: { en: 'Create, manage, and run scheduled tasks with cron and one-time execution support.', zh: '创建、管理和运行定时任务，支持 cron 和一次性执行。' },
    tags: ['automation', 'productivity'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'canvas-design',
    name: 'Canvas Design',
    description: { en: 'Create beautiful visual art, posters, and designs using AI image generation.', zh: '使用 AI 图像生成创建精美的视觉艺术、海报和设计。' },
    tags: ['visual', 'design', 'creative'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'pptx-creator',
    name: 'PPT Creator',
    description: { en: 'Create, edit, and manage PowerPoint presentations for reports, proposals, and courseware.', zh: '创建、编辑和管理 PPT 演示文稿，用于汇报、提案和课件。' },
    tags: ['document', 'productivity', 'presentation'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
  {
    id: 'memory-manager',
    name: 'Memory Manager',
    description: { en: 'Manage long-term memory — store preferences, recall past context, and review daily logs.', zh: '管理长期记忆——存储偏好、回忆过往上下文、查看每日日志。' },
    tags: ['memory', 'productivity'],
    url: '',
    version: '1.0.0',
    source: { from: 'WULU', url: 'https://ai.005656.xyz', author: 'WULU Team' },
  },
];

const BUILTIN_TAGS = [
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
];

// GET /api/skill-store
router.get('/', (_req, res) => {
  const responseBody = {
    code: 0,
    data: {
      value: {
        marketplace: BUILTIN_SKILLS,
        marketTags: BUILTIN_TAGS,
        localSkill: [],
      },
    },
  };

  res.json(responseBody);
});

module.exports = router;
