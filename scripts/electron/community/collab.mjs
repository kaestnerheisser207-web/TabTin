import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { inspectPortOwner } from './docker-dev-backend.mjs';

const COLLAB_HEALTH_URL = 'http://127.0.0.1:4100/health';

async function collabHealthy(timeoutMs = 1500) {
  try {
    const response = await fetch(COLLAB_HEALTH_URL, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return response.ok && (await response.text()).includes('ok');
  } catch {
    return false;
  }
}

async function waitForCollab({ timeoutMs = 60_000, pollMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await collabHealthy(Math.min(1500, deadline - Date.now()))) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollMs, deadline - Date.now())),
    );
  }
  throw new Error(
    'Collab 启动超时，请查看 apps/tabtin_django/logs/collab-live.log',
  );
}

export async function ensureCommunityCollab({
  rootDir,
  platform = process.platform,
  skipWorkspaceBuild = false,
  spawnSyncImpl = spawnSync,
} = {}) {
  const owner = inspectPortOwner(4100, rootDir);
  if (
    owner.kind !== 'available' &&
    !owner.reusable &&
    owner.kind !== 'current-repo-stale'
  ) {
    const error = new Error(
      `PORT_CONFLICT: 4100 已被 ${owner.kind} 占用（${owner.owners.join(', ') || 'unknown'}），未停止该进程。`,
    );
    error.code = 'PORT_CONFLICT';
    throw error;
  }
  const healthy = await collabHealthy();
  if ((owner.reusable || owner.kind === 'current-repo-stale') && healthy) {
    return { reused: true };
  }
  if (owner.kind === 'current-repo-stale') {
    for (const processOwner of owner.processOwners)
      process.kill(processOwner.pid, 'SIGTERM');
  }

  const command =
    platform === 'win32'
      ? {
          command: process.env.ComSpec || 'cmd.exe',
          args: [
            '/d',
            '/s',
            '/c',
            'call',
            'scripts\\backend\\collab-live-start.bat',
          ],
        }
      : {
          command: 'bash',
          args: [
            path.join(rootDir, 'scripts', 'backend', 'collab-live-start.sh'),
          ],
        };
  const result = spawnSyncImpl(command.command, command.args, {
    cwd: rootDir,
    env: skipWorkspaceBuild
      ? { ...process.env, MUSE_SKIP_COLLAB_WORKSPACE_BUILD: '1' }
      : process.env,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`Collab startup exited with code ${result.status}`);
  await waitForCollab();
  return { reused: false };
}
