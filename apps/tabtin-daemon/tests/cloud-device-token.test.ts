import { afterEach, describe, expect, it, vi } from 'vitest'
import { TokenAuth } from '../src/transport/gateway/auth.js'
import type { ConfigManager } from '../src/platform/system/config/config-manager.js'

afterEach(() => vi.restoreAllMocks())

function token(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'DIT' })).toString('base64url')
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${header}.${body}.${'a'.repeat(43)}`
}

describe('Cloud daemon activation identity', () => {
  it('uses the token-bound cloud type instead of hardcoded daemon', async () => {
    const initFromToken = vi.fn((config, credential) => ({ ...config, ...credential }))
    const bindFingerprint = vi.fn((value: string) => value)
    const configManager = {
      getFingerprint: () => null,
      getOrCreateFingerprint: vi.fn(),
      bindFingerprint,
      initFromToken,
    } as unknown as ConfigManager
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: {
          device_id: 'device-1',
          access_token: 'access-token',
          organization_id: 'organization-1',
        },
      }),
    } as Response)
    const auth = new TokenAuth(configManager)

    await auth.activateToken(token({
      organization_id: 'organization-1',
      user_id: 'user-1',
      device_name: 'Cloud Workspace',
      expires_at: '2099-01-01T00:00:00.000Z',
      scope: 'device_register',
      device_type: 'cloud',
      expected_fingerprint: 'cloud-allocation-1',
      cloud_allocation_id: 'allocation-1',
      cloud_generation: 1,
      server_url: 'http://127.0.0.1:7070',
      ws_url: 'ws://127.0.0.1:7070',
    }))

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))
    expect(request.fingerprint).toBe('cloud-allocation-1')
    expect(request.device_type).toBe('cloud')
    expect(bindFingerprint).toHaveBeenCalledWith('cloud-allocation-1')
    expect(initFromToken.mock.calls[0]?.[0].device_type).toBe('cloud')
  })

  it('rejects a cloud token bound to another fingerprint before registration', async () => {
    const configManager = {
      getFingerprint: () => 'cloud-current',
    } as unknown as ConfigManager
    const fetchMock = vi.spyOn(globalThis, 'fetch')
    const auth = new TokenAuth(configManager)

    await expect(auth.activateToken(token({
      organization_id: 'organization-1',
      user_id: 'user-1',
      device_name: 'Cloud Workspace',
      expires_at: '2099-01-01T00:00:00.000Z',
      scope: 'device_register',
      device_type: 'cloud',
      expected_fingerprint: 'cloud-other',
      cloud_allocation_id: 'allocation-1',
      cloud_generation: 1,
      server_url: 'http://127.0.0.1:7070',
      ws_url: 'ws://127.0.0.1:7070',
    }))).rejects.toThrow('different device fingerprint')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does not persist an unverified token-bound fingerprint', async () => {
    const bindFingerprint = vi.fn()
    const configManager = {
      getFingerprint: () => null,
      getOrCreateFingerprint: vi.fn(),
      bindFingerprint,
    } as unknown as ConfigManager
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'invalid token',
    } as Response)

    await expect(new TokenAuth(configManager).activateToken(token({
      organization_id: 'organization-1',
      user_id: 'user-1',
      device_name: 'Cloud Workspace',
      expires_at: '2099-01-01T00:00:00.000Z',
      scope: 'device_register',
      device_type: 'cloud',
      expected_fingerprint: 'cloud-allocation-1',
      cloud_allocation_id: 'allocation-1',
      cloud_generation: 1,
      server_url: 'http://127.0.0.1:7070',
      ws_url: 'ws://127.0.0.1:7070',
    }))).rejects.toThrow('Device registration failed')
    expect(bindFingerprint).not.toHaveBeenCalled()
  })
})
