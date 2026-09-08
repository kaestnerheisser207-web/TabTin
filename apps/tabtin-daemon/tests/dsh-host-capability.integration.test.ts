import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type ServerResponse } from 'node:http'
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { BudgetTracker, type EngineConfig, type StreamEvent, type Tool } from '@muse/agent-runtime'
import type { ToolRiskPolicyPort } from '../../../packages/agent-runtime/src/engine/contracts/tool-risk-policy.js'
import { createHostCapabilitySession, type HostCapabilitySnapshot } from '../../../packages/agent-host/src/runtime/host-capability-session.js'
import { ManagedDshRuntime } from '../../../packages/agent-host/src/runtime/dsh/managed-dsh-runtime.js'
import { createTabCodeTools } from '../../../packages/agent-host/src/tools/tabcode-adapter.js'
import { compareCapabilitySnapshots, snapshotFromHostSession } from '../../../scripts/dsh-parity/capability-snapshot.mjs'

const enabled = process.env.MUSE_DSH_INTEGRATION === '1'
const cleanup: Array<() => Promise<unknown>> = []
afterEach(async () => {
  const errors: unknown[] = []
  for (const close of cleanup.splice(0).reverse()) try { await close() } catch (error) { errors.push(error) }
  if (errors.length) throw new AggregateError(errors, 'Host capability fixture cleanup failed')
})
function reply(response: ServerResponse, sequence: number, tool?: { name: string; args: Record<string, unknown> }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  const delta = tool ? { role: 'assistant', tool_calls: [{ index: 0, id: `host-call-${sequence}`, type: 'function', function: { name: tool.name, arguments: JSON.stringify(tool.args) } }] }
    : { role: 'assistant', content: 'HOST_CAPABILITY_OK' }
  response.write(`data: ${JSON.stringify({ id: `host-${sequence}`, object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`)
  response.write(`data: ${JSON.stringify({ id: `host-${sequence}`, object: 'chat.completion.chunk', created: 1, model: 'test-model', choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 30, completion_tokens: 5, total_tokens: 35 } })}\n\n`)
  response.end('data: [DONE]\n\n')
}

