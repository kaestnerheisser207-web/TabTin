import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { DshApiClient } from '../src/application/agent/runtime/dsh-api-client.js'
import { DshModelGateway } from '../src/application/agent/runtime/dsh-model-gateway.js'
import { DshProcessService } from '../src/application/agent/runtime/dsh-process-service.js'
import { DshRuntimeDriver } from '../src/application/agent/runtime/dsh-runtime-driver.js'

const enabled = process.env.MUSE_DSH_INTEGRATION === '1'
const temporaryDirectories: string[] = []
const servers: Server[] = []
const gateways: DshModelGateway[] = []
const processes: DshProcessService[] = []

afterEach(async () => {
  await Promise.all(processes.splice(0).map(process => process.stop()))
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
    const portProbe = createServer()
    await listen(portProbe)
    const dshUrl = `http://127.0.0.1:${addressPort(portProbe)}`
    await new Promise<void>(resolve => portProbe.close(() => resolve()))
    const processService = new DshProcessService({
      executable: process.env.MUSE_DSH_TEST_EXECUTABLE ?? join(process.cwd(), 'node_modules', '.bin', 'dsh'),
      workspaceRoot: dshHome, dshHome, apiUrl: dshUrl,
      modelGatewayUrl: `http://127.0.0.1:${gateway.port}/v1`, modelGatewayToken: 'loopback-token',
      logger: { info() {}, warn() {} },
    })
    processes.push(processService)
    await processService.start()
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
