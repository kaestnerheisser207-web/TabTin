import { randomUUID } from 'node:crypto'
import type {
  ContentBlock,
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
  Message,
  ToolParam,
} from '@muse/agent-runtime'

export interface ProviderChatContext {
  requestSource?: string
  logicalBillingKey?: string
}

type ToolState = { index: number; name: string; arguments: string; complete: boolean }

/** OpenAI chat transport over an existing provider, with no AgentRuntime or second tool loop. */
export async function* streamProviderChat(
  provider: LLMProvider,
  body: Record<string, unknown>,
  signal: AbortSignal,
  context: ProviderChatContext = {},
): AsyncGenerator<string> {
  const id = `chatcmpl-muse-${randomUUID()}`
  const created = Math.floor(Date.now() / 1000)
  const model = typeof body.model === 'string' ? body.model : ''
  const tools = new Map<string, ToolState>()
  let stopped = false
  let iterator: AsyncIterator<LLMResponseChunk> | undefined
  const envelope = (choices: unknown[], extra: Record<string, unknown> = {}) => sse({
    id, object: 'chat.completion.chunk', created, model, choices, ...extra,
  })
  const delta = (value: Record<string, unknown>, finishReason: string | null = null) => envelope([
    { index: 0, delta: value, finish_reason: finishReason },
  ])
  const toolDelta = (toolId: string, name: string, argumentsDelta: string) => {
    let state = tools.get(toolId)
    const first = !state
    if (!state) {
      state = { index: tools.size, name, arguments: '', complete: false }
      tools.set(toolId, state)
    }
    if (state.complete) throw new Error('Provider emitted arguments after completing a tool call')
    if (name && state.name && name !== state.name) throw new Error('Provider changed a streaming tool name')
    const announceName = Boolean(name && !state.name)
    if (name) state.name = name
    state.arguments += argumentsDelta
    return delta({ tool_calls: [{
      index: state.index,
      ...(first ? { id: toolId, type: 'function' } : {}),
      function: {
        ...(first || announceName ? { name: state.name } : {}),
        arguments: argumentsDelta,
      },
    }] })
  }
  try {
    signal.throwIfAborted()
    const request = buildRequest(body, signal, context)
    yield delta({ role: 'assistant' })
    signal.throwIfAborted()
    iterator = provider.createStream(request)[Symbol.asyncIterator]()
    while (true) {
      const next = await withCancellation(iterator.next(), signal)
      if (next.done) break
      signal.throwIfAborted()
      const chunk = next.value
      switch (chunk.type) {
        case 'text_delta':
          if (chunk.text) yield delta({ content: chunk.text })
          break
        case 'thinking':
          if (chunk.text) yield delta({ reasoning_content: chunk.text })
          break
        case 'tool_use_delta': {
          const tool = chunk.toolUseDelta
          if (!tool?.id) throw new Error('Provider tool delta has no call id')
          yield toolDelta(tool.id, tool.name, tool.argDelta)
          break
        }
        case 'tool_use': {
          const tool = chunk.toolUse
          if (!tool?.id || !tool.name) throw new Error('Provider tool call has no identity')
          const input = typeof tool.input === 'string' ? parseArguments(tool.input) : tool.input
          const completeArguments = JSON.stringify(input ?? {})
          const existing = tools.get(tool.id)
          if (existing?.name && existing.name !== tool.name) throw new Error('Provider changed a streaming tool name')
          if (existing?.complete) {
            if (existing.name !== tool.name || canonical(parseArguments(existing.arguments)) !== canonical(input)) {
              throw new Error('Provider emitted conflicting duplicate tool calls')
            }
            break
          }
          if (!existing) yield toolDelta(tool.id, tool.name, completeArguments)
          else {
            let alreadyComplete = false
            try { alreadyComplete = canonical(parseArguments(existing.arguments)) === canonical(input) } catch { /* incomplete delta prefix */ }
            if (!alreadyComplete) {
              if (!completeArguments.startsWith(existing.arguments)) throw new Error('Provider changed already streamed tool arguments')
              yield toolDelta(tool.id, tool.name, completeArguments.slice(existing.arguments.length))
            } else if (!existing.name) yield toolDelta(tool.id, tool.name, '')
          }
          tools.get(tool.id)!.complete = true
          break
        }
        case 'usage':
          if (chunk.usage) {
            yield envelope([], { usage: usageToChat(chunk.usage) })
            if (chunk.usage.cost_usd !== undefined || chunk.usage.charge_status !== undefined) {
              yield `event: tabtin.billing\ndata: ${JSON.stringify({ credits_charged: chunk.usage.cost_usd ?? 0, charge_status: chunk.usage.charge_status ?? 'charged' })}\n\n`
            }
          }
          break
        case 'stop': {
          if (stopped) throw new Error('Provider emitted more than one stop event')
          for (const state of tools.values()) {
            if (!state.name || !state.complete) throw new Error('Provider stopped before completing a tool call')
          }
          stopped = true
          yield delta({}, chunk.stopReason === 'max_tokens' ? 'length'
            : chunk.stopReason === 'tool_use' || tools.size > 0 ? 'tool_calls' : 'stop')
          break
        }
        // Provider diagnostics have their own host channel, not chat-completion content.
        case 'cache_stats': case 'capability_event': case 'timing': break
      }
    }
    signal.throwIfAborted()
    if (!stopped) throw new Error('Provider stream ended without a stop event')
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    const record = error && typeof error === 'object' ? error as Record<string, unknown> : {}
    yield sse({ error: {
      message: error instanceof Error ? error.message : String(error),
      type: error instanceof TypeError ? 'invalid_request_error' : 'provider_error',
      code: typeof record.code === 'string' ? record.code : 'provider_stream_error',
    } })
  } finally {
    const closing = iterator?.return?.()
    if (closing) {
      if (signal.aborted) void closing.catch(() => undefined)
      else await withCancellation(closing, signal)
    }
  }
  yield 'data: [DONE]\n\n'
}

