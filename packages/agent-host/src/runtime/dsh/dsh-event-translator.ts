import { randomUUID } from 'node:crypto'
import {
  ContentBlockEvents,
  StreamEvents,
  nextArrivalSeq,
  EventEmitter,
  TypedAgentEvent,
  isContentBlockEvent,
  type StreamEvent,
} from '@muse/agent-runtime'

type DshSessionEvent = Extract<import('@deepseek-ai/dsh-host-apiproxy/api').MuxFrame, { type: 'session/event' }>['event']
type EventOf<T extends DshSessionEvent['type']> = Extract<DshSessionEvent, { type: T }>
type DshBlock = EventOf<'assistant/message'>['data']['message']['content'][number]

interface MessageState {
  messageId: string
  started: boolean
  startedBlocks: Set<number>
  stoppedBlocks: Set<number>
  finalText: string
  stopReason?: string
  persistedBlocks?: Record<string, unknown>[]
  persistedArrival?: number
  modelName?: string
  usage?: EventOf<'assistant/message'>['data']['usage']
}

/** Translate the pinned DSH SessionEvent vocabulary into TabTin's existing wire. */
export class DshEventTranslator {
  private readonly emitter: EventEmitter
  private readonly stepStartedAt = new Map<string, number>()
  private readonly messages = new Map<string, MessageState>()
  private readonly toolOwners = new Map<string, MessageState>()
  private finalText = ''
  private finalUsage?: Record<string, number>
  private readonly imageSources = new Map<string, {type:'base64';media_type:string;data:string}>()
  private turnOutcome: Record<string, unknown> = {}

  constructor(
    private readonly threadId: string,
    private readonly runId: string,
    private modelId?: string,
  ) {
    this.emitter = new EventEmitter(undefined, { threadId, runId, traceId: runId })
  }

  translate(event: DshSessionEvent): StreamEvent[] {
    switch (event.type) {
      case 'turn/start':
        return [this.meta(StreamEvents.LIFECYCLE, {
          phase: 'start',
          status: 'running',
          run_id: this.runId,
          trace_id: this.runId,
          turn_id: String(event.data.turn),
          started_at: event.time,
        })]
      case 'step/start': {
        const stepId = this.keyOf(event.data.turn, event.data.step)
        this.stepStartedAt.set(stepId, event.time)
        return [this.meta(StreamEvents.LIFECYCLE, {
          phase: 'turn_start',
          status: 'running',
          turn_id: stepId,
          iteration: event.data.step,
          started_at: event.time,
          source: 'runtime',
        })]
      }
      case 'step/end': {
        const stepId = this.keyOf(event.data.turn, event.data.step)
        const startedAt = this.stepStartedAt.get(stepId)
        this.stepStartedAt.delete(stepId)
        return [this.meta(StreamEvents.LIFECYCLE, {
          phase: 'turn_end',
          status: 'completed',
          turn_id: stepId,
          iteration: event.data.step,
          ended_at: event.time,
          ...(startedAt !== undefined ? { duration_ms: Math.max(0, event.time - startedAt) } : {}),
          source: 'runtime',
        })]
      }
      case 'assistant/chunk':
        return this.translateChunk(event)
      case 'assistant/message':
        return this.finalizeAssistant(event)
      case 'tool/result':
        return this.emitToolResult(event)
      case 'todo/write':
        return [this.meta(StreamEvents.TODO, { todos: event.data.todos ?? [] })]
      case 'turn/end':
        return this.finishTurn(event)
      default:
        return []
    }
  }

  setModelId(modelId: string):void { this.modelId = modelId }

  setImageSource(id:string,mediaType:string,data:string):void { this.imageSources.set(id,{type:'base64',media_type:mediaType,data}) }

  setTurnOutcome(outcome: Record<string, unknown>): void { this.turnOutcome = outcome }

  emit(type: string, payload: Record<string, unknown>): StreamEvent {
    return this.meta(type, payload)
  }

  private translateChunk(event: EventOf<'assistant/chunk'>): StreamEvent[] {
    const { turn, step, chunk } = event.data
    const state = this.stateOf(turn, step)
    switch (chunk?.type) {
      case 'block-start': {
        if (chunk.blockType === 'tool-call' || chunk.blockType === 'image') return []
        const block = chunk.blockType === 'reasoning'
          ? { type: 'thinking', thinking: '', signature: '' }
          : { type: 'text', text: '' }
        return [
          ...this.ensureMessageStart(state),
          this.blockStart(state, chunk.index, block),
        ]
      }
      case 'text-delta':
        return [
          ...this.ensureTextBlock(state, chunk.index),
          this.blockDelta(state, chunk.index, { type: 'text_delta', text: chunk.text ?? '' }),
        ]
      case 'reasoning-delta':
        return [
          ...this.ensureThinkingBlock(state, chunk.index),
          this.blockDelta(state, chunk.index, { type: 'thinking_delta', thinking: chunk.text ?? '' }),
        ]
      case 'block-end':
        return this.finishBlock(state, chunk.index, chunk.block)
      case 'usage':
        state.usage = chunk.usage
        return []
      case 'finish':
        state.stopReason = finishReason(chunk.reason)
        return []
      default:
        return []
    }
  }

