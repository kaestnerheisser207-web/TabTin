#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** DSH runs outside Electron, so its plugin must be a real ESM resource outside app.asar. */
export function stageDshMusePlugin(sourceDirectory, deployDirectory) {
  const source = resolve(sourceDirectory)
  const entry = join(source, 'index.js')
  try {
    if (!statSync(entry).isFile() || readFileSync(entry).length === 0) throw new Error('empty entry')
  } catch {
    throw new Error(`Missing built DSH Muse plugin: ${entry}. Build @muse/dsh-muse-plugin before packaging.`)
  }
  const destination = join(resolve(deployDirectory), 'dsh-muse-plugin-dist-src')
  if (source === destination || source.startsWith(`${destination}${sep}`) || destination.startsWith(`${source}${sep}`)) throw new Error('DSH staging source must be outside its destination')
  rmSync(destination, { recursive: true, force: true })
  mkdirSync(destination, { recursive: true })
  cpSync(source, destination, { recursive: true, dereference: true })
  // Copying dist alone loses the npm package root that declares ESM.
  writeFileSync(join(destination, 'package.json'), `${JSON.stringify({ type: 'module' }, null, 2)}\n`)
  return destination
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , sourceDirectory, deployDirectory] = process.argv
  if (!sourceDirectory || !deployDirectory) throw new Error('Usage: stage-dsh-muse-plugin.mjs built-dist deploy-directory')
  console.log(`Staged DSH Muse plugin: ${stageDshMusePlugin(sourceDirectory, deployDirectory)}`)
}
