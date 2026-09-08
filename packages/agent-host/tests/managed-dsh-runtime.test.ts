import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostCapabilitySession } from '../src/runtime/host-capability-session.js'
import type { DshModelGatewayOptions } from '../src/runtime/dsh/dsh-model-gateway.js'
import type { DshProcessOptions } from '../src/runtime/dsh/dsh-process-service.js'

const doubles = vi.hoisted(() => ({
  gateways: [] as Array<{ options: DshModelGatewayOptions; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
  processes: [] as Array<{ options: DshProcessOptions; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }>,
  bridges: [] as Array<{ capabilities: unknown; start: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn>; waitUntilReady: ReturnType<typeof vi.fn>; url: string; token: string }>,
  driverCreate: vi.fn(), query: vi.fn(), abort: vi.fn(), dispose: vi.fn(), compact: vi.fn(),
  processStart: vi.fn(), gatewayStart: vi.fn(), ready: vi.fn(), listen: vi.fn(),
  nextPort: 42100,
}))
vi.mock('node:net', () => ({ createServer: () => {
  const port = doubles.nextPort++
  return { once() {}, listen: (port: number, host: string, cb: () => void) => { doubles.listen(port, host); cb() }, address: () => ({ port }), close: (cb: () => void) => cb() }
} }))
vi.mock('../src/runtime/dsh/dsh-api-client.js', () => ({ DshApiClient: class {} }))
vi.mock('../src/runtime/dsh/dsh-model-gateway.js', () => ({ DshModelGateway: class {
  port = doubles.nextPort++
  start = doubles.gatewayStart
  stop = vi.fn(async () => undefined)
  constructor(readonly options: DshModelGatewayOptions) { doubles.gateways.push(this) }
} }))
vi.mock('../src/runtime/dsh/dsh-process-service.js', () => ({ DshProcessService: class {
  start = doubles.processStart
  stop = vi.fn(async () => undefined)
  constructor(readonly options: DshProcessOptions) { doubles.processes.push(this) }
} }))
vi.mock('../src/runtime/dsh/dsh-capability-bridge.js', () => ({ DshCapabilityBridge: class {
  url = `http://127.0.0.1:${doubles.nextPort++}`
  token = 'capability-token'
  start = vi.fn(async () => undefined)
  stop = vi.fn(async () => undefined)
  waitUntilReady = doubles.ready
  constructor(readonly capabilities: unknown) { doubles.bridges.push(this) }
} }))
vi.mock('../src/runtime/dsh/dsh-runtime-driver.js', () => ({ DshRuntimeDriver: class { create = doubles.driverCreate } }))
import { ManagedDshRuntime, type ManagedDshRuntimeOptions } from '../src/runtime/dsh/managed-dsh-runtime.js'

const instances: ManagedDshRuntime[] = []
function fixture(overrides: Partial<ManagedDshRuntimeOptions> = {}) {
  const capabilities = {
    beforeModelRequest: vi.fn(async () => undefined), recordModelUsage: vi.fn(), dispose: vi.fn(async () => undefined),
  } as unknown as HostCapabilitySession
  const options: ManagedDshRuntimeOptions = {
    owner: { userId: 'user-1', organizationId: 'org-1' }, workspaceId: 'ws-1',
    workspaceRoot: '/workspace', threadId: 'thread-1', modelId: 'selected-model',
    interactions: { request: async () => ({ outcome: 'deny' }) }, capabilities,
    permissionMode: 'workspace-write', dataRoot: '/app-profile', serverUrl: 'http://127.0.0.1:6060/api',
    getExecutable: vi.fn(async () => '/installed/dsh'), getCredential: vi.fn(async () => 'muse-token'),
    logger: { info: vi.fn(), warn: vi.fn() }, ...overrides,
  }
  const runtime = new ManagedDshRuntime(options)
  instances.push(runtime)
  return { runtime, options }
}
async function run(runtime: ManagedDshRuntime) {
  const events = []
  for await (const event of runtime.query({ prompt: 'hello' })) events.push(event)
  return events
}
beforeEach(() => {
  vi.clearAllMocks()
  doubles.gateways.length = doubles.processes.length = doubles.bridges.length = 0
  doubles.processStart.mockResolvedValue(undefined)
  doubles.gatewayStart.mockResolvedValue(undefined)
  doubles.ready.mockResolvedValue(undefined)
  doubles.dispose.mockResolvedValue(undefined)
  doubles.compact.mockResolvedValue({ summary: 'compacted' })
  doubles.query.mockImplementation(async function* () { yield { type: 'agent.stream.done', payload: { agent_type: 'dsh' } } })
  doubles.driverCreate.mockResolvedValue({ runtime: { query: doubles.query, abort: doubles.abort, dispose: doubles.dispose, compactCheckpoint: doubles.compact } })
})
afterEach(async () => { await Promise.all(instances.splice(0).map(runtime => runtime.dispose())) })

describe('ManagedDshRuntime isolation and lifecycle', () => {
  it('lazily reuses one isolated process, private home, dynamic loopback and selected model', async () => {
    const { runtime, options } = fixture()
    expect(doubles.processes).toHaveLength(0)
    await run(runtime)
    await run(runtime)
    expect(doubles.processes).toHaveLength(1)
    expect(doubles.processes[0].options).toMatchObject({ executable: '/installed/dsh', workspaceRoot: '/workspace', permissionMode: 'workspace-write' })
    expect(doubles.processes[0].options.dshHome).toMatch(/^\/app-profile\/dsh\/[a-f0-9]{64}$/)
    expect(doubles.processes[0].options.apiUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    expect(doubles.processes[0].options.apiUrl).not.toBe('http://127.0.0.1:3080')
    expect(doubles.listen).toHaveBeenCalledWith(0, '127.0.0.1')
    expect(doubles.gateways[0].options).toMatchObject({ organizationId: 'org-1', sessionId: 'thread-1', modelId: 'selected-model', port: 0 })
    await runtime.dispose()
    await runtime.dispose()
    expect(doubles.processes[0].stop).toHaveBeenCalledOnce()
    expect(doubles.gateways[0].stop).toHaveBeenCalledOnce()
    expect(doubles.bridges[0].stop).toHaveBeenCalledOnce()
    expect(doubles.bridges[0].stop).toHaveBeenCalledWith(false)
    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect(options.capabilities.dispose).toHaveBeenCalledOnce()
  })

  it.each([
    { owner: { userId: 'user-1', organizationId: 'org-2' } },
    { owner: { userId: 'user-2', organizationId: 'org-1' } },
    { permissionMode: 'read-only' as const }, { modelId: 'another-model' },
    { workspaceId: 'another-workspace' }, { threadId: 'another-thread' },
  ])('isolates a changed execution scope: %j', async override => {
    await run(fixture().runtime)
    await run(fixture(override).runtime)
    expect(new Set(doubles.processes.map(process => process.options.dshHome)).size).toBe(2)
    expect(new Set(doubles.gateways.map(gateway => gateway.options.token)).size).toBe(2)
  })

  it('requires installed DSH without allocating gateway, bridge or fallback', async () => {
    const missing = Object.assign(new Error('DSH_NOT_INSTALLED'), { code: 'DSH_NOT_INSTALLED' })
    const { runtime } = fixture({ getExecutable: vi.fn(async () => { throw missing }) })
    await expect(run(runtime)).rejects.toMatchObject({ code: 'DSH_NOT_INSTALLED' })
    expect(doubles.processes).toHaveLength(0)
    expect(doubles.gateways).toHaveLength(0)
    expect(doubles.driverCreate).not.toHaveBeenCalled()
  })

  it('does not launch or send after abort during installation detection and permits a later run', async () => {
    let detected!: (path: string) => void
    const getExecutable = vi.fn().mockImplementationOnce(() => new Promise<string>(resolve => { detected = resolve })).mockResolvedValue('/installed/dsh')
    const { runtime } = fixture({ getExecutable })
    const pending = run(runtime)
    runtime.abort()
    detected('/installed/dsh')
    await expect(pending).rejects.toThrow('DSH query aborted')
    expect(doubles.processes).toHaveLength(0)
    expect(doubles.gateways).toHaveLength(0)
    expect(doubles.query).not.toHaveBeenCalled()
    await run(runtime)
    expect(doubles.query).toHaveBeenCalledOnce()
  })

  it('propagates an active turn abort to DSH without disposing the reusable process', async () => {
    doubles.query.mockImplementation(async function* (params: { signal: AbortSignal }) {
      await new Promise<void>(resolve => params.signal.addEventListener('abort', () => resolve(), { once: true }))
      params.signal.throwIfAborted()
    })
    const { runtime } = fixture()
    const active = run(runtime)
    await vi.waitFor(() => expect(doubles.query).toHaveBeenCalledOnce())
    runtime.abort()
    await expect(active).rejects.toThrow('DSH query aborted')
    expect(doubles.abort).toHaveBeenCalledOnce()
    expect(doubles.processes[0].stop).not.toHaveBeenCalled()
    doubles.query.mockImplementation(async function* () { yield { type: 'agent.stream.done' } })
    await run(runtime)
    expect(doubles.processes).toHaveLength(1)
  })

  it('cancels startup when the host is disposed during executable detection', async () => {
    let detected!: (path: string) => void
    const getExecutable = vi.fn(() => new Promise<string>(resolve => { detected = resolve }))
    const { runtime } = fixture({ getExecutable })
    const active = run(runtime)
    const disposing = runtime.dispose()
    detected('/installed/dsh')
    await expect(active).rejects.toThrow('DSH runtime disposed')
    await disposing
    expect(doubles.processes).toHaveLength(0)
    expect(doubles.query).not.toHaveBeenCalled()
  })

  it('cleans all acquired resources on plugin startup failure and can retry', async () => {
    doubles.ready.mockRejectedValueOnce(new Error('plugin handshake failed'))
    const { runtime } = fixture()
    await expect(run(runtime)).rejects.toThrow('plugin handshake failed')
    expect(doubles.processes[0].stop).toHaveBeenCalledOnce()
    expect(doubles.gateways[0].stop).toHaveBeenCalledOnce()
    expect(doubles.bridges[0].stop).toHaveBeenCalledOnce()
    expect(doubles.query).not.toHaveBeenCalled()
    await run(runtime)
    expect(doubles.processes).toHaveLength(2)
  })

  it.each(['getExecutable', 'getCredential'] as const)('disposes promptly while %s never resolves and ignores its late completion', async key => {
    let finish!: (value: string) => void
    const pending = vi.fn(() => new Promise<string>(resolve => { finish = resolve }))
    const { runtime } = fixture({ [key]: pending })
    const active = run(runtime)
    const rejected = expect(active).rejects.toThrow('DSH runtime disposed')
    await vi.waitFor(() => expect(pending).toHaveBeenCalledOnce())
    await runtime.dispose()
    await rejected
    expect(doubles.processes).toHaveLength(0)
    finish('late-preparation-result')
    await Promise.resolve()
    expect(doubles.processes).toHaveLength(0)
    expect(doubles.query).not.toHaveBeenCalled()
  })

  it('revalidates credentials per gateway request and forwards model accounting hooks', async () => {
    const { runtime, options } = fixture()
    await run(runtime)
    expect(doubles.gateways[0].options.getCredential).toBe(options.getCredential)
    await doubles.gateways[0].options.beforeRequest?.()
    doubles.gateways[0].options.onUsage?.({ inputTokens: 2, outputTokens: 3 } as never)
    expect(options.capabilities.beforeModelRequest).toHaveBeenCalledOnce()
    expect(options.capabilities.recordModelUsage).toHaveBeenCalledWith({ inputTokens: 2, outputTokens: 3 })
    expect(doubles.processes[0].options).toMatchObject({ capabilityBridgeUrl: doubles.bridges[0].url, capabilityBridgeToken: doubles.bridges[0].token })
  })

  it('delegates compaction to DSH and rejects concurrent turn/compaction', async () => {
    const { runtime } = fixture()
    const params = { messages: [], keepLastN: 2 }
    await expect(runtime.compactCheckpoint(params)).resolves.toEqual({ summary: 'compacted' })
    expect(doubles.compact).toHaveBeenCalledWith(params)
    let finish!: () => void
    const gate = new Promise<void>(resolve => { finish = resolve })
    doubles.query.mockImplementation(async function* () { await gate; yield { type: 'agent.stream.done' } })
    const active = run(runtime)
    await expect(run(runtime)).rejects.toThrow('already active')
    await expect(runtime.compactCheckpoint(params)).rejects.toThrow('active DSH turn')
    finish()
    await active
  })

  it('stops process, gateway and bridge even when runtime disposal rejects', async () => {
    const { runtime } = fixture()
    await run(runtime)
    doubles.dispose.mockRejectedValueOnce(new Error('runtime cleanup failed'))
    await expect(runtime.dispose()).rejects.toThrow('runtime cleanup failed')
    expect(doubles.processes[0].stop).toHaveBeenCalledOnce()
    expect(doubles.gateways[0].stop).toHaveBeenCalledOnce()
    expect(doubles.bridges[0].stop).toHaveBeenCalledOnce()
  })

  it('fails closed after disposal and never launches a process', async () => {
    const { runtime } = fixture()
    await runtime.dispose()
    await expect(run(runtime)).rejects.toThrow('disposed')
    expect(doubles.processes).toHaveLength(0)
  })
})
