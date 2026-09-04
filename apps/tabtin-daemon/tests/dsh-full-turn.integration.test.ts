import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { DshApiClient } from '../src/application/agent/runtime/dsh-api-client.js'
import { DshModelGateway } from '../src/application/agent/runtime/dsh-model-gateway.js'
import { DshRuntimeDriver } from '../src/application/agent/runtime/dsh-runtime-driver.js'

const enabled = process.env.MUSE_DSH_INTEGRATION === '1'
const children: ChildProcess[] = []
const temporaryDirectories: string[] = []
const servers: Server[] = []
const gateways: DshModelGateway[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (!child.killed) child.kill('SIGTERM')
    await new Promise(resolve => child.once('exit', resolve))
  }
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe.skipIf(!enabled)('DSH full turn integration', () => {
  it('runs DSH through the loopback Model Gateway and emits TabTin stream events', async () => {
    const upstream = createServer((request, response) => {
      if (request.url !== '/api/llm/proxy') {
        response.writeHead(404).end()
        return
      }
      expect(request.headers.authorization).toBe('Bearer daemon-secret')
      expect(request.headers['x-tabtin-organization-id']).toBe('organization-1')
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: { content: '你好' }, finish_reason: null }],
      })}\n\n`)
      response.write(`data: ${JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'deepseek-v4-flash',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 2, total_tokens: 14 },
      })}\n\n`)
      response.end('data: [DONE]\n\n')
    })
    servers.push(upstream)
    await listen(upstream)
    const upstreamPort = addressPort(upstream)

    const gateway = new DshModelGateway({
      serverUrl: `http://127.0.0.1:${upstreamPort}`,
      organizationId: 'organization-1',
      credential: 'daemon-secret',
      token: 'loopback-token',
      port: 0,
    })
    gateways.push(gateway)
    await gateway.start()

    const dshHome = await mkdtemp(join(tmpdir(), 'tabtin-dsh-turn-'))
    temporaryDirectories.push(dshHome)
    const child = spawn(join(process.cwd(), 'node_modules', '.bin', 'dsh'), [
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
        DEEPSEEK_BASE_URL: `http://127.0.0.1:${gateway.port}/v1`,
        DEEPSEEK_API_KEY: 'loopback-token',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    children.push(child)
    const dshUrl = await readDshUrl(child)
    const driver = new DshRuntimeDriver(new DshApiClient(dshUrl))
    const created = await driver.create({
      threadId: `turn-${Date.now()}`,
      workspaceId: 'workspace-1',
      workspaceRoot: dshHome,
      owner: { userId: 'user-1', organizationId: 'organization-1' },
    })

    const events = []
    for await (const event of created.runtime.query({
      prompt: '只回复“你好”，不要调用工具。',
    })) events.push(event)

    const text = events
      .filter(event => event.type === 'agent.stream.content_block_delta')
      .map(event => (event.payload as any).delta?.text ?? '')
      .join('')
    expect(text).toContain('你好')
    expect(events.some(event => event.type === 'agent.stream.message_stop')).toBe(true)
    expect(events.some(event => event.type === 'agent.stream.persist_message')).toBe(true)
    const done = events.find(event => event.type === 'agent.stream.done')
    expect((done?.payload as any).error).toBe(false)
    expect((done?.payload as any).agent_type).toBe('dsh')
  }, 60_000)
})

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
}

function addressPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('server has no TCP address')
  return address.port
}

function readDshUrl(child: ChildProcess): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DSH Web startup timed out')), 15_000)
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