  private finalizeAssistant(event: EventOf<'assistant/message'>): StreamEvent[] {
    const { turn, step, message, usage, interrupted } = event.data
    const state = this.stateOf(turn, step)
    const events = this.ensureMessageStart(state)
    const blocks = Array.isArray(message?.content) ? message.content : []
    for (let index = 0; index < blocks.length; index++) {
      if (!state.startedBlocks.has(index)) {
        events.push(...this.emitCompleteBlock(state, index, blocks[index]))
      } else if (!state.stoppedBlocks.has(index)) {
        events.push(this.blockStop(state, index))
      }
    }
    state.finalText = blocks
      .filter((block) => block?.type === 'text')
      .map((block) => String(block.text ?? ''))
      .join('')
    if (state.finalText) this.finalText = state.finalText
    const finalUsage = usage ?? state.usage
    if (finalUsage) {
      const previous = this.finalUsage
      const inputTokens = Number(finalUsage.inputTokens ?? 0)
      const outputTokens = Number(finalUsage.outputTokens ?? 0)
      const cacheReadTokens = Number(finalUsage.cacheReadTokens ?? 0)
      const cacheWriteTokens = Number(finalUsage.cacheWriteTokens ?? 0)
      const reasoningTokens = Number(finalUsage.reasoningTokens ?? 0)
      this.finalUsage = {
        input_tokens: Number(previous?.input_tokens ?? 0) + inputTokens,
        output_tokens: Number(previous?.output_tokens ?? 0) + outputTokens,
        cache_read_input_tokens: Number(previous?.cache_read_input_tokens ?? 0) + cacheReadTokens,
        cache_creation_input_tokens: Number(previous?.cache_creation_input_tokens ?? 0) + cacheWriteTokens,
        reasoning_tokens: Number(previous?.reasoning_tokens ?? 0) + reasoningTokens,
        last_input_tokens: inputTokens,
        last_cache_read_input_tokens: cacheReadTokens,
        last_cache_creation_input_tokens: cacheWriteTokens,
      }
      events.push(this.meta(ContentBlockEvents.MESSAGE_DELTA, {
        message_id: state.messageId,
        delta: { stop_reason: interrupted ? 'aborted' : state.stopReason },
        usage: {
          input_tokens: Number(finalUsage.inputTokens ?? 0),
          output_tokens: Number(finalUsage.outputTokens ?? 0),
          cache_read_input_tokens: Number(finalUsage.cacheReadTokens ?? 0),
          cache_creation_input_tokens: Number(finalUsage.cacheWriteTokens ?? 0),
        },
      }))
    }
    events.push(this.meta(ContentBlockEvents.MESSAGE_STOP, {
      message_id: state.messageId,
      ...(interrupted ? {
        error_info: {
          error_class: 'ABORT',
          category: 'aborted',
          partial_reason: 'aborted',
        },
      } : {}),
    }))
    const arrivalSeq = nextArrivalSeq()
    const persistedBlocks = blocks.flatMap<Record<string, unknown>>((block, index: number) => {
      const blockArrivalSeq = arrivalSeq + index
      if (block?.type === 'text') {
        return [{ type: 'text', text: String(block.text ?? ''), arrival_seq: blockArrivalSeq }]
      }
      if (block?.type === 'reasoning') {
        return [{
          type: 'thinking',
          thinking: String(block.text ?? ''),
          signature: '',
          arrival_seq: blockArrivalSeq,
        }]
      }
      if (block?.type === 'tool-call') {
        const parsed = parseToolArguments(String(block.arguments ?? ''))
        return [{
          type: 'tool_use',
          id: String(block.id ?? `dsh-call-${index}`),
          name: String(block.name ?? 'unknown'),
          input: parsed.input,
          ...(parsed.error ? { input_parse_error: parsed.error } : {}),
          arrival_seq: blockArrivalSeq,
        }]
      }
      return []
    })
    const modelName = this.modelId ?? String(message?.source?.model ?? 'DeepSeek Harness')
    state.persistedBlocks = persistedBlocks
    state.persistedArrival = arrivalSeq
    state.modelName = modelName
    for (const block of blocks) if (block.type === 'tool-call') this.toolOwners.set(String(block.id), state)
    events.push(this.meta(StreamEvents.PERSIST_MESSAGE, {
      message_id: state.messageId,
      client_event_id: state.messageId,
      role: 'assistant',
      blocks_json: persistedBlocks,
      agent_run_id: this.runId,
      arrival_seq: arrivalSeq,
      message_kind: 'llm',
      stop_reason: interrupted ? 'aborted' : state.stopReason ?? 'end_turn',
      model_id: modelName,
      model_name: modelName,
      ...(interrupted ? {
        partial: true,
        error_info_json: {
          error_class: 'ABORT',
          category: 'aborted',
          partial_reason: 'aborted',
        },
      } : {}),
    }))
    return events
  }

