import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';

import {
  classifyPortOwner,
  formatBackendFailure,
  probeCommunityBackend,
  resolveCommunityDevBackendCommand,
  startCommunityDevBackend,
} from './backend.mjs';
import {
  filterDockerRecordsPublishingHostPort,
  inspectPortOwner,
} from './docker-dev-backend.mjs';

const COLLAB_LOG = path.join(
  'apps',
  'tabtin_django',
  'logs',
  'collab-live.log',
);

test('Community Runtime core stays ready when Collab is not running', async () => {
  const report = await probeCommunityBackend({
    probeHttp: async (url) => ({
      ok: !url.includes(':4100'),
      status: url.includes(':4100') ? 503 : 200,
      text: url.includes(':6060') ? 'healthy' : '',
    }),
    probeTcp: async () => true,
  });

  assert.equal(report.coreHealthy, true);
  assert.equal(report.collabHealthy, false);
  assert.equal(report.healthy, true);
});

test('Community Dev resolves only the Docker backend orchestrator', () => {
  const command = resolveCommunityDevBackendCommand('darwin', '/repo');
  assert.equal(command.command, process.execPath);
  assert.ok(
    command.args[0].endsWith(
      '/scripts/electron/community/docker-dev-backend.mjs',
    ),
  );
  assert.ok(
    command.args.every(
      (argument) => !argument.includes('scripts/backend/start'),
    ),
  );
});

test('8100 owned by the current Community project is reused', () => {
  assert.deepEqual(
    classifyPortOwner({
      rootDir: '/repo',
      dockerOwners: [
        {
          name: 'tabtin-community-centrifugo-1',
          labels: {
            'com.docker.compose.project': 'tabtin-community',
            'com.docker.compose.project.working_dir': '/old/linked-worktree',
            'com.docker.compose.service': 'centrifugo',
          },
        },
      ],
      processOwners: [],
    }),
    {
      kind: 'current-community',
      reusable: true,
      owners: ['tabtin-community-centrifugo-1'],
    },
  );
});

test('Windows port inspection does not require lsof', () => {
  const commands = [];
  const run = (command) => {
    commands.push(command);
    if (command === 'docker' || command === 'netstat')
      return { status: 0, stdout: '', stderr: '' };
    throw new Error(`unexpected command: ${command}`);
  };

  assert.deepEqual(
    inspectPortOwner(4100, 'C:/repo', {
      platform: 'win32',
      runImpl: run,
    }),
    { kind: 'available', reusable: false, owners: [] },
  );
  assert.ok(!commands.includes('lsof'));
});

test('8100 owned by another process reports PORT_CONFLICT and never kills it', () => {
  const killCalls = [];
  const owner = classifyPortOwner({
    rootDir: '/repo',
    dockerOwners: [],
    processOwners: [{ pid: 4321, command: '/usr/local/bin/unrelated-server' }],
  });

  assert.equal(owner.kind, 'other-process');
  assert.equal(owner.reusable, false);
  assert.deepEqual(killCalls, []);
});

test('host 8100 ownership ignores containers publishing container 8100 on other host ports', () => {
  const owners = filterDockerRecordsPublishingHostPort(
    [
      { ID: 'current', Ports: '127.0.0.1:8100->8100/tcp' },
      { ID: 'isolated', Ports: '127.0.0.1:28111->8100/tcp' },
      { ID: 'internal-only', Ports: '8100/tcp' },
    ],
    8100,
  );

  assert.deepEqual(
    owners.map((owner) => owner.ID),
    ['current'],
  );
});

test('formatBackendFailure lists failed services, first error, log path and tail', () => {
  const rootDir = '/repo';
  const logPath = path.join(rootDir, COLLAB_LOG);
  const message = formatBackendFailure({
    rootDir,
    report: {
      healthy: false,
      checks: [
        {
          id: 'django',
          ok: true,
          endpoint: 'http://127.0.0.1:6060/health',
          detail: 'healthy response',
        },
        {
          id: 'collab',
          ok: false,
          endpoint: 'http://127.0.0.1:4100/health',
          detail: 'fetch failed',
        },
        {
          id: 'centrifugo',
          ok: true,
          endpoint: '127.0.0.1:8100',
          detail: 'TCP connection succeeded',
        },
      ],
    },
    existsSyncImpl: (filePath) => filePath === logPath,
    readFileSyncImpl: (filePath) => {
      assert.equal(filePath, logPath);
      return [
        'boot',
        "Error: Cannot find module '@muse/doc-editor'",
        'still crashing',
        'last line',
      ].join('\n');
    },
  });

  assert.match(
    message,
    /失败服务：Collab \(http:\/\/127\.0\.0\.1:4100\/health — fetch failed\)/,
  );
  assert.doesNotMatch(message, /失败服务：.*Django/);
  assert.match(
    message,
    /首个错误：Collab: Error: Cannot find module '@tabtin\/doc-editor'/,
  );
  assert.ok(message.includes(`Collab 日志：${logPath}`));
  assert.match(
    message,
    /最后 12 行：\nboot\nError: Cannot find module '@tabtin\/doc-editor'\nstill crashing\nlast line/,
  );
});

