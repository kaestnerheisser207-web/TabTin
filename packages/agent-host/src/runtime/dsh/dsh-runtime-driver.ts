import { AskInteractionRequestSchema } from '@muse/agent-wire'
import { questionResponsePayloadSchema } from '@deepseek-ai/dsh-host-apiproxy/api/questions.schema'
import { randomUUID, createHash } from 'node:crypto'
import { readFile, writeFile, rename } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { DshCapabilityBridge } from './dsh-capability-bridge.js'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type {
  MuxFrame,
  RpcRequest,
  QuestionResponsePayload,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  StreamEvents,
  hitlMessageId,
  HitlInteractionEvent,
  type HitlInteractionArgs,
  estimateTokens,
  type Message,
  type CompactCheckpointSummary,
  type QueryParams,
  type StreamEvent,
} from '@muse/agent-runtime'
import type {
  HostedRuntime,
  RuntimeDriver,
  RuntimeDriverContext,
  RuntimeDriverSession,
} from '../runtime-driver.js'
import { DshEventTranslator } from './dsh-event-translator.js'

type SessionId = Parameters<IApiClient['sessions']['cancel']>[0]['sessionId']

export interface DshRuntimeOptions { bindingPath?: string; terminateUnconfirmedRun?: () => Promise<void> }

interface DurableDshBinding { version: 1; businessThreadId: string; workspaceRoot: string; sessionId: string; generation: string; historyPrefix: string[]; historyDigest: string; lastCompleted: boolean }

export interface DshRuntimeBinding {
  sessionId: string
}

export interface DshInteractionRequest {
  requestId: string
  conversationId: string
  kind: 'approval' | 'question'
  payload: Record<string, unknown>
  timeoutMs: number
  timeoutValue: unknown
}

export interface DshInteractionPort {
  request(input: DshInteractionRequest): Promise<unknown>
  cancel?(requestId: string): void
}

export class DshRuntimeDriver implements RuntimeDriver<RuntimeDriverContext, DshRuntimeBinding> {
  readonly harness = 'dsh' as const

  constructor(
    private readonly client: IApiClient,
    private readonly interactions?: DshInteractionPort,
    private readonly modelId?: string,
    private readonly bridge?: DshCapabilityBridge,
    private readonly options: DshRuntimeOptions = {},
  ) {}

  async create(
    context: RuntimeDriverContext,
  ): Promise<RuntimeDriverSession<DshRuntimeBinding>> {
    if (this.bridge) {
      return { runtime: new DshHostedRuntime(this.client, context.threadId, context.threadId, this.interactions, this.modelId, this.bridge, context.workspaceRoot, this.options), binding: { sessionId: context.threadId } }
    }
    const response = await this.client.sessions.create({
      sessionId: context.threadId as SessionId,
      cwd: context.workspaceRoot,
    })
    const value = unwrap(response, 'session.create')
    const sessionId = String(value.sessionId)
    return {
      runtime: new DshHostedRuntime(
        this.client,
        sessionId,
        context.threadId,
        this.interactions,
        this.modelId,
        this.bridge,
        context.workspaceRoot,
        this.options,
      ),
      binding: { sessionId },
    }
  }

  async resume(
    context: RuntimeDriverContext,
    binding: DshRuntimeBinding,
  ): Promise<RuntimeDriverSession<DshRuntimeBinding>> {
    if (binding.sessionId !== context.threadId) {
      throw new Error('DSH binding does not match the business thread')
    }
    return await this.create(context)
  }

  async dispose(session: RuntimeDriverSession<DshRuntimeBinding>): Promise<void> {
    if (session.runtime.dispose) await session.runtime.dispose()
    else await Promise.resolve(session.runtime.abort())
  }
}

