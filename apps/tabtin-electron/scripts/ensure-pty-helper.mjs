import { chmodSync, existsSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(import.meta.url);

// node-pty's macOS helper can lose its executable bit during dependency
// installation. Packaged builds repair it during pruning; dev needs the same
// guarantee before launching Electron, including direct dev.mjs invocations.
export function ensurePtyHelper({
  platform = process.platform,
  arch = process.arch,
  packageDir,
} = {}) {
  if (platform !== 'darwin') return [];
  const root = packageDir ?? path.dirname(require.resolve('node-pty/package.json'));
  const repaired = [];
  for (const directory of ['build/Release', 'build/Debug', `prebuilds/darwin-${arch}`]) {
    const helper = path.join(root, directory, 'spawn-helper');
    if (!existsSync(helper)) continue;
    const stat = statSync(helper);
    if (!stat.isFile() || (stat.mode & 0o111) === 0o111) continue;
    chmodSync(helper, (stat.mode & 0o777) | 0o111);
    repaired.push(helper);
  }
  return repaired;
}
