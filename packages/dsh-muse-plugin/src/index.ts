export { managedAgentPreset } from './managed-preset.js'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import WebSocket from 'ws'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentHandle, Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-settings'
import { historySeed, historyBlocks, type HistoryMessage } from './history.js'

export const name = 'muse-host-capabilities'
export const inject = ['sessions', 'agents', 'tools', 'systemPrompt', 'agentPresets', 'attachments', 'settings']
export interface Config { bridgeUrl: string; token: string }
interface ToolSpec { name: string; description: string; inputSchema: Record<string, unknown> }
interface Snapshot { tools: ToolSpec[]; systemPrompt: string; context: unknown; runId: string; model: { id: string; contextWindowTokens?: number; maxOutputTokens?: number; supportsVision: boolean } }
interface RecordState {
  handle?: AgentHandle; agent: Agent; generation: string; snapshot: Snapshot; workspaceRoot: string
  toolDisposers: Map<string, () => void>; outcome: Record<string, unknown> | null
}
const NATIVE = new Set(['read','write','edit','read_image','bash','pwsh'])
const DENIED_NATIVE = 'This native tool is disabled by Muse; use the Muse platform tool with the canonical name.'

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object')
  return value as Record<string, unknown>
}
function content(value: unknown): ContentBlock[] {
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  if (!Array.isArray(value)) return [{ type: 'text', text: JSON.stringify(value ?? null) }]
  return value.map(item => {
    const block = object(item)
    if (block.type === 'text') return { type: 'text', text: String(block.text ?? '') }
    return { type: 'text', text: JSON.stringify(block) }
  })
}
function snapshotOf(value: unknown): Snapshot {
  const raw = object(value)
  if (!Array.isArray(raw.tools) || typeof raw.systemPrompt !== 'string' || typeof raw.runId !== 'string') throw new Error('Invalid Muse capability snapshot')
  const tools = raw.tools.map(value => {
    const tool = object(value)
    if (typeof tool.name !== 'string' || !tool.name || typeof tool.description !== 'string') throw new Error('Invalid Muse tool identity')
    return { name: tool.name, description: tool.description, inputSchema: object(tool.inputSchema) }
  })
  const model = object(raw.model)
  if (typeof model.id !== 'string' || typeof model.supportsVision !== 'boolean') throw new Error('Muse model capabilities are unavailable')
  return { tools, systemPrompt: raw.systemPrompt, context: raw.context, runId: raw.runId, model: model as Snapshot['model'] }
}

