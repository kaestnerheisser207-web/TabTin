#!/usr/bin/env node
import { readFile } from 'node:fs/promises'
import { compareCapabilitySnapshots } from './capability-snapshot.mjs'

const [, , builtinFile, dshFile] = process.argv
if (!builtinFile || !dshFile) throw new Error('Usage: compare-snapshots.mjs builtin.json dsh.json')
const [builtin, dsh] = await Promise.all([builtinFile, dshFile].map(async file => JSON.parse(await readFile(file, 'utf8'))))
const result = compareCapabilitySnapshots(builtin, dsh)
// Report only category/name differences, never prompt text, credentials or catalog content.
console.log(JSON.stringify(result, null, 2))
if (!result.ok) process.exitCode = 1