export class DshHostedRuntime implements HostedRuntime {
  private activeController: AbortController | null = null
  private cancellationPromise: Promise<void> | null = null
  private cancellationFailure: Error | null = null
  private readonly pendingInteractions = new Set<string>()
  private readonly approvalRequestIds = new Map<string, string>()
  private readonly hitlFacts = new Map<string, HitlInteractionArgs>()
  private initialized = false
  private generation: string = randomUUID()
  private historyPrefix: string[] = []
  private bindingLoaded = false

  constructor(
    private readonly client: IApiClient,
    private dshSessionId: string,
    private readonly businessThreadId: string,
    private readonly interactions?: DshInteractionPort,
    private readonly modelId?: string,
    private readonly bridge?: DshCapabilityBridge,
    private readonly workspaceRoot?: string,
    private readonly options: DshRuntimeOptions = {},
  ) {}

  getRuntimeId(): string {
    return `dsh:${this.dshSessionId}`
  }

  abort(): void {
    if (!this.activeController) return
    this.activeController.abort(new Error('DSH runtime aborted'))
    void this.requestCancellation().catch(() => { /* query/dispose reports the stored failure */ })
  }

  private requestCancellation(): Promise<void> {
    if (this.cancellationPromise) return this.cancellationPromise
    this.cancellationPromise = this.cancelAndConfirm().catch(async error => {
      let cleanup = ''
      if (this.options.terminateUnconfirmedRun) {
        try { await withAbort(this.options.terminateUnconfirmedRun(), AbortSignal.timeout(5000)); cleanup = ' 已请求清理受管进程；执行终态与此前业务副作用仍需核对。' }
        catch { cleanup = ' 受管进程强制清理也未确认。' }
      }
      this.cancellationFailure = new Error(`DSH 停止未确认，需重建运行实例。${cleanup} 原因：${error instanceof Error ? error.message : String(error)}`)
      throw this.cancellationFailure
    })
    return this.cancellationPromise
  }

