import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DockerWorkspaceManager } from './docker-workspace-manager.js'
import type { AllocationIdentity, ProvisionWorkspaceInput } from './contracts.js'
import type { StorageQuotaMode } from './storage-quota.js'
import type { ResourceIsolationMode } from './resource-isolation.js'

const MAX_BODY_BYTES = 64 * 1024

export interface WorkerServerOptions {
  manager: DockerWorkspaceManager
  token: string
  protocolVersion: string
  runtimeVersion: string
  storageQuotaMode: StorageQuotaMode
  resourceIsolationMode: ResourceIsolationMode
}

export function createWorkerServer(options: WorkerServerOptions) {
  if (!options.token) throw new Error('TABTIN_CLOUD_WORKER_TOKEN is required')
  return createServer(async (request, response) => {
    try {
      if (!authorized(request, options.token)) return send(response, 401, { error: 'unauthorized' })
      const url = new URL(request.url ?? '/', 'http://worker.local')
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        return send(response, 200, {
          ok: true,
          protocolVersion: options.protocolVersion,
          runtimeVersion: options.runtimeVersion,
          storageQuotaMode: options.storageQuotaMode,
          resourceIsolationMode: options.resourceIsolationMode,
        })
      }
      const match = /^\/v1\/allocations\/([0-9a-f-]+)(?:\/(status|disable|restart))?$/.exec(url.pathname)
      if (!match) return send(response, 404, { error: 'not_found' })
      const body = await readJson(request)
      const identity: AllocationIdentity = {
        allocationId: match[1],
        generation: Number(body.generation),
      }
      if (request.method === 'PUT' && !match[2]) {
        const input = { ...body, allocationId: match[1] } as unknown as ProvisionWorkspaceInput
        return send(response, 200, await options.manager.provision(input))
      }
      if (request.method === 'POST' && match[2] === 'status') {
        return send(response, 200, await options.manager.status(identity))
      }
      if (request.method === 'POST' && match[2] === 'disable') {
        return send(response, 200, await options.manager.disable(identity))
      }
      if (request.method === 'POST' && match[2] === 'restart') {
        return send(response, 200, await options.manager.restart(identity))
      }
      if (request.method === 'DELETE' && !match[2]) {
        if (body.permanent !== true) return send(response, 400, { error: 'permanent_confirmation_required' })
        await options.manager.deletePermanently(identity)
        return send(response, 200, { deleted: true })
      }
      return send(response, 405, { error: 'method_not_allowed' })
    } catch (error) {
      return send(response, 400, {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })
}

export async function listenWorkerServer(
  server: ReturnType<typeof createWorkerServer>,
  host: string,
  port: number,
): Promise<AddressInfo> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })
  return server.address() as AddressInfo
}

function authorized(request: IncomingMessage, expected: string): boolean {
  const raw = request.headers.authorization ?? ''
  const supplied = raw.startsWith('Bearer ') ? raw.slice(7) : ''
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  let body = ''
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString('utf8')
    if (body.length > MAX_BODY_BYTES) throw new Error('request body too large')
  }
  if (!body) return {}
  const parsed = JSON.parse(body) as unknown
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON object required')
  return parsed as Record<string, unknown>
}

function send(response: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}