/** Public Cordis plugin; all state belongs to this managed DSH process. */
export function apply(ctx: Context, config: Config): void {
  const base = new URL(config.bridgeUrl)
  if (base.protocol !== 'http:' || base.hostname !== '127.0.0.1' || !config.token) throw new Error('Muse bridge must be authenticated loopback')
  const lifetime = new AbortController()
  const sessions = new Map<string, RecordState>()
  const controls = new Map<string, AbortController>()
  const authorizedNative = new WeakSet<object>()
  const auditedNative = new WeakSet<object>()
  let socket: WebSocket | null = null

  const http = async (path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> => {
    const response = await fetch(new URL(path, base), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, lifetime.signal]) : lifetime.signal,
    })
    const value: unknown = await response.json()
    if (!response.ok) throw new Error(typeof object(value).error === 'string' ? String(object(value).error) : `Muse bridge HTTP ${response.status}`)
    return value
  }
  const configureModel = async (snapshot: Snapshot) => {
    const model = snapshot.model
    if (!model.contextWindowTokens || !model.maxOutputTokens) throw new Error('Muse must provide model context and output limits for DSH')
    await ctx.settings.update('llm-deepseek' as Parameters<Context['settings']['update']>[0], {
      defaultContextWindow: model.contextWindowTokens, maxTokens: model.maxOutputTokens,
      models: [{ id: 'muse', name: 'Muse configured model', contextWindow: model.contextWindowTokens,
        maxTokens: model.maxOutputTokens, inputModalities: model.supportsVision ? ['text','image'] : ['text'] }],
    })
  }
  const getState = (exec: Pick<ToolExecution,'agent'>): RecordState => {
    const state = exec.agent ? sessions.get(String(exec.agent.id)) : undefined
    if (!state) throw new Error('DSH agent has no Muse-owned capability session')
    return state
  }
  const nativeDeadlines = new WeakMap<object, number>()
  const nativeInput = (exec: ToolExecution, state: RecordState) => {
    const args = object(exec.arguments)
    let mapped: Record<string, unknown>
    let canonical: string
    let nativeTimeoutMs: number | undefined
    if (exec.name === 'read' || exec.name === 'read_image') {
      canonical = 'read_file'; mapped = { path: args.file_path, ...(args.offset !== undefined ? { offset: args.offset } : {}), ...(args.limit !== undefined ? { limit: args.limit } : {}) }
    } else if (exec.name === 'write') {
      canonical = 'write_file'; mapped = { path: args.file_path, contents: args.content }
    } else if (exec.name === 'edit') {
      canonical = 'edit_file'; mapped = { path: args.file_path, old_string: args.old_string, new_string: args.new_string, ...(args.replace_all !== undefined ? { replace_all: args.replace_all } : {}) }
    } else if (exec.name === 'bash' || exec.name === 'pwsh') {
      if (/(?:^|[\s\/\\;|&"'])(?:muse|tabtin)(?:[\s.;|&"']|$)/i.test(String(args.command ?? ''))) throw new Error('Use Muse run_terminal_command for Muse CLI commands so the active run scope and credentials are bound correctly')
      if (args.sandbox_permissions !== undefined) throw new Error('Use Muse run_terminal_command for a host-approved execution policy; native sandbox escalation is disabled')
      const workdir = args.workdir ?? args.cwd
      if (typeof workdir === 'string' && resolve(state.workspaceRoot,workdir) !== resolve(state.workspaceRoot)) throw new Error('Native shell cwd must remain the Muse workspace; use the host terminal tool for scoped directory operations')
      if (args.run_in_background === true) throw new Error('Use Muse run_terminal_command with wait_ms: 0 for managed background execution, output collection and cancellation')
      canonical = 'run_terminal_command'; mapped = { command: args.command, wait_ms: 60000, ...(args.timeoutMs !== undefined ? { hard_timeout_ms: args.timeoutMs } : {}) }
      nativeTimeoutMs = nativeDeadlines.get(exec.token)
      if (nativeTimeoutMs === undefined) {
        // Both shipped executors use the registered `shell` settings namespace:
        // defaults are 120000/600000 ms, with deployment/user overrides resolved here.
        const shell = object(ctx.settings.get('shell' as Parameters<Context['settings']['get']>[0]))
        const requested = args.timeoutMs ?? shell.timeoutMs
        const maximum = shell.maxTimeoutMs
        if (typeof requested !== 'number' || !Number.isSafeInteger(requested) || requested <= 0
          || typeof maximum !== 'number' || !Number.isSafeInteger(maximum) || maximum <= 0) {
          throw new Error('DSH native shell timeout must resolve to positive integer milliseconds')
        }
        nativeTimeoutMs = Math.min(requested, maximum)
        if (nativeTimeoutMs > 3600000) throw new Error('DSH native shell deadline exceeds the host one-hour limit')
        nativeDeadlines.set(exec.token, nativeTimeoutMs)
      }
    } else throw new Error(DENIED_NATIVE)
    return { callId: String(exec.callId), name: canonical, arguments: mapped, runId: state.snapshot.runId, ...(nativeTimeoutMs !== undefined ? { nativeTimeoutMs } : {}) }
  }
  const refreshTools = (state: RecordState) => {
    for (const dispose of state.toolDisposers.values()) dispose()
    state.toolDisposers.clear()
    for (const tool of state.snapshot.tools) {
      if (NATIVE.has(tool.name)) continue
      const definition: ToolDefinition = {
        name: tool.name, description: tool.description,
        parameters: tool.inputSchema as ToolDefinition['parameters'],
        output: { schema: {}, render: (_args, value) => object(value).museModelContent as ContentBlock[] },
        execute: async (args, exec) => {
          const raw = object(await http('/mcp', { jsonrpc: '2.0', id: String(exec.callId), method: 'tools/call', params: {
            name: tool.name, arguments: args, _meta: { callId: String(exec.callId), runId: state.snapshot.runId },
          } }, exec.signal))
          if (raw.error) throw new Error(String(object(raw.error).message))
          const result = object(raw.result)
          const blocks = Array.isArray(result.content) ? result.content : []
          const text = blocks.map(item => String(object(item).text ?? '')).join('\n')
          const canonical = object(JSON.parse(text))
          if (Array.isArray(canonical.newMessages)) for (const rawMessage of canonical.newMessages) {
            const message = object(rawMessage)
            exec.deferContext({ id: randomUUID() as Message['id'], role: 'user', source: { kind: 'plugin', plugin: name, form: 'instructions' }, content: await historyBlocks(ctx,message.content,exec.signal) })
          }
          const signals = canonical.signals && typeof canonical.signals === 'object' ? object(canonical.signals) : {}
          if (signals.suspendRun || signals.endConversation) { state.outcome = signals; exec.concludeTurn() }
          if (canonical.contextModifier) {
            const modifier = object(canonical.contextModifier)
            if (modifier.allowedTools) state.snapshot.tools = state.snapshot.tools.filter(tool => Array.isArray(modifier.allowedTools) && modifier.allowedTools.includes(tool.name))
          }
          if (canonical.isError || result.isError) throw new Error(content(canonical.content).map(block => block.type === 'text' ? block.text : '').join('\n'))
          const { hostMetadata: _hostMetadata, ...safe } = canonical
          return { ...safe, museModelContent: await historyBlocks(ctx,canonical.rejectedContent ?? canonical.llmContextContent ?? canonical.content,exec.signal) }
        },
      }
      state.toolDisposers.set(tool.name, state.agent.ctx.tools.register(definition))
    }
  }

  // A synchronous monotonic guard prevents a later pre-execute listener from
  // overriding a host denial, and rejects all native names outside the allowlist.
  ctx.tools.guard(exec => {
    const state = exec.agent ? sessions.get(String(exec.agent.id)) : undefined
    if (!state) return 'No Muse capability owner'
    if (state.toolDisposers.has(exec.name)) return undefined
    if (!NATIVE.has(exec.name)) return DENIED_NATIVE
    return authorizedNative.has(exec.token) ? undefined : 'Muse native authorization was not granted'
  })
  ctx.on('tools/pre-execute', async (exec,next) => {
    const state = getState(exec)
    if (state.toolDisposers.has(exec.name)) return next()
    if (!NATIVE.has(exec.name)) return { kind: 'deny', reason: DENIED_NATIVE }
    const inherited = await next()
    if (inherited.kind === 'deny') return inherited
    const result = object(await http('/native/before',nativeInput(exec,state),exec.signal))
    if (result.allowed !== true) return { kind: 'deny', reason: String(result.reason ?? 'Muse policy denied this operation') }
    authorizedNative.add(exec.token)
    // Muse already resolves the workspace approval; never ask through a second DSH UI.
    return { kind: 'allow' }
  })
  ctx.on('tools/post-execute', async (exec,result,next) => {
    const state = getState(exec)
    if (NATIVE.has(exec.name)) {
      await http('/native/after', { ...nativeInput(exec,state), result: { content: result.content, isError: result.isError, hostMetadata: { nativeToolName: exec.name, ...(exec.name === 'read' && !result.isError ? { nativeRead: result.value } : {}) } } }, exec.signal)
      auditedNative.add(exec.token)
    }
    return next()
  })
  ctx.on('tools/result', (exec,result) => {
    // Pre-policy denials never reach post-execute; retain their audit result too.
    if (NATIVE.has(exec.name) && !auditedNative.has(exec.token)) {
      try { void http('/native/after', { ...nativeInput(exec,getState(exec)), result: { content: result.content, isError: result.isError } }).catch(() => undefined) } catch { /* denial is already fail-closed */ }
    }
    return undefined
  })
  ctx.on('agent/pre-step', async (input,next) => {
    const state = getState({ agent: input.agent })
    state.snapshot = snapshotOf(await http('/context',undefined,input.signal)) // includes the Muse pause gate
    if (!state.snapshot.runId) throw new Error('Muse capability run is not active')
    await configureModel(state.snapshot)
    refreshTools(state)
    return next()
  })
  ctx.on('system-prompt/assemble', async (assembly,context,next) => {
    const result = await next()
    const state = [...sessions.values()].find(state => state.agent === context.scope)
    if (!state) throw new Error('Prompt assembly has no Muse scope')
    await http('/context',undefined,context.signal)
    result.contexts = [{ name: 'muse:context', text: typeof state.snapshot.context === 'string' ? state.snapshot.context : JSON.stringify(state.snapshot.context ?? {}) }]
    result.tools = result.tools.filter(tool => NATIVE.has(tool.name) || state.toolDisposers.has(tool.name))
    return result
  })

  const initialize = async (params: Record<string, unknown>, signal: AbortSignal) => {
    const sessionId = String(params.sessionId ?? '')
    const workspaceRoot = String(params.workspaceRoot ?? '')
    const generation = String(params.generation ?? '')
    if (!sessionId || !workspaceRoot || !generation || !Array.isArray(params.initialMessages)) throw new Error('Invalid Muse initialize request')
    const snapshot = snapshotOf(await http('/context',undefined,signal))
    await configureModel(snapshot)
    const existing = sessions.get(sessionId)
    if (existing) {
      if (existing.generation !== generation) throw new Error('DSH session generation conflict')
      if (existing.agent.status !== 'idle') await existing.agent.whenIdle()
      signal.throwIfAborted()
      existing.snapshot = snapshot; existing.outcome = null; refreshTools(existing)
      return { sessionId, generation, reused: true }
    }
    const seed = params.resume === true ? [] : await historySeed(ctx,params.initialMessages as HistoryMessage[])
    let initialized: RecordState | undefined
    try {
      const setup = async (agentCtx: Context) => {
          await ctx.agentPresets.mount(agentCtx,'muse')
          if (!agentCtx.agent) throw new Error('DSH unpublished setup has no agent association')
          initialized = { agent: agentCtx.agent, generation, snapshot, workspaceRoot, toolDisposers: new Map(), outcome: null }
          sessions.set(sessionId,initialized)
          agentCtx.systemPrompt.section({ name: 'muse:complete', order: 0, complete: true, text: () => sessions.get(sessionId)?.snapshot.systemPrompt ?? snapshot.systemPrompt })
          refreshTools(initialized)
        }
      const handle = params.resume === true
        ? await ctx.agents.resume({ resumeSessionId: sessionId as AgentHandle['agent']['id'], signal, agentOptions: { provider:'deepseek-official',model:'muse' }, setup })
        : await ctx.agents.create({ sessionId: sessionId as AgentHandle['agent']['id'], meta:{cwd:workspaceRoot,seedLength:seed.length,agentPreset:'muse'},seed,signal,agentOptions:{provider:'deepseek-official',model:'muse'},setup })
      if (!initialized) throw new Error('DSH capability setup was not invoked')
      initialized.handle = handle
    } catch (error) { sessions.delete(sessionId); throw error }
    return { sessionId, generation, reused: false }
  }
  const control = async (method: string, params: Record<string, unknown>, signal: AbortSignal): Promise<unknown> => {
    if (method === 'initialize') return initialize(params,signal)
    const state = sessions.get(String(params.sessionId ?? ''))
    if (!state) throw new Error('Unknown Muse DSH session')
    if (method === 'cancelAndWait') {
      signal.throwIfAborted()
      const ownerId = String(params.sessionId)
      const targets = [...sessions.entries()].filter(([id]) => id === ownerId || id.startsWith(`${ownerId}:compact:`)).map(([, value]) => value)
      for (const target of targets) target.agent.cancel({ kind: 'user' }, { keepInbox: false })
      let onAbort!: () => void
      const cancelled = new Promise<never>((_resolve,reject) => { onAbort=()=>reject(signal.reason); signal.addEventListener('abort',onAbort,{once:true}) })
      try {
        await Promise.race([Promise.all(targets.map(target => target.agent.whenIdle())),cancelled])
        signal.throwIfAborted()
        if (targets.some(target => target.agent.status !== 'idle')) throw new Error('DSH agent is still running after cancellation')
        await Promise.race([Promise.all(targets.map(target => ctx.sessions.flush(target.agent.session))),cancelled])
        return { stopped: true }
      } finally { signal.removeEventListener('abort',onAbort) }
    }
    if (method === 'outcome') { if (params.flush !== false) await ctx.sessions.flush(state.agent.session); return { ...state.outcome, modelId: state.snapshot.model.id } }
    if (method === 'dispose') { await state.agent.whenIdle(); await ctx.sessions.flush(state.agent.session); await state.handle?.dispose(); sessions.delete(String(params.sessionId)); return { disposed: true } }
    if (method === 'compact') {
      if (!Array.isArray(params.messages)) throw new Error('Compaction requires the canonical Muse message snapshot')
      const messages = params.messages as HistoryMessage[]
      const keep = typeof params.keepLastN === 'number' ? Math.max(1,Math.floor(params.keepLastN)) : 4
      const prefix = messages.slice(0,Math.max(0,messages.length-keep))
      const tail = messages.slice(prefix.length)
      if (prefix.length < 2) return { summary:'',messagesBefore:messages.length,messagesAfter:messages.length,remainingMessages:messages }
      const temporaryId = `${String(params.sessionId)}:compact:${randomUUID()}`
      await initialize({sessionId:temporaryId,generation:randomUUID(),workspaceRoot:state.workspaceRoot,initialMessages:prefix},signal)
      const temporary = sessions.get(temporaryId)
      if (!temporary) throw new Error('DSH maintenance session was not initialized')
      try {
        const compaction = ctx.agentPresets.serviceFor(temporary.agent,'compaction')
        if (!compaction) throw new Error('DSH preset does not provide compaction')
        const result = await compaction.compactNow(temporary.agent,signal)
        const summary = result?.summary.filter(block=>block.type==='text').map(block=>block.text).join('\n') ?? ''
        const remaining = summary ? [{role:'user',content:summary},...tail] : messages
        return {summary,messagesBefore:messages.length,messagesAfter:remaining.length,
          remainingMessages:remaining.map(message=>({role:message.role,content:typeof message.content==='string'?message.content:JSON.stringify(message.content)}))}
      } finally {
        await ctx.sessions.flush(temporary.agent.session)
        await temporary.handle?.dispose();sessions.delete(temporaryId)
      }
    }
    throw new Error(`Unknown Muse control method: ${method}`)
  }
  ctx.effect(() => {
    const url = new URL('/control',base); url.protocol = 'ws:'
    socket = new WebSocket(url,{ headers: { authorization: `Bearer ${config.token}` } })
    socket.on('open', () => socket?.send(JSON.stringify({ id: 'hello', method: 'hello', params: { protocolVersion: 1 } })))
    socket.on('error', () => { /* close cancels owned agents */ })
    socket.on('close', () => {
      for (const state of sessions.values()) state.agent.cancel({ kind: 'hook', reason: 'Muse capability bridge disconnected' })
    })
    socket.on('message', data => {
      const frame = object(JSON.parse(data.toString()))
      if (frame.method === 'cancel') { controls.get(String(object(frame.params).id))?.abort(); return }
      if (typeof frame.id !== 'string' || typeof frame.method !== 'string') return
      const controller = new AbortController(); controls.set(frame.id,controller)
      void control(frame.method,object(frame.params),controller.signal).then(
        result => socket?.send(JSON.stringify({ id: frame.id, result })),
        error => socket?.send(JSON.stringify({ id: frame.id, error: { message: error instanceof Error ? error.message : String(error) } })),
      ).finally(() => controls.delete(String(frame.id)))
    })
    return () => socket?.close()
  })
  ctx.effect(() => async () => {
    lifetime.abort(); socket?.close()
    for (const controller of controls.values()) controller.abort()
    await Promise.all([...sessions.values()].map(state => state.handle?.dispose()))
    sessions.clear()
  })
}
