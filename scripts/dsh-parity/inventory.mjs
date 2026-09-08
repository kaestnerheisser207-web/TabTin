#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const manifestPath = path.join(root, 'scripts/dsh-parity/capability-inventory.json')
const hosts = {
  electron: {
    provider: 'apps/tabtin-electron/src/main/agent/capabilities/ElectronToolProvider.ts',
    assembly: 'apps/tabtin-electron/src/main/agent/runtime/electron-runtime-assembly.ts',
  },
  daemon: {
    provider: 'apps/tabtin-daemon/src/application/agent/daemon-tool-provider.ts',
    assembly: 'apps/tabtin-daemon/src/application/agent/runtime/daemon-runtime-assembly.ts',
  },
}

export function registrationsFromSource(text, filename) {
  const source = ts.createSourceFile(filename, text, ts.ScriptTarget.Latest, true)
  const factories = new Set()
  const capabilities = new Set()
  const interfaces = {}
  const visitCalls = node => {
    if (ts.isCallExpression(node) && /(?:^|\.)create\w*Tool(?:s|Provider)?$/.test(node.expression.getText(source))) factories.add(node.expression.getText(source))
    ts.forEachChild(node, visitCalls)
  }
  const visit = node => {
    // Ignore historical comments, unused imports and unrelated class methods.
    if (ts.isMethodDeclaration(node) && node.name.getText(source) === 'getTools') visitCalls(node)
    if (ts.isNewExpression(node) && /Cap$/.test(node.expression.getText(source))) capabilities.add(node.expression.getText(source))
    if (ts.isInterfaceDeclaration(node) && ['HostedRuntime', 'BackendSession'].includes(node.name.text)) {
      interfaces[node.name.text] = node.members.filter(ts.isMethodSignature).map(member => ({
        name: member.name.getText(source), optional: Boolean(member.questionToken),
      })).sort((a, b) => a.name.localeCompare(b.name))
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return { factories: [...factories].sort(), capabilities: [...capabilities].sort(), interfaces }
}

export async function collectInventory() {
  const result = { schemaVersion: 1, dshVersion: '0.1.1-rc.2', evidence: 'source-registrations-and-isolated-native-cli; not runtime parity', hosts: {}, controls: {}, cliCommands: [] }
  for (const [host, files] of Object.entries(hosts)) {
    const provider = registrationsFromSource(await readFile(path.join(root, files.provider), 'utf8'), files.provider)
    const assembly = registrationsFromSource(await readFile(path.join(root, files.assembly), 'utf8'), files.assembly)
    result.hosts[host] = { ...files, toolFactories: provider.factories, capabilities: assembly.capabilities }
  }
  const controlFile = 'packages/agent-host/src/runtime/runtime-driver.ts'
  result.controls = { hostedRuntime: { source: controlFile, ...registrationsFromSource(await readFile(path.join(root, controlFile), 'utf8'), controlFile).interfaces } }
  const backendFile = 'packages/agent-runtime/src/capability/backend-session.ts'
  result.controls.backendSession = { source: backendFile, ...registrationsFromSource(await readFile(path.join(root, backendFile), 'utf8'), backendFile).interfaces }
  const temporary = await mkdtemp(path.join(tmpdir(), 'muse-dsh-inventory-'))
  try {
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(?:_?MUSE_|TABTIN_)/.test(key)) delete env[key]
    env.MUSE_CONFIG_DIR = temporary
    const raw = execFileSync('go', ['run', '.', 'commands', '--format', 'json'], {
      cwd: path.join(root, 'packages/tabtin-cli-go'), env, encoding: 'utf8', timeout: 180_000, maxBuffer: 16 * 1024 * 1024,
    })
    const envelope = JSON.parse(raw)
    const commands = envelope.data?.commands
    if (envelope.ok !== true || !Array.isArray(commands) || commands.length === 0) throw new Error('Native CLI returned no command inventory')
    const seen = new Set()
    result.cliCommands = commands.map(command => {
      if (seen.has(command.name)) throw new Error(`Duplicate native CLI command: ${command.name}`)
      seen.add(command.name)
      const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value
      return {
        ...Object.fromEntries(['name', 'source', 'method', 'path', 'risk', 'runtime', 'requires_auth', 'is_group'].filter(key => command[key] !== undefined).map(key => [key, command[key]])),
        schemaSha256: createHash('sha256').update(JSON.stringify(canonical(command))).digest('hex'),
      }
    }).sort((a, b) => a.name.localeCompare(b.name))
  } finally { await rm(temporary, { recursive: true, force: true }) }
  return result
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = `${JSON.stringify(await collectInventory(), null, 2)}\n`
  if (process.argv.includes('--write')) {
    await writeFile(manifestPath, output)
    console.log('Updated source capability inventory; runtime parity remains a separate check.')
  } else {
    const expected = await readFile(manifestPath, 'utf8')
    if (expected !== output) throw new Error('Capability inventory drifted. Review current host registrations/CLI, then run node scripts/dsh-parity/inventory.mjs --write')
    console.log('Source capability inventory matches current host registrations and native CLI.')
  }
}