describe.skipIf(!enabled)('Real Muse HostCapabilitySession through managed DSH', () => {
  it('shares actual schemas/context, enforces native and platform effects through host hooks/policy, and accounts model tickets', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'muse-dsh-host-e2e-')))
    cleanup.push(() => rm(root, { recursive: true, force: true }))
    const target = join(root, 'proof.txt')
    const platformFile = join(root, 'platform-effect.txt')
    const deniedFile = join(root, 'denied.txt')
    await writeFile(target, 'BEFORE_NATIVE_EDIT\n')
    const audit: Array<{ phase: string; tool?: string; error?: boolean }> = []
    const platformExecute = vi.fn(async () => { await writeFile(platformFile, 'PLATFORM_EFFECT'); return { content: 'PLATFORM_EFFECT' } })
    const forbiddenExecute = vi.fn(async () => { await writeFile(deniedFile, 'FORBIDDEN_PLATFORM_EFFECT'); return { content: 'forbidden' } })
    const platform: Tool[] = [
      { name: 'platform_write', description: 'Write the fixture platform resource', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, policyActionKind: 'object_write', isReadOnly: false, execute: platformExecute },
      { name: 'platform_forbidden', description: 'A policy-denied fixture action', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, policyActionKind: 'object_write', isReadOnly: false, execute: forbiddenExecute },
    ]
    const tools = [...createTabCodeTools({ workspaceRoot: () => root }), ...platform]
    const judged: string[] = []
    const policy: ToolRiskPolicyPort = {
      resolveSnapshot: () => ({ workspace: { allowedPaths: [root], allowedFiles: [] } }),
      judge: ({ tool, input }) => {
        judged.push(tool.name)
        const denied = tool.name === 'platform_forbidden' || (tool.name === 'write_file' && input.path === deniedFile)
        return { behavior: denied ? 'deny' : 'allow', reason: { type: denied ? 'fixture_deny' : 'fixture_allow' }, ...(denied ? { userVisibleReason: 'FIXTURE_POLICY_DENIED' } : {}) }
      },
      buildMemoPatternKey: input => input.toolName,
      forWorkspaceRoot() { return this }, forReadonlyChild() { return this },
    }
    const makeConfig = (tracker: BudgetTracker, label: string): EngineConfig => ({
      contextWindowTokens: 32000, maxOutputTokens: 4096,
      model: 'host-selected-model', provider: { async *createStream() { throw new Error('A Builtin model loop must not run in this test') } },
      tools: { getTools: () => tools }, permissionHandler: { requestPermissionsBatch: async () => [] },
      sessionConfig: { threadId: 'host-thread', sessionDir: join(root, label) }, businessThreadId: 'host-thread',
      workspaceRoot: root, systemPrompt: 'REAL_HOST_SYSTEM_SENTINEL', agentMode: 'agent',
      toolRiskPolicy: policy, toolGate: { isRestrictedMode: () => false, evaluate: () => ({ allowed: true }), isPlanTargetGuarded: () => false },
      readFileState: new Map(), budgetTracker: tracker,
      hooks: {
        beforeRun: async ctx => { ctx.state.systemPrompt += '\nREAL_BEFORE_RUN_SENTINEL'; audit.push({ phase: 'beforeRun' }) },
        beforeModel: async ctx => { ctx.appendSystemSection('fixture', 'REAL_BEFORE_MODEL_CONTEXT') },
        beforeTool: async ctx => { audit.push({ phase: 'beforeTool', tool: ctx.tool.name }) },
        afterTool: async ctx => { audit.push({ phase: 'afterTool', tool: ctx.tool.name, error: Boolean(ctx.result?.isError) }) },
        afterRun: async () => { audit.push({ phase: 'afterRun' }) },
      },
    })
    const scope = { threadId: 'host-thread', workspaceId: 'host-workspace', agentId: 'host-agent', owner: { userId: 'host-user', organizationId: 'host-org' } }
    const builtinTracker = new BudgetTracker()
    const builtin = createHostCapabilitySession({ config: makeConfig(builtinTracker, 'builtin'), scope, emit: () => {} })
    cleanup.push(() => builtin.dispose())
    await builtin.beginRun({ hostRunId: 'builtin-snapshot-run', prompt: 'fixture' })
    const builtinSnapshot = await builtin.snapshot()
    await builtin.endRun()

    const tracker = new BudgetTracker()
    const config = makeConfig(tracker, 'dsh')
    const backup = vi.fn(async (_anchor: string, file: string) => { expect(await readFile(file, 'utf8')).toBe('BEFORE_NATIVE_EDIT\n') })
    config.fileHistory = { beginSnapshot: async () => {}, trackEdit: backup }
    const hostEvents: StreamEvent[] = []
    const capabilities = createHostCapabilitySession({ config, scope, emit: event => { hostEvents.push(event) } })
    const captured: HostCapabilitySnapshot[] = []
    const actualSnapshot = capabilities.snapshot.bind(capabilities)
    vi.spyOn(capabilities, 'snapshot').mockImplementation(async () => { const value = await actualSnapshot(); if (value.runId) captured.push(value); return value })
    const ticketSpy = vi.spyOn(capabilities, 'beforeModelRequest')
    const legacyUsage = vi.spyOn(capabilities, 'recordModelUsage')
    const requests: Record<string, unknown>[] = []
    const errors: string[] = []
    const upstream = createServer(async (request, response) => {
      try {
        expect(request.url).toBe('/api/llm/proxy')
        expect(request.headers.authorization).toBe('Bearer fixture-host-credential')
        expect(request.headers['x-tabtin-organization-id']).toBe('host-org')
        expect(request.headers['x-tabtin-session-id']).toBe('host-thread')
        let body = ''; for await (const chunk of request) body += chunk.toString()
        const parsed = JSON.parse(body) as Record<string, unknown>
        requests.push(parsed)
        const sequence = requests.length
        expect(sequence).toBeLessThanOrEqual(6)
        expect(parsed.model).toBe('host-selected-model')
        const messages = JSON.stringify(parsed.messages)
        expect(messages).toContain('REAL_HOST_SYSTEM_SENTINEL')
        expect(messages).toContain('REAL_BEFORE_RUN_SENTINEL')
        expect(messages).toContain('REAL_BEFORE_MODEL_CONTEXT')
        const names = (parsed.tools as Array<{ function: { name: string } }>).map(tool => tool.function.name)
        expect(names).toEqual(expect.arrayContaining(['read', 'edit', 'write', 'platform_write', 'platform_forbidden']))
        if (sequence === 1) reply(response, sequence, { name: 'read', args: { file_path: target } })
        else if (sequence === 2) {
          expect(messages).toContain('BEFORE_NATIVE_EDIT')
          expect(config.readFileState?.get(target)?.content).toBe('BEFORE_NATIVE_EDIT')
          reply(response, sequence, { name: 'edit', args: { file_path: target, old_string: 'BEFORE_NATIVE_EDIT', new_string: 'AFTER_NATIVE_EDIT' } })
        } else if (sequence === 3) {
          expect(await readFile(target, 'utf8')).toBe('AFTER_NATIVE_EDIT\n')
          reply(response, sequence, { name: 'platform_write', args: {} })
        } else if (sequence === 4) {
          expect(await readFile(platformFile, 'utf8')).toBe('PLATFORM_EFFECT')
          reply(response, sequence, { name: 'write', args: { file_path: deniedFile, content: 'FORBIDDEN_NATIVE_EFFECT' } })
        } else if (sequence === 5) reply(response, sequence, { name: 'platform_forbidden', args: {} })
        else reply(response, sequence)
      } catch (error) { errors.push(String(error)); reply(response, 999) }
    })
    await new Promise<void>((resolve, reject) => { upstream.once('error', reject); upstream.listen(0, '127.0.0.1', resolve) })
    cleanup.push(() => new Promise<void>(resolve => { upstream.closeAllConnections(); upstream.close(() => resolve()) }))
    const address = upstream.address(); if (!address || typeof address === 'string') throw new Error('No loopback port')
    const runtime = new ManagedDshRuntime({
      ...scope, modelId: 'host-selected-model', workspaceRoot: root, dataRoot: join(root, 'managed'),
      capabilities, interactions: { request: async () => ({ outcome: 'deny' }) }, permissionMode: 'workspace-write',
      serverUrl: `http://127.0.0.1:${address.port}`, getCredential: async () => 'fixture-host-credential',
      getExecutable: async () => join(process.cwd(), 'node_modules', '.bin', 'dsh'),
      pluginPath: resolve('../../packages/dsh-muse-plugin/dist/index.js'), logger: { info() {}, warn(message) { errors.push(message) } },
    })
    cleanup.push(() => runtime.dispose())
    const events: StreamEvent[] = []
    for await (const event of runtime.query({ prompt: 'Run the bounded native and platform fixture actions.', hostRunId: 'dsh-host-run', signal: AbortSignal.timeout(60000) })) events.push(event)
    expect(errors).toEqual([])
    expect(requests).toHaveLength(6)
    expect(events.find(event => event.type === 'agent.stream.done')?.payload).toMatchObject({ error: false, content: 'HOST_CAPABILITY_OK' })
    expect(await readFile(target, 'utf8')).toBe('AFTER_NATIVE_EDIT\n')
    expect(await readFile(platformFile, 'utf8')).toBe('PLATFORM_EFFECT')
    await expect(access(deniedFile)).rejects.toThrow()
    expect(platformExecute).toHaveBeenCalledOnce()
    expect(forbiddenExecute).not.toHaveBeenCalled()
    expect(backup).toHaveBeenCalledOnce()
    expect(judged).toEqual(expect.arrayContaining(['read_file', 'edit_file', 'platform_write', 'write_file', 'platform_forbidden']))
    for (const tool of ['read_file', 'edit_file', 'platform_write']) {
      expect(audit).toContainEqual({ phase: 'afterTool', tool, error: false })
      expect(audit).toContainEqual({ phase: 'beforeTool', tool })
    }
    expect(audit).toContainEqual({ phase: 'afterTool', tool: 'platform_forbidden', error: true })
    expect(hostEvents.length).toBeGreaterThan(0)
    expect(ticketSpy).toHaveBeenCalledTimes(6)
    expect(legacyUsage).not.toHaveBeenCalled()
    expect(tracker.getUsage()).toMatchObject({ inputTokens: 180, outputTokens: 30 })

    const dshSnapshot = captured[0]
    expect(dshSnapshot).toBeDefined()
    expect(dshSnapshot.tools).toEqual(builtinSnapshot.tools)
    expect(dshSnapshot.systemPrompt).toBe(builtinSnapshot.systemPrompt)
    expect(dshSnapshot.context).toBe(builtinSnapshot.context)
    for (const key of ['hooks', 'policies', 'controls'] as const) expect(dshSnapshot[key]).toEqual(builtinSnapshot[key])
    const comparisonScope = { organizationId: 'host-org', workspaceId: 'host-workspace', agentId: 'host-agent', mode: 'agent' }
    const capture = (harness: 'builtin' | 'dsh', session: HostCapabilitySnapshot) => snapshotFromHostSession({ host: 'daemon', scope: comparisonScope, harness, session })
    // This fixture proves the real shared host path, not a fabricated Electron/Daemon catalog.
    // Actual organization CLI and installed Skill catalogs must still be captured on the real host.
    const remaining = compareCapabilitySnapshots(capture('builtin', builtinSnapshot), capture('dsh', dshSnapshot))
    expect(remaining.failures).toEqual(['cliCommands: missing actual capture', 'skills: missing actual capture'])
    await runtime.dispose()
  }, 90000)
})
