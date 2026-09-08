import test from 'node:test'
import assert from 'node:assert/strict'
import { compareCapabilitySnapshots, snapshotFromHostSession } from './capability-snapshot.mjs'
import { assertIntegrationReport } from './assert-integration-report.mjs'
import { registrationsFromSource } from './inventory.mjs'

const captured = harness => ({ schemaVersion: 1, host: 'electron', harness, scope: { organizationId: 'o', workspaceId: 'w', agentId: 'a', mode: 'agent' }, tools: [{ name: 'read_file', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }], cliCommands: [{ name: 'muse browser open', risk: 'write' }], skills: [{ key: 'org/test', version: 1 }], controls: ['abort', 'query'], hooks: ['beforeRun', 'beforeTool'], policies: ['toolGate', 'toolRiskPolicy'], contextSections: [{ name: 'systemPrompt', sha256: 'a'.repeat(64) }] })

test('same host and scope compare every captured category and ignore ordering', () => {
  const dsh = captured('dsh')
  dsh.controls.reverse()
  assert.deepEqual(compareCapabilitySnapshots(captured('builtin'), dsh), { ok: true, failures: [] })
})
test('host, organization and Agent mismatch are not capability parity', () => {
  const dsh = captured('dsh')
  dsh.host = 'daemon'
  dsh.scope.organizationId = 'other'
  dsh.scope.agentId = 'other'
  const result = compareCapabilitySnapshots(captured('builtin'), dsh)
  assert.equal(result.ok, false)
  assert.ok(result.failures.some(item => item.includes('same-host')))
  assert.ok(result.failures.some(item => item.includes('scope.organizationId')))
  assert.ok(result.failures.some(item => item.includes('scope.agentId')))
})
test('same names with changed schema or missing CLI, skill and control fail', () => {
  const dsh = captured('dsh')
  dsh.tools[0].inputSchema.properties.path.type = 'number'
  dsh.cliCommands = []
  dsh.skills = []
  dsh.controls = ['query']
  const result = compareCapabilitySnapshots(captured('builtin'), dsh)
  for (const dimension of ['tools:', 'cliCommands:', 'skills:', 'controls:']) assert.ok(result.failures.some(item => item.startsWith(dimension)))
})
test('extractor leaves unknown catalogs missing and hashes actual prompt without logging it', () => {
  const { host, scope } = captured('builtin')
  const snapshot = snapshotFromHostSession({ host, scope, harness: 'builtin', session: { tools: captured('builtin').tools, systemPrompt: 'private prompt', hooks: ['beforeRun'], controls: ['query'], policies: ['toolGate'] } })
  assert.equal(snapshot.cliCommands, undefined)
  assert.equal(snapshot.skills, undefined)
  assert.ok(!JSON.stringify(snapshot).includes('private prompt'))
  const result = compareCapabilitySnapshots(snapshot, { ...snapshot, harness: 'dsh' })
  assert.ok(result.failures.includes('cliCommands: missing actual capture'))
  assert.ok(result.failures.includes('skills: missing actual capture'))
})
test('duplicate tools and vacuous captures cannot pass', () => {
  const dsh = captured('dsh')
  dsh.tools.push(dsh.tools[0])
  dsh.hooks = []
  assert.equal(compareCapabilitySnapshots(captured('builtin'), dsh).ok, false)
})
const report = statuses => ({ success: true, numFailedTests: 0, numFailedTestSuites: 0, testResults: [{ name: '/repo/tests/dsh.integration.test.ts', status: 'passed', assertionResults: statuses.map(status => ({ status })) }] })
test('report gate requires actual passing integration assertions', () => {
  assert.equal(assertIntegrationReport(report(['passed']), ['tests/dsh.integration.test.ts'])[0].passed, 1)
  for (const statuses of [[], ['pending'], ['skipped'], ['passed', 'pending'], ['failed']]) assert.throws(() => assertIntegrationReport(report(statuses), ['tests/dsh.integration.test.ts']))
  assert.throws(() => assertIntegrationReport(report(['passed']), ['tests/missing.test.ts']))
  assert.throws(() => assertIntegrationReport(report(['passed']), []))
})
test('source inventory ignores retired comments, unused imports and unrelated helpers', () => {
  const source = `import {createOldTools} from './old'; // new RetiredCap()
    class Provider { getTools() { return [...createCoreTools({})] } unrelated() { createOldTools() } }
    const cap = new SkillsCap({});
    interface HostedRuntime { query(): void; compactCheckpoint?(): void }`
  assert.deepEqual(registrationsFromSource(source, 'test.ts'), { factories: ['createCoreTools'], capabilities: ['SkillsCap'], interfaces: { HostedRuntime: [{ name: 'compactCheckpoint', optional: true }, { name: 'query', optional: false }] } })
})