test('formatBackendFailure notes a missing log file', () => {
  const message = formatBackendFailure({
    rootDir: '/repo',
    report: {
      healthy: false,
      checks: [
        {
          id: 'django',
          ok: false,
          endpoint: 'http://127.0.0.1:6060/health',
          detail: 'fetch failed',
        },
      ],
    },
    existsSyncImpl: () => false,
    readFileSyncImpl: () => {
      throw new Error('should not read');
    },
  });

  assert.match(message, /Django 日志：.*django-dev\.log（文件不存在）/);
  assert.doesNotMatch(message, /首个错误/);
});

test('startCommunityDevBackend keeps a non-zero exit code and attaches diagnostics', async () => {
  const rootDir = '/repo';
  const logPath = path.join(rootDir, COLLAB_LOG);

  await assert.rejects(
    () =>
      startCommunityDevBackend({
        platform: 'darwin',
        rootDir,
        spawnSyncImpl: () => ({ status: 7 }),
        probeBackend: async () => ({
          healthy: false,
          checks: [
            {
              id: 'collab',
              ok: false,
              endpoint: 'http://127.0.0.1:4100/health',
              detail: 'Expected an HTTP 2xx response containing ok',
            },
          ],
        }),
        existsSyncImpl: (filePath) => filePath === logPath,
        readFileSyncImpl: () =>
          "Error: Cannot find module '@muse/config'\nexit",
      }),
    (error) => {
      assert.match(error.message, /退出码 7/);
      assert.match(error.message, /失败服务：Collab/);
      assert.match(
        error.message,
        /首个错误：Collab: Error: Cannot find module '@tabtin\/config'/,
      );
      assert.match(error.message, /collab-live\.log/);
      assert.match(
        error.message,
        /最后 12 行：\nError: Cannot find module '@tabtin\/config'\nexit/,
      );
      return true;
    },
  );
});

test('startCommunityDevBackend leaves root env switches to Docker Compose', async () => {
  let spawnOptions;
  const previousEdition = process.env.MUSE_EDITION;
  const previousFixedCode = process.env.AUTH_FIXED_VERIFICATION_CODE;
  process.env.MUSE_EDITION = 'saas';
  process.env.AUTH_FIXED_VERIFICATION_CODE = '123456';
  try {
    await startCommunityDevBackend({
      platform: 'darwin',
      rootDir: '/repo',
      region: 'cn',
      spawnSyncImpl: (_command, _args, options) => {
        spawnOptions = options;
        return { status: 0 };
      },
    });
  } finally {
    if (previousEdition === undefined) delete process.env.MUSE_EDITION;
    else process.env.MUSE_EDITION = previousEdition;
    if (previousFixedCode === undefined)
      delete process.env.AUTH_FIXED_VERIFICATION_CODE;
    else process.env.AUTH_FIXED_VERIFICATION_CODE = previousFixedCode;
  }

  assert.equal(Object.hasOwn(spawnOptions.env, 'MUSE_EDITION'), false);
  assert.equal(
    Object.hasOwn(spawnOptions.env, 'AUTH_FIXED_VERIFICATION_CODE'),
    false,
  );
  assert.equal(spawnOptions.env.MUSE_DEV_REGION, 'cn');
});

test('startCommunityDevBackend still reports spawn errors without log archaeology', async () => {
  await assert.rejects(
    () =>
      startCommunityDevBackend({
        platform: 'darwin',
        rootDir: '/repo',
        spawnSyncImpl: () => ({ error: new Error('ENOENT') }),
        probeBackend: async () => {
          throw new Error('should not probe');
        },
      }),
    /后端启动失败: ENOENT/,
  );
});
