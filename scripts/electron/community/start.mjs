import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  collectCommunityDoctorChecks,
  createCommunityDoctorRuntimeContext,
} from './doctor.mjs';
import {
  formatBackendFailure,
  probeCommunityBackend,
  resolveCommunityDevBackendCommand,
  startCommunityDevBackend,
  waitForCommunityBackend,
} from './backend.mjs';
import { ensureCommunityCollab } from './collab.mjs';
import {
  computeElectronInstallFingerprint,
  isElectronInstallCurrent,
  markElectronInstallCurrent,
} from './install-cache.mjs';
import {
  ensureCommunityEnvFile,
  ensureRootEnvFile,
  writeCommunityRuntimeEnvFile,
} from './environment.mjs';
import { formatCommunityDevHelp, parseCommunityDevArgs } from './options.mjs';
import {
  resolveElectronInstallProfile,
  resolveElectronInstallRegion,
} from '../install-dependencies.mjs';
import { ensureCentrifugoBinary } from './centrifugo.mjs';
import { waitForElectronReady } from './electron-readiness.mjs';
import { runTimedStage } from './timing.mjs';
import { parsePredevSeedReady } from '../predev-build-events.mjs';

const SCRIPT_PATH = fileURLToPath(import.meta.url);
const HEALTH_TARGETS = [
  'Django http://127.0.0.1:6060/health',
  'Collab http://127.0.0.1:4100/health',
  'Centrifugo 127.0.0.1:8100',
];

function getRootDir() {
  return path.resolve(path.dirname(SCRIPT_PATH), '../../..');
}

function getEnvironmentFile(rootDir) {
  return path.join(rootDir, 'apps', 'tabtin-electron', '.env.opensource.local');
}

function getElectronCommand(rootDir) {
  return {
    command: process.execPath,
    args: [
      path.join(rootDir, 'scripts', 'electron', 'dev.mjs'),
      '--env-file',
      getEnvironmentFile(rootDir),
    ],
  };
}

function assertSpawnSucceeded(result, stage) {
  if (result.error) throw result.error;
  if (result.signal)
    throw new Error(`${stage} terminated by signal ${result.signal}`);
  if (result.status !== 0)
    throw new Error(`${stage} exited with code ${result.status}`);
}

export async function ensureElectronInstall({
  rootDir,
  region,
  spawnSyncImpl = spawnSync,
}) {
  const fingerprint = await computeElectronInstallFingerprint(rootDir);
  if (await isElectronInstallCurrent(rootDir, fingerprint))
    return { cached: true };

  const result = spawnSyncImpl(
    process.execPath,
    [
      path.join(rootDir, 'scripts', 'electron', 'install-dependencies.mjs'),
      '--region',
      region,
    ],
    { cwd: rootDir, stdio: 'inherit', shell: false },
  );
  assertSpawnSucceeded(result, 'Electron dependency installation');
  await markElectronInstallCurrent(rootDir, {
    fingerprint,
    region,
  });
  return { cached: false };
}

export async function prepareElectronWorkspace({
  rootDir,
  platform = process.platform,
  notifySeed,
  onSeedReady,
  spawnImpl = spawn,
  writeOutput = (chunk) => process.stdout.write(chunk),
}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  // 与 `pnpm --dir apps/tabtin-electron dev` 的 predev 同源：workspace dist、
  // Go CLI、muse-filegen、desktop runtimes。只跑 predev-build 会漏掉 filegen，
  // 首次 `muse file create` 只能落到手动 build.sh。
  const args = [
    pathApi.join(
      rootDir,
      'apps',
      'tabtin-electron',
      'scripts',
      'prepare-dev-runtime.mjs',
    ),
    '--core',
  ];
  if (notifySeed) args.push('--notify-seed', notifySeed);

  const child = spawnImpl(process.execPath, args, {
    cwd: rootDir,
    stdio: ['inherit', 'pipe', 'inherit'],
    shell: false,
  });
  let buffered = '';
  let notified = false;
  let callbackError;
  const inspectLine = (line) => {
    const seed = parsePredevSeedReady(line.replace(/\r$/, ''));
    if (seed !== notifySeed || notified) return;
    notified = true;
    try {
      onSeedReady?.(seed);
    } catch (error) {
      callbackError = error;
    }
  };
  child.stdout.on('data', (chunk) => {
    writeOutput(chunk);
    buffered += chunk.toString();
    let newlineIndex;
    while ((newlineIndex = buffered.indexOf('\n')) !== -1) {
      inspectLine(buffered.slice(0, newlineIndex));
      buffered = buffered.slice(newlineIndex + 1);
    }
  });

  const result = await new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    // `close` is emitted after stdout closes, so the readiness marker cannot
    // arrive after we validate the buffered output.
    child.once('close', (status, signal) => resolve({ status, signal }));
  });
  if (buffered) inspectLine(buffered);
  if (callbackError) throw callbackError;
  assertSpawnSucceeded(result, 'Electron workspace preparation');
  if (notifySeed && !notified) {
    throw new Error(
      `Electron workspace preparation completed without ${notifySeed} readiness event`,
    );
  }
}

