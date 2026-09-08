import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import test from 'node:test'
import { applyDeployPackageTransforms } from './prepare-deploy-package.mjs'
import { stageDshMusePlugin } from './stage-dsh-muse-plugin.mjs'

const scripts = dirname(fileURLToPath(import.meta.url))
const repo = join(scripts, '../../..')

test('DSH resource mapping keeps the plugin outside app.asar after isolated deploy', () => {
  const entry = { from: '../../packages/dsh-muse-plugin/dist', to: 'dsh-muse-plugin', filter: ['**/*'] }
  const result = applyDeployPackageTransforms({ build: { extraResources: [entry] } })
  assert.deepEqual(result.build.extraResources, [{ ...entry, from: './dsh-muse-plugin-dist-src' }])
  const actual = JSON.parse(readFileSync(join(scripts, '../package.json'), 'utf8'))
  assert.ok(actual.build.extraResources.some(resource => resource.from === entry.from && resource.to === entry.to))
})

test('both full and quick packaging invoke mandatory DSH resource staging', () => {
  for (const name of ['build-packaged-app.sh', 'build-mac-dmg-quick.sh']) {
    const source = readFileSync(join(scripts, name), 'utf8')
    assert.match(source, /node "\$APP_DIR\/scripts\/stage-dsh-muse-plugin\.mjs"\s*\\\s*"\$REPO_ROOT\/packages\/dsh-muse-plugin\/dist" "\$DEPLOY_DIR"/)
  }
})

test('staged plugin loads in a plain Node process without source tree or app.asar', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'muse-dsh-packaging-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const source = join(temporary, 'plugin', 'dist')
  mkdirSync(source, { recursive: true })
  mkdirSync(join(temporary, 'plugin', 'src'))
  writeFileSync(join(temporary, 'plugin', 'src', 'not-packaged.ts'), 'not a runtime asset')
  writeFileSync(join(source, 'index.js'), 'export const name = "muse-host-capabilities"; export function apply() {}\n')
  const staging = stageDshMusePlugin(source, join(temporary, 'deploy'))
  const resource = join(temporary, 'resources', 'dsh-muse-plugin')
  cpSync(staging, resource, { recursive: true })
  rmSync(join(temporary, 'plugin'), { recursive: true })
  rmSync(join(temporary, 'deploy'), { recursive: true })
  assert.equal(existsSync(join(resource, 'src')), false)
  assert.deepEqual(JSON.parse(readFileSync(join(resource, 'package.json'), 'utf8')), { type: 'module' })
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `const plugin = await import(${JSON.stringify(pathToFileURL(join(resource, 'index.js')).href)}); console.log(plugin.name, typeof plugin.apply)`], { encoding: 'utf8' })
  assert.equal(output.trim(), 'muse-host-capabilities function')
})

test('missing build output aborts packaging before replacing an existing staging tree', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'muse-dsh-missing-'))
  t.after(() => rmSync(temporary, { recursive: true, force: true }))
  const destination = join(temporary, 'deploy', 'dsh-muse-plugin-dist-src')
  mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, 'existing.txt'), 'preserved')
  assert.throws(() => stageDshMusePlugin(join(temporary, 'missing-dist'), join(temporary, 'deploy')), /Missing built DSH Muse plugin/)
  assert.equal(readFileSync(join(destination, 'existing.txt'), 'utf8'), 'preserved')
})

test('cloud production dependency closure exports only built plugin entry points', () => {
  const manifest = relative => JSON.parse(readFileSync(join(repo, relative), 'utf8'))
  const host = manifest('packages/agent-host/package.json')
  const daemon = manifest('apps/tabtin-daemon/package.json')
  const plugin = manifest('packages/dsh-muse-plugin/package.json')
  assert.equal(daemon.dependencies['@muse/agent-host'], 'workspace:*')
  assert.equal(host.dependencies['@muse/dsh-muse-plugin'], 'workspace:*')
  assert.deepEqual(plugin.files, ['dist'])
  assert.equal(plugin.exports['.'].import, './dist/index.js')
  assert.doesNotMatch(JSON.stringify(plugin.exports), /src\//)
  const docker = readFileSync(join(repo, 'apps/tabtin-daemon/Dockerfile.cloud'), 'utf8')
  assert.match(docker, /pnpm --filter '@muse\/daemon\^\.\.\.' build/)
  assert.match(docker, /pnpm --filter @muse\/daemon deploy --prod/)
})
