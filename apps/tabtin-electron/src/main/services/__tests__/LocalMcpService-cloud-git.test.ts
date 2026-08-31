import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  existsSync: vi.fn(() => true),
  readFileSync: vi.fn(),
  fetch: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/userData') },
  ipcMain: { handle: vi.fn() },
}))
vi.mock('@modelcontextprotocol/sdk/client/index.js', () => ({ Client: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/stdio.js', () => ({ StdioClientTransport: vi.fn() }))
vi.mock('@modelcontextprotocol/sdk/client/streamableHttp.js', () => ({ StreamableHTTPClientTransport: vi.fn() }))
vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))
vi.mock('../../auth', () => ({
  isTrustedSender: vi.fn(() => true),
  TokenManager: { getAccessToken: vi.fn(async () => 'tabtin-access-token') },
}))
vi.mock('../../config/api', () => ({ API_BASE_URL: 'https://workspace.test/api' }))
vi.mock('@tabtin/terminal-core', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('@tabtin/storage-manager', () => ({ registerStorageBucket: vi.fn() }))
vi.mock('../../security/agent-access-guard', () => ({
  assertCurrentUserCanAccessAgent: vi.fn(),
  AgentAccessDeniedError: class AgentAccessDeniedError extends Error {},
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: mocks.existsSync,
    readFileSync: mocks.readFileSync,
    default: { ...actual, existsSync: mocks.existsSync, readFileSync: mocks.readFileSync },
  }
})

import { LocalMcpService } from '../LocalMcpService'

describe('LocalMcpService personal Cloud Git credential bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mocks.fetch)
    mocks.fetch.mockResolvedValue({
      ok: true,
      json: async () => ({ data: { credential_ref: 'credential-ref-1' } }),
    })
    mocks.readFileSync.mockReturnValue(JSON.stringify({
      version: 2,
      connections: [{
        id: 'github-1',
        name: 'GitHub',
        source: { kind: 'manual', label: 'Manual' },
        transport: {
          kind: 'http',
          url: 'https://api.githubcopilot.com/mcp/',
          headers: { Authorization: 'Bearer github_pat_private_value' },
        },
        enabled: true,
        attachedAgentIds: [],
        createdAt: '2026-08-31T00:00:00.000Z',
        updatedAt: '2026-08-31T00:00:00.000Z',
      }],
    }))
  })

  it('sends the secret from main and returns only an opaque reference', async () => {
    const result = await new LocalMcpService().createCloudGitCredential(
      'github-1',
      'organization-1',
    )

    expect(result).toEqual({ credentialRef: 'credential-ref-1' })
    const request = mocks.fetch.mock.calls[0]
    expect(request[0]).toBe('https://workspace.test/api/context/workspaces/cloud/git-credential')
    expect(JSON.parse(request[1].body)).toEqual({
      organization_id: 'organization-1',
      credential_value: 'github_pat_private_value',
    })
  })

  it('rejects non-GitHub connections before any network request', async () => {
    const store = JSON.parse(mocks.readFileSync())
    store.connections[0].transport.url = 'https://example.com/mcp'
    mocks.readFileSync.mockReturnValue(JSON.stringify(store))

    await expect(new LocalMcpService().createCloudGitCredential(
      'github-1',
      'organization-1',
    )).rejects.toThrow('MCP_ERR:CLOUD_GIT_REQUIRES_GITHUB_CONNECTION')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
