import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { EngineConfig } from '../../engine/contracts/kernel.js'
import type { StreamEvent } from '../../engine/contracts/wire-protocol.js'
import { createMockProvider, createMockPermissionHandler, createMockToolProvider } from '../../../tests/test-utils.js'

const doubles = vi.hoisted(() => ({ builtin: vi.fn(), query: vi.fn(), dispose: vi.fn() }))
vi.mock('../../runtime-assembly.js', () => ({ createRuntime: doubles.builtin, createDefaultQueryDeps: vi.fn() }))
import { forkQuery, type ForkQueryConfig } from '../fork-query.js'
import { createAgentTool } from '../agent-tool.js'

let directory: string
function fixture(overrides: Partial<ForkQueryConfig> = {}): ForkQueryConfig {
  return {
    parentMessages: [], taskPrompt: 'bounded fixture task', systemPrompt: 'fixture system',
    provider: createMockProvider(), tools: createMockToolProvider(), permissionHandler: createMockPermissionHandler(),
    model: 'selected-model', sessionConfig: { sessionDir: directory, threadId: 'parent' },
    workspaceRoot: directory, childId: 'child-fixture', businessThreadId: 'business-thread', ...overrides,
  }
}
async function collect(config: ForkQueryConfig) {
  const iterator = forkQuery(config)
  const events: StreamEvent[] = []
  while (true) {
    const item = await iterator.next()
    if (item.done) return { events, summary: item.value }
    events.push(item.value)
  }
}
async function indexEntries() {
  const source = await readFile(path.join(directory, 'parent', 'subagents.jsonl'), 'utf8')
  return source.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
}
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'muse-fork-harness-'))
  vi.clearAllMocks()
  doubles.dispose.mockResolvedValue(undefined)
  doubles.query.mockImplementation(async function* () {
    yield { type: 'agent.stream.done', payload: { content: 'DSH child result', agent_type: 'dsh' } }
  })
  doubles.builtin.mockImplementation((_config: EngineConfig) => ({
    query: async function* () { yield { type: 'agent.stream.done', payload: { content: 'Builtin child result' } } },
  }))
})
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })

describe('forkQuery host-selected harness', () => {
  it('runs a DSH child through the host factory without constructing a Builtin runtime', async () => {
    const createRuntime = vi.fn((_config: EngineConfig) => ({ query: doubles.query, dispose: doubles.dispose }))
    const config = fixture({ createRuntime })
    const result = await collect(config)
    expect(result.summary).toBe('DSH child result')
    expect(createRuntime).toHaveBeenCalledOnce()
    expect(doubles.builtin).not.toHaveBeenCalled()
    expect(createRuntime.mock.calls[0][0]).toMatchObject({
      model: 'selected-model', workspaceRoot: directory, businessThreadId: 'business-thread',
      subagentRunId: 'child-fixture', subagentDepth: 1, tools: config.tools,
      sessionConfig: { threadId: 'agent-child-fixture' },
    })
    expect(doubles.query).toHaveBeenCalledWith(expect.objectContaining({ prompt: config.taskPrompt, hostRunId: 'child-fixture' }))
    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect((await indexEntries()).at(-1)).toMatchObject({ phase: 'ended', status: 'completed' })
  })

  it('preserves the Builtin default when no host runtime factory is supplied', async () => {
    const result = await collect(fixture())
    expect(result.summary).toBe('Builtin child result')
    expect(doubles.builtin).toHaveBeenCalledOnce()
    expect(doubles.query).not.toHaveBeenCalled()
  })

  it('forwards AgentToolConfig.createRuntime through the actual agent tool and fork path', async () => {
    const config = fixture()
    const createRuntime = vi.fn((_config: EngineConfig) => ({ query: doubles.query, dispose: doubles.dispose }))
    const tool = createAgentTool({
      provider: config.provider, tools: config.tools, permissionHandler: config.permissionHandler,
      sessionConfig: config.sessionConfig, model: config.model, workspaceRoot: directory, createRuntime,
    })
    const result = await tool.execute({ prompt: 'bounded child fixture', description: 'harness regression' }, {
      threadId: 'parent', runtimeId: 'parent-dsh', toolUseId: 'parent-tool',
      abortSignal: new AbortController().signal, messages: [],
    })
    expect(result.isError).toBeFalsy()
    expect(result.content).toContain('DSH child result')
    expect(createRuntime).toHaveBeenCalledOnce()
    expect(doubles.builtin).not.toHaveBeenCalled()
    expect(doubles.dispose).toHaveBeenCalledOnce()
  })

  it('propagates DSH query failure without silently falling back and disposes the child', async () => {
    doubles.query.mockImplementation(async function* () { throw new Error('DSH unavailable') })
    await expect(collect(fixture({ createRuntime: () => ({ query: doubles.query, dispose: doubles.dispose }) }))).rejects.toThrow('DSH unavailable')
    expect(doubles.builtin).not.toHaveBeenCalled()
    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect((await indexEntries()).at(-1)).toMatchObject({ phase: 'ended', status: 'failed' })
  })

  it('passes the cancellation signal to the child, disposes it and records cancelled status', async () => {
    const controller = new AbortController()
    doubles.query.mockImplementation(async function* (params: { signal: AbortSignal }) {
      expect(params.signal).toBe(controller.signal)
      controller.abort(new Error('cancel fixture'))
      params.signal.throwIfAborted()
    })
    await expect(collect(fixture({ signal: controller.signal, createRuntime: () => ({ query: doubles.query, dispose: doubles.dispose }) }))).rejects.toThrow('cancel fixture')
    expect(doubles.dispose).toHaveBeenCalledOnce()
    expect((await indexEntries()).at(-1)).toMatchObject({ phase: 'ended', status: 'cancelled' })
  })

  it('finalizes the child sidechain when its selected harness factory throws', async () => {
    await expect(collect(fixture({ createRuntime: () => { throw new Error('DSH factory failed') } }))).rejects.toThrow('DSH factory failed')
    expect(doubles.builtin).not.toHaveBeenCalled()
    expect((await indexEntries()).at(-1)).toMatchObject({ phase: 'ended', status: 'failed' })
  })

  it('preserves both DSH query and cleanup errors while still ending the sidechain', async () => {
    doubles.query.mockImplementation(async function* () { throw new Error('DSH turn failed') })
    doubles.dispose.mockRejectedValueOnce(new Error('DSH cleanup failed'))
    const error = await collect(fixture({ createRuntime: () => ({ query: doubles.query, dispose: doubles.dispose }) })).catch(error => error)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors.map((item: Error) => item.message)).toEqual(['DSH turn failed', 'DSH cleanup failed'])
    expect((await indexEntries()).at(-1)).toMatchObject({ phase: 'ended', status: 'failed' })
  })

  it('finalizes the sidechain even when the selected runtime disposal throws', async () => {
    doubles.dispose.mockRejectedValueOnce(new Error('DSH dispose failed'))
    await expect(collect(fixture({ createRuntime: () => ({ query: doubles.query, dispose: doubles.dispose }) }))).rejects.toThrow('DSH dispose failed')
    expect((await indexEntries()).at(-1)?.phase).toBe('ended')
  })
})