export function prepareOptionalElectronWorkspace({
  rootDir,
  platform = process.platform,
  output = console.log,
  spawnImpl = spawn,
} = {}) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  output(
    '[community-dev] 可选开发工具后台准备：Python Runtime / filegen / Go CLI / Playwright',
  );
  const runtimeChild = spawnImpl(
    process.execPath,
    [
      pathApi.join(
        rootDir,
        'apps',
        'tabtin-electron',
        'scripts',
        'prepare-dev-runtime.mjs',
      ),
      '--optional',
    ],
    { cwd: rootDir, stdio: 'inherit', shell: false },
  );
  const composeArgs = [
    'compose',
    '--project-directory',
    rootDir,
    '--env-file',
    pathApi.join(rootDir, '.env'),
    '-f',
    pathApi.join(rootDir, 'compose.yaml'),
    '-f',
    pathApi.join(rootDir, 'compose.community-dev.yaml'),
    'exec',
    '-T',
    '--user',
    '0:0',
    'django',
    'sh',
    '-lc',
    [
      'if [ -f /ms-playwright/.community-ready ]; then',
      'echo "[community-dev] Playwright 已准备，跳过";',
      'elif mkdir /ms-playwright/.community-preparing 2>/dev/null; then',
      "trap 'rmdir /ms-playwright/.community-preparing 2>/dev/null || true' EXIT;",
      'python -m playwright install --with-deps chromium',
      '&& touch /ms-playwright/.community-ready;',
      'else',
      'echo "[community-dev] Playwright 正由当前 Community 实例准备，复用该任务";',
      'fi',
    ].join(' '),
  ];
  const composeEnv = { ...process.env, COMPOSE_DISABLE_ENV_FILE: '1' };
  delete composeEnv.MUSE_EDITION;
  delete composeEnv.AUTH_FIXED_VERIFICATION_CODE;
  const playwrightChild = spawnImpl('docker', composeArgs, {
    cwd: rootDir,
    env: composeEnv,
    stdio: 'inherit',
    shell: false,
  });
  const waitForChild = (child, label) =>
    new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', (status, signal) => {
        if (signal) reject(new Error(`${label} terminated by ${signal}`));
        else if (status !== 0)
          reject(new Error(`${label} exited with code ${status}`));
        else resolve();
      });
    });
  return Promise.all([
    waitForChild(runtimeChild, 'optional runtime preparation'),
    waitForChild(playwrightChild, 'Playwright preparation'),
  ]);
}

function defaultDoctor({
  backendAlreadyHealthy,
  backendReconciliationRequired,
  rootDir,
  region,
}) {
  return collectCommunityDoctorChecks({
    ...createCommunityDoctorRuntimeContext({
      rootDir,
      region,
      backendReconciliationRequired,
    }),
    backendAlreadyHealthy,
  });
}

function printDoctorChecks(checks, output) {
  if (!Array.isArray(checks)) return;

  for (const check of checks) {
    const status = check.ok
      ? 'PASS'
      : check.required === false
        ? 'WARN'
        : 'FAIL';
    output(`${status} ${check.id}: ${check.summary}`);
    if (!check.ok && check.remediation) output(`  ${check.remediation}`);
  }
}

async function prepareOptionalCentrifugo({
  ensureCentrifugo,
  rootDir,
  platform,
  region,
  output,
}) {
  try {
    const result = await ensureCentrifugo({
      rootDir,
      platform,
      region,
      output,
    });
    if (result?.available === false) {
      output(
        `[community-dev] Centrifugo 宿主二进制准备失败，继续使用 Docker 后端：${result.error instanceof Error ? result.error.message : '下载源不可用'}`,
      );
    }
    return result;
  } catch (error) {
    output(
      `[community-dev] Centrifugo 宿主二进制准备异常，继续使用 Docker 后端：${error instanceof Error ? error.message : String(error)}`,
    );
    return { available: false, error };
  }
}

function assertDoctorReady(checks) {
  if (checks === false) throw new Error('Community development doctor failed');
  if (!Array.isArray(checks)) return;

  const failed = checks.filter((check) => check.required && !check.ok);
  if (failed.length > 0) {
    throw new Error(failed.map((check) => check.summary).join('; '));
  }
}

