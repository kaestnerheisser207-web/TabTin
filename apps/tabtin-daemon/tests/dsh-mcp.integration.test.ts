import { createServer, type Server } from 'node:http'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { DshProcessService } from '../src/application/agent/runtime/dsh-process-service.js'

const enabled = process.env.TABTIN_DSH_INTEGRATION === '1'
const servers: Server[] = []
const services: DshProcessService[] = []
const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(services.splice(0).map(service => service.stop()))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe.skipIf(!enabled)('DSH TabTin MCP integration', () => {
  it('authenticates and discovers TabTin MCP tools before ApiProxy becomes ready', async () => {
    const calls: string[] = []
    const mcp = createServer(async (request, response) => {
      if (request.url !== '/mcp' || request.method !== 'POST') {
        response.writeHead(404).end()
        return
      }
      expect(request.headers.authorization).toBe('Bearer mcp-secret')
      let raw = ''
      for await (const chunk of request) raw += Buffer.from(chunk).toString('utf8')
      const message = JSON.parse(raw)
      calls.push(message.method)
      if (message.id === undefined) {
        response.writeHead(202).end()
        return
      }
      const result = message.method === 'initialize'
        ? {
            protocolVersion: '2024-11-05',
            capabilities: { tools: {} },
            serverInfo: { name: 'tabtin-test', version: '1' },
          }
        : message.method === 'tools/list'
          ? {
              tools: [{
                name: 'tabtin_ping',
                description: 'Ping TabTin',
                inputSchema: { type: 'object', properties: {} },
              }],
            }
          : {}
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
    })
    servers.push(mcp)
    await listen(mcp)

    const apiPort = await reservePort()
    const dshHome = await mkdtemp(join(tmpdir(), 'tabtin-dsh-mcp-'))
    temporaryDirectories.push(dshHome)
    const service = new DshProcessService({
      workspaceRoot: dshHome,
      dshHome,
      apiUrl: `http://127.0.0.1:${apiPort}`,
      modelGatewayUrl: 'http://127.0.0.1:3090/v1',
      modelGatewayToken: 'gateway-token',
      mcpUrl: `http://127.0.0.1:${addressPort(mcp)}/mcp`,
      mcpToken: 'mcp-secret',
      executable: join(process.cwd(), 'node_modules', '.bin', 'dsh'),
      logger: { info: () => undefined, warn: () => undefined },
    })
    services.push(service)

    await service.start()

    expect(calls).toContain('initialize')
    expect(calls).toContain('tools/list')
  }, 30_000)
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

async function reservePort(): Promise<number> {
  const server = createServer()
  await listen(server)
  const port = addressPort(server)
  await new Promise<void>(resolve => server.close(() => resolve()))
  return port
}
