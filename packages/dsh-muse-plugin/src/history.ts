import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock, Message, ToolResultBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-attachment'

export interface HistoryMessage { role: string; content: unknown; id?: string; tool_call_id?: string }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid history block')
  return value as Record<string, unknown>
}
export async function historySeed(ctx: Context, history: HistoryMessage[]): Promise<SessionEvent[]> {
  const events: SessionEvent[] = []
  let turn = 1
  let step = 0
  let turnOpen = false
  let stepOpen = false
  const pendingCalls = new Set<string>()
  const append = (event: { [T in SessionEvent['type']]: Omit<Extract<SessionEvent, { type: T }>, 'seq' | 'time'> }[SessionEvent['type']]) => {
    events.push({ ...event, seq: events.length, time: Date.now() } as SessionEvent)
  }
  const closeStep = () => {
    if (!stepOpen) return
    if (pendingCalls.size) throw new Error('Cannot seed history with unresolved tool calls')
    append({ type: 'step/end', data: { turn, step } }); stepOpen = false; step++
  }
  const closeTurn = () => {
    if (!turnOpen) return
    closeStep(); append({ type: 'turn/end', data: { turn, reason: { kind: 'completed' } } }); turnOpen = false; turn++
  }
  for (let index = 0; index < history.length; index++) {
    const input = history[index]
    if (input.role === 'system') continue // Muse assembles its current authoritative system prompt separately.
    if (!['user', 'assistant', 'tool'].includes(input.role)) throw new Error(`Unsupported history role: ${input.role}`)
    const content = await historyBlocks(ctx, input.content)
    const id = (input.id ?? createHash('sha256').update(JSON.stringify([index,input])).digest('hex')) as Message['id']
    const results = content.filter((block): block is ToolResultBlock => block.type === 'tool-result')
    if (input.role === 'tool' && results.length === 0) {
      if (!input.tool_call_id) throw new Error('Tool history message has no call id')
      results.push({ type: 'tool-result', toolCallId: input.tool_call_id as ToolResultBlock['toolCallId'], content })
    }
    const appendResults = () => {
      if (!results.length) return
      if (!stepOpen) throw new Error('Tool history result has no open assistant step')
      for (const block of results) {
        if (!pendingCalls.delete(String(block.toolCallId))) throw new Error('Tool history result has no matching call')
        append({ type: 'tool/result', surfaceOp: 'append', data: { turn, step, message: {
          id: `${id}:${block.toolCallId}` as Message['id'], role: 'user', source: { kind: 'tool', callId: block.toolCallId }, content: [block],
        } } })
      }
    }
    if (results.length && input.role !== 'assistant') {
      appendResults()
      if (content.some(block => block.type !== 'tool-result') && input.role !== 'tool') throw new Error('Mixed user tool results and ordinary content require a normalized host transcript')
      continue
    }
    if (input.role === 'user') {
      if (stepOpen) closeTurn()
      if (!turnOpen) { append({ type: 'turn/start', data: { turn } }); turnOpen = true; step = 0 }
      append({ type: 'user/message', surfaceOp: 'append', data: { id, role: 'user', source: { kind: 'user' }, content } })
    } else {
      if (!turnOpen) { append({ type: 'turn/start', data: { turn } }); turnOpen = true; step = 0 }
      closeStep(); append({ type: 'step/start', data: { turn, step } }); stepOpen = true
      append({ type: 'assistant/message', surfaceOp: 'append', data: { turn, step, message: {
        id, role: 'assistant', source: { kind: 'model', provider: 'muse-history', model: 'muse-history' }, content: content.filter(block => block.type !== 'tool-result'),
      } } })
      for (const block of content) if (block.type === 'tool-call') {
        pendingCalls.add(String(block.id))
        append({ type: 'tool/call', data: { turn, step, callId: block.id, name: block.name, arguments: block.arguments } })
      }
      appendResults()
    }
  }
  closeTurn()
  return events
}

export async function historyBlocks(ctx: Context, raw: unknown, signal?: AbortSignal): Promise<ContentBlock[]> {
  if (typeof raw === 'string') return [{ type: 'text', text: raw }]
  if (!Array.isArray(raw)) throw new Error('Unsupported history message content')
  const result: ContentBlock[] = []
  for (const item of raw) {
    const block = object(item)
    if (block.type === 'text') result.push({ type: 'text', text: String(block.text ?? '') })
    else if (block.type === 'thinking' || block.type === 'reasoning') result.push({ type: 'reasoning', text: String(block.thinking ?? block.text ?? '') })
    else if (block.type === 'tool_use') result.push({ type: 'tool-call', id: String(block.id) as ToolResultBlock['toolCallId'], name: String(block.name), arguments: JSON.stringify(block.input ?? {}) })
    else if (block.type === 'tool_result') result.push({ type: 'tool-result', toolCallId: String(block.tool_use_id) as ToolResultBlock['toolCallId'], content: await historyBlocks(ctx, block.content, signal), ...(block.is_error ? { isError: true } : {}) })
    else if (block.type === 'image') {
      const source = object(block.source ?? {})
      let data: Uint8Array
      let mediaType: unknown = source.media_type
      if (source.type === 'base64' && typeof source.data === 'string') data = Buffer.from(source.data,'base64')
      else if (source.type === 'url' && typeof source.url === 'string') {
        const url = new URL(source.url)
        if (!['http:','https:','data:'].includes(url.protocol)) throw new Error('Host must materialize local image files before returning them to DSH')
        const response = await fetch(url,{ signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000) })
        if (!response.ok) throw new Error(`Cannot materialize Muse tool image: HTTP ${response.status}`)
        mediaType = response.headers.get('content-type')?.split(';')[0]
        data = new Uint8Array(await response.arrayBuffer())
      } else throw new Error('Unsupported Muse image source')
      if (data.byteLength>20*1024*1024) throw new Error('Muse tool image exceeds DSH 20 MiB bound')
      if (!['image/png','image/jpeg','image/webp','image/gif'].includes(String(mediaType))) throw new Error('Unsupported history image media type')
      const attachment = await ctx.attachments.saveImage({ data, mediaType: mediaType as 'image/png' })
      result.push({ type: 'image', attachment })
    } else if (block.type === 'file') {
      result.push({ type: 'text', text: JSON.stringify({ file: block }) })
    } else throw new Error(`Unsupported history content block: ${String(block.type)}`)
  }
  return result
}
