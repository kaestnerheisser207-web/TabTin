import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { ensurePtyHelper } from './ensure-pty-helper.mjs';

test('repairs only current macOS helpers and is idempotent', (t) => {
  const packageDir = mkdtempSync(path.join(os.tmpdir(), 'muse-pty-helper-'));
  t.after(() => rmSync(packageDir, { recursive: true, force: true }));
  const helpers = ['build/Release', 'prebuilds/darwin-arm64', 'prebuilds/darwin-x64'].map((dir) => {
    const directory = path.join(packageDir, dir);
    mkdirSync(directory, { recursive: true });
    const helper = path.join(directory, 'spawn-helper');
    writeFileSync(helper, 'helper');
    chmodSync(helper, 0o640);
    return helper;
  });
  const options = { packageDir, platform: 'darwin', arch: 'arm64' };
  assert.deepEqual(ensurePtyHelper(options), helpers.slice(0, 2));
  assert.equal(statSync(helpers[0]).mode & 0o777, 0o751);
  assert.equal(statSync(helpers[1]).mode & 0o777, 0o751);
  assert.equal(statSync(helpers[2]).mode & 0o777, 0o640);
  assert.deepEqual(ensurePtyHelper(options), []);
});

test('does not resolve or modify node-pty on other platforms', () => {
  assert.deepEqual(ensurePtyHelper({ platform: 'win32', packageDir: '/missing' }), []);
  assert.deepEqual(ensurePtyHelper({ platform: 'linux', packageDir: '/missing' }), []);
});