  private async cancelAndConfirm(): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('DSH cancellation confirmation timed out')), 10000)
    const signal = controller.signal
    try {
      if (this.bridge && this.initialized) {
        const result = await withAbort(this.bridge.control<{ stopped: boolean }>('cancelAndWait', { sessionId: this.dshSessionId }, signal), signal)
        if (result.stopped !== true) throw new Error('DSH plugin did not confirm an idle agent')
        return
      }
      // Official cancel returns accepted immediately, not a stopped state.
      unwrap(await withAbort(this.client.sessions.cancel({ sessionId: this.dshSessionId as SessionId }, signal), signal), 'session.cancel')
      while (true) {
        const value = unwrap(await withAbort(this.client.sessions.list({}, signal), signal), 'session.list')
        const session = value.items.find(item => String(item.sessionId) === this.dshSessionId)
        if (!session) throw new Error('DSH session disappeared before cancellation could be verified')
        if (session.running === false) return
        await withAbort(new Promise<void>(resolve => setTimeout(resolve, 100)), signal)
      }
    } finally { clearTimeout(timer) }
  }

  async *query(params: QueryParams): AsyncGenerator<StreamEvent, void, undefined> {
    if (this.cancellationFailure) throw this.cancellationFailure
    if (this.activeController) throw new Error('DSH runtime query is already active')
    this.cancellationPromise = null
    const controller = new AbortController()
    this.activeController = controller
    const signals = [controller.signal, params.signal].filter(Boolean) as AbortSignal[]
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    const runId = params.hostRunId ?? randomUUID()
    const translator = new DshEventTranslator(this.businessThreadId, runId, this.modelId)
    let iterator: AsyncIterator<RpcRequest<MuxFrame>> | undefined
    let capabilityRun = false
    const cancelDsh = () => { void this.requestCancellation().catch(() => { /* reported at the query boundary */ }) }
    signal.addEventListener('abort', cancelDsh, { once: true })
    try {
      if (this.bridge) { await this.bridge.beginRun({ ...params, signal, hostRunId: runId }); capabilityRun = true }
      await params.waitIfPaused?.(signal)
      const { history, prompt, submitted } = await prepareInput(params, signal)
      if (this.bridge) await this.initialize(history, submitted, signal)
      iterator = this.client.events.mux({}, signal)[Symbol.asyncIterator]()
      await waitForSubscription(iterator, this.dshSessionId)
      yield translator.emit(StreamEvents.USER, {
        content: params.displayMessage ?? params.prompt,
        client_event_id: params.clientMessageId,
        triggered_by: params.triggeredBy ?? 'user',
        run_id: runId,
        trace_id: runId,
      })
      const accepted = await this.client.sessions.prompt({
        sessionId: this.dshSessionId as SessionId,
        mode: 'queue',
        content: prompt,
      }, signal)
      unwrap(accepted, 'session.prompt')

      while (true) {
        signal.throwIfAborted()
        const next = await iterator.next()
        signal.throwIfAborted()
        if (next.done) throw new Error('DSH event stream ended before turn completion')
        const request = next.value
        const frame = request.payload
        if (frame.type === 'stream/error') {
          throw new Error(`DSH stream error: ${frame.error.message}`)
        }
        if (frame.sessionId !== this.dshSessionId) continue
        if (frame.type === 'approval/requested') {
          const approvalRequest = { ...request, payload: frame }
          this.approvalRequestIds.set(String(frame.approvalId), String(request.rpcId))
          const payload = approvalPayload(approvalRequest)
          const requestKey = String(request.rpcId)
          this.hitlFacts.set(requestKey, {
            kind: 'tool_approval', requestKey, payload, agentRunId: runId, status: 'pending',
            expiresAtMs: Number(payload.expires_at), messageId: String(payload.message_id),
          })
          yield translator.emit(StreamEvents.APPROVAL_REQUESTED, payload)
          yield this.persistHitl(translator, requestKey, 'pending')
          await withAbort(this.answerApproval(approvalRequest, signal), signal)
          continue
        }
        if (frame.type === 'approval/resolved') {
          const requestKey = this.approvalRequestIds.get(String(frame.approvalId)) ?? String(frame.approvalId)
          yield translator.emit(StreamEvents.APPROVAL_RESOLVED, {
            batch_id: this.approvalRequestIds.get(String(frame.approvalId)) ?? String(frame.approvalId),
            decisions: [{
              request_id: this.approvalRequestIds.get(String(frame.approvalId)) ?? String(frame.approvalId),
              tool_call_id: String(frame.approvalId),
              outcome: frame.outcome === 'allowed-once' ? 'allow' : 'deny',
            }],
            schema_version: 1,
          })
          if (this.hitlFacts.has(requestKey)) yield this.persistHitl(translator, requestKey, 'resolved')
          continue
        }
        if (frame.type === 'question/resolved') {
          yield translator.emit(StreamEvents.SINGLE_HITL_RESOLVED, {
            request_id: String(frame.questionRpcId),
            interrupt_id: String(frame.questionRpcId),
            outcome: frame.outcome,
            schema_version: 1,
          })
          const requestKey = String(frame.questionRpcId)
          if (this.hitlFacts.has(requestKey)) yield this.persistHitl(translator, requestKey, frame.outcome === 'cancelled' ? 'cancelled' : 'resolved')
          continue
        }
        if (frame.type === 'question/requested') {
          const question = questionPayload(request.rpcId, frame)
          const requestKey = String(request.rpcId)
          this.hitlFacts.set(requestKey, {
            kind: question.tool_name === 'ask_user' ? 'ask_choice' : 'ask_form',
            requestKey, payload: question, agentRunId: runId, status: 'pending',
            messageId: question.message_id, expiresAtMs: Date.now() + 24 * 60 * 60 * 1000,
          })
          yield translator.emit(question.tool_name === 'ask_user'
            ? StreamEvents.ASK_USER_REQUIRED : StreamEvents.ASK_FORM_REQUIRED, question)
          yield this.persistHitl(translator, requestKey, 'pending')
          await withAbort(this.answerQuestion({ ...request, payload: frame }, signal), signal)
          continue
        }
        if (frame.type !== 'session/event') continue
        if (frame.event.type === 'step/start' && this.bridge) {
          const current = await this.bridge.control<{ modelId?: string }>('outcome',{sessionId:this.dshSessionId,flush:false},signal)
          if (current.modelId) translator.setModelId(current.modelId)
        }
        if (frame.event.type === 'tool/result') {
          for (const resultBlock of frame.event.data.message.content) {
            for (const block of resultBlock.content) if (block.type === 'image') {
              const image = unwrap(await this.client.sessions.attachment({sessionId:this.dshSessionId as SessionId,attachmentId:block.attachment.attachmentId},signal),'session.attachment')
              translator.setImageSource(String(block.attachment.attachmentId),image.attachment.mediaType,image.data)
            }
          }
        }
        if (frame.event.type === 'turn/end') {
          if (this.bridge) {
            translator.setTurnOutcome(await this.bridge.control<Record<string, unknown>>('outcome', { sessionId: this.dshSessionId }, signal))
            await this.saveBinding(frame.event.data.reason.kind === 'completed')
          }
          for (const requestKey of this.hitlFacts.keys()) yield this.persistHitl(translator, requestKey, 'cancelled')
        }
        for (const event of translator.translate(frame.event)) yield event
        if (frame.event.type === 'turn/end') return
      }
    } catch (error) {
      for (const requestKey of this.hitlFacts.keys()) {
        yield this.persistHitl(translator, requestKey, 'cancelled')
      }
      if (signal.aborted) {
        try { await this.requestCancellation() }
        catch (confirmationError) {
          yield translator.emit(StreamEvents.DONE, {
            content: confirmationError instanceof Error ? confirmationError.message : 'DSH 停止未确认，需重建运行实例。',
            error: true, error_class: 'CANCELLATION_UNCONFIRMED', trace_id: runId, agent_type: 'dsh',
            metadata: { host_confirmed: false },
          })
          return
        }
        yield translator.emit(StreamEvents.DONE, {
          content: '',
          error: false,
          error_class: 'ABORT',
          trace_id: runId,
          agent_type: 'dsh',
          metadata: { host_confirmed: true },
        })
        return
      }
      throw error
    } finally {
      for (const requestId of this.pendingInteractions) this.interactions?.cancel?.(requestId)
      this.pendingInteractions.clear()
      this.approvalRequestIds.clear()
      this.hitlFacts.clear()
      signal.removeEventListener('abort', cancelDsh)
      try {
        // A consumer may return() while a yielded event is outstanding rather
        // than re-enter catch. Never let a pending cancel hit the next run.
        if (signal.aborted) await this.requestCancellation().catch(() => { /* sticky failure remains visible to dispose/next query */ })
        await iterator?.return?.()
        if (capabilityRun) await this.bridge?.endRun()
      } finally { this.activeController = null }
    }
  }

  async compactCheckpoint(params: { messages: Message[]; summaryFocus?: string; keepLastN?: number }): Promise<CompactCheckpointSummary> {
    if (this.cancellationFailure) throw this.cancellationFailure
    if (!this.bridge) throw new Error('DSH compaction requires the Muse capability bridge')
    if (this.activeController) throw new Error('Cannot compact an active DSH run')
    const controller = new AbortController()
    this.activeController = controller
    this.cancellationPromise = null
    try {
      await this.bridge.beginRun({ prompt: '', initialMessages: params.messages, hostRunId: randomUUID(), signal: controller.signal })
      this.bridge.setCompactionFocus(params.summaryFocus)
      const history = await materializeMessages(params.messages,controller.signal)
      await this.initialize(history, history, controller.signal)
      const compacted = await this.bridge.control<{ summary: string; messagesBefore: number; messagesAfter: number; remainingMessages: Array<{ role: 'user'|'assistant'; content: string }> }>('compact', { sessionId: this.dshSessionId, messages: history, summaryFocus: params.summaryFocus, keepLastN: params.keepLastN },controller.signal)
      await this.saveBinding(true)
      const before = estimateTokens(params.messages)
      const after = estimateTokens(compacted.remainingMessages)
      return { summary: compacted.summary, stats: { messages_before: compacted.messagesBefore, messages_after: compacted.messagesAfter, tokens_before: before, tokens_after: after, tokens_freed: Math.max(0,before-after), summary_length: compacted.summary.length } }
    } finally {
      try {
        if (controller.signal.aborted) await this.requestCancellation()
      } finally {
        try { await this.bridge.endRun() } finally { this.activeController = null }
      }
    }
  }

  async dispose(): Promise<void> {
    this.abort()
    if (this.cancellationPromise) await this.cancellationPromise
    if (this.bridge && this.initialized) {
      await this.bridge.control('dispose',{ sessionId: this.dshSessionId },AbortSignal.timeout(10000))
      this.initialized = false
    }
  }

  private async initialize(history: Message[], submitted: Message[], signal: AbortSignal): Promise<void> {
    if (!this.bridge || !this.workspaceRoot) throw new Error('Missing DSH capability initialization scope')
    await this.bridge.waitUntilReady(signal)
    const prefix = history.map(messageDigest)
    let resume = false
    if (!this.bindingLoaded && this.options.bindingPath) {
      this.bindingLoaded = true
      const saved = await this.loadBinding()
      if (saved?.lastCompleted && saved.historyPrefix.every((value,index) => prefix[index] === value)) {
        this.generation = saved.generation; this.dshSessionId = saved.sessionId; resume = true
      }
    }
    const unchanged = this.initialized && this.historyPrefix.every((value,index) => prefix[index] === value)
    if (this.initialized && !unchanged) {
      await this.bridge.control('dispose',{ sessionId: this.dshSessionId },signal)
      this.initialized = false; this.generation = randomUUID()
    }
    if (!this.initialized && !resume) this.dshSessionId = `${this.businessThreadId}:muse:${this.generation}`
    await this.bridge.control('initialize',{ sessionId: this.dshSessionId, generation: this.generation, workspaceRoot: this.workspaceRoot, initialMessages: history, resume },signal)
    unwrap(await this.client.sessions.selectModel({sessionId:this.dshSessionId as SessionId,provider:'deepseek-official',model:'muse'},signal),'session.selectModel')
    this.initialized = true
    this.historyPrefix = submitted.map(messageDigest)
    await this.saveBinding(false)
  }

  private async loadBinding(): Promise<DurableDshBinding | undefined> {
    const path = this.options.bindingPath
    if (!path) return undefined
    if (!isAbsolute(path)) throw new Error('DSH binding path must be absolute')
    let raw: string
    try { raw = await readFile(path,'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
    if (raw.length > 8*1024*1024) throw new Error('DSH binding metadata exceeds limit')
    const value = JSON.parse(raw) as DurableDshBinding
    if (value.version !== 1 || value.businessThreadId !== this.businessThreadId || value.workspaceRoot !== this.workspaceRoot
      || typeof value.generation !== 'string' || typeof value.sessionId !== 'string' || !value.sessionId.startsWith(`${this.businessThreadId}:muse:`)
      || !Array.isArray(value.historyPrefix) || !value.historyPrefix.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash))) {
      throw new Error('DSH durable binding is incompatible with this workspace/session')
    }
    return value
  }

  private async saveBinding(lastCompleted: boolean): Promise<void> {
    const path = this.options.bindingPath
    if (!path || !this.workspaceRoot) return
    const value: DurableDshBinding = { version:1,businessThreadId:this.businessThreadId,workspaceRoot:this.workspaceRoot,
      sessionId:this.dshSessionId,generation:this.generation,historyPrefix:this.historyPrefix,
      historyDigest:createHash('sha256').update(JSON.stringify(this.historyPrefix)).digest('hex'),lastCompleted }
    const temporary = `${path}.${randomUUID()}.tmp`
    await writeFile(temporary,JSON.stringify(value),{encoding:'utf8',mode:0o600})
    await rename(temporary,path)
  }


  private persistHitl(
    translator: DshEventTranslator,
    requestKey: string,
    status: HitlInteractionArgs['status'],
  ): StreamEvent {
    const fact = this.hitlFacts.get(requestKey)
    if (!fact) throw new Error('DSH interaction transcript missing')
    const raw = new HitlInteractionEvent({
      ...fact, status,
      ...(status !== 'pending' ? { resolvedAtMs: Date.now() } : {}),
    }).toStreamEvent()
    if (status !== 'pending') this.hitlFacts.delete(requestKey)
    return translator.emit(raw.type, raw.payload)
  }

  private async requestInteraction(request: DshInteractionRequest): Promise<unknown> {
    this.pendingInteractions.add(request.requestId)
    try {
      return await this.interactions!.request(request)
    } finally {
      this.pendingInteractions.delete(request.requestId)
    }
  }

  private async answerApproval(request: RpcRequest<Extract<MuxFrame, { type: 'approval/requested' }>>, signal: AbortSignal): Promise<void> {
    const frame = request.payload
    const timeoutValue = { outcome: 'deny', scope: 'once' }
    const response = this.interactions
      ? await this.requestInteraction({
          requestId: String(request.rpcId),
          conversationId: this.businessThreadId,
          kind: 'approval',
          payload: frame as unknown as Record<string, unknown>,
          timeoutMs: 24 * 60 * 60 * 1000,
          timeoutValue,
        })
      : timeoutValue
    if (signal.aborted) return
    const fact = this.hitlFacts.get(String(request.rpcId))
    if (fact) fact.result = record(response)
    const allowed = approvalAllowed(response)
    await this.client.respond({
      type: 'client-response',
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: this.dshSessionId as SessionId,
          approvalId: frame.approvalId,
          outcome: allowed ? 'allowed-once' : 'rejected',
        },
      },
    })
  }

  private async answerQuestion(request: RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>, signal: AbortSignal): Promise<void> {
    const frame = request.payload
    const timeoutValue = { answers: [] }
    const response = this.interactions
      ? await this.requestInteraction({
          requestId: String(request.rpcId),
          conversationId: this.businessThreadId,
          kind: 'question',
          payload: frame as unknown as Record<string, unknown>,
          timeoutMs: 24 * 60 * 60 * 1000,
          timeoutValue,
        })
      : timeoutValue
    if (signal.aborted) return
    const fact = this.hitlFacts.get(String(request.rpcId))
    if (fact) fact.result = record(response)
    await this.client.respond({
      type: 'client-response',
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: this.dshSessionId as SessionId,
          answer: normalizeQuestionAnswer(response, frame.questions),
        },
      },
    })
  }
}

