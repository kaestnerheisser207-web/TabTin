import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ManagedDshRuntimeOptions } from '@muse/agent-host/runtime/dsh'
import type { HostCapabilitySession } from '@muse/agent-host/runtime'

const doubles = vi.hoisted(() => ({
  executable: vi.fn(async () => '/opt/homebrew/bin/dsh'),
  token: vi.fn(async (): Promise<string | null> => 'muse-token'),
  user: vi.fn(async (): Promise<unknown> => ({ id: 'user-1' })),
  options: [] as ManagedDshRuntimeOptions[],
  disposed: [] as unknown[],
  packaged: false,
}))
vi.mock('electron', () => ({ app: { getPath: () => '/tmp/muse-dsh-test', get isPackaged() { return doubles.packaged } } }))
vi.mock('../../../dsh/local-dsh-installation.js', () => ({ requireLocalDshExecutable: doubles.executable }))
vi.mock('../../../auth.js', () => ({ TokenManager: { getAccessToken: doubles.token, getUserInfo: doubles.user } }))
vi.mock('../../../config/api.js', () => ({ API_BASE_URL: 'http://127.0.0.1:6060/api' }))
vi.mock('../../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))
vi.mock('@muse/agent-host/runtime/dsh', () => ({
  ManagedDshRuntime: class {
    private disposed = false
    constructor(readonly options: ManagedDshRuntimeOptions) { doubles.options.push(options) }
    async dispose() {
      if (!this.disposed) { this.disposed = true; doubles.disposed.push(this) }
    }
  },
}))
import { LocalDshRuntime, disposeLocalDshRuntimes } from '../local-dsh-runtime.js'

function runtime(overrides: Partial<ConstructorParameters<typeof LocalDshRuntime>[0]> = {}) {
  return new LocalDshRuntime({
    owner: { userId: 'user-1', organizationId: 'org-1' }, workspaceId: 'ws-1',
    workspaceRoot: '/tmp/workspace', threadId: 'thread-1', modelId: 'selected-model',
    interactions: { request: async () => ({ outcome: 'deny' }) }, permissionMode: 'workspace-write',
    capabilities: {} as HostCapabilitySession, ...overrides,
  })
}
const resourceDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath')
beforeEach(() => {
  doubles.options.length = doubles.disposed.length = 0
  doubles.packaged = false
  doubles.executable.mockResolvedValue('/opt/homebrew/bin/dsh')
  doubles.token.mockResolvedValue('muse-token')
  doubles.user.mockResolvedValue({ id: 'user-1' })
})
afterEach(async () => {
  await disposeLocalDshRuntimes()
  if (resourceDescriptor) Object.defineProperty(process, 'resourcesPath', resourceDescriptor)
  else Reflect.deleteProperty(process, 'resourcesPath')
  vi.clearAllMocks()
})

describe('LocalDshRuntime Electron wrapper', () => {
  // Process isolation, dynamic ports, abort-during-detection and startup cleanup
  // moved to agent-host/tests/managed-dsh-runtime.test.ts with the real shared class.
  it('supplies the installed executable callback and private profile to the shared runtime lazily', () => {
    const capabilities = {} as HostCapabilitySession
    runtime({ capabilities })
    expect(doubles.executable).not.toHaveBeenCalled()
    expect(doubles.token).not.toHaveBeenCalled()
    expect(doubles.options[0]).toMatchObject({
      owner: { userId: 'user-1', organizationId: 'org-1' },
      workspaceRoot: '/tmp/workspace', workspaceId: 'ws-1', threadId: 'thread-1',
      modelId: 'selected-model', permissionMode: 'workspace-write', dataRoot: '/tmp/muse-dsh-test',
      serverUrl: 'http://127.0.0.1:6060/api', getExecutable: doubles.executable, capabilities,
    })
    expect(doubles.options[0].pluginPath).toBeUndefined()
  })

  it('uses a real packaged plugin path outside app.asar', () => {
    doubles.packaged = true
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/Applications/Muse.app/Contents/Resources' })
    runtime()
    expect(doubles.options[0].pluginPath).toBe('/Applications/Muse.app/Contents/Resources/dsh-muse-plugin/index.js')
    expect(doubles.options[0].pluginPath).not.toContain('app.asar')
  })

  it('retains organization and mode authority and disposes every locally owned runtime', async () => {
    const first = runtime()
    const second = runtime({ owner: { userId: 'user-1', organizationId: 'org-2' }, permissionMode: 'read-only' })
    expect(doubles.options[1]).toMatchObject({ owner: { organizationId: 'org-2' }, permissionMode: 'read-only' })
    await first.dispose()
    await disposeLocalDshRuntimes()
    await disposeLocalDshRuntimes()
    expect(doubles.disposed).toEqual([first, second])
  })

  it('preserves a missing-installation error instead of choosing Builtin', async () => {
    doubles.executable.mockRejectedValueOnce(Object.assign(new Error('DSH_NOT_INSTALLED'), { code: 'DSH_NOT_INSTALLED' }))
    runtime()
    await expect(doubles.options[0].getExecutable()).rejects.toMatchObject({ code: 'DSH_NOT_INSTALLED' })
  })

  it('rejects a changed account before forwarding its credential', async () => {
    runtime()
    await expect(doubles.options[0].getCredential()).resolves.toBe('muse-token')
    doubles.token.mockClear()
    doubles.user.mockResolvedValueOnce({ id: 'another-user' })
    await expect(doubles.options[0].getCredential()).rejects.toThrow('owner is no longer authenticated')
    expect(doubles.token).not.toHaveBeenCalled()
  })

  it.each([{ user_id: 'user-1' }, { userId: 'user-1' }])('accepts the same authenticated owner id shape: %j', async user => {
    doubles.user.mockResolvedValueOnce(user)
    runtime()
    await expect(doubles.options[0].getCredential()).resolves.toBe('muse-token')
  })

  it('fails closed after logout or token expiry', async () => {
    runtime()
    doubles.user.mockResolvedValueOnce(null)
    await expect(doubles.options[0].getCredential()).rejects.toThrow('owner is no longer authenticated')
    doubles.token.mockResolvedValueOnce(null)
    await expect(doubles.options[0].getCredential()).rejects.toThrow('requires an authenticated Muse session')
  })
})