function printDryRun({ options, rootDir, platform, output }) {
  const backend = resolveCommunityDevBackendCommand(platform, rootDir);
  const electron = getElectronCommand(rootDir);
  output(`region strategy: ${options.region}`);
  if (options.region === 'auto') {
    output('registry: auto probe before installation');
  } else {
    output(
      `registry: ${resolveElectronInstallProfile(options.region).registry}`,
    );
  }
  output(
    `backend: ${options.skipBackend ? 'health check only' : 'reconcile current dev topology'}`,
  );
  output(`backend command: ${backend.command} ${backend.args.join(' ')}`);
  output(`environment file: ${getEnvironmentFile(rootDir)}`);
  output(`health targets: ${HEALTH_TARGETS.join('; ')}`);
  output(`electron command: ${electron.command} ${electron.args.join(' ')}`);
}

export async function runCommunityDev(dependencies = {}) {
  const rootDir = dependencies.rootDir ?? getRootDir();
  const platform = dependencies.platform ?? process.platform;
  const output = dependencies.output ?? console.log;
  const options = parseCommunityDevArgs(
    dependencies.argv ?? process.argv.slice(2),
  );

  if (options.help) {
    output(formatCommunityDevHelp());
    return { options, mode: 'help' };
  }

  if (options.dryRun) {
    printDryRun({ options, rootDir, platform, output });
    return { options, mode: 'dry-run' };
  }

  const timingOptions = {
    now: dependencies.now ?? performance.now.bind(performance),
    output,
  };
  const timed = (label, operation) =>
    runTimedStage(label, operation, timingOptions);
  const probeBackend = dependencies.probeBackend ?? probeCommunityBackend;
  let report = await timed('后端状态检查', () => probeBackend());
  const doctor = dependencies.doctor ?? defaultDoctor;
  const doctorChecks = await timed('开发环境检查', () =>
    doctor({
      backendAlreadyHealthy: report.coreHealthy ?? report.healthy,
      backendReconciliationRequired: !options.skipBackend,
      rootDir,
      region: options.region,
    }),
  );
  printDoctorChecks(doctorChecks, output);
  assertDoctorReady(doctorChecks);
  if (options.doctor) return { options, mode: 'doctor' };
  if (options.skipBackend && !(report.coreHealthy ?? report.healthy)) {
    throw new Error(formatBackendFailure({ report, rootDir }));
  }

  const resolveRegion =
    dependencies.resolveRegion ?? resolveElectronInstallRegion;
  const region = await timed('依赖源选择', () => resolveRegion(options.region));
  if (!options.skipBackend && !(report.coreHealthy ?? report.healthy)) {
    const ensureCentrifugo =
      dependencies.ensureCentrifugo ?? ensureCentrifugoBinary;
    await timed('Centrifugo 可选二进制准备', () =>
      prepareOptionalCentrifugo({
        ensureCentrifugo,
        rootDir,
        platform,
        region,
        output,
      }),
    );
  }
  const ensureInstall = dependencies.ensureInstall ?? ensureElectronInstall;
  await timed('Electron 依赖安装', () => ensureInstall({ rootDir, region }));

  const ensureEnv =
    dependencies.ensureEnv ??
    (async (electronEnvFile) => {
      await ensureRootEnvFile(
        path.join(rootDir, '.env'),
        path.join(rootDir, '.env.example'),
      );
      await writeCommunityRuntimeEnvFile(
        path.join(rootDir, '.env'),
        path.join(rootDir, '.env.community-runtime'),
      );
      return ensureCommunityEnvFile(electronEnvFile);
    });
  await timed('开发配置准备', () => ensureEnv(getEnvironmentFile(rootDir)));

  if (!options.skipBackend) {
    const startBackend = dependencies.startBackend ?? startCommunityDevBackend;
    await timed('后端拓扑同步', () =>
      startBackend({ platform, rootDir, region }),
    );
    const waitForBackend =
      dependencies.waitForBackend ?? waitForCommunityBackend;
    report = await timed('后端健康等待', () => waitForBackend());
  }

  if (!(report.coreHealthy ?? report.healthy)) {
    throw new Error(formatBackendFailure({ report, rootDir }));
  }

  const collabNeedsStart = !report.collabHealthy;
  const ensureCollab = dependencies.ensureCollab ?? ensureCommunityCollab;
  let collabPreparation;
  const startCollabWhenReady = () => {
    if (collabPreparation) return;
    output('[community-dev] Collab workspace 依赖已就绪，开始启动 Collab Live');
    collabPreparation = Promise.resolve()
      .then(() =>
        ensureCollab({
          rootDir,
          platform,
          skipWorkspaceBuild: true,
        }),
      )
      .then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
  };
  const prepareWorkspace =
    dependencies.prepareWorkspace ?? prepareElectronWorkspace;
  if (!collabNeedsStart) {
    await timed('Collab Live 归属确认', () =>
      ensureCollab({ rootDir, platform }),
    );
  }
  await timed('Electron dev runtime 准备', () =>
    prepareWorkspace({
      rootDir,
      platform,
      notifySeed: collabNeedsStart ? 'collab-live' : undefined,
      onSeedReady: collabNeedsStart ? startCollabWhenReady : undefined,
    }),
  );
  if (collabNeedsStart) {
    if (!collabPreparation) {
      throw new Error('Collab workspace readiness event was not received');
    }
    const collabResult = await timed(
      'Collab Live 准备',
      () => collabPreparation,
    );
    if (collabResult.error) throw collabResult.error;
  }

  report = await timed('Community Dev 健康确认', () => probeBackend());
  if (!report.collabHealthy) {
    throw new Error(
      formatBackendFailure({
        report: {
          ...report,
          checks: report.checks.filter((check) => check.id === 'collab'),
        },
        rootDir,
      }),
    );
  }

  const startElectron = dependencies.startElectron ?? startCommunityElectron;
  const startOptionalPreparation =
    dependencies.startOptionalPreparation ?? prepareOptionalElectronWorkspace;
  await startElectron({
    rootDir,
    output,
    now: timingOptions.now,
    onReady: () => startOptionalPreparation({ rootDir, platform, output }),
  });
  return { options, region, report };
}

