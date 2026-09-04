import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { EventEmitter } from 'node:events';
import { formatCommunityDevHelp } from './options.mjs';
import {
  prepareElectronWorkspace,
  runCommunityDev,
  startCommunityElectron,
} from './start.mjs';
import {
  ensureRootEnvFile,
  writeCommunityRuntimeEnvFile,
} from './environment.mjs';

const PREPARE_DEV_RUNTIME_SEGMENTS = [
  'apps',
  'tabtin-electron',
  'scripts',
  'prepare-dev-runtime.mjs',
];

test('root env bootstrap copies the template once and preserves user config', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin root env '));
  const envFile = path.join(rootDir, '.env');
  const templateFile = path.join(rootDir, '.env.example');
  try {
    await fs.writeFile(
      templateFile,
      'MUSE_EDITION=community\nAUTH_FIXED_VERIFICATION_CODE=888888\n',
    );

    const created = await ensureRootEnvFile(envFile, templateFile);
    assert.equal(created.changed, true);
    assert.equal(
      await fs.readFile(envFile, 'utf8'),
      'MUSE_EDITION=community\nAUTH_FIXED_VERIFICATION_CODE=888888\n',
    );

    await fs.writeFile(envFile, 'MUSE_EDITION=saas\n');
    const preserved = await ensureRootEnvFile(envFile, templateFile);
    assert.equal(preserved.changed, true);
    assert.equal(
      await fs.readFile(envFile, 'utf8'),
      'MUSE_EDITION=saas\nAUTH_FIXED_VERIFICATION_CODE=\n',
    );

    await fs.writeFile(
      envFile,
      'MUSE_EDITION=saas\nAUTH_FIXED_VERIFICATION_CODE=\n',
    );
    const disabled = await ensureRootEnvFile(envFile, templateFile);
    assert.equal(disabled.changed, false);
    assert.equal(
      await fs.readFile(envFile, 'utf8'),
      'MUSE_EDITION=saas\nAUTH_FIXED_VERIFICATION_CODE=\n',
    );
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('runtime env contains only the two public root switches', async () => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin runtime env '));
  const rootEnvFile = path.join(rootDir, '.env');
  const runtimeEnvFile = path.join(rootDir, '.env.community-runtime');
  try {
    await fs.writeFile(
      rootEnvFile,
      'MUSE_EDITION=community\n' +
        'AUTH_FIXED_VERIFICATION_CODE=888888\n' +
        'OPENAI_API_KEY=must-not-enter-container\n' +
        'AWS_SECRET_ACCESS_KEY=must-not-enter-container\n',
    );

    await writeCommunityRuntimeEnvFile(rootEnvFile, runtimeEnvFile);

    assert.equal(
      await fs.readFile(runtimeEnvFile, 'utf8'),
      'MUSE_EDITION=community\nAUTH_FIXED_VERIFICATION_CODE=888888\n',
    );
    assert.equal((await fs.stat(runtimeEnvFile)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(rootDir, { recursive: true, force: true });
  }
});

test('community help explains the self-contained quick-start workflow', () => {
  const help = formatCommunityDevHelp();

  assert.match(help, /automatically runs environment checks/i);
  assert.match(help, /apps\/tabtin-electron\/\.env\.opensource\.local/);
});

function createWorkspaceChild(calls, { command, args, options }) {
  calls.push({ command, args, options });
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  queueMicrotask(() => child.emit('close', 0, null));
  return child;
}

function backendReconciliationDeps(getCollabHealthy = () => false) {
  return {
    startBackend: async () => {},
    waitForBackend: async () => ({
      healthy: true,
      coreHealthy: true,
      collabHealthy: getCollabHealthy(),
      checks: [],
    }),
  };
}

test('community workspace prep shares pnpm predev runtime, including filegen', async () => {
  const calls = [];
  await prepareElectronWorkspace({
    rootDir: '/repo',
    platform: 'darwin',
    spawnImpl: (command, args, options) =>
      createWorkspaceChild(calls, { command, args, options }),
    writeOutput: () => {},
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.deepEqual(calls[0].args, [
    path.posix.join('/repo', ...PREPARE_DEV_RUNTIME_SEGMENTS),
    '--core',
  ]);
  assert.equal(calls[0].options.cwd, '/repo');
});

test('windows community workspace prep uses win32 script path', async () => {
  const calls = [];
  await prepareElectronWorkspace({
    rootDir: 'C:\\repo',
    platform: 'win32',
    spawnImpl: (command, args, options) =>
      createWorkspaceChild(calls, { command, args, options }),
    writeOutput: () => {},
  });

  assert.deepEqual(calls[0].args, [
    path.win32.join('C:\\repo', ...PREPARE_DEV_RUNTIME_SEGMENTS),
    '--core',
  ]);
});

test('workspace prep streams split readiness lines before the build exits', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  let ready = false;
  let mirrored = '';
  const running = prepareElectronWorkspace({
    rootDir: '/repo',
    notifySeed: 'collab-live',
    spawnImpl: () => child,
    writeOutput: (chunk) => {
      mirrored += chunk.toString();
    },
    onSeedReady: () => {
      ready = true;
    },
  });

  child.stdout.emit('data', Buffer.from('Layer 3 done\n[predev-build][seed-'));
  assert.equal(ready, false);
  child.stdout.emit('data', Buffer.from('ready] collab-live\nLayer 4 start\n'));
  assert.equal(ready, true);
  assert.match(mirrored, /Layer 4 start/);
  child.emit('close', 0, null);
  await running;
});

test('workspace prep fails when the requested readiness event is missing', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  const running = prepareElectronWorkspace({
    rootDir: '/repo',
    notifySeed: 'collab-live',
    spawnImpl: () => child,
    writeOutput: () => {},
  });
  child.emit('close', 0, null);
  await assert.rejects(running, /without collab-live readiness event/);
});

test('community dry-run reports backend topology reconciliation', async () => {
  const output = [];

  await runCommunityDev({
    rootDir: '/repo',
    argv: ['--dry-run'],
    output: (line) => output.push(line),
  });

  assert.ok(output.includes('backend: reconcile current dev topology'));
});

test('a healthy Backend core is reconciled with the current dev topology before Electron starts', async () => {
  let backendStarts = 0;
  let backendWaits = 0;
  let collabStarts = 0;
  let collabHealthy = false;
  await runCommunityDev({
    rootDir: '/repo',
    argv: [],
    output: () => {},
    probeBackend: async () => ({
      healthy: true,
      coreHealthy: true,
      collabHealthy,
      checks: [
        {
          id: 'collab',
          ok: collabHealthy,
          endpoint: 'http://127.0.0.1:4100/health',
          detail: collabHealthy ? 'healthy response' : 'fetch failed',
        },
      ],
    }),
    doctor: async () => [],
    resolveRegion: async () => 'global',
    ensureInstall: async () => ({ cached: true }),
    ensureEnv: async () => {},
    startBackend: async () => {
      backendStarts += 1;
    },
    waitForBackend: async () => {
      backendWaits += 1;
      return {
        healthy: true,
        coreHealthy: true,
        collabHealthy,
        checks: [],
      };
    },
    ensureCollab: async (options) => {
      collabStarts += 1;
      assert.equal(options.skipWorkspaceBuild, true);
      collabHealthy = true;
    },
    prepareWorkspace: async ({ notifySeed, onSeedReady }) => {
      assert.equal(notifySeed, 'collab-live');
      onSeedReady();
    },
    startElectron: async () => {},
    startOptionalPreparation: () => Promise.resolve(),
  });

  assert.equal(backendStarts, 1);
  assert.equal(backendWaits, 1);
  assert.equal(collabStarts, 1);
});

test('missing optional host Centrifugo does not block Docker backend startup', async () => {
  let probeCount = 0;
  let ensureCentrifugoCalls = 0;
  let startedBackend = false;
  await runCommunityDev({
    rootDir: '/repo',
    argv: ['--region', 'cn'],
    output: () => {},
    probeBackend: async () => {
      probeCount += 1;
      return {
        healthy: probeCount > 1,
        coreHealthy: probeCount > 1,
        collabHealthy: true,
        checks: [],
      };
    },
    doctor: async () => [
      {
        id: 'centrifugo',
        ok: false,
        required: false,
        summary: 'host binary is unavailable',
      },
    ],
    resolveRegion: async (requestedRegion) => requestedRegion,
    ensureCentrifugo: async ({ region }) => {
      ensureCentrifugoCalls += 1;
      assert.equal(region, 'cn');
      return { available: false, error: new Error('mirror unavailable') };
    },
    ensureInstall: async () => ({ cached: true }),
    ensureEnv: async () => {},
    startBackend: async () => {
      startedBackend = true;
    },
    waitForBackend: async () => ({
      healthy: true,
      coreHealthy: true,
      collabHealthy: true,
      checks: [],
    }),
    ensureCollab: async () => {},
    prepareWorkspace: async () => {},
    startElectron: async () => {},
    startOptionalPreparation: () => Promise.resolve(),
  });

  assert.equal(ensureCentrifugoCalls, 1);
  assert.equal(startedBackend, true);
});

test('doctor mode does not install the optional host Centrifugo binary', async () => {
  let ensureCentrifugoCalls = 0;
  const result = await runCommunityDev({
    rootDir: '/repo',
    argv: ['--doctor', '--region', 'cn'],
    output: () => {},
    probeBackend: async () => ({
      healthy: false,
      coreHealthy: false,
      collabHealthy: false,
      checks: [],
    }),
    doctor: async () => [],
    resolveRegion: async () => 'cn',
    ensureCentrifugo: async () => {
      ensureCentrifugoCalls += 1;
    },
  });

  assert.equal(result.mode, 'doctor');
  assert.equal(ensureCentrifugoCalls, 0);
});

test('Collab starts while later Electron workspace layers are still building', async () => {
  let collabHealthy = false;
  let collabStarted = false;
  let releaseWorkspace;
  const workspaceGate = new Promise((resolve) => {
    releaseWorkspace = resolve;
  });
  const running = runCommunityDev({
    ...backendReconciliationDeps(() => collabHealthy),
    rootDir: '/repo',
    argv: [],
    output: () => {},
    probeBackend: async () => ({
      healthy: true,
      coreHealthy: true,
      collabHealthy,
      checks: [],
    }),
    doctor: async () => [],
    resolveRegion: async () => 'global',
    ensureInstall: async () => ({ cached: true }),
    ensureEnv: async () => {},
    ensureCollab: async () => {
      collabStarted = true;
      collabHealthy = true;
    },
    prepareWorkspace: async ({ onSeedReady }) => {
      onSeedReady();
      await workspaceGate;
    },
    startElectron: async () => {},
    startOptionalPreparation: () => Promise.resolve(),
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(collabStarted, true);
  releaseWorkspace();
  await running;
});

test('Collab startup failures are propagated after the shared build', async () => {
  await assert.rejects(
    runCommunityDev({
      ...backendReconciliationDeps(),
      rootDir: '/repo',
      argv: [],
      output: () => {},
      probeBackend: async () => ({
        healthy: true,
        coreHealthy: true,
        collabHealthy: false,
        checks: [],
      }),
      doctor: async () => [],
      resolveRegion: async () => 'global',
      ensureInstall: async () => ({ cached: true }),
      ensureEnv: async () => {},
      ensureCollab: async () => {
        throw new Error('collab start failed');
      },
      prepareWorkspace: async ({ onSeedReady }) => onSeedReady(),
      startElectron: async () => {},
      startOptionalPreparation: () => Promise.resolve(),
    }),
    /collab start failed/,
  );
});

test('a healthy Collab validates ownership without a readiness request', async () => {
  let collabStarts = 0;
  let collabOptions;
  let workspaceOptions;
  await runCommunityDev({
    ...backendReconciliationDeps(() => true),
    rootDir: '/repo',
    argv: [],
    output: () => {},
    probeBackend: async () => ({
      healthy: true,
      coreHealthy: true,
      collabHealthy: true,
      checks: [],
    }),
    doctor: async () => [],
    resolveRegion: async () => 'global',
    ensureInstall: async () => ({ cached: true }),
    ensureEnv: async () => {},
    ensureCollab: async (options) => {
      collabStarts += 1;
      collabOptions = options;
    },
    prepareWorkspace: async (options) => {
      workspaceOptions = options;
    },
    startElectron: async () => {},
    startOptionalPreparation: () => Promise.resolve(),
  });

  assert.equal(collabStarts, 1);
  assert.equal(collabOptions.skipWorkspaceBuild, undefined);
  assert.equal(workspaceOptions.notifySeed, undefined);
  assert.equal(workspaceOptions.onSeedReady, undefined);
});

test('a healthy foreign Collab blocks before workspace preparation', async () => {
  let workspaceStarts = 0;
  const conflict = new Error('PORT_CONFLICT: foreign Collab');
  conflict.code = 'PORT_CONFLICT';

  await assert.rejects(
    runCommunityDev({
      ...backendReconciliationDeps(() => true),
      rootDir: '/repo',
      argv: [],
      output: () => {},
      probeBackend: async () => ({
        healthy: true,
        coreHealthy: true,
        collabHealthy: true,
        checks: [],
      }),
      doctor: async () => [],
      resolveRegion: async () => 'global',
      ensureInstall: async () => ({ cached: true }),
      ensureEnv: async () => {},
      ensureCollab: async () => {
        throw conflict;
      },
      prepareWorkspace: async () => {
        workspaceStarts += 1;
      },
      startElectron: async () => {},
      startOptionalPreparation: () => Promise.resolve(),
    }),
    /PORT_CONFLICT: foreign Collab/,
  );

  assert.equal(workspaceStarts, 0);
});

test('optional Python preparation does not delay Electron READY', async () => {
  const child = new EventEmitter();
  child.pid = 91;
  child.kill = () => {};
  const signalSource = new EventEmitter();
  let optionalStarted = false;
  let resolveOptional;
  const optional = new Promise((resolve) => {
    resolveOptional = resolve;
  });
  const outputs = [];
  const running = startCommunityElectron({
    rootDir: '/repo',
    output: (line) => outputs.push(line),
    spawnImpl: () => child,
    signalSource,
    waitForReady: async () => {},
    onReady: () => {
      optionalStarted = true;
      return optional;
    },
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(optionalStarted, true);
  assert.ok(outputs.some((line) => line.includes('Electron 已就绪')));

  child.emit('exit', 0, null);
  await running;
  resolveOptional();
});
