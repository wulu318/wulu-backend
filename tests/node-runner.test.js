'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('node runner stays off by default', async () => {
  const saved = process.env.SHARE_NODE_RUNNER;
  delete process.env.SHARE_NODE_RUNNER;
  try {
    const runner = require('../src/services/nodeRunner');
    assert.equal(runner.isEnabled(), false);
    const result = await runner.startDeployment({ deploymentId: 'dep_x', contentDir: os.tmpdir(), manifest: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'runtime_unavailable');
  } finally {
    if (saved !== undefined) process.env.SHARE_NODE_RUNNER = saved;
  }
});

test('node runner refuses to start without memory headroom', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wulu-runner-'));
  const saved = {
    mode: process.env.SHARE_NODE_RUNNER,
    min: process.env.SHARE_NODE_MIN_FREE_MB,
  };
  process.env.SHARE_NODE_RUNNER = 'docker';
  process.env.SHARE_NODE_MIN_FREE_MB = '100000000';

  try {
    const runner = require('../src/services/nodeRunner');
    assert.equal(runner.isEnabled(), true);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'svc', version: '1.0.0' }));

    const result = await runner.startDeployment({ deploymentId: 'dep_mem', contentDir: dir, manifest: {} });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'insufficient_memory');
    assert.match(result.message, /at least/);
  } finally {
    if (saved.mode === undefined) delete process.env.SHARE_NODE_RUNNER;
    else process.env.SHARE_NODE_RUNNER = saved.mode;
    if (saved.min === undefined) delete process.env.SHARE_NODE_MIN_FREE_MB;
    else process.env.SHARE_NODE_MIN_FREE_MB = saved.min;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
