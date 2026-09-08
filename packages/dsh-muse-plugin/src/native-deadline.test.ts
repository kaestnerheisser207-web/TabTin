import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'

const sockets = vi.hoisted(() => [] as Array<{
  sent: Array<Record<string, unknown>>
  emit(event: string, data?: unknown): boolean
}>)
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events')
  return { default: class extends EventEmitter {
    sent: Array<Record<string, unknown>> = []
    constructor() { super(); sockets.push(this) }
    send(raw: string) { this.sent.push(JSON.parse(raw) as Record<string, unknown>) }
    close() { this.emit('close') }
  } }
})
import { apply } from './index.js'

type Hook = (...args: unknown[]) => unknown
const disposers: Array<() => unknown> = []
beforeEach(() => { sockets.length = 0 })
afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose()
  vi.unstubAllGlobals()
})

async function fixture(defaultTimeout = 120000, maxTimeout = 600000) {
  const hooks = new Map<string, Hook>()
  const shell = { timeoutMs: defaultTimeout, maxTimeoutMs: maxTimeout }
  const bodies: Array<{ path: string; body: Record<string, unknown> }> = []
  vi.stubGlobal('fetch', async (url: URL, options?: RequestInit) => {
    if (options?.body) bodies.push({ path: url.pathname, body: JSON.parse(String(options.body)) as Record<string, unknown> })
    return Response.json(url.pathname === '/context' ? {
      tools: [], systemPrompt: 'Fixture', context: '', runId: 'run-fixture',
      model: { id: 'fixture-model', supportsVision: false, contextWindowTokens: 32000, maxOutputTokens: 4096 },
    } : url.pathname === '/native/before' ? { allowed: true } : { ok: true })
  })
  const agent = {
    id: 'session-fixture', status: 'idle', cancel: vi.fn(), whenIdle: async () => {},
    ctx: {} as Context,
  }
  const context = {
    tools: { guard: vi.fn(), register: () => () => {} },
    sessions: { flush: async () => true },
    systemPrompt: { section: vi.fn() },
    settings: { update: async () => {}, get: (name: string) => name === 'shell' ? shell : undefined },
    agentPresets: { mount: async () => {} },
    agents: { create: async (options: { setup(ctx: Context): Promise<void> }) => {
      await options.setup({ ...context, agent } as unknown as Context)
      return { agent, dispose: async () => {} }
    } },
    on: (name: string, listener: Hook) => hooks.set(name, listener),
    effect: (effect: () => () => unknown) => { const dispose = effect(); disposers.push(dispose); return dispose },
  }
  agent.ctx = context as unknown as Context
  apply(context as unknown as Context, { bridgeUrl: 'http://127.0.0.1:9000', token: 'fixture-token' })
  sockets[0].emit('message', Buffer.from(JSON.stringify({ id: 'initialize-fixture', method: 'initialize', params: {
    sessionId: agent.id, workspaceRoot: '/workspace', generation: 'generation-fixture', initialMessages: [],
  } })))
  await vi.waitFor(() => expect(sockets[0].sent.find(frame => frame.id === 'initialize-fixture')).toMatchObject({ result: { sessionId: agent.id } }))
  return {
    shell, bodies,
    execution(name: string, args: Record<string, unknown>) {
      return { name, arguments: args, agent, callId: 'call-fixture', token: {}, signal: new AbortController().signal } as unknown as ToolExecution
    },
    before: (exec: ToolExecution) => hooks.get('tools/pre-execute')!(exec, async () => ({ kind: 'allow' })),
    after: (exec: ToolExecution) => hooks.get('tools/post-execute')!(exec, { isError: false, content: [{ type: 'text', text: 'done' }] }, async () => ({ kind: 'accept' })),
  }
}

describe('native shell deadline transport', () => {
  it.each(['bash', 'pwsh'])('keeps the %s effective deadline outside canonical arguments and stable through afterNative', async name => {
    const f = await fixture()
    const exec = f.execution(name, { command: 'echo fixture', timeoutMs: 120000 })
    await expect(f.before(exec)).resolves.toEqual({ kind: 'allow' })
    const before = f.bodies.find(item => item.path === '/native/before')!.body
    expect(before).toEqual({ callId: 'call-fixture', name: 'run_terminal_command', arguments: { command: 'echo fixture', wait_ms: 60000, hard_timeout_ms: 120000 }, runId: 'run-fixture', nativeTimeoutMs: 120000 })
    // Settings may be edited while a long command runs. Its admitted deadline
    // and dedup identity must not be recomputed from the new defaults afterward.
    f.shell.timeoutMs = 1000; f.shell.maxTimeoutMs = 1000
    await f.after(exec)
    const after = f.bodies.find(item => item.path === '/native/after')!.body
    const { result: _result, ...identity } = after
    expect(identity).toEqual(before)
    expect(after.arguments).not.toHaveProperty('nativeTimeoutMs')
  })

  it.each([120000, 45000])('reads resolved DSH default %i instead of confusing it with host wait_ms', async timeoutMs => {
    const f = await fixture(timeoutMs)
    await f.before(f.execution('bash', { command: 'echo fixture' }))
    expect(f.bodies[0].body).toMatchObject({ nativeTimeoutMs: timeoutMs, arguments: { wait_ms: 60000 } })
    expect(f.bodies[0].body.arguments).not.toHaveProperty('hard_timeout_ms')
  })

  it('uses the executor cap for native timing while preserving the canonical requested arguments', async () => {
    const f = await fixture()
    await f.before(f.execution('bash', { command: 'echo fixture', timeoutMs: 900000 }))
    expect(f.bodies[0].body).toMatchObject({ nativeTimeoutMs: 600000, arguments: { wait_ms: 60000, hard_timeout_ms: 900000 } })
  })

  it.each([0, -1, 1.5, '120000'])('rejects invalid native timeout %s before native execution', async timeoutMs => {
    const f = await fixture()
    await expect(f.before(f.execution('bash', { command: 'echo fixture', timeoutMs }))).rejects.toThrow('positive integer')
    expect(f.bodies).toHaveLength(0)
  })

  it('leaves native file calls free of shell-only timing fields', async () => {
    const f = await fixture()
    await f.before(f.execution('read', { file_path: '/workspace/a.md' }))
    expect(f.bodies[0].body).not.toHaveProperty('nativeTimeoutMs')
    expect(f.bodies[0].body.arguments).toEqual({ path: '/workspace/a.md' })
  })
})
