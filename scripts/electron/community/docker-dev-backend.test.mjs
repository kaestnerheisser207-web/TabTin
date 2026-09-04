import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  createDockerDevEnvironment,
  resolveDockerDevComposeArgs,
} from './docker-dev-backend.mjs';

test('Docker dev Compose uses the root env file and ignores shell edition overrides', () => {
  const args = resolveDockerDevComposeArgs('/repo');
  const env = createDockerDevEnvironment({
    baseEnv: {
      MUSE_EDITION: 'saas',
      AUTH_FIXED_VERIFICATION_CODE: '123456',
      PATH: '/usr/bin',
    },
    fingerprint: 'fixture',
  });

  assert.deepEqual(args.slice(0, 5), [
    'compose',
    '--project-directory',
    '/repo',
    '--env-file',
    '/repo/.env',
  ]);
  assert.equal(Object.hasOwn(env, 'MUSE_EDITION'), false);
  assert.equal(Object.hasOwn(env, 'AUTH_FIXED_VERIFICATION_CODE'), false);
  assert.equal(env.PATH, '/usr/bin');
  assert.equal(env.MUSE_DEV_DEPENDENCY_FINGERPRINT, 'fixture');
});
