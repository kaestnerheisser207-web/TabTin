#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { stageDshMusePlugin } from '../../apps/tabtin-electron/scripts/stage-dsh-muse-plugin.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const temporary = mkdtempSync(join(tmpdir(), 'muse-dsh-packaged-plugin-'))
try {
  const staged = stageDshMusePlugin(join(root, 'packages/dsh-muse-plugin/dist'), temporary)
  const env = { ...process.env }
  delete env.NODE_PATH
  delete env.NODE_OPTIONS
  const program = `
    const plugin = await import(${JSON.stringify(pathToFileURL(join(staged, 'index.js')).href)});
    if (plugin.name !== 'muse-host-capabilities' || typeof plugin.apply !== 'function') throw new Error('Invalid Muse plugin exports');
    console.log('Built DSH plugin imports from isolated real files in plain Node.');
  `
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', program], { cwd: temporary, env, encoding: 'utf8', timeout: 15_000 })
  console.log(output.trim())
} finally { rmSync(temporary, { recursive: true, force: true }) }