function unwrap<T>(
  response: { result: { ok: true; value: T } | { ok: false; error: { message: string } } },
  method: string,
): T {
  if (response.result.ok) return response.result.value
  throw new Error(`DSH ${method} failed: ${response.result.error.message}`)
}

async function waitForSubscription(
  iterator: AsyncIterator<RpcRequest<MuxFrame>>,
  sessionId: string,
): Promise<void> {
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const next = await nextWithTimeout(iterator, remaining)
    if (next.done) throw new Error('DSH event stream ended during subscription')
    if (
      next.value.payload.type === 'session/subscribed'
      && next.value.payload.sessionId === sessionId
    ) return
  }
  throw new Error('DSH subscription timed out')
}

function nextWithTimeout(
  iterator: AsyncIterator<RpcRequest<MuxFrame>>,
  timeoutMs: number,
): Promise<IteratorResult<RpcRequest<MuxFrame>>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('DSH subscription timed out')),
      timeoutMs,
    )
    iterator.next().then(
      value => {
        clearTimeout(timer)
        resolve(value)
      },
      error => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function approvalPayload(
  request: RpcRequest<Extract<MuxFrame, { type: 'approval/requested' }>>,
): Record<string, unknown> {
  const frame = request.payload
  return {
    batch_id: String(request.rpcId),
    message_id: hitlMessageId('tool_approval', String(request.rpcId)),
    approval_type: 'tool_permission',
    action_requests: [{
      request_id: String(request.rpcId),
      tool_call_id: String(frame.callId ?? frame.approvalId),
      tool_name: frame.toolName,
      tool_input: {},
      decision_reason: {
        type: 'hardline_confirm',
        pattern_name: 'dsh_api_proxy_approval',
        matched_text: frame.toolName,
      },
      user_visible_reason: frame.reason,
      allowed_scopes: ['once'],
      allowed_outcomes: ['allow', 'deny'],
      risk_level: 'review',
    }],
    runtime_mode: 'interactive',
    expires_at: Date.now() + 24 * 60 * 60 * 1000,
    schema_version: 1,
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function approvalAllowed(response: unknown): boolean {
  const value = record(response)
  const decisions = Array.isArray(value.decisions) ? value.decisions : []
  const outcome = value.outcome ?? record(decisions[0]).outcome ?? record(value.response).outcome
  return outcome === 'allow' || outcome === 'allowed-once' || outcome === 'approved'
}

function normalizeQuestionAnswer(
  response: unknown,
  questions: Extract<MuxFrame, { type: 'question/requested' }>['questions'],
): QuestionResponsePayload['answer'] {
  const value = record(response)
  const rawAnswers = value.answers ?? record(value.response).answers
    ?? Object.entries(record(value.field_values ?? record(value.response).field_values)).map(([id, answer]) => {
      const question = questions.find(question => question.id === id)
      const selected = (Array.isArray(answer) ? answer : [answer]).filter((label): label is string =>
        typeof label === 'string' && Boolean(question?.options?.some(option => option.label === label)))
      return { id, selected, ...(selected.length === 0 && typeof answer === 'string' ? { custom: answer } : {}) }
    })
  const answers = Array.isArray(rawAnswers) ? rawAnswers.map(answer => {
    const entry = record(answer)
    return {
      id: entry.id ?? entry.question_id,
      selected: entry.selected ?? (Array.isArray(entry.selected_options)
        ? entry.selected_options.filter(option => option !== '__other__') : []),
      ...((entry.custom ?? entry.free_text) ? { custom: entry.custom ?? entry.free_text } : {}),
    }
  }) : []
  // Validate at the public DSH schema boundary, rather than trusting renderer input.
  const parsed = questionResponsePayloadSchema.safeParse({ sessionId: 'validation', answer: { answers } })
  return parsed.success ? parsed.data.answer : { answers: [] }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function questionPayload(
  requestId: string,
  frame: Extract<MuxFrame, { type: 'question/requested' }>,
) {
  const shared = {
    request_id: requestId,
    interaction_type: 'ask_user', blocking_policy: 'hard', schema_version: 1,
  }
  const isChoice = frame.questions.length <= 4 && frame.questions.every(question =>
    (question.options?.length ?? 0) >= 2 && (question.options?.length ?? 0) <= 5)
  if (isChoice) {
    return AskInteractionRequestSchema.parse({
      ...shared, message_id: hitlMessageId('ask_choice', requestId), tool_name: 'ask_user', intent: 'choose', form_mode: 'questions',
      questions: frame.questions.map(question => ({
        id: question.id,
        prompt: [question.question, question.detail].filter(Boolean).join('\n\n'),
        header: (question.header?.trim() || question.question).slice(0, 12),
        options: (question.options ?? []).map(option => ({
          id: option.label, label: option.label,
          description: option.description?.trim() || option.label,
        })),
        allow_multiple: question.multiSelect ?? false, allow_free_text: true,
      })),
    })
  }
  // DSH also permits plain-text questions and larger batches; use Muse's form
  // contract for those instead of emitting an invalid choice card.
  return AskInteractionRequestSchema.parse({
    ...shared, message_id: hitlMessageId('ask_form', requestId), tool_name: 'ask_form', title: 'DSH', intent: 'collect', form_mode: 'fields',
    fields: frame.questions.map(question => ({
      key: question.id, label: question.question, type: 'text',
      description: [question.detail, ...(question.options ?? []).map(option =>
        option.description ? `${option.label}: ${option.description}` : option.label)].filter(Boolean).join('\n'),
    })),
  })
}


type PromptPart = Parameters<IApiClient['sessions']['prompt']>[0]['content'][number]
async function imagePart(url: string, signal: AbortSignal): Promise<Extract<PromptPart,{ type:'image' }>> {
  const data = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]+)$/.exec(url)
  if (data) return { type: 'image', mediaType: data[1] as 'image/png', data: data[2] }
  const response = await fetch(url,{ signal: AbortSignal.any([signal,AbortSignal.timeout(30000)]) })
  if (!response.ok) throw new Error(`Cannot load image attachment: HTTP ${response.status}`)
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]
  if (!['image/png','image/jpeg','image/webp','image/gif'].includes(mediaType)) throw new Error('Unsupported image attachment media type')
  const bytes = new Uint8Array(await response.arrayBuffer())
  if (bytes.byteLength > 20*1024*1024) throw new Error('DSH image exceeds 20 MiB')
  return { type:'image', mediaType: mediaType as 'image/png', data: Buffer.from(bytes).toString('base64') }
}
async function materializeBlocks(content: Message['content'], signal: AbortSignal): Promise<Message['content']> {
  if (typeof content === 'string') return content
  return Promise.all(content.map(async block => {
    if (block.type === 'image' && block.source.type === 'url') {
      const image = await imagePart(block.source.url,signal)
      return { type:'image' as const, source:{ type:'base64' as const, media_type:image.mediaType, data:image.data } }
    }
    if (block.type === 'tool_result' && Array.isArray(block.content)) return { ...block, content:await materializeBlocks(block.content,signal) }
    return block
  })) as Promise<Message['content']>
}
async function materializeMessages(messages: Message[],signal: AbortSignal): Promise<Message[]> {
  return Promise.all(messages.map(async message => ({ ...message, content:await materializeBlocks(message.content,signal) })))
}
async function prepareInput(params: QueryParams,signal: AbortSignal): Promise<{ history:Message[]; prompt:PromptPart[]; submitted:Message[] }> {
  const messages = params.initialMessages ? await materializeMessages(params.initialMessages,signal) : []
  const latest = messages.at(-1)
  if (messages.length && latest?.role !== 'user') throw new Error('DSH initialMessages must end with the current user directive')
  const prompt: PromptPart[] = []
  const blocks = latest ? latest.content : params.prompt
  if (typeof blocks === 'string') prompt.push({ type:'text',text:blocks })
  else for (const block of blocks) {
    if (block.type === 'text') prompt.push({ type:'text',text:block.text })
    else if (block.type === 'image' && block.source.type === 'base64') prompt.push({type:'image',mediaType:block.source.media_type as 'image/png',data:block.source.data})
    else prompt.push({type:'text',text:JSON.stringify(block)})
  }
  if (!latest) for (const attachment of params.attachments ?? []) {
    if (attachment.type === 'image' && attachment.url) prompt.push(await imagePart(attachment.url,signal))
    else prompt.push({type:'text',text:JSON.stringify({ attachment })})
  }
  return { history:messages.slice(0,-1),prompt,submitted:messages }
}

function messageDigest(message: Message): string {
  const sorted = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(sorted)
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,item])=>[key,sorted(item)]))
    return value
  }
  return createHash('sha256').update(JSON.stringify(sorted([message.role,message.content]))).digest('hex')
}
