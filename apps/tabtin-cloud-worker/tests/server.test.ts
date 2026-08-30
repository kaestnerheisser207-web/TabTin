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
})
