import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { performance } from 'node:perf_hooks'
import {
  GitWorkspaceInitializationError,
  type DockerWorkspaceManager,
} from './docker-workspace-manager.js'
import type { AllocationIdentity, ProvisionWorkspaceInput } from './contracts.js'
import type { StorageQuotaMode } from './storage-quota.js'
import type { ResourceIsolationMode } from './resource-isolation.js'
import {
  WorkerMetrics,
  type WorkerEventLogger,
  type WorkerOperation,
  type WorkerRequestObservation,
} from './observability.js'

const MAX_BODY_BYTES = 64 * 1024
const ALLOCATION_ROUTE = /^\/v1\/allocations\/([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/(status|disable|restart))?$/i

export interface WorkerServerOptions {
  manager: DockerWorkspaceManager
  token: string
  protocolVersion: string
  runtimeVersion: string
  storageQuotaMode: StorageQuotaMode
  resourceIsolationMode: ResourceIsolationMode
  metrics?: WorkerMetrics
  log?: WorkerEventLogger
}

export function createWorkerServer(options: WorkerServerOptions) {
  if (!options.token) throw new Error('TABTIN_CLOUD_WORKER_TOKEN is required')
  const metrics = options.metrics ?? new WorkerMetrics()
  return createServer(async (request, response) => {
    const startedAt = performance.now()
    const url = new URL(request.url ?? '/', 'http://worker.local')
    const operation = operationOf(request.method, url.pathname)
    const routeMatch = allocationRoute(url.pathname)
    let result: WorkerRequestObservation['result'] = 'error'
    let statusCode = 500
    let generation: number | undefined
    let errorType: string | undefined
    try {
      if (!authorized(request, options.token)) {
        statusCode = 401
        result = 'unauthorized'
        return send(response, statusCode, { error: 'unauthorized' })
      }
      if (request.method === 'GET' && url.pathname === '/v1/health') {
        statusCode = 200
        result = 'ok'
        return send(response, statusCode, {
          ok: true,
          protocolVersion: options.protocolVersion,
          runtimeVersion: options.runtimeVersion,
          storageQuotaMode: options.storageQuotaMode,
          resourceIsolationMode: options.resourceIsolationMode,
        })
      }
      if (request.method === 'GET' && url.pathname === '/v1/metrics') {
        statusCode = 200
        result = 'ok'
        return sendText(response, statusCode, metrics.render(options))
      }
      if (!routeMatch) {
        statusCode = 404
        result = 'not_found'
        return send(response, statusCode, { error: 'not_found' })
      }
      const body = await readJson(request)
      const parsedGeneration = Number(body.generation)
      generation = Number.isSafeInteger(parsedGeneration) && parsedGeneration > 0
        ? parsedGeneration
        : undefined
      const identity: AllocationIdentity = {
        allocationId: routeMatch[1],
        generation: parsedGeneration,
      }
      if (request.method === 'PUT' && !routeMatch[2]) {
        const input = { ...body, allocationId: routeMatch[1] } as unknown as ProvisionWorkspaceInput
        statusCode = 200
        result = 'ok'
        return send(response, statusCode, await options.manager.provision(input))
      }
      if (request.method === 'POST' && routeMatch[2] === 'status') {
        statusCode = 200
        result = 'ok'
        return send(response, statusCode, await options.manager.status(identity))
      }
      if (request.method === 'POST' && routeMatch[2] === 'disable') {
        statusCode = 200
        result = 'ok'
        return send(response, statusCode, await options.manager.disable(identity))
      }
      if (request.method === 'POST' && routeMatch[2] === 'restart') {
        statusCode = 200
        result = 'ok'
        return send(response, statusCode, await options.manager.restart(identity))
      }
      if (request.method === 'DELETE' && !routeMatch[2]) {
        if (body.permanent !== true) {
          statusCode = 400
          result = 'error'
          return send(response, statusCode, { error: 'permanent_confirmation_required' })
        }
        await options.manager.deletePermanently(identity)
        statusCode = 200
        result = 'ok'
        return send(response, statusCode, { deleted: true })
      }
      statusCode = 405
      result = 'method_not_allowed'
      return send(response, statusCode, { error: 'method_not_allowed' })
    } catch (error) {
      const gitSourceUnavailable = error instanceof GitWorkspaceInitializationError
      statusCode = gitSourceUnavailable ? 422 : 400
      result = 'error'
      errorType = safeErrorType(error)
      return send(response, statusCode, {
        error: error instanceof Error ? error.message : String(error),
        ...(gitSourceUnavailable ? { code: 'git_source_unavailable' } : {}),
      })
    } finally {
      const observation: WorkerRequestObservation = {
        operation,
        result,
        statusCode,
        durationMs: Math.max(0, performance.now() - startedAt),
        allocationId: routeMatch?.[1],
        generation,
        errorType,
      }
      metrics.record(observation)
      options.log?.(observation)
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

function sendText(response: ServerResponse, status: number, payload: string): void {
  response.writeHead(status, {
    'content-type': 'text/plain; version=0.0.4; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
  })
  response.end(payload)
}

function allocationRoute(pathname: string): RegExpExecArray | null {
  return ALLOCATION_ROUTE.exec(pathname)
}

function operationOf(method: string | undefined, pathname: string): WorkerOperation {
  if (method === 'GET' && pathname === '/v1/health') return 'health'
  if (method === 'GET' && pathname === '/v1/metrics') return 'metrics'
  const match = allocationRoute(pathname)
  if (!match) return 'unknown'
  if (method === 'PUT' && !match[2]) return 'provision'
  if (method === 'POST' && match[2] === 'status') return 'status'
  if (method === 'POST' && match[2] === 'disable') return 'disable'
  if (method === 'POST' && match[2] === 'restart') return 'restart'
  if (method === 'DELETE' && !match[2]) return 'delete'
  return 'unknown'
}

function safeErrorType(error: unknown): string {
  const value = error instanceof Error ? error.name : typeof error
  return /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'Error'
}
