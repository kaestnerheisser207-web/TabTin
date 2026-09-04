#!/usr/bin/env node
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const rootDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const aliases = new Map([
  ['server', 'backend'],
  ['admin', 'admindash'],
  ['desktop', 'electron'],
  ['web', 'tabtin-web'],
]);
const targetScripts = {
  backend: 'scripts/backend/dev.mjs',
  admindash: 'scripts/admindash/dev.mjs',
  electron: 'scripts/electron/dev.mjs',
  'tabtin-web': 'scripts/tabtin-web/dev.mjs',
  community: 'scripts/electron/community/start.mjs',
};
const defaultClients = ['admindash', 'tabtin-web', 'electron'];
const clientHealthUrls = {
  admindash: 'http://127.0.0.1:5174/',
  'tabtin-web': 'http://127.0.0.1:5176/',
};

export function normalizeDevTarget(value = 'all') {
  const normalized = value.trim().toLowerCase();
  return aliases.get(normalized) ?? normalized;
}

export function resolveDevPlan(value = 'all') {
  const target = normalizeDevTarget(value);
  if (target === 'all') return ['backend', ...defaultClients];
  if (target in targetScripts) return [target];
  throw new Error(
    `未知开发目标 “${value}”。可用目标: all, ${Object.keys(targetScripts).join(', ')}`,
  );
}

export function resolveTargetCommand(
  target,
  args = [],
  platform = process.platform,
) {
  if (target === 'electron') {
    const pnpmArgs = [
      '--filter',
      'tabtin-electron',
      'dev',
      ...(args.length > 0 ? ['--', ...args] : []),
    ];
    if (platform === 'win32') {
      return {
        command: process.env.ComSpec || 'cmd.exe',
        args: ['/d', '/s', '/c', 'pnpm.cmd', ...pnpmArgs],
      };
    }
    return { command: 'pnpm', args: pnpmArgs };
  }

  return {
    command: process.execPath,
    args: [path.join(rootDir, targetScripts[target]), ...args],
  };
}

export function resolveElectronBuildCommand(platform = process.platform) {
  if (platform === 'win32') {
    return {
      command: process.env.ComSpec || 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', '--filter', 'tabtin-electron', 'build'],
    };
  }
  return {
    command: 'pnpm',
    args: ['--filter', 'tabtin-electron', 'build'],
  };
}

/**
 * The Electron build performed by Full Preview is a local debug build.
 * Keep its environment source aligned with the later Electron dev process:
 * both must use the repository-level `.env.local`, not `.env.production`.
 */
export function resolveFullPreviewBuildEnv(env = process.env) {
  return {
    ...env,
    MUSE_BUILD_PROFILE: 'local',
    MUSE_ELECTRON_DEV_ENV_FILE: path.join(rootDir, '.env.local'),
  };
}

function spawnTarget(target, args = []) {
  const command = resolveTargetCommand(target, args);
  return spawn(
    command.command,
    command.args,
    {
      cwd: rootDir,
      env: process.env,
      stdio: 'inherit',
    },
  );
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForHttpReady(
  url,
  { timeoutMs = 60_000, retryIntervalMs = 500, fetchImpl = fetch } = {},
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'no response';
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(Math.min(2_000, deadline - Date.now())),
      });
      if (response.ok) return true;
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await wait(Math.min(retryIntervalMs, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`${url} did not become healthy within ${timeoutMs}ms (${lastError})`);
}

function waitForTcpReady(host, port, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    let lastError = 'connection refused';
    let timer;
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.setTimeout(2_000);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.destroy();
        resolve(true);
      });
      socket.once('error', (error) => {
        lastError = error.message;
        socket.destroy();
        schedule();
      });
      socket.once('timeout', () => {
        lastError = 'connection timeout';
        socket.destroy();
        schedule();
      });
    };
    const schedule = () => {
      if (Date.now() >= deadline) {
        reject(new Error(`${host}:${port} did not become ready within ${timeoutMs}ms (${lastError})`));
        return;
      }
      timer = setTimeout(attempt, 500);
    };
    attempt();
  });
}

