import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../..',
);

for (const launcher of ['collab-live-start.sh', 'collab-live-start.bat']) {
  test(`${launcher} skips only the Community-prepared workspace build`, () => {
    const source = fs.readFileSync(
      path.join(root, 'scripts', 'backend', launcher),
      'utf8',
    );
    assert.match(source, /MUSE_SKIP_COLLAB_WORKSPACE_BUILD/);
    assert.match(source, /run-predev-build-with-lock\.mjs/);
    assert.match(source, /--seed collab-live/);
  });
}
