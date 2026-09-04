import { randomUUID } from 'node:crypto'
import {
  ContentBlockEvents,
  StreamEvents,
  nextArrivalSeq,
  type StreamEvent,
} from '@muse/agent-runtime'

interface DshSessionEvent {
  type: string
  seq: number
  time: number
  data: Record<string, any>
}

interface MessageState {
  messageId: string
  started: boolean
  startedBlocks: Set<number>
  stoppedBlocks: Set<number>
  finalText: string
  stopReason?: string
  usage?: Record<string, number>
}

/** Translate the pinned DSH SessionEvent vocabulary into TabTin's existing wire. */
export class DshEventTranslator {
  private seq = 0
  private readonly messages = new Map<string, MessageState>()
  private finalText = ''
  private finalUsage?: Record<string, number>

  constructor(
    private readonly threadId: string,
    private readonly runId: string,
  ) {}

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
      case 'step/start':
        return [this.meta(StreamEvents.STEP, {
          step_type: 'dsh',
          title: `DSH step ${event.data.step}`,
          status: 'running',
          step_id: this.keyOf(event.data.turn, event.data.step),
        })]
      case 'step/end':
        return [this.meta(StreamEvents.STEP, {
          step_type: 'dsh',
          title: `DSH step ${event.data.step}`,
          status: 'done',
          step_id: this.keyOf(event.data.turn, event.data.step),
        })]
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

  emit(type: string, payload: Record<string, unknown>): StreamEvent {
    return this.meta(type, payload)
  }

  private translateChunk(event: DshSessionEvent): StreamEvent[] {
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

  private finalizeAssistant(event: DshSessionEvent): StreamEvent[] {
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
      .filter((block: any) => block?.type === 'text')
      .map((block: any) => String(block.text ?? ''))
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
    const persistedBlocks = blocks.flatMap((block: any, index: number) => {
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
    const modelName = String(message?.source?.model ?? 'DeepSeek Harness')
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

  private emitToolResult(event: DshSessionEvent): StreamEvent[] {
    const message = event.data.message ?? {}
    const messageId = String(message.id ?? `dsh-tool-result-${event.seq}`)
    const block = Array.isArray(message.content) ? message.content[0] : undefined
    const content = Array.isArray(block?.content)
      ? block.content.filter((item: any) => item?.type === 'text').map((item: any) => item.text).join('\n')
      : String(block?.content ?? '')
    const state: MessageState = {
      messageId,
      started: false,
      startedBlocks: new Set(),
      stoppedBlocks: new Set(),
      finalText: '',
    }
    return [
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
  }

  private finishTurn(event: DshSessionEvent): StreamEvent[] {
    const reason = event.data.reason ?? { kind: 'completed' }
    const error = reason.kind === 'error' || reason.kind === 'blocked' || reason.kind === 'interrupted'
    const aborted = reason.kind === 'aborted'
    const message = reason.error?.message
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
        metadata: { dsh_turn_end_reason: reason.kind },
      }),
    ]
  }

  private emitCompleteBlock(state: MessageState, index: number, raw: any): StreamEvent[] {
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

  private finishBlock(state: MessageState, index: number, block: any): StreamEvent[] {
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
      model_id: 'dsh',
      model_name: 'DeepSeek Harness',
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
    const seq = this.seq++
    return {
      type,
      payload: {
        protocol_version: 'v2',
        min_compatible_version: 'v2',
        trace_id: this.runId,
        _seq: seq,
        thread_id: this.threadId,
        event_id: `${this.runId}:${seq}:${randomUUID()}`,
        ...payload,
      },
    } as StreamEvent
  }
}

function finishReason(reason: any): string | undefined {
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
