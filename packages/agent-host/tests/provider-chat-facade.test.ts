import { afterEach, describe, expect, it, vi } from 'vitest'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { LocalCodexResponsesProvider, type LLMProvider, type LLMRequest } from '@muse/agent-runtime'
import { streamProviderChat } from '../src/runtime/dsh/provider-chat-facade.js'

const servers: Server[] = []
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
  }
})
const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
function frames(response: ServerResponse, events: unknown[], end = true) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
  if (end) response.end('data: [DONE]\n\n')
}
async function serve(handler: (request: IncomingMessage, response: ServerResponse, body: Record<string, unknown>) => Promise<void> | void): Promise<string> {
  const server = createServer(async (request, response) => {
    try {
      const chunks: Buffer[] = []
      for await (const chunk of request) chunks.push(Buffer.from(chunk))
      await handler(request, response, JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>)
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: String(error) } }))
    }
  })
  servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No fixture port')
  return `http://127.0.0.1:${address.port}/backend-api`
}
function parse(raw: string) {
  return raw.split('\n\n').filter(frame => frame.startsWith('data: ') && frame !== 'data: [DONE]')
    .map(frame => JSON.parse(frame.slice(6)) as Record<string, unknown>)
}
async function collect(provider: LLMProvider, body: Record<string, unknown>, signal = new AbortController().signal) {
  let raw = ''
  for await (const frame of streamProviderChat(provider, body, signal, { requestSource: 'dsh', logicalBillingKey: 'logical-1' })) raw += frame
  return { raw, events: parse(raw) }
}
function choices(events: Record<string, unknown>[]): Array<{ delta?: Record<string, unknown>; finish_reason?: string | null }> {
  return events.flatMap(event => Array.isArray(event.choices) ? event.choices : [])
}

