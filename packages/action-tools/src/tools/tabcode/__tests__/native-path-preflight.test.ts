import { mkdtemp, mkdir, symlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { preflightFilePathSecurity } from '../index';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
describe('shared native/Builtin file path preflight', () => {
  it('permits ordinary new files and blocks boundary escapes before approval', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-preflight-')); roots.push(root);
    expect(await preflightFilePathSecurity('write_file', path.join(root, 'new', 'file.txt'), [root], false)).toBeNull();
    expect(await preflightFilePathSecurity('write_file', path.join(root, '..', 'outside.txt'), [root], false)).toContain('outside');
  });
  it('checks sensitive real targets through directory symlinks even after judge allow', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'native-preflight-')); roots.push(root);
    const sensitive = path.join(root, '.ssh'); await mkdir(sensitive);
    await symlink(sensitive, path.join(root, 'innocent'));
    const denial = await preflightFilePathSecurity('write_file', path.join(root, 'innocent', 'new-key'), [root], true);
    expect(denial).not.toBeNull();
  });
});
