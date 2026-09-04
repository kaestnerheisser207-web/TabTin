import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeDevTarget,
  resolveDevPlan,
  resolveElectronBuildCommand,
  resolveFullPreviewBuildEnv,
  resolveTargetCommand,
  waitForBackendReady,
  waitForHttpReady,
} from '../dev.mjs';
import { resolveViteDevCommand, stopPort } from './vite-dev.mjs';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

test('default dev plan starts backend before all browser and desktop clients', () => {
  assert.deepEqual(resolveDevPlan(), [
    'backend',
    'admindash',
    'tabtin-web',
    'electron',
  ]);
});

test('health gates accept only successful HTTP responses', async () => {
  const calls = [];
  await waitForHttpReady('http://127.0.0.1:5174/', {
    timeoutMs: 20,
    retryIntervalMs: 1,
    fetchImpl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200 };
    },
  });
  assert.deepEqual(calls, ['http://127.0.0.1:5174/']);
});

test('backend health gate is composed from the three required services', async () => {
  const seen = [];
  await waitForBackendReady(20, {
    waitForHttp: async (url) => seen.push(url),
    waitForTcp: async (host, port) => seen.push(`${host}:${port}`),
  });
  assert.deepEqual(seen.sort(), [
    '127.0.0.1:8100',
    'http://127.0.0.1:4100/health',
    'http://127.0.0.1:6060/health',
    'http://127.0.0.1:6060/health/ready',
  ]);
});

test('dev aliases normalize to product directory names', () => {
  assert.equal(normalizeDevTarget('server'), 'backend');
  assert.equal(normalizeDevTarget('admin'), 'admindash');
  assert.equal(normalizeDevTarget('desktop'), 'electron');
  assert.equal(normalizeDevTarget('web'), 'tabtin-web');
});

test('Electron uses its package lifecycle and local binaries', () => {
  const posix = resolveTargetCommand('electron', ['--no-hmr'], 'darwin');
  assert.deepEqual(posix, {
    command: 'pnpm',
    args: [
      '--filter',
      'tabtin-electron',
      'dev',
      '--',
      '--no-hmr',
    ],
  });

  const windows = resolveTargetCommand('electron', [], 'win32');
  assert.match(windows.command, /cmd(?:\.exe)?$/i);
  assert.deepEqual(windows.args.slice(-4), [
    'pnpm.cmd',
    '--filter',
    'tabtin-electron',
    'dev',
  ]);
});

test('full dev builds Electron before starting its dev process', () => {
  assert.deepEqual(resolveElectronBuildCommand('darwin'), {
    command: 'pnpm',
    args: ['--filter', 'tabtin-electron', 'build'],
  });
  const windows = resolveElectronBuildCommand('win32');
  assert.match(windows.command, /cmd(?:\.exe)?$/i);
  assert.deepEqual(windows.args.slice(-4), [
    'pnpm.cmd',
    '--filter',
    'tabtin-electron',
    'build',
  ]);
});

test('full preview Electron build uses the same local env as Electron dev', () => {
  const env = resolveFullPreviewBuildEnv({ PATH: '/tmp/bin' });
  assert.equal(env.MUSE_BUILD_PROFILE, 'local');
  assert.equal(
    env.MUSE_ELECTRON_DEV_ENV_FILE,
    path.join(rootDir, '.env.local'),
  );
  assert.equal(env.PATH, '/tmp/bin');
});

test('Vite clients use native pnpm launch commands on POSIX and Windows', () => {
  assert.deepEqual(resolveViteDevCommand('admindash', 'linux'), {
    command: 'pnpm',
    args: ['--filter', 'admindash', 'dev'],
  });
  const windows = resolveViteDevCommand('tabtin-web', 'win32');
  assert.match(windows.command, /cmd(?:\.exe)?$/i);
  assert.deepEqual(windows.args.slice(-4), [
    'pnpm.cmd',
    '--filter',
    'tabtin-web',
    'dev',
  ]);
});

test('Windows Vite port cleanup emits a valid PowerShell statement boundary', () => {
  const calls = [];
  stopPort(5174, 'win32', (command, args) => calls.push({ command, args }));
  assert.equal(calls.length, 1);
  assert.match(calls[0].args.at(-1), /^\$port=5174;/);
});

test('scripts root contains only unified public entries', () => {
  const files = readdirSync(path.join(rootDir, 'scripts'), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(files, ['dev.mjs', 'package.mjs']);
});