function buildRequest(body: Record<string, unknown>, signal: AbortSignal, context: ProviderChatContext): LLMRequest {
  if (typeof body.model !== 'string' || !body.model.trim()) throw new TypeError('Chat request model is required')
  if (!Array.isArray(body.messages)) throw new TypeError('Chat request messages must be an array')
  const system: string[] = []
  const messages: Message[] = []
  for (const value of body.messages) {
    const message = object(value, 'message')
    if (message.role === 'system' || message.role === 'developer') {
      const blocks = contentBlocks(message.content)
      if (blocks.some(block => block.type !== 'text')) throw new TypeError('System/developer messages must contain text')
      system.push(blocks.map(block => block.type === 'text' ? block.text : '').join(''))
      continue
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) throw new TypeError('Tool result must identify its tool_call_id')
      const content = contentBlocks(message.content)
      // Responses function_call_output is textual. Preserve tool images as the
      // adjacent user image input, matching DSH's chat serialization convention.
      const images = content.filter(block => block.type === 'image')
      const text = content.filter(block => block.type !== 'image')
      messages.push({ role: 'user', content: [{
        type: 'tool_result', tool_use_id: message.tool_call_id,
        content: text,
      }, ...images] })
      continue
    }
    if (message.role !== 'user' && message.role !== 'assistant') throw new TypeError(`Unsupported chat role: ${String(message.role)}`)
    const blocks = contentBlocks(message.content)
    if (message.role === 'assistant') {
      if (blocks.some(block => block.type === 'image')) throw new TypeError('Assistant image history is unsupported by the provider chat bridge')
      if (typeof message.reasoning_content === 'string' && message.reasoning_content) {
        blocks.unshift({ type: 'thinking', thinking: message.reasoning_content })
      }
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls)) throw new TypeError('tool_calls must be an array')
        for (const rawCall of message.tool_calls) {
          const call = object(rawCall, 'tool call')
          const fn = object(call.function, 'tool function')
          if (call.type !== 'function' || typeof call.id !== 'string' || !call.id || typeof fn.name !== 'string' || !fn.name) throw new TypeError('Invalid function call identity')
          blocks.push({ type: 'tool_use', id: call.id, name: fn.name, input: parseArguments(fn.arguments) })
        }
      }
    }
    messages.push({ role: message.role, content: blocks })
  }
  const tools: ToolParam[] | undefined = body.tools === undefined ? undefined : array(body.tools, 'tools').map(value => {
    const tool = object(value, 'tool')
    const fn = object(tool.function, 'tool function')
    if (tool.type !== 'function' || typeof fn.name !== 'string' || !fn.name) throw new TypeError('Only named function tools are supported')
    return { name: fn.name, description: typeof fn.description === 'string' ? fn.description : '', input_schema: object(fn.parameters ?? { type: 'object', properties: {} }, 'tool parameters') }
  })
  const maxTokens = body.max_completion_tokens ?? body.max_tokens
  if (typeof maxTokens !== 'number' || !Number.isSafeInteger(maxTokens) || maxTokens <= 0) throw new TypeError('Chat request requires a positive max_tokens or max_completion_tokens')
  const toolChoice = parseToolChoice(body.tool_choice)
  return {
    model: body.model, messages, maxTokens, signal,
    ...(system.length ? { system: system.join('\n\n') } : {}),
    ...(tools ? { tools } : {}), ...(toolChoice ? { toolChoice } : {}),
    ...(typeof body.temperature === 'number' ? { temperature: body.temperature } : {}),
    ...(context.requestSource ? { requestSource: context.requestSource } : {}),
    ...(context.logicalBillingKey ? { billingIdempotencyKey: context.logicalBillingKey } : {}),
  }
}

