import { readFileSync } from 'node:fs'
import { describe, expect, it, vi, afterEach } from 'vitest'
import { createRunHostLeaseHttpApi } from '../src/application/agent/run-host-lease-coordinator.js'

afterEach(() => vi.restoreAllMocks())

describe('Daemon RunHostLease wiring', () => {
  it('uses the shared lease endpoints with the daemon credential', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ outcome: 'claimed', lease_token: 'lease-1', generation: 2 }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))
    const api = createRunHostLeaseHttpApi({
      apiBaseUrl: 'https://tabtin.example/api',
      getAccessToken: () => 'daemon-token',
    })

    await api.claim('run-1', 'cloud-device:generation:2')

    expect(fetchMock).toHaveBeenCalledWith(
      'https://tabtin.example/api/services/agent-engine/run-host-leases/claim/',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer daemon-token',
        }),
      }),
    )
  })

  it('claims before admission, starts heartbeats, and fences by Cloud generation', () => {
    const source = readFileSync(
      new URL('../src/application/agent/daemon-agent-host.ts', import.meta.url),
      'utf8',
    )
    expect(source).toContain('await this.runHostLeaseCoordinator.start()')
    expect(source).toContain('await this.runHostLeaseCoordinator.claim(request.runId)')
    expect(source).toContain('this.runHostLeaseCoordinator.stopTracking(request.runId)')
    expect(source).toContain("`${this.config.fingerprint}:generation:${this.config.cloud_generation ?? 1}`")
    expect(source.indexOf('runHostLeaseCoordinator.claim(request.runId)'))
      .toBeLessThan(source.indexOf('sharedHost.beginSubmitHostQuery('))
  })
})
