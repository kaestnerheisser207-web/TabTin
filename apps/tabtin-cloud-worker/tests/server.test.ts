import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorkerServer, listenWorkerServer } from '../src/server.js'
import type { DockerWorkspaceManager } from '../src/docker-workspace-manager.js'

const servers: Array<ReturnType<typeof createWorkerServer>> = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))))
})

describe('Cloud Worker HTTP server', () => {
  it('requires bearer authentication and exposes versioned health', async () => {
    const manager = {} as DockerWorkspaceManager
    const server = createWorkerServer({
      manager,
      token: 'test-token',
      protocolVersion: '1',
      runtimeVersion: 'test',
      storageQuotaMode: 'none',
      resourceIsolationMode: 'unverified',
    })
    servers.push(server)
    const address = await listenWorkerServer(server, '127.0.0.1', 0)
    const url = `http://127.0.0.1:${address.port}/v1/health`

    expect((await fetch(url)).status).toBe(401)
    const response = await fetch(url, {
      headers: { authorization: 'Bearer test-token' },
    })
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      ok: true,
      protocolVersion: '1',
      runtimeVersion: 'test',
      storageQuotaMode: 'none',
      resourceIsolationMode: 'unverified',
    })

    expect((await fetch(`http://127.0.0.1:${address.port}/v1/metrics`)).status).toBe(401)
    const metrics = await fetch(`http://127.0.0.1:${address.port}/v1/metrics`, {
      headers: { authorization: 'Bearer test-token' },
    })
    expect(metrics.status).toBe(200)
    const payload = await metrics.text()
    expect(payload).toContain('tabtin_cloud_worker_up 1')
    expect(payload).toContain(
      'tabtin_cloud_worker_requests_total{operation="health",result="ok"} 1',
    )
    expect(payload).toContain(
      'tabtin_cloud_worker_requests_total{operation="health",result="unauthorized"} 1',
    )
  })

  it('requires explicit permanent confirmation before deleting', async () => {
    const manager = {
      deletePermanently: vi.fn(async () => undefined),
    } as unknown as DockerWorkspaceManager
    const server = createWorkerServer({
      manager,
      token: 'test-token',
      protocolVersion: '1',
      runtimeVersion: 'test',
      storageQuotaMode: 'none',
      resourceIsolationMode: 'unverified',
    })
    servers.push(server)
    const address = await listenWorkerServer(server, '127.0.0.1', 0)
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/allocations/11111111-1111-4111-8111-111111111111`,
      {
        method: 'DELETE',
        headers: {
          authorization: 'Bearer test-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ generation: 1 }),
      },
    )

    expect(response.status).toBe(400)
    expect(manager.deletePermanently).not.toHaveBeenCalled()
  })

  it('emits bounded structured observations without request bodies or bearer tokens', async () => {
    const log = vi.fn()
    const manager = {
      status: vi.fn(async () => { throw new Error('private worker detail') }),
    } as unknown as DockerWorkspaceManager
    const server = createWorkerServer({
      manager,
      token: 'never-log-this-token',
      protocolVersion: '1',
      runtimeVersion: 'test',
      storageQuotaMode: 'none',
      resourceIsolationMode: 'unverified',
      log,
    })
    servers.push(server)
    const address = await listenWorkerServer(server, '127.0.0.1', 0)
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/allocations/11111111-1111-4111-8111-111111111111/status`,
      {
        method: 'POST',
        headers: {
          authorization: 'Bearer never-log-this-token',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ generation: 7, secret: 'never-log-this-body' }),
      },
    )

    expect(response.status).toBe(400)
    expect(log).toHaveBeenCalledOnce()
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'status',
      result: 'error',
      statusCode: 400,
      allocationId: '11111111-1111-4111-8111-111111111111',
      generation: 7,
      errorType: 'Error',
    }))
    const serialized = JSON.stringify(log.mock.calls)
    expect(serialized).not.toContain('never-log-this-token')
    expect(serialized).not.toContain('never-log-this-body')
    expect(serialized).not.toContain('private worker detail')
  })

  it('does not promote malformed allocation paths into high-cardinality log fields', async () => {
    const log = vi.fn()
    const server = createWorkerServer({
      manager: {} as DockerWorkspaceManager,
      token: 'test-token',
      protocolVersion: '1',
      runtimeVersion: 'test',
      storageQuotaMode: 'none',
      resourceIsolationMode: 'unverified',
      log,
    })
    servers.push(server)
    const address = await listenWorkerServer(server, '127.0.0.1', 0)
    const untrustedId = 'a'.repeat(512)
    const response = await fetch(
      `http://127.0.0.1:${address.port}/v1/allocations/${untrustedId}/status`,
      { headers: { authorization: 'Bearer test-token' } },
    )

    expect(response.status).toBe(404)
    expect(log).toHaveBeenCalledWith(expect.objectContaining({
      operation: 'unknown',
      result: 'not_found',
      statusCode: 404,
    }))
    expect(log.mock.calls[0]?.[0]).not.toHaveProperty('allocationId', untrustedId)
  })
})