export async function waitForBackendReady(
  timeoutMs = 60_000,
  { waitForHttp = waitForHttpReady, waitForTcp = waitForTcpReady } = {},
) {
  await Promise.all([
    waitForHttp('http://127.0.0.1:6060/health', { timeoutMs }),
    waitForHttp('http://127.0.0.1:6060/health/ready', { timeoutMs }),
    waitForHttp('http://127.0.0.1:4100/health', { timeoutMs }),
    waitForTcp('127.0.0.1', 8100, timeoutMs),
  ]);
}

async function waitForClientReady(target) {
  const url = clientHealthUrls[target];
  if (!url) return;
  await waitForHttpReady(url);
}

function ensureWorkspaceDependencies() {
  if (existsSync(path.join(rootDir, 'node_modules', '.modules.yaml'))) return;
  const windows = process.platform === 'win32';
  const command = windows ? process.env.ComSpec || 'cmd.exe' : 'pnpm';
  const args = windows
    ? ['/d', '/s', '/c', 'pnpm.cmd', 'install', '--frozen-lockfile']
    : ['install', '--frozen-lockfile'];
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`pnpm install exited with code ${result.status}`);
  }
}

function buildElectronOnce() {
  const command = resolveElectronBuildCommand();
  console.log('[dev] 后端已就绪，先构建 Electron 主进程、preload 和 renderer...');
  const result = spawnSync(command.command, command.args, {
    cwd: rootDir,
    env: resolveFullPreviewBuildEnv(),
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  return result.status ?? (result.signal ? 1 : 0);
}

export async function runDev(value = 'all', args = []) {
  const plan = resolveDevPlan(value);
  if (!plan.includes('community')) ensureWorkspaceDependencies();
  const children = [];
  const stopChildren = (signal = 'SIGTERM') => {
    for (const child of children) {
      if (!child.killed) child.kill(signal);
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => stopChildren(signal));
  }

  if (plan[0] === 'backend') {
    console.log('[dev] 先启动后端并等待健康检查通过...');
    const backend = spawnTarget('backend', plan.length === 1 ? args : []);
    children.push(backend);
    const backendCode = await waitForExit(backend);
    children.splice(children.indexOf(backend), 1);
    if (backendCode !== 0 || plan.length === 1) return backendCode;
    try {
      await waitForBackendReady();
    } catch (error) {
      console.error(`[dev] 后端健康检查失败: ${error.message}`);
      stopChildren();
      return 1;
    }
  }

  // 根目录 `pnpm dev` 是完整本地开发入口：后端就绪后先完成一次 Electron
  // 构建，避免 electron-vite dev 已运行时又被打包链抢占并迫使窗口退出重启。
  // 单独执行 `pnpm dev electron` 不改变原有快速开发行为。
  if (normalizeDevTarget(value) === 'all') {
    const electronBuildCode = buildElectronOnce();
    if (electronBuildCode !== 0) {
      console.error(`[dev] Electron 构建失败，退出码 ${electronBuildCode}；不会启动客户端`);
      stopChildren();
      return electronBuildCode;
    }
    console.log('[dev] Electron 构建完成，继续启动 AdminDash 和 tabtin-web');
  }

  const clients = plan.filter((target) => target !== 'backend');
  for (const target of clients) {
    console.log(`[dev] 启动客户端: ${target}`);
    const child = spawnTarget(target, args);
    children.push(child);
    try {
      await waitForClientReady(target);
      if (clientHealthUrls[target]) {
        console.log(`[dev] ${target} 健康检查通过`);
      }
    } catch (error) {
      console.error(`[dev] ${target} 健康检查失败: ${error.message}`);
      stopChildren();
      return 1;
    }
  }
  const codes = await Promise.all(
    children.map((child, index) =>
      waitForExit(child).then((code) => {
        if (code !== 0) {
          const target = clients[index] ?? 'backend';
          console.error(`[dev] 客户端 ${target} 异常退出（code ${code}），停止其余客户端`);
          stopChildren();
        }
        return code;
      }),
    ),
  );
  return codes.find((code) => code !== 0) ?? 0;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    process.exitCode = await runDev(
      process.argv[2] ?? 'all',
      process.argv.slice(3).filter((arg) => arg !== '--'),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
