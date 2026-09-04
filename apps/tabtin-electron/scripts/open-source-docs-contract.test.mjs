import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const docsDirectory = new URL('../docs/', import.meta.url);
const repositoryRoot = new URL('../../../', import.meta.url);
const guideNames = [
  'open-source-development.md',
  'open-source-development.zh-CN.md',
];
const oneCommand = 'node scripts/dev.mjs community';

function read(name) {
  return readFileSync(new URL(name, docsDirectory), 'utf8');
}

function extractShellCommands(markdown) {
  return [
    ...markdown.matchAll(/```(?:bash|powershell)\r?\n([\s\S]*?)```/g),
  ].map((match) => match[1].trim());
}

test('English and Chinese guides expose the same executable commands', () => {
  const english = extractShellCommands(read('open-source-development.md'));
  const chinese = extractShellCommands(
    read('open-source-development.zh-CN.md'),
  );

  assert.ok(english.length >= 5);
  assert.deepEqual(english, chinese);
});

test('both guides document the Electron-only scope and security boundaries', () => {
  for (const name of guideNames) {
    const content = read(name);
    for (const required of [
      'bootstrap:electron',
      'bootstrap:electron:cn',
      'audit:opensource',
      'MUSE_COMMUNITY_API_BASE_URL',
      'SOURCEMAP_UPLOAD_KEY',
      'SENTRY_AUTH_TOKEN',
      'Django',
      'Daemon',
    ]) {
      assert.match(
        content,
        new RegExp(required),
        `${name} must mention ${required}`,
      );
    }
  }
});

test('both guides lead with the one-command community path', () => {
  for (const name of guideNames) {
    const content = read(name);

    assert.match(content, /node scripts\/dev\.mjs community/);
    assert.match(content, /--region cn/);
    assert.match(content, /--skip-backend/);
    assert.ok(
      content.indexOf(oneCommand) <
        content.indexOf('pnpm bootstrap:electron:doctor'),
      `${name} must put the unified entry before manual doctor/install commands`,
    );
  }
});

test('both guides document every public top-level startup option', () => {
  const expectations = {
    'open-source-development.md': [
      ['node scripts/dev.mjs community --region global', /official source/i],
      ['node scripts/dev.mjs community --doctor', /only.*checks/i],
      ['node scripts/dev.mjs community --dry-run', /without starting.*plan/i],
    ],
    'open-source-development.zh-CN.md': [
      ['node scripts/dev.mjs community --region global', /官方源/],
      ['node scripts/dev.mjs community --doctor', /只.*检查/],
      ['node scripts/dev.mjs community --dry-run', /不.*启动.*计划/],
    ],
  };

  for (const [name, options] of Object.entries(expectations)) {
    const content = read(name);
    for (const [command, meaning] of options) {
      assert.match(
        content,
        new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
      );
      assert.match(content, meaning, `${name} must explain ${command}`);
    }
  }
});

test('both guides make the Windows shell contract explicit', () => {
  for (const name of guideNames) {
    const content = read(name);

    for (const shell of ['PowerShell', 'CMD', 'Git Bash']) {
      assert.match(content, new RegExp(shell), `${name} must mention ${shell}`);
    }
    assert.match(content, /Bash.*WSL|WSL.*Bash/);
  }
});

test('the root README links to the unified community entry and detailed guide', () => {
  const readme = readFileSync(new URL('README.md', repositoryRoot), 'utf8');

  assert.match(readme, /node scripts\/dev\.mjs community/);
  assert.match(
    readme,
    /apps\/tabtin-electron\/docs\/open-source-development\.md/,
  );
});

test('root READMEs front-load the hosted service and business contact', () => {
  for (const entry of [
    {
      file: 'README.md',
      boundary: '## 为什么做 Muse',
      website: '[访问 Muse 官网](https://tabtin.com/)',
      business: '[contact@larchiveai.com](mailto:contact@larchiveai.com)',
    },
    {
      file: 'README.en.md',
      boundary: '## Why Muse',
      website: '[Visit the Muse website](https://tabtin.com/)',
      business: '[contact@larchiveai.com](mailto:contact@larchiveai.com)',
    },
  ]) {
    const readme = readFileSync(new URL(entry.file, repositoryRoot), 'utf8');
    const boundary = readme.indexOf(entry.boundary);
    const website = readme.indexOf(entry.website);
    const business = readme.indexOf(entry.business);

    assert.ok(boundary > 0, `${entry.file} must include ${entry.boundary}`);
    assert.ok(
      website >= 0 && website < boundary,
      `${entry.file} must place the website CTA before ${entry.boundary}`,
    );
    assert.ok(
      business >= 0 && business < boundary,
      `${entry.file} must place the business contact before ${entry.boundary}`,
    );
  }
});

