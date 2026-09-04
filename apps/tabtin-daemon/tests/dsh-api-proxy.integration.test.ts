import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'
import { DshApiClient } from '../src/application/agent/runtime/dsh-api-client.js'

const enabled = process.env.MUSE_DSH_INTEGRATION === '1'
const children: ChildProcess[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe.skipIf(!enabled)('DSH ApiProxy integration', () => {
  it('creates a stable session and exposes it on the official WebSocket mux', async () => {
    const dshHome = await mkdtemp(join(tmpdir(), 'tabtin-dsh-api-'))
    temporaryDirectories.push(dshHome)
    const dshBin = join(process.cwd(), 'node_modules', '.bin', 'dsh')
    const child = spawn(dshBin, [
      '--profile', 'web',
      '--host', '127.0.0.1',
      '--port', '0',
      '--no-open',
    ], {
      cwd: dshHome,
      env: {
        ...process.env,
        DSH_HOME: dshHome,
        DSH_TELEMETRY_MODE: 'DISABLED',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    const baseUrl = await readDshUrl(child)
    const client = new DshApiClient(baseUrl)
    const sessionId = `tabtin-integration-${Date.now()}`

    const created = await client.sessions.create({
      sessionId: sessionId as any,
      cwd: dshHome,
    })
    expect(created.result).toEqual({
      ok: true,
      value: expect.objectContaining({ sessionId }),
    })
    const resumed = await client.sessions.create({
      sessionId: sessionId as any,
      cwd: dshHome,
    })
    expect(resumed.result).toEqual({
      ok: true,
      value: expect.objectContaining({ sessionId }),
    })

    const abort = new AbortController()
    const iterator = client.events.mux({}, abort.signal)[Symbol.asyncIterator]()
    const first = await iterator.next()
    abort.abort()
    await iterator.return?.()

    expect(first.done).toBe(false)
    expect(first.value?.payload).toEqual(expect.objectContaining({
      type: 'session/subscribed',
      sessionId,
    }))
  }, 30_000)
})

function readDshUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('DSH Web startup timed out'))
    }, 15_000)
    const onData = (chunk: Buffer) => {
      const match = chunk.toString('utf8').match(/dsh web: (http:\/\/127\.0\.0\.1:\d+)/)
      if (!match) return
      clearTimeout(timer)
      resolve(match[1])
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.once('error', error => {
      clearTimeout(timer)
      reject(error)
    })
    child.once('exit', code => {
      clearTimeout(timer)
      reject(new Error(`DSH Web exited before startup: ${code}`))
    })
  })
}
