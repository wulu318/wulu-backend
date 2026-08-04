'use strict';

const express = require('express');
const { getDb } = require('../db/database');
const { authMiddleware } = require('../middleware/auth');

const router = express.Router();

// ═══════════════════════════════════════════════════════════════════
// Kit Store — Returns marketplace kits in the format the client expects:
// { code: 0, data: { value: { kits: [...] } } }
//
// Note: The client's main process will inject built-in kits
// (SkinPack + ComputerUse) into the response automatically.
// ═══════════════════════════════════════════════════════════════════

// Community kits available in the store
const STORE_KITS = [
  {
    id: 'wulu-productivity-pack',
    name: { en: 'Productivity Pack', zh: '效率套件' },
    description: { en: 'Essential productivity skills bundled together — document creation, spreadsheets, scheduling, and deep research.', zh: '必备效率技能打包——文档创建、电子表格、定时任务和深度研究。' },
    icon: '',
    author: 'WULU Team',
    version: '1.0.0',
    downloadCount: '0',
    tryAsking: [
      { en: 'Create a project report in DOCX format', zh: '用 DOCX 格式创建项目报告' },
      { en: 'Analyze this Excel data and create a summary chart', zh: '分析这份 Excel 数据并创建汇总图表' },
      { en: 'Schedule a daily news briefing at 8 AM', zh: '设置每天早上8点的新闻简报定时任务' },
    ],
    skills: {
      bundle: '',
      list: [
        { id: 'document-creator', name: { en: 'Document Creator', zh: '文档创建' }, description: { en: 'Create DOCX/PDF documents', zh: '创建 DOCX/PDF 文档' } },
        { id: 'spreadsheet-analyst', name: { en: 'Spreadsheet Analyst', zh: '表格分析' }, description: { en: 'Analyze and create spreadsheets', zh: '分析和创建电子表格' } },
        { id: 'scheduler', name: { en: 'Scheduler', zh: '定时任务' }, description: { en: 'Manage scheduled tasks', zh: '管理定时任务' } },
        { id: 'deep-research', name: { en: 'Deep Research', zh: '深度研究' }, description: { en: 'Multi-source research', zh: '多源研究' } },
      ],
    },
    mcpServers: null,
    connectors: null,
  },
  {
    id: 'wulu-visual-pack',
    name: { en: 'Visual Design Pack', zh: '视觉设计套件' },
    description: { en: 'All visual creation tools in one kit — diagrams, infographics, presentations, and canvas art.', zh: '所有视觉创作工具打包——图表、信息图、演示文稿和画布设计。' },
    icon: '',
    author: 'WULU Team',
    version: '1.0.0',
    downloadCount: '0',
    tryAsking: [
      { en: 'Draw a system architecture diagram', zh: '画一个系统架构图' },
      { en: 'Create an infographic about AI trends', zh: '创建一个关于 AI 趋势的信息图' },
      { en: 'Design a presentation for product launch', zh: '设计一个产品发布的演示文稿' },
    ],
    skills: {
      bundle: '',
      list: [
        { id: 'diagram-drawing', name: { en: 'Diagram Drawing', zh: '图表绘制' }, description: { en: 'Generate professional diagrams', zh: '生成专业图表' } },
        { id: 'infographic-designer', name: { en: 'Infographic Designer', zh: '信息图设计' }, description: { en: 'Design infographics', zh: '设计信息图' } },
        { id: 'pptx-creator', name: { en: 'PPT Creator', zh: 'PPT 创建' }, description: { en: 'Create presentations', zh: '创建演示文稿' } },
        { id: 'canvas-design', name: { en: 'Canvas Design', zh: '画布设计' }, description: { en: 'Create visual art', zh: '创建视觉艺术' } },
      ],
    },
    mcpServers: null,
    connectors: null,
  },
  {
    id: 'wulu-analysis-pack',
    name: { en: 'Analysis & Research Pack', zh: '分析研究套件' },
    description: { en: 'Professional analysis toolkit — contract review, deep research, and memory management for complex tasks.', zh: '专业分析工具包——合同审查、深度研究和记忆管理，应对复杂任务。' },
    icon: '',
    author: 'WULU Team',
    version: '1.0.0',
    downloadCount: '0',
    tryAsking: [
      { en: 'Review this contract for potential risks', zh: '审查这份合同的潜在风险' },
      { en: 'Research the latest trends in quantum computing', zh: '调研量子计算的最新趋势' },
      { en: 'Remember that I prefer concise summaries', zh: '记住我喜欢简洁的摘要' },
    ],
    skills: {
      bundle: '',
      list: [
        { id: 'contract-review', name: { en: 'Contract Review', zh: '合同审查' }, description: { en: 'Review contracts with risk analysis', zh: '审查合同并进行风险分析' } },
        { id: 'deep-research', name: { en: 'Deep Research', zh: '深度研究' }, description: { en: 'Multi-source research with citations', zh: '带引用的多源研究' } },
        { id: 'memory-manager', name: { en: 'Memory Manager', zh: '记忆管理' }, description: { en: 'Manage long-term memory', zh: '管理长期记忆' } },
        { id: 'web-search', name: { en: 'Web Search', zh: '网页搜索' }, description: { en: 'Search the web', zh: '搜索网络' } },
      ],
    },
    mcpServers: null,
    connectors: null,
  },
];

// GET /api/kit-store
router.get('/', (_req, res) => {
  const responseBody = {
    code: 0,
    data: {
      value: {
        kits: STORE_KITS,
      },
    },
  };

  res.json(responseBody);
});

module.exports = router;
