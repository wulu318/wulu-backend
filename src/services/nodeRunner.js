'use strict';

// Optional container runtime for user node services.
//
// Disabled unless SHARE_NODE_RUNNER=docker. Even when enabled it refuses to start when
// the host lacks memory headroom, because running user code next to the API server can
// starve it. Every container is hard-capped and cannot reach the internet.
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const MEMORY_LIMIT = process.env.SHARE_NODE_MEMORY || '192m';
const CPU_LIMIT = process.env.SHARE_NODE_CPUS || '0.5';
const MIN_FREE_MB = 400;
const NETWORK = process.env.SHARE_NODE_NETWORK || 'wulu-share-net';

function minFreeMb() {
  const configured = Number(process.env.SHARE_NODE_MIN_FREE_MB);
  return Number.isFinite(configured) && configured > 0 ? configured : MIN_FREE_MB;
}

function runnerMode() {
  return String(process.env.SHARE_NODE_RUNNER || 'none').toLowerCase();
}

function isEnabled() {
  return runnerMode() === 'docker';
}

function run(cmd, args, options = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: options.timeout || 300_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: String(stdout || ''), stderr: String(stderr || ''), error });
    });
  });
}

function freeMemoryMb() {
  return Math.round(os.freemem() / (1024 * 1024));
}

async function ensureNetwork() {
  const inspect = await run('docker', ['network', 'inspect', NETWORK]);
  if (inspect.ok) return true;
  const create = await run('docker', ['network', 'create', '--internal', NETWORK]);
  return create.ok;
}

function writeDockerfile(dir, manifest) {
  const startCommand = String(manifest.startCommand || 'npm start');
  const installCommand = String(manifest.installCommand || 'npm ci --omit=dev || npm install --omit=dev');
  const dockerfile = [
    'FROM node:22-alpine',
    'WORKDIR /app',
    'COPY . /app',
    `RUN ${installCommand}`,
    'ENV NODE_ENV=production',
    'EXPOSE 3000',
    `CMD ${JSON.stringify(startCommand.split(' '))}`,
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'Dockerfile.wulu'), dockerfile, 'utf8');
}

function containerName(deploymentId) {
  return `wulu-dep-${String(deploymentId).replace(/[^a-zA-Z0-9_.-]/g, '')}`;
}

/**
 * Build and start a deployment. Returns { ok, port } or { ok:false, code, message }.
 * The caller records the outcome; this never throws for expected conditions.
 */
async function startDeployment({ deploymentId, contentDir, manifest }) {
  if (!isEnabled()) {
    return { ok: false, code: 'runtime_unavailable', message: 'SHARE_NODE_RUNNER is not enabled' };
  }

  const free = freeMemoryMb();
  const required = minFreeMb();
  if (free < required) {
    return {
      ok: false,
      code: 'insufficient_memory',
      message: `Host has ${free}MB free but needs at least ${required}MB to start a service container`,
    };
  }

  if (!fs.existsSync(path.join(contentDir, 'package.json'))) {
    return { ok: false, code: 'missing_package_json', message: 'package.json is required for a node service' };
  }

  if (!(await ensureNetwork())) {
    return { ok: false, code: 'network_unavailable', message: 'Could not prepare the container network' };
  }

  writeDockerfile(contentDir, manifest);

  const image = `wulu-share/${containerName(deploymentId)}:latest`;
  const build = await run('docker', ['build', '-f', 'Dockerfile.wulu', '-t', image, '.'], { timeout: 600_000 });
  if (!build.ok) {
    const tail = (build.stderr || build.stdout || '').split('\n').slice(-8).join('\n');
    return { ok: false, code: 'build_failed', message: tail.slice(0, 1500) };
  }

  const port = 20000 + Math.floor(Math.random() * 20000);
  await stopDeployment(deploymentId);

  const start = await run('docker', [
    'run', '-d',
    '--name', containerName(deploymentId),
    '--network', NETWORK,
    '--memory', MEMORY_LIMIT,
    '--memory-swap', MEMORY_LIMIT,
    '--cpus', CPU_LIMIT,
    '--pids-limit', '128',
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,noexec,nosuid,size=64m',
    '-e', 'PORT=3000',
    '-p', `127.0.0.1:${port}:3000`,
    image,
  ]);

  if (!start.ok) {
    const tail = (start.stderr || start.stdout || '').split('\n').slice(-6).join('\n');
    return { ok: false, code: 'start_failed', message: tail.slice(0, 1000) };
  }

  return { ok: true, port, container: containerName(deploymentId) };
}

async function stopDeployment(deploymentId) {
  const name = containerName(deploymentId);
  await run('docker', ['rm', '-f', name], { timeout: 60_000 });
  await run('docker', ['rmi', '-f', `wulu-share/${name}:latest`], { timeout: 60_000 });
}

async function isRunning(deploymentId) {
  const result = await run('docker', ['inspect', '-f', '{{.State.Running}}', containerName(deploymentId)], { timeout: 20_000 });
  return result.ok && result.stdout.trim() === 'true';
}

module.exports = {
  isEnabled,
  runnerMode,
  freeMemoryMb,
  startDeployment,
  stopDeployment,
  isRunning,
  MIN_FREE_MB,
  minFreeMb,
};
