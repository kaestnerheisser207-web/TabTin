#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { readFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertIntegrationReport } from './assert-integration-report.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const daemon = path.join(root, 'apps/tabtin-daemon')
const files = [
  'tests/dsh-api-proxy.integration.test.ts',
  'tests/dsh-mcp.integration.test.ts',
  'tests/dsh-full-turn.integration.test.ts',
  'tests/dsh-muse-plugin.integration.test.ts',
  'tests/dsh-host-capability.integration.test.ts',
]
const pinnedVersion = '0.1.1-rc.2'
for (const name of ['dsh', 'dsh-host-apiproxy']) {
  const manifest = JSON.parse(await readFile(path.join(daemon, 'node_modules/@deepseek-ai', name, 'package.json'), 'utf8'))
  if (manifest.version !== pinnedVersion) throw new Error(`Expected @deepseek-ai/${name}@${pinnedVersion}; got ${manifest.version}`)
}
for (const file of files) await readFile(path.join(daemon, file), 'utf8')
const reportDir = path.resolve(process.argv[2] ?? path.join(root, 'artifacts/dsh-parity'))
await mkdir(reportDir, { recursive: true })
const reportPath = path.join(reportDir, 'integration.json')
const env = { ...process.env, MUSE_DSH_INTEGRATION: '1', DSH_TELEMETRY_MODE: 'DISABLED' }
// Fixtures create isolated DSH homes, loopback servers, credentials and workspaces.
// Never select a user's global DSH executable via a persisted test override.
delete env.MUSE_DSH_TEST_EXECUTABLE
const exitCode = await new Promise((resolve, reject) => {
  const child = spawn('pnpm', ['exec', 'vitest', 'run', ...files, '--no-file-parallelism', '--reporter=default', '--reporter=json', `--outputFile=${reportPath}`], { cwd: daemon, env, stdio: 'inherit', shell: false })
  child.once('error', reject)
  child.once('exit', (code, signal) => resolve(signal ? 1 : code ?? 1))
})
if (exitCode !== 0) throw new Error(`DSH integration execution failed (${exitCode})`)
const verified = assertIntegrationReport(JSON.parse(await readFile(reportPath, 'utf8')), files)
console.log(JSON.stringify({ dshVersion: pinnedVersion, executed: verified }, null, 2))
