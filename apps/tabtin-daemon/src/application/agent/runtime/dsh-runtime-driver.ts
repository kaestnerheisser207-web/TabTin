import { randomUUID } from 'node:crypto'
import type { IApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import type {
  MuxFrame,
  RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'
import {
  StreamEvents,
  type QueryParams,
  type StreamEvent,
} from '@muse/agent-runtime'
import type {
  HostedRuntime,
  RuntimeDriver,
  RuntimeDriverContext,
  RuntimeDriverSession,
} from '@muse/agent-host/runtime'
import { DshEventTranslator } from './dsh-event-translator.js'

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
}

export class DshRuntimeDriver implements RuntimeDriver<RuntimeDriverContext, DshRuntimeBinding> {
  readonly harness = 'dsh' as const

  constructor(
    private readonly client: IApiClient,
    private readonly interactions?: DshInteractionPort,
  ) {}

  async create(
    context: RuntimeDriverContext,
  ): Promise<RuntimeDriverSession<DshRuntimeBinding>> {
    const response = await this.client.sessions.create({
      sessionId: context.threadId as any,
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
    await Promise.resolve(session.runtime.abort())
  }
}

export class DshHostedRuntime implements HostedRuntime {
  private activeController: AbortController | null = null

  constructor(
    private readonly client: IApiClient,
    private readonly dshSessionId: string,
    private readonly businessThreadId: string,
    private readonly interactions?: DshInteractionPort,
  ) {}

  getRuntimeId(): string {
    return `dsh:${this.dshSessionId}`
  }

  abort(): void {
    this.activeController?.abort(new Error('DSH runtime aborted'))
    void this.client.sessions.cancel({
      sessionId: this.dshSessionId as any,
    }).catch(() => undefined)
  }

  async *query(params: QueryParams): AsyncGenerator<StreamEvent, void, undefined> {
    if (this.activeController) throw new Error('DSH runtime query is already active')
    const controller = new AbortController()
    this.activeController = controller
    const signals = [controller.signal, params.signal].filter(Boolean) as AbortSignal[]
    const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals)
    const runId = randomUUID()
    const translator = new DshEventTranslator(this.businessThreadId, runId)
    const iterator = this.client.events.mux({}, signal)[Symbol.asyncIterator]()
    const cancelDsh = () => {
      void this.client.sessions.cancel({
        sessionId: this.dshSessionId as any,
      }).catch(() => undefined)
    }
    signal.addEventListener('abort', cancelDsh, { once: true })
    try {
      await waitForSubscription(iterator, this.dshSessionId)
      yield translator.emit(StreamEvents.USER, {
        content: params.displayMessage ?? params.prompt,
        client_event_id: params.clientMessageId,
        triggered_by: params.triggeredBy ?? 'user',
        run_id: runId,
        trace_id: runId,
      })
      const accepted = await this.client.sessions.prompt({
        sessionId: this.dshSessionId as any,
        mode: 'queue',
        content: [{ type: 'text', text: params.prompt }],
      }, signal)
      unwrap(accepted, 'session.prompt')

      while (true) {
        const next = await iterator.next()
        if (next.done) throw new Error('DSH event stream ended before turn completion')
        const request = next.value
        const frame = request.payload
        if (frame.type === 'stream/error') {
          throw new Error(`DSH stream error: ${frame.error.message}`)
        }
        if (frame.sessionId !== this.dshSessionId) continue
        if (frame.type === 'approval/requested') {
          const approvalRequest = { ...request, payload: frame }
          yield translator.emit(StreamEvents.APPROVAL_REQUESTED, approvalPayload(approvalRequest))
          await this.answerApproval(approvalRequest)
          continue
        }
        if (frame.type === 'approval/resolved') {
          yield translator.emit(StreamEvents.APPROVAL_RESOLVED, {
            batch_id: String(frame.approvalId),
            decisions: [{
              request_id: String(frame.approvalId),
              tool_call_id: String(frame.approvalId),
              outcome: frame.outcome === 'allowed-once' ? 'allow' : 'deny',
            }],
            schema_version: 1,
          })
          continue
        }
        if (frame.type === 'question/requested') {
          yield translator.emit(StreamEvents.ASK_FORM_REQUIRED, {
            request_id: String(request.rpcId),
            questions: frame.questions,
            expires_at: Date.now() + 24 * 60 * 60 * 1000,
          })
          await this.answerQuestion({ ...request, payload: frame })
          continue
        }
        if (frame.type !== 'session/event') continue
        for (const event of translator.translate(frame.event as any)) yield event
        if (frame.event.type === 'turn/end') return
      }
    } catch (error) {
      if (signal.aborted) {
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
      signal.removeEventListener('abort', cancelDsh)
      this.activeController = null
      await iterator.return?.()
    }
  }

  private async answerApproval(request: RpcRequest<Extract<MuxFrame, { type: 'approval/requested' }>>): Promise<void> {
    const frame = request.payload
    const timeoutValue = { outcome: 'deny', scope: 'once' }
    const response = this.interactions
      ? await this.interactions.request({
          requestId: String(request.rpcId),
          conversationId: this.businessThreadId,
          kind: 'approval',
          payload: frame as unknown as Record<string, unknown>,
          timeoutMs: 24 * 60 * 60 * 1000,
          timeoutValue,
        })
      : timeoutValue
    const allowed = approvalAllowed(response)
    await this.client.respond({
      type: 'client-response',
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: this.dshSessionId,
          approvalId: frame.approvalId,
          outcome: allowed ? 'allowed-once' : 'rejected',
        },
      },
    } as any)
  }

  private async answerQuestion(request: RpcRequest<Extract<MuxFrame, { type: 'question/requested' }>>): Promise<void> {
    const frame = request.payload
    const timeoutValue = { answers: [] }
    const response = this.interactions
      ? await this.interactions.request({
          requestId: String(request.rpcId),
          conversationId: this.businessThreadId,
          kind: 'question',
          payload: frame as unknown as Record<string, unknown>,
          timeoutMs: 24 * 60 * 60 * 1000,
          timeoutValue,
        })
      : timeoutValue
    await this.client.respond({
      type: 'client-response',
      rpcId: request.rpcId,
      result: {
        ok: true,
        value: {
          sessionId: this.dshSessionId,
          answer: normalizeQuestionAnswer(response),
        },
      },
    } as any)
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

function approvalAllowed(response: unknown): boolean {
  const value = response as any
  const outcome = value?.outcome
    ?? value?.decisions?.[0]?.outcome
    ?? value?.response?.outcome
  return outcome === 'allow' || outcome === 'allowed-once' || outcome === 'approved'
}

function normalizeQuestionAnswer(response: unknown): { answers: any[] } {
  const value = response as any
  if (Array.isArray(value?.answers)) return { answers: value.answers }
  if (Array.isArray(value?.response?.answers)) return { answers: value.response.answers }
  return { answers: [] }
}