function contentBlocks(value: unknown): ContentBlock[] {
  if (value === null || value === undefined) return []
  if (typeof value === 'string') return [{ type: 'text', text: value }]
  return array(value, 'message content').map(raw => {
    const part = object(raw, 'content part')
    if (part.type === 'text' || part.type === 'input_text' || part.type === 'output_text') {
      if (typeof part.text !== 'string') throw new TypeError('Text part requires text')
      return { type: 'text', text: part.text }
    }
    if (part.type === 'image_url' || part.type === 'input_image') {
      const source = typeof part.image_url === 'string' ? { url: part.image_url, detail: part.detail } : object(part.image_url, 'image_url')
      if (typeof source.url !== 'string' || !source.url) throw new TypeError('Image URL is required')
      const detail = source.detail
      if (detail !== undefined && !['low', 'high', 'auto'].includes(String(detail))) throw new TypeError('Invalid image detail')
      return { type: 'image', source: { type: 'url', url: source.url }, ...(detail ? { detail: detail as 'low' | 'high' | 'auto' } : {}) }
    }
    throw new TypeError(`Unsupported chat content type: ${String(part.type)}`)
  })
}
function parseToolChoice(value: unknown): LLMRequest['toolChoice'] {
  if (value === undefined) return undefined
  if (value === 'auto' || value === 'required' || value === 'none') return value
  const choice = object(value, 'tool_choice')
  const fn = object(choice.function, 'tool_choice.function')
  if (choice.type !== 'function' || typeof fn.name !== 'string' || !fn.name) throw new TypeError('Invalid tool_choice')
  return { type: 'function', function: { name: fn.name } }
}
function usageToChat(usage: NonNullable<LLMResponseChunk['usage']>): Record<string, unknown> {
  // Muse UsageReport uses uncached-input accounting; OpenAI prompt_tokens includes the cache subset.
  const prompt = (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
  const completion = usage.output_tokens ?? 0
  return {
    prompt_tokens: prompt, completion_tokens: completion, total_tokens: usage.total_tokens ?? prompt + completion,
    ...((usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined) ? { prompt_tokens_details: {
      ...(usage.cache_read_input_tokens !== undefined ? { cached_tokens: usage.cache_read_input_tokens } : {}),
      ...(usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: usage.cache_creation_input_tokens } : {}),
    } } : {}),
    ...(usage.reasoning_tokens !== undefined ? { completion_tokens_details: { reasoning_tokens: usage.reasoning_tokens } } : {}),
  }
}
function parseArguments(value: unknown): unknown {
  if (typeof value !== 'string') throw new TypeError('Function arguments must be a JSON string')
  try { return JSON.parse(value || '{}') } catch { throw new TypeError('Function arguments are not valid JSON') }
}
function canonical(value: unknown): string {
  const normalize = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(normalize)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, normalize(value)]))
    return item
  }
  return JSON.stringify(normalize(value))
}
function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`${name} must be an object`)
  return value as Record<string, unknown>
}
function array(value: unknown, name: string): unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`)
  return value
}
function sse(value: unknown): string { return `data: ${JSON.stringify(value)}\n\n` }

/** Provider setup may await shared auth/image work that cannot itself be cancelled. */
function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(signal.reason) }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