  private emitToolResult(event: EventOf<'tool/result'>): StreamEvent[] {
    const message = event.data.message ?? {}
    const messageId = String(message.id ?? `dsh-tool-result-${event.seq}`)
    const block = Array.isArray(message.content) ? message.content[0] : undefined
    const content = Array.isArray(block?.content)
      ? block.content.some(item=>item.type==='image')
        ? block.content.map(item=>{
            if(item.type==='text') return {type:'text',text:item.text}
            if(item.type==='image') {
              const source=this.imageSources.get(String(item.attachment.attachmentId))
              if(!source) throw new Error('DSH tool image was not materialized for canonical persistence')
              return {type:'image',source}
            }
            throw new Error(`Unsupported DSH tool result block: ${item.type}`)
          })
        : block.content.filter(item=>item.type==='text').map(item=>item.text).join('\n')
      : String(block?.content ?? '')
    const state: MessageState = {
      messageId,
      started: false,
      startedBlocks: new Set(),
      stoppedBlocks: new Set(),
      finalText: '',
    }
    const events = [
      ...this.ensureMessageStart(state, 'user'),
      this.blockStart(state, 0, {
        type: 'tool_result',
        tool_use_id: String(block?.toolCallId ?? event.data.message?.source?.callId ?? ''),
        content,
        ...(block?.isError || event.data.error ? { is_error: true } : {}),
      }),
      this.blockStop(state, 0),
      this.meta(ContentBlockEvents.MESSAGE_STOP, { message_id: messageId }),
    ]
    const callId = String(block?.toolCallId ?? event.data.message?.source?.callId ?? '')
    const owner = this.toolOwners.get(callId)
    if (owner?.persistedBlocks) {
      owner.persistedBlocks.push({ type:'tool_result', tool_use_id:callId, content,
        ...(block?.isError || event.data.error ? { is_error:true } : {}), arrival_seq:nextArrivalSeq() })
      events.push(this.meta(StreamEvents.PERSIST_MESSAGE,{
        message_id:owner.messageId,client_event_id:owner.messageId,role:'assistant',
        blocks_json:[...owner.persistedBlocks],agent_run_id:this.runId,arrival_seq:owner.persistedArrival,
        message_kind:'llm',stop_reason:owner.stopReason??'tool_use',model_id:owner.modelName,model_name:owner.modelName,
      }))
      this.toolOwners.delete(callId)
    }
    return events
  }

  private finishTurn(event: EventOf<'turn/end'>): StreamEvent[] {
    const reason = event.data.reason ?? { kind: 'completed' }
    const error = reason.kind === 'error' || reason.kind === 'blocked' || reason.kind === 'interrupted'
    const aborted = reason.kind === 'aborted'
    const message = ('error' in reason ? reason.error?.message : undefined)
      ?? (aborted ? 'DSH run aborted' : error ? `DSH run ended: ${reason.kind}` : undefined)
    return [
      this.meta(StreamEvents.LIFECYCLE, {
        phase: error ? 'error' : 'end',
        status: aborted ? 'aborted' : error ? 'error' : 'completed',
        run_id: this.runId,
        trace_id: this.runId,
        turn_id: String(event.data.turn),
        ended_at: event.time,
        ...(message ? { error_message: message } : {}),
      }),
      this.meta(StreamEvents.DONE, {
        content: this.finalText,
        error,
        ...(this.finalUsage ? { usage: this.finalUsage } : {}),
        ...(message ? { error_message: message } : {}),
        ...(aborted ? { error_class: 'ABORT' } : error ? { error_class: 'INTERNAL' } : {}),
        trace_id: this.runId,
        agent_type: 'dsh',
        metadata: { dsh_turn_end_reason: reason.kind, ...(this.turnOutcome.suspendRun ? { run_state: 'awaiting_subagents', suspension_reason: (this.turnOutcome.suspendRun as { reason?:string }).reason, pending_subagent_ids: (this.turnOutcome.suspendRun as { pendingSubagentIds?:string[] }).pendingSubagentIds ?? [] } : {}), ...(this.turnOutcome.endConversation ? { termination_reason: (this.turnOutcome.endConversation as { reason?:string }).reason } : {}) },
      }),
    ]
  }

