#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifyPortOwner } from './backend.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const ROOT_DIR = path.resolve(path.dirname(SCRIPT_PATH), '../../..');
const DEV_IMAGE = 'muse/community-django:dev';
const FINGERPRINT_LABEL = 'com.tabtin.community.dev-dependency-fingerprint';
const FINGERPRINT_INPUTS = [
  'apps/tabtin_django/Dockerfile',
  'apps/tabtin_django/requirements.txt',
  'apps/tabtin_django/docker-entrypoint.sh',
  'compose.community-dev.yaml',
];

export function computeDockerDevDependencyFingerprint(rootDir = ROOT_DIR) {
  const hash = crypto.createHash('sha256');
  for (const relativePath of FINGERPRINT_INPUTS) {
    hash.update(`${relativePath}\0`);
    hash.update(fs.readFileSync(path.join(rootDir, relativePath)));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function run(
  command,
  args,
  { rootDir, env = process.env, capture = false } = {},
) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    env,
    encoding: capture ? 'utf8' : undefined,
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result;
}

export function filterDockerRecordsPublishingHostPort(records, port) {
  const published = new RegExp(`:${port}->`);
  return records.filter((record) =>
    String(record.Ports ?? '')
      .split(',')
      .some((binding) => published.test(binding.trim())),
  );
}

function dockerOwnersForPort(port, rootDir, runCommand = run) {
  const listed = runCommand('docker', ['ps', '--format', '{{json .}}'], {
    rootDir,
    capture: true,
  });
  if (listed.status !== 0) throw new Error(listed.stderr || 'docker ps failed');
  const records = listed.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  const ids = filterDockerRecordsPublishingHostPort(records, port).map(
    (record) => record.ID,
  );
  return ids.map((id) => {
    const inspected = runCommand(
      'docker',
      ['inspect', '--format', '{{json .Config.Labels}}|{{.Name}}', id],
      { rootDir, capture: true },
    );
    if (inspected.status !== 0)
      throw new Error(inspected.stderr || `docker inspect ${id} failed`);
    const separator = inspected.stdout.lastIndexOf('|');
    return {
      labels: JSON.parse(inspected.stdout.slice(0, separator)),
      name: inspected.stdout
        .slice(separator + 1)
        .trim()
        .replace(/^\//, ''),
    };
  });
}

function processOwnersForPort(port, rootDir, platform, runCommand = run) {
  if (platform === 'win32') {
    const listed = runCommand('netstat', ['-ano', '-p', 'tcp'], {
      rootDir,
      capture: true,
    });
    if (listed.error || (listed.status !== 0 && listed.status !== 1)) return [];
    const pids = listed.stdout
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/))
      .filter(
        (parts) =>
          parts[0]?.toUpperCase() === 'TCP' &&
          parts[1]?.endsWith(`:${port}`) &&
          parts[3]?.toUpperCase() === 'LISTENING',
      )
      .map((parts) => Number.parseInt(parts[4], 10))
      .filter(Number.isInteger);
    return [...new Set(pids)].map((pid) => {
      const command = runCommand(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `(Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}').CommandLine`,
        ],
        { rootDir, capture: true },
      );
      return { pid, command: command.stdout.trim() };
    });
  }

  const listed = runCommand('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fp'], {
    rootDir,
    capture: true,
  });
  if (listed.error || (listed.status !== 0 && listed.status !== 1)) return [];
  const pids = listed.stdout
    .split('\n')
    .filter((line) => line.startsWith('p'))
    .map((line) => Number.parseInt(line.slice(1), 10))
    .filter(Number.isInteger);
  return pids.map((pid) => {
    const command = runCommand('ps', ['-p', String(pid), '-o', 'command='], {
      rootDir,
      capture: true,
    });
    const cwdResult = runCommand(
      'lsof',
      ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      {
        rootDir,
        capture: true,
      },
    );
    const cwd = cwdResult.stdout
      .split('\n')
      .find((line) => line.startsWith('n'))
      ?.slice(1);
    return { pid, command: command.stdout.trim(), cwd };
  });
}

export function inspectPortOwner(
  port,
  rootDir = ROOT_DIR,
  { platform = process.platform, runImpl = run } = {},
) {
  const dockerOwners = dockerOwnersForPort(port, rootDir, runImpl);
  return classifyPortOwner({
    rootDir,
    dockerOwners,
    processOwners:
      dockerOwners.length > 0
        ? []
        : processOwnersForPort(port, rootDir, platform, runImpl),
  });
}

function assertPortOwnership(port, rootDir) {
  const owner = inspectPortOwner(port, rootDir);
  if (owner.kind === 'available' || owner.reusable) return owner;
  if (owner.kind === 'current-repo-stale') {
    for (const processOwner of owner.processOwners)
      process.kill(processOwner.pid, 'SIGTERM');
    return owner;
  }
  const error = new Error(
    `PORT_CONFLICT: ${port} 已被 ${owner.kind} 占用（${owner.owners.join(', ') || 'unknown'}），未停止该进程。`,
  );
  error.code = 'PORT_CONFLICT';
  throw error;
}

function inspectImageFingerprint(rootDir) {
  const result = run(
    'docker',
    [
      'image',
      'inspect',
      '--format',
      `{{ index .Config.Labels "${FINGERPRINT_LABEL}" }}`,
      DEV_IMAGE,
    ],
    { rootDir, capture: true },
  );
  return result.status === 0 ? result.stdout.trim() : '';
}

export function resolveDockerDevComposeArgs(rootDir) {
  return [
    'compose',
    '--project-directory',
    rootDir,
    '--env-file',
    path.join(rootDir, '.env'),
    '-f',
    path.join(rootDir, 'compose.yaml'),
    '-f',
    path.join(rootDir, 'compose.community-dev.yaml'),
  ];
}

export function createDockerDevEnvironment({
  baseEnv = process.env,
  fingerprint,
} = {}) {
  const env = {
    ...baseEnv,
    COMPOSE_DISABLE_ENV_FILE: '1',
    MUSE_DEV_DEPENDENCY_FINGERPRINT: fingerprint,
  };
  delete env.MUSE_EDITION;
  delete env.AUTH_FIXED_VERIFICATION_CODE;
  return env;
}

export function ensureDockerDevBackend({ rootDir = ROOT_DIR } = {}) {
  for (const port of [6060, 8100]) assertPortOwnership(port, rootDir);

  const fingerprint = computeDockerDevDependencyFingerprint(rootDir);
  const env = createDockerDevEnvironment({ fingerprint });
  if (inspectImageFingerprint(rootDir) !== fingerprint) {
    console.log('[community-dev] Docker Dev 依赖发生变化，构建一次后端镜像');
    const built = run(
      'docker',
      [...resolveDockerDevComposeArgs(rootDir), 'build', 'django'],
      { rootDir, env },
    );
    if (built.status !== 0)
      throw new Error(
        `Docker Dev image build exited with code ${built.status}`,
      );
  } else {
    console.log('[community-dev] Docker Dev 依赖指纹未变化，复用现有镜像');
  }

  const started = run(
    'docker',
    [
      ...resolveDockerDevComposeArgs(rootDir),
      'up',
      '-d',
      '--no-build',
      'postgres',
      'redis',
      'django',
      'celery',
      'centrifugo',
    ],
    { rootDir, env },
  );
  if (started.status !== 0)
    throw new Error(`Docker Dev Backend exited with code ${started.status}`);
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  try {
    ensureDockerDevBackend();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
