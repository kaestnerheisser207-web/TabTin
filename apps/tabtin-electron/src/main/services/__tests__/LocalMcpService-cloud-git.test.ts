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
vi.mock('@muse/terminal-core', () => ({ atomicWriteFileSync: vi.fn() }))
vi.mock('@muse/storage-manager', () => ({ registerStorageBucket: vi.fn() }))
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

const connectionStore = () => JSON.stringify({
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
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-09-01T00:00:00.000Z',
  }],
})

describe('LocalMcpService personal Cloud Git authorization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', mocks.fetch)
    mocks.readFileSync.mockReturnValue(connectionStore())
    mocks.fetch.mockImplementation(async (url: string) => {
      if (url === 'https://api.github.com/repos/flowdos/flow') {
        return { ok: true, status: 200, json: async () => ({ private: true }) }
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: { credential_ref: 'credential-ref-1' } }),
      }
    })
  })

  it('checks repository access before returning an opaque Cloud credential reference', async () => {
    const result = await new LocalMcpService().createCloudGitCredential(
      'github-1',
      'organization-1',
      'https://github.com/flowdos/flow.git',
    )

    expect(result).toEqual({ credentialRef: 'credential-ref-1' })
    expect(mocks.fetch.mock.calls[0][0]).toBe('https://api.github.com/repos/flowdos/flow')
    expect(mocks.fetch.mock.calls[1][0]).toBe(
      'https://workspace.test/api/context/workspaces/cloud/git-credential',
    )
    expect(JSON.parse(mocks.fetch.mock.calls[1][1].body)).toEqual({
      organization_id: 'organization-1',
      credential_value: 'github_pat_private_value',
    })
  })

  it('does not create a Cloud credential when the selected repository is inaccessible', async () => {
    mocks.fetch.mockResolvedValueOnce({ ok: false, status: 404, json: async () => ({}) })

    await expect(new LocalMcpService().createCloudGitCredential(
      'github-1',
      'organization-1',
      'https://github.com/flowdos/missing.git',
    )).rejects.toThrow('MCP_ERR:CLOUD_GIT_REPOSITORY_NOT_ACCESSIBLE')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('rejects non-GitHub connectors before any network request', async () => {
    const store = JSON.parse(connectionStore())
    store.connections[0].transport.url = 'https://example.com/mcp'
    mocks.readFileSync.mockReturnValue(JSON.stringify(store))

    await expect(new LocalMcpService().createCloudGitCredential(
      'github-1',
      'organization-1',
      'https://github.com/flowdos/flow.git',
    )).rejects.toThrow('MCP_ERR:CLOUD_GIT_REQUIRES_GITHUB_CONNECTION')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })
})