function getElectronWorkspace(rootDir, platform) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.join(rootDir, 'apps', 'tabtin-electron');
}

function createElectronProcessEnv({ rootDir, platform, env }) {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === 'path');
  const electronBin = pathApi.join(
    getElectronWorkspace(rootDir, platform),
    'node_modules',
    '.bin',
  );
  const effectivePathKey = pathKey ?? 'PATH';
  const inheritedPath = env[effectivePathKey];

  return {
    ...env,
    [effectivePathKey]: inheritedPath
      ? `${electronBin}${pathApi.delimiter}${inheritedPath}`
      : electronBin,
  };
}

export function terminateElectronProcessTree({
  child,
  platform = process.platform,
  signal = 'SIGTERM',
  spawnSyncImpl = spawnSync,
}) {
  if (platform === 'win32' && Number.isInteger(child.pid)) {
    const result = spawnSyncImpl(
      'taskkill',
      ['/PID', String(child.pid), '/T', '/F'],
      { stdio: 'ignore', shell: false },
    );
    if (!result.error && result.status === 0) return;
  }

  try {
    child.kill(signal);
  } catch {
    // The child may already have exited.
  }
}

export async function startCommunityElectron({
  rootDir,
  platform = process.platform,
  env = process.env,
  output = console.log,
  now = performance.now.bind(performance),
  readyTimeoutMs = 600_000,
  spawnImpl = spawn,
  signalSource = process,
  terminateProcessTree = terminateElectronProcessTree,
  waitForReady = waitForElectronReady,
  onReady,
}) {
  const electron = getElectronCommand(rootDir);
  const startedAt = now();
  const child = spawnImpl(electron.command, electron.args, {
    cwd: getElectronWorkspace(rootDir, platform),
    env: {
      ...createElectronProcessEnv({ rootDir, platform, env }),
      MUSE_COMMUNITY_DEV_BOOTSTRAP: '1',
    },
    stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    shell: false,
  });

  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const signalHandlers = new Map(
    signals.map((signal) => [
      signal,
      () => {
        terminateProcessTree({ child, platform, signal });
      },
    ]),
  );
  for (const signal of signals) {
    signalSource.on(signal, signalHandlers.get(signal));
  }

  const exitResult = new Promise((resolve) => {
    child.once('error', (error) => resolve({ error }));
    child.once('exit', (status, signal) => resolve({ status, signal }));
  });

  try {
    await waitForReady({ child, timeoutMs: readyTimeoutMs });
    output(
      `[community-dev] Electron 已就绪（${((now() - startedAt) / 1_000).toFixed(1)}s）`,
    );
    if (onReady) {
      Promise.resolve()
        .then(() => onReady())
        .then(() => output('[community-dev] 可选开发工具准备完成'))
        .catch((error) =>
          output(
            `[community-dev] 可选开发工具准备失败（不影响 READY）：${error instanceof Error ? error.message : String(error)}`,
          ),
        );
    }
    assertSpawnSucceeded(await exitResult, 'Electron development server');
  } catch (error) {
    terminateProcessTree({ child, platform, signal: 'SIGTERM' });
    throw error;
  } finally {
    for (const signal of signals) {
      signalSource.removeListener(signal, signalHandlers.get(signal));
    }
  }
}

async function main() {
  try {
    await runCommunityDev();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (path.resolve(process.argv[1] ?? '') === SCRIPT_PATH) {
  main();
}