  private emitCompleteBlock(state: MessageState, index: number, raw: DshBlock): StreamEvent[] {
    if (raw?.type === 'text') {
      return [
        ...this.ensureTextBlock(state, index),
        this.blockDelta(state, index, { type: 'text_delta', text: String(raw.text ?? '') }),
        this.blockStop(state, index),
      ]
    }
    if (raw?.type === 'reasoning') {
      return [
        ...this.ensureThinkingBlock(state, index),
        this.blockDelta(state, index, { type: 'thinking_delta', thinking: String(raw.text ?? '') }),
        this.blockStop(state, index),
      ]
    }
    if (raw?.type === 'tool-call') {
      const parsed = parseToolArguments(String(raw.arguments ?? ''))
      return [
        ...this.ensureMessageStart(state),
        this.blockStart(state, index, {
          type: 'tool_use',
          id: String(raw.id ?? `dsh-call-${index}`),
          name: String(raw.name ?? 'unknown'),
          input: parsed.input,
          ...(parsed.error ? { input_parse_error: parsed.error } : {}),
        }),
        this.blockStop(state, index),
      ]
    }
    return []
  }

  private finishBlock(state: MessageState, index: number, block: DshBlock): StreamEvent[] {
    if (!state.startedBlocks.has(index)) return this.emitCompleteBlock(state, index, block)
    if (state.stoppedBlocks.has(index)) return []
    return [this.blockStop(state, index)]
  }

  private ensureMessageStart(state: MessageState, role: 'assistant' | 'user' = 'assistant'): StreamEvent[] {
    if (state.started) return []
    state.started = true
    return [this.meta(ContentBlockEvents.MESSAGE_START, {
      message_id: state.messageId,
      role,
      model_id: this.modelId ?? 'dsh',
      model_name: this.modelId ?? 'DeepSeek Harness',
      started_at: new Date().toISOString(),
      run_id: this.runId,
      message_kind: 'llm',
    })]
  }

  private ensureTextBlock(state: MessageState, index: number): StreamEvent[] {
    if (state.startedBlocks.has(index)) return []
    return [
      ...this.ensureMessageStart(state),
      this.blockStart(state, index, { type: 'text', text: '' }),
    ]
  }

  private ensureThinkingBlock(state: MessageState, index: number): StreamEvent[] {
    if (state.startedBlocks.has(index)) return []
    return [
      ...this.ensureMessageStart(state),
      this.blockStart(state, index, { type: 'thinking', thinking: '', signature: '' }),
    ]
  }

  private blockStart(state: MessageState, index: number, block: Record<string, unknown>): StreamEvent {
    state.startedBlocks.add(index)
    return this.meta(ContentBlockEvents.CONTENT_BLOCK_START, {
      message_id: state.messageId,
      index,
      block_id: `${state.messageId}:${index}`,
      block,
    })
  }

  private blockDelta(state: MessageState, index: number, delta: Record<string, unknown>): StreamEvent {
    return this.meta(ContentBlockEvents.CONTENT_BLOCK_DELTA, {
      message_id: state.messageId,
      index,
      delta,
    })
  }

  private blockStop(state: MessageState, index: number): StreamEvent {
    state.stoppedBlocks.add(index)
    return this.meta(ContentBlockEvents.CONTENT_BLOCK_STOP, {
      message_id: state.messageId,
      index,
    })
  }

  private stateOf(turn: number, step: number): MessageState {
    const key = this.keyOf(turn, step)
    let state = this.messages.get(key)
    if (!state) {
      state = {
        messageId: randomUUID(),
        started: false,
        startedBlocks: new Set(),
        stoppedBlocks: new Set(),
        finalText: '',
      }
      this.messages.set(key, state)
    }
    return state
  }

  private keyOf(turn: number, step: number): string {
    return `${turn}:${step}`
  }

  private meta(type: string, payload: Record<string, unknown>): StreamEvent {
    return this.emitter.build(new TypedAgentEvent(
      type,
      payload,
      undefined,
      isContentBlockEvent(type),
    ))
  }
}

function finishReason(reason: Extract<EventOf<'assistant/chunk'>['data']['chunk'], { type: 'finish' }>['reason']): string | undefined {
  switch (reason?.kind) {
    case 'stop': return 'end_turn'
    case 'tool-calls': return 'tool_use'
    case 'max-tokens': return 'max_tokens'
    case 'aborted': return 'aborted'
    case 'error': return 'error'
    default: return undefined
  }
}

function parseToolArguments(raw: string): {
  input: Record<string, unknown>
  error?: { message: string; partial: string }
} {
  try {
    const parsed = JSON.parse(raw || '{}')
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return { input: parsed }
    throw new Error('tool arguments must be a JSON object')
  } catch (error) {
    return {
      input: {},
      error: {
        message: error instanceof Error ? error.message : String(error),
        partial: raw,
      },
    }
  }
}