test('root READMEs present local source startup as one entry with two methods', () => {
  const readme = readFileSync(new URL('README.md', repositoryRoot), 'utf8');
  const englishReadme = readFileSync(
    new URL('README.en.md', repositoryRoot),
    'utf8',
  );

  for (const text of [
    '2. **本地运行源码**',
    '### 本地运行源码',
    '#### 方式一：使用 Agent 启动',
    '#### 方式二：手动启动',
  ]) {
    assert.ok(readme.includes(text), `README.md must include ${text}`);
  }
  assert.doesNotMatch(readme, /^### (?:🤖 )?AI Agent 启动$/m);
  assert.doesNotMatch(readme, /^### 本地开发$/m);

  for (const text of [
    '2. **Run from source locally**',
    '### Run from source locally',
    '#### Option 1: Start with an Agent',
    '#### Option 2: Start manually',
  ]) {
    assert.ok(
      englishReadme.includes(text),
      `README.en.md must include ${text}`,
    );
  }
  assert.doesNotMatch(englishReadme, /^### AI Agent startup$/m);
  assert.doesNotMatch(englishReadme, /^### Local development$/m);
});

test('the root README keeps runtime installation separate from source quick start', () => {
  const readme = readFileSync(new URL('README.md', repositoryRoot), 'utf8');
  const localSourceRun = readme.indexOf('### 本地运行源码');
  const runtimeGuide = readme.indexOf(
    'docs/development/community-quickstart.md',
  );
  const quickStart = readme.indexOf(oneCommand, localSourceRun);
  const optionalRootEnv = readme.indexOf(
    'cp .env.example .env',
    localSourceRun,
  );

  assert.ok(runtimeGuide >= 0);
  assert.ok(quickStart < optionalRootEnv);
});

test('community guides describe generated env without a cold-start deadline', () => {
  for (const name of guideNames) {
    const content = read(name);

    assert.match(content, /apps\/tabtin-electron\/\.env\.opensource\.local/);
    assert.doesNotMatch(content, /up to ten minutes|10 分钟/i);
  }
});

test('the AI startup prompt includes the cross-platform canonical entry', () => {
  const prompt = readFileSync(
    new URL('docs/development/community-dev-agent-prompt.md', repositoryRoot),
    'utf8',
  );

  assert.match(prompt, /node scripts\/dev\.mjs community/);
  for (const platform of ['Linux', 'macOS', 'Windows']) {
    assert.match(prompt, new RegExp(platform.replace('/', '\\/')));
  }
});

test('the root README keeps the two copyable local-development prompts stable', () => {
  const readme = readFileSync(new URL('README.md', repositoryRoot), 'utf8');
  assert.match(
    readme,
    /请运行 https:\/\/github\.com\/tabtin-ai\/TabTin 的「快速预览」/,
  );
  assert.match(
    readme,
    /请运行 https:\/\/github\.com\/tabtin-ai\/TabTin 的「全量预览」/,
  );
  assert.match(readme, /pnpm dev/);
  assert.match(readme, /\.env\.local/);
});

test('the local-development guide requires dependency installation and Docker readiness', () => {
  const guide = readFileSync(
    new URL('docs/development/getting-started.md', repositoryRoot),
    'utf8',
  );

  for (const requirement of [
    '依赖缺失但可自动安装',
    '软件官方渠道安装',
    'docker info',
    'pnpm install --frozen-lockfile',
    'pnpm dev',
    '.env.local',
  ]) {
    assert.ok(
      guide.includes(requirement),
      `missing dependency rule: ${requirement}`,
    );
  }
});

test('local-development docs keep preview modes under Agent startup', () => {
  const chinese = readFileSync(
    new URL('docs/development/getting-started.md', repositoryRoot),
    'utf8',
  );
  const english = readFileSync(
    new URL('docs/development/getting-started.en.md', repositoryRoot),
    'utf8',
  );

  assert.match(chinese, /快速预览和全量预览是 Agent 启动时的两种模式/);
  assert.match(
    english,
    /Quick Preview and Full Preview are the two modes under Agent startup/,
  );
  assert.match(chinese, /手动启动不需要使用“快速预览”或“全量预览”的提示词/);
  assert.match(
    english,
    /Manual startup does not require the “Quick Preview” or “Full Preview” prompts/,
  );
});
