import { randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, type ChildProcess } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { afterEach, describe, expect, it } from 'vitest'

const image = process.env.TABTIN_CLOUD_RUNTIME_IMAGE
const children: ChildProcess[] = []
const servers: Server[] = []
const temporaryDirectories: string[] = []
const containerNames: string[] = []

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) {
      child.kill('SIGTERM')
      await new Promise(resolve => child.once('exit', resolve))
    }
  }
  await Promise.all(containerNames.splice(0).map(name => removeContainer(name)))
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    server.close(() => resolve())
  })))
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe.skipIf(!image)('Cloud Runtime image bootstrap integration', () => {
  it('activates the token-bound Cloud Device and emits a real heartbeat', async () => {
    const activations: Array<Record<string, unknown>> = []
    const heartbeats: Array<Record<string, unknown>> = []
    const server = createServer(async (request, response) => {
      const body = await readJson(request)
      if (request.method === 'POST' && request.url === '/api/context/devices/activate') {
        activations.push(body)
        return json(response, 200, {
          success: true,
          data: {
            device_id: 'cloud-device-1',
            access_token: 'daemon-access-token',
            organization_id: 'organization-1',
          },
        })
      }
      if (request.method === 'POST' && request.url === '/api/context/devices/heartbeat') {
        expect(request.headers.authorization).toBe('Bearer daemon-access-token')
        heartbeats.push(body)
        return json(response, 200, {
          success: true,
          data: {
            status: 'online',
            last_heartbeat_at: new Date().toISOString(),
            token_expires_in_seconds: 3600,
          },
        })
      }
      return json(response, 200, { success: true, data: { items: [], total: 0 } })
    })
    servers.push(server)
    const socketServer = new WebSocketServer({ noServer: true })
    server.on('upgrade', (request, socket, head) => {
      socketServer.handleUpgrade(request, socket, head, ws => {
        socketServer.emit('connection', ws, request)
      })
    })
    socketServer.on('connection', socket => {
      socket.on('message', raw => {
        const envelope = JSON.parse(raw.toString())
        const now = Math.floor(Date.now() / 1000)
        if (envelope.type === 'auth') {
          socket.send(JSON.stringify({
            v: 1,
            type: 'auth.ok',
            request_id: envelope.request_id,
            ts: now,
            device_id: 'server',
            role: 'backend',
            payload: { session_id: 'runtime-image-e2e', transport_capabilities: [] },
          }))
          return
        }
        if (envelope.type === 'subscribe') {
          const topics = envelope.payload?.topics ?? []
          socket.send(JSON.stringify({
            v: 1,
            type: 'subscribe.ok',
            request_id: envelope.request_id,
            ts: now,
            device_id: 'server',
            role: 'backend',
            payload: {
              topics,
              boundary_cursors: Object.fromEntries(
                topics.map((topic: string) => [topic, '1-0']),
              ),
            },
          }))
          return
        }
        socket.send(JSON.stringify({
          v: 1,
          type: envelope.type === 'ping' ? 'pong' : `${envelope.type}.ok`,
          request_id: envelope.request_id,
          ts: now,
          device_id: 'server',
          role: 'backend',
          payload: {},
        }))
      })
    })
    await listen(server)
    const port = addressPort(server)
    const apiPort = await reservePort()
    const gatewayPort = await reservePort()
    const root = await mkdtemp(join(tmpdir(), 'tabtin-runtime-image-'))
    temporaryDirectories.push(root)
    const workspace = join(root, 'workspace')
    const runtime = join(root, 'runtime')
    const bootstrap = join(runtime, 'bootstrap')
    await Promise.all([
      mkdir(workspace, { recursive: true }),
      mkdir(bootstrap, { recursive: true }),
    ])
    await chmod(workspace, 0o777)
    await chmod(runtime, 0o777)
    await chmod(bootstrap, 0o777)
    const fingerprint = `cloud-${randomUUID()}`
    const installToken = token({
      organization_id: 'organization-1',
      user_id: 'user-1',
      device_name: 'Cloud Runtime E2E',
      expires_at: '2099-01-01T00:00:00.000Z',
      scope: 'device_register',
      device_type: 'cloud',
      expected_fingerprint: fingerprint,
      cloud_allocation_id: randomUUID(),
      cloud_generation: 7,
      workspace_root: '/workspace',
      server_url: `http://127.0.0.1:${port}`,
      ws_url: `ws://127.0.0.1:${port}`,
    })
    await writeFile(join(bootstrap, 'install-token'), installToken, { mode: 0o666 })

    const containerName = `tabtin-runtime-image-${randomUUID()}`
    containerNames.push(containerName)
    const child = spawn('docker', [
      'run', '--rm', '--network', 'host',
      '--name', containerName,
      '--mount', `type=bind,src=${workspace},dst=/workspace`,
      '--mount', `type=bind,src=${runtime},dst=/var/lib/tabtin`,
      '--env', 'TABTIN_DSH_GATEWAY_TOKEN=image-e2e-gateway-token',
      '--env', `TABTIN_DSH_API_URL=http://127.0.0.1:${apiPort}`,
      '--env', `TABTIN_DSH_GATEWAY_PORT=${gatewayPort}`,
      '--env', 'DAEMON_CONTROL_ENABLED=false',
      image!,
    ], { stdio: ['ignore', 'pipe', 'pipe'] })
    children.push(child)
    let output = ''
    child.stdout.on('data', chunk => { output = `${output}${chunk}`.slice(-20_000) })
    child.stderr.on('data', chunk => { output = `${output}${chunk}`.slice(-20_000) })

    await waitFor(() => activations.length === 1 && heartbeats.length >= 1, child, () => output)

    expect(activations[0]).toMatchObject({
      fingerprint,
      device_type: 'cloud',
    })
    expect(heartbeats[0]).toMatchObject({ fingerprint })
    expect(output).toContain('[DSH] ApiProxy and TabTin MCP bridge ready')
    expect(await readFile(join(runtime, 'daemon', 'fingerprint'), 'utf8'))
      .toBe(fingerprint)
    const config = JSON.parse(await readFile(join(runtime, 'daemon', 'config.json'), 'utf8'))
    expect(config).toMatchObject({
      fingerprint,
      device_type: 'cloud',
      cloud_generation: 7,
      workspace_root: '/workspace',
    })
  }, 90_000)
})

function token(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'DIT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.${'a'.repeat(43)}`
}

function removeContainer(name: string): Promise<void> {
  return new Promise(resolve => {
    const child = spawn('docker', ['rm', '--force', name], {
      stdio: 'ignore',
    })
    child.once('error', () => resolve())
    child.once('close', () => resolve())
  })
}

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

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of request) raw += Buffer.from(chunk).toString('utf8')
  return raw ? JSON.parse(raw) : {}
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

async function waitFor(
  predicate: () => boolean,
  child: ChildProcess,
  diagnostics: () => string,
): Promise<void> {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (predicate()) return
    if (child.exitCode !== null) {
      throw new Error(`Cloud Runtime exited early (${child.exitCode}):\n${diagnostics()}`)
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error(`Cloud Runtime bootstrap timed out:\n${diagnostics()}`)
}