describe('provider chat facade', () => {
  it('round-trips real LocalCodex Responses text, system/profile, images, function history, tools and usage', async () => {
    const requests: Record<string, unknown>[] = []
    const authHeaders: Array<Record<string, string | string[] | undefined>> = []
    const baseUrl = await serve((request, response, body) => {
      expect(request.url).toBe('/backend-api/codex/responses')
      requests.push(body); authHeaders.push(request.headers)
      if (requests.length === 1) frames(response, [
        { type: 'response.output_text.delta', delta: '先读取文件。' },
        { type: 'response.output_item.done', item: { type: 'function_call', call_id: 'call-new', name: 'read_file', arguments: '{"path":"资料/示例.md"}' } },
        { type: 'response.completed', response: { usage: { input_tokens: 13, output_tokens: 4, total_tokens: 17, input_tokens_details: { cached_tokens: 5 }, output_tokens_details: { reasoning_tokens: 2 } } } },
      ])
      else frames(response, [
        { type: 'response.output_text.delta', delta: '已读取。' },
        { type: 'response.completed', response: { usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23 } } },
      ])
    })
    const resolveAuth = vi.fn(async () => ({ accessToken: 'fixture-token', accountId: 'fixture-account' }))
    const provider = new LocalCodexResponsesProvider({ baseUrl, resolveAuth, threadId: 'muse-thread' })
    const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } } }]
    const messages: Record<string, unknown>[] = [
      { role: 'system', content: 'MUSE_SYSTEM_POLICY' },
      { role: 'developer', content: [{ type: 'text', text: 'USER_PORTRAIT: concise Chinese' }] },
      { role: 'user', content: [{ type: 'text', text: '看图并继续' }, { type: 'image_url', image_url: { url: pixel, detail: 'high' } }] },
      { role: 'assistant', content: null, reasoning_content: 'Previous reasoning', tool_calls: [{ id: 'call-old', type: 'function', function: { name: 'read_file', arguments: '{"path":"old.md"}' } }] },
      { role: 'tool', tool_call_id: 'call-old', content: [{ type: 'text', text: 'old result' }, { type: 'image_url', image_url: { url: pixel } }] },
      { role: 'user', content: 'Continue' },
    ]
    const first = await collect(provider, { model: 'gpt-5.6-sol', messages, tools, tool_choice: 'auto', max_tokens: 4096 })
    expect(first.events.some(event => event.error)).toBe(false)
    expect(choices(first.events).map(choice => choice.delta?.content ?? '').join('')).toBe('先读取文件。')
    const streamedTools = choices(first.events).flatMap(choice => Array.isArray(choice.delta?.tool_calls) ? choice.delta.tool_calls : [])
    expect(streamedTools).toEqual([{ index: 0, id: 'call-new', type: 'function', function: { name: 'read_file', arguments: '{"path":"资料/示例.md"}' } }])
    expect(choices(first.events).at(-1)?.finish_reason).toBe('tool_calls')
    expect(first.events.find(event => event.usage)?.usage).toMatchObject({ prompt_tokens: 13, completion_tokens: 4, total_tokens: 17, prompt_tokens_details: { cached_tokens: 5 }, completion_tokens_details: { reasoning_tokens: 2 } })
    expect(first.raw.endsWith('data: [DONE]\n\n')).toBe(true)
    const sent = requests[0]
    expect(sent.instructions).toBe('MUSE_SYSTEM_POLICY\n\nUSER_PORTRAIT: concise Chinese')
    expect(sent.model).toBe('gpt-5.6-sol')
    expect(sent.store).toBe(false)
    expect(sent.tools).toEqual([{ type: 'function', name: 'read_file', description: 'Read a file', parameters: tools[0].function.parameters }])
    const inputs = sent.input as Array<Record<string, unknown>>
    expect(inputs).toEqual(expect.arrayContaining([
      { type: 'function_call', call_id: 'call-old', name: 'read_file', arguments: '{"path":"old.md"}' },
      { type: 'function_call_output', call_id: 'call-old', output: 'old result' },
    ]))
    const imageParts = inputs.flatMap(input => Array.isArray(input.content) ? input.content : []).filter(part => part.type === 'input_image')
    expect(imageParts).toHaveLength(2)
    expect(imageParts[0]).toEqual({ type: 'input_image', image_url: pixel, detail: 'high' })
    expect(authHeaders[0].authorization).toBe('Bearer fixture-token')
    expect(authHeaders[0]['chatgpt-account-id']).toBe('fixture-account')
    expect(authHeaders[0]['session-id']).toBe('muse-thread')
    const second = await collect(provider, { model: 'gpt-5.6-sol', max_tokens: 4096, tools, messages: [...messages,
      { role: 'assistant', content: '先读取文件。', tool_calls: streamedTools.map(({ index: _index, ...tool }) => tool) },
      { role: 'tool', tool_call_id: 'call-new', content: 'fresh result' },
    ] })
    expect(second.events.some(event => event.error)).toBe(false)
    expect(choices(second.events).map(choice => choice.delta?.content ?? '').join('')).toBe('已读取。')
    expect(requests[1].input).toEqual(expect.arrayContaining([{ type: 'function_call_output', call_id: 'call-new', output: 'fresh result' }]))
    expect(resolveAuth).toHaveBeenCalledTimes(2)
  })

  it('forwards reasoning and incremental arguments without duplicating the final tool block', async () => {
    let received: LLMRequest | undefined
    const provider: LLMProvider = { async *createStream(request) {
      received = request
      yield { type: 'thinking', text: 'Analyze first' }
      yield { type: 'tool_use_delta', toolUseDelta: { id: 'tool-1', name: 'read_file', argDelta: '{ "path": ' } }
      yield { type: 'tool_use_delta', toolUseDelta: { id: 'tool-1', name: '', argDelta: '"a.md" }' } }
      yield { type: 'tool_use', toolUse: { id: 'tool-1', name: 'read_file', input: { path: 'a.md' } } }
      yield { type: 'stop', stopReason: 'tool_use' }
    } }
    const controller = new AbortController()
    const result = await collect(provider, { model: 'local-model', max_completion_tokens: 100, messages: [{ role: 'user', content: 'read' }] }, controller.signal)
    expect(received).toMatchObject({ model: 'local-model', maxTokens: 100, signal: controller.signal, requestSource: 'dsh', billingIdempotencyKey: 'logical-1' })
    expect(choices(result.events).find(choice => choice.delta?.reasoning_content)?.delta?.reasoning_content).toBe('Analyze first')
    const deltas = choices(result.events).flatMap(choice => Array.isArray(choice.delta?.tool_calls) ? choice.delta.tool_calls : [])
    expect(deltas).toHaveLength(2)
    expect(JSON.parse(deltas.map(tool => tool.function.arguments).join(''))).toEqual({ path: 'a.md' })
    expect(choices(result.events).at(-1)?.finish_reason).toBe('tool_calls')
  })

  it('turns real Responses failure into an SSE error without claiming successful completion', async () => {
    const baseUrl = await serve((_request, response) => frames(response, [{ type: 'response.failed', response: { error: { message: 'fixture provider failure', code: 'fixture_error' } } }]))
    const provider = new LocalCodexResponsesProvider({ baseUrl, resolveAuth: async () => ({ accessToken: 'fixture', accountId: 'fixture' }) })
    const result = await collect(provider, { model: 'gpt-5.6-sol', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] })
    expect(result.events.find(event => event.error)?.error).toMatchObject({ message: expect.stringContaining('fixture provider failure'), type: 'provider_error' })
    expect(choices(result.events).some(choice => choice.finish_reason)).toBe(false)
  })

  it('aborts the real Responses HTTP stream and propagates the caller cancellation', async () => {
    let closed: () => void = () => undefined
    const serverClosed = new Promise<void>(resolve => { closed = resolve })
    const baseUrl = await serve((_request, response) => {
      response.once('close', closed)
      frames(response, [{ type: 'response.output_text.delta', delta: 'partial' }], false)
    })
    const provider = new LocalCodexResponsesProvider({ baseUrl, resolveAuth: async () => ({ accessToken: 'fixture', accountId: 'fixture' }) })
    const controller = new AbortController()
    let sawPartial: () => void = () => undefined
    const partial = new Promise<void>(resolve => { sawPartial = resolve })
    const draining = (async () => {
      for await (const frame of streamProviderChat(provider, { model: 'gpt-5.6-sol', max_tokens: 100, messages: [{ role: 'user', content: 'hello' }] }, controller.signal)) {
        if (frame.includes('partial')) sawPartial()
      }
    })()
    await partial
    const reason = new Error('cancel fixture')
    controller.abort(reason)
    await expect(draining).rejects.toBe(reason)
    await serverClosed
  })

  it('cancels before a real LocalCodex provider finishes auth and never dispatches its late fetch', async () => {
    let entered!:()=>void;let release!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve})
    const blocked=new Promise<void>(resolve=>{release=resolve})
    const fetchImpl=vi.fn(async()=>{throw new Error('Late fetch is forbidden')})
    const provider=new LocalCodexResponsesProvider({fetchImpl,resolveAuth:async()=>{
      entered();await blocked;return {accessToken:'fixture',accountId:'fixture'}
    }})
    const controller=new AbortController()
    const reason=new Error('cancelled before auth resolved')
    let settled=false;let failure:unknown
    const draining=collect(provider,{model:'gpt-5.6-sol',max_tokens:100,messages:[{role:'user',content:'fixture'}]},controller.signal)
      .catch(error=>{failure=error}).finally(()=>{settled=true})
    try {
      await started;controller.abort(reason)
      await vi.waitFor(()=>expect(settled).toBe(true))
      expect(failure).toBe(reason)
      release();await new Promise<void>(resolve=>setImmediate(resolve))
      expect(fetchImpl).not.toHaveBeenCalled()
    } finally {release();await draining}
  })

  it('rejects conflicting final tool identities and invalid inputs before execution', async () => {
    const provider: LLMProvider = { async *createStream() {
      yield { type: 'tool_use_delta', toolUseDelta: { id: 'same', name: 'read_file', argDelta: '{}' } }
      yield { type: 'tool_use', toolUse: { id: 'same', name: 'write_file', input: {} } }
      yield { type: 'stop', stopReason: 'tool_use' }
    } }
    const conflicting = await collect(provider, { model: 'model', max_tokens: 100, messages: [] })
    expect(conflicting.events.find(event => event.error)?.error).toMatchObject({ message: 'Provider changed a streaming tool name' })
    const createStream = vi.fn()
    const invalid = await collect({ createStream }, { model: 'model', max_tokens: 100, messages: [{ role: 'assistant', tool_calls: [{ id: 'bad', type: 'function', function: { name: 'read_file', arguments: '{bad' } }] }] })
    expect(invalid.events.find(event => event.error)?.error).toMatchObject({ type: 'invalid_request_error' })
    expect(createStream).not.toHaveBeenCalled()
  })
})
