import { LocalCodexResponsesProvider } from '@muse/agent-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DshModelGateway,
  filterProxySse,
} from '../src/application/agent/runtime/dsh-model-gateway.js'

const gateways: DshModelGateway[] = []

afterEach(async () => {
  await Promise.all(gateways.splice(0).map(gateway => gateway.stop()))
  vi.restoreAllMocks()
})

function sseBody(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text))
      controller.close()
    },
  })
}

describe('DshModelGateway', () => {
  it('filters TabTin-only frames while preserving OpenAI chunks and DONE', async () => {
    const body = sseBody([
      ': tabtin_timing {"phase":"x"}\n\n',
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      'data: {"type":"billing","credits":1}\n\n',
      'data: [DONE]\n\n',
    ].join(''))
    let result = ''
    for await (const event of filterProxySse(body)) result += event

    expect(result).toContain('"choices"')
    expect(result).toContain('data: [DONE]')
    expect(result).not.toContain('billing')
    expect(result).not.toContain('tabtin_timing')
  })

  it('keeps the daemon credential inside the loopback proxy boundary', async () => {
    const upstreamFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer daemon-secret')
      expect(headers.get('x-tabtin-organization-id')).toBe('organization-1')
      expect(headers.get('x-tabtin-session-id')).toBe('session-1')
      expect(headers.has('x-tabtin-billing-idempotency-key')).toBe(false)
      return new Response(sseBody('data: {"choices":[]}\n\ndata: [DONE]\n\n'), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      })
    })
    const gateway = new DshModelGateway({
      serverUrl: 'http://127.0.0.1:7070',
      organizationId: 'organization-1',
      credential: 'daemon-secret',
      token: 'loopback-token',
      port: 0,
      fetchImpl: upstreamFetch as typeof fetch,
    })
    gateways.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer loopback-token',
        'content-type': 'application/json',
        'x-deepseek-harness-session-id': 'session-1',
      },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [], stream: true }),
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain('data: [DONE]')
    expect(upstreamFetch).toHaveBeenCalledOnce()
  })

  it('pins the local Muse model and business session and refreshes credentials per call', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers)
      expect(headers.get('authorization')).toBe('Bearer refreshed-secret')
      expect(headers.get('x-tabtin-session-id')).toBe('muse-thread')
      expect(headers.get('x-tabtin-organization-id')).toBe('muse-org')
      expect(JSON.parse(String(init?.body)).model).toBe('selected-model')
      return new Response(sseBody('data: [DONE]\n\n'))
    })
    const getCredential = vi.fn(async () => 'refreshed-secret')
    const gateway = new DshModelGateway({
      serverUrl: 'http://127.0.0.1:7070', organizationId: 'muse-org',
      credential: 'expired-secret', getCredential, modelId: 'selected-model',
      sessionId: 'muse-thread', token: 'private-token', port: 0,
      fetchImpl: fetchImpl as typeof fetch,
    })
    gateways.push(gateway)
    await gateway.start()
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: 'POST', headers: {
        authorization: 'Bearer private-token', 'x-deepseek-harness-session-id': 'untrusted-thread',
      }, body: JSON.stringify({ model: 'dsh-default', messages: [], stream: true }),
    })
    expect(await response.text()).toContain('[DONE]')
    expect(getCredential).toHaveBeenCalledOnce()
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('checks host budget/model authority before dispatch and accounts usage plus billing once', async () => {
    const beforeRequest = vi.fn(async () => ({ modelId: 'authorized-model' }))
    const onUsage = vi.fn()
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).model).toBe('authorized-model')
      return new Response(sseBody([
        'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":12,"prompt_tokens_details":{"cached_tokens":30}}}\n\n',
        'event: tabtin.billing\ndata: {"credits_charged":0.25,"charge_status":"charged"}\n\n',
        'data: [DONE]\n\n',
      ].join('')))
    })
    const gateway = new DshModelGateway({ serverUrl: 'http://127.0.0.1:7070', organizationId: 'org',
      credential: 'credential', token: 'token', port: 0, modelId: 'default',
      beforeRequest, onUsage, fetchImpl: fetchImpl as typeof fetch })
    gateways.push(gateway); await gateway.start()
    const call = () => fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer token' }, body: JSON.stringify({ model: 'untrusted', stream: true }),
    })
    expect(await (await call()).text()).toContain('[DONE]')
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 70, outputTokens: 12, cacheReadTokens: 30, cacheWriteTokens: 0, costUsd: 0.25, modelId: 'authorized-model' })
    beforeRequest.mockRejectedValueOnce(new Error('Host capability budget exhausted'))
    expect((await call()).status).toBe(502)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('freezes model tickets, closes them on failure, and uses trusted logical/attempt billing identities', async () => {
    const close = vi.fn()
    const recordUsage = vi.fn()
    const ticket = { runId: 'run-ticket', modelId: 'model', billingIdempotencyScope: 'job-scope', requestSource: '_main_chat', recordUsage, close }
    const fetchImpl = vi.fn(async () => new Response(sseBody('data: {"choices":[],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\ndata: [DONE]\n\n')))
    const gateway = new DshModelGateway({ serverUrl: 'http://127.0.0.1:7070', organizationId: 'org',
      credential: 'credential', token: 'token', port: 0, beforeRequest: async () => ticket, fetchImpl: fetchImpl as typeof fetch })
    gateways.push(gateway); await gateway.start()
    const call = () => fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: 'POST', headers: { authorization: 'Bearer token' }, body: JSON.stringify({ model: 'requested', messages: [], stream: true }),
    })
    await (await call()).text(); await (await call()).text()
    const first = new Headers((fetchImpl.mock.calls[0] as unknown as [unknown, RequestInit])[1].headers)
    const second = new Headers((fetchImpl.mock.calls[1] as unknown as [unknown, RequestInit])[1].headers)
    expect(first.get('x-tabtin-billing-logical-key')).toBe('agent-turn:job-scope:_main_chat:0')
    expect(second.get('x-tabtin-billing-logical-key')).toBe(first.get('x-tabtin-billing-logical-key'))
    expect(first.get('x-tabtin-billing-attempt-index')).toBe('0')
    expect(second.get('x-tabtin-billing-attempt-index')).toBe('1')
    expect(close).toHaveBeenCalledTimes(2)
    expect(recordUsage).toHaveBeenCalledTimes(2)
    fetchImpl.mockRejectedValueOnce(new Error('network failed'))
    expect((await call()).status).toBe(502)
    expect(close).toHaveBeenCalledTimes(3)
  })

  it('preserves native provider charges and normalized cache accounting through the same gateway', async () => {
    const recordUsage = vi.fn(); const close = vi.fn(); const upstreamFetch = vi.fn()
    const gateway = new DshModelGateway({ serverUrl: 'http://127.0.0.1:7070', organizationId: 'org', credential: 'credential', token: 'token', port: 0,
      beforeRequest: async () => ({ modelId: 'native-model', recordUsage, close }), fetchImpl: upstreamFetch,
      provider: { async *createStream(request) {
        expect(request.model).toBe('native-model')
        yield { type: 'text_delta', text: 'native provider answer' } as const
        yield { type: 'usage', usage: { input_tokens: 8, output_tokens: 2, cache_read_input_tokens: 5, cache_creation_input_tokens: 3, cost_usd: .75, charge_status: 'charged' } } as const
        yield { type: 'stop', stopReason: 'end_turn' } as const
      } },
    })
    gateways.push(gateway); await gateway.start()
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer token' }, body: JSON.stringify({ model: 'ignored', max_tokens: 4096, messages: [{ role: 'user', content: 'hello' }] }) })
    expect(await response.text()).toContain('native provider answer')
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(recordUsage).toHaveBeenCalledWith({ inputTokens: 8, outputTokens: 2, cacheReadTokens: 5, cacheWriteTokens: 3, costUsd: .75, modelId: 'native-model' })
    expect(close).toHaveBeenCalledOnce()
  })

  it('closes a model ticket promptly when cancellation interrupts credential refresh', async () => {
    const controller = new AbortController(); const close = vi.fn(); const upstreamFetch = vi.fn()
    let entered!: () => void
    const refreshing = new Promise<void>(resolve => { entered = resolve })
    const gateway = new DshModelGateway({ serverUrl: 'http://127.0.0.1:7070', organizationId: 'org', credential: 'credential', token: 'token', port: 0,
      beforeRequest: async () => ({ signal: controller.signal, close }), fetchImpl: upstreamFetch,
      getCredential: () => { entered(); return new Promise<string>(() => {}) },
    })
    gateways.push(gateway); await gateway.start()
    const response = fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, { method: 'POST', headers: { authorization: 'Bearer token' }, body: JSON.stringify({ model: 'test', messages: [] }) })
    await refreshing; controller.abort(new Error('cancelled while refreshing'))
    expect((await response).status).toBe(502)
    await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
    expect(upstreamFetch).not.toHaveBeenCalled()
  })

  it.each(['auth', 'image'])('releases a native provider ticket while %s setup is still pending and prevents late dispatch', async phase => {
    const controller = new AbortController()
    const close = vi.fn(); const recordUsage = vi.fn(); const lateRunUsage = vi.fn()
    let entered!: () => void; let release!: () => void
    const started = new Promise<void>(resolve => { entered = resolve })
    const blocked = new Promise<void>(resolve => { release = resolve })
    const modelFetch = vi.fn(async () => { throw new Error('Late model fetch must never start') })
    const provider = new LocalCodexResponsesProvider({
      baseUrl: 'http://127.0.0.1:9', fetchImpl: modelFetch,
      resolveAuth: async () => {
        if (phase === 'auth') { entered(); await blocked }
        return { accessToken: 'fixture-token', accountId: 'fixture-account' }
      },
      resolveRemoteImageUrl: async () => { entered(); await blocked; return 'data:image/png;base64,YQ==' },
    })
    const gateway = new DshModelGateway({ serverUrl:'http://127.0.0.1:9',organizationId:'fixture',credential:'fixture',token:'fixture',port:0,provider,
      beforeRequest:async()=>({modelId:'gpt-5.6-sol',signal:controller.signal,close,recordUsage}),onUsage:lateRunUsage,
    })
    gateways.push(gateway);await gateway.start()
    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`,{
      method:'POST',headers:{authorization:'Bearer fixture'},body:JSON.stringify({model:'gpt-5.6-sol',max_tokens:100,messages:[{role:'user',content:phase==='image'
        ? [{type:'image_url',image_url:{url:'https://fixture.invalid/image.png'}}] : 'fixture'}]}),
    })
    const reading = response.text()
    try {
      await started
      controller.abort(new Error('cancelled during provider preparation'))
      await vi.waitFor(()=>expect(close).toHaveBeenCalledOnce())
      await reading
      expect(modelFetch).not.toHaveBeenCalled()
      // A completed shared auth/image operation may arrive after a new run is
      // already possible; it must not launch this cancelled LLM or account usage.
      release()
      await new Promise<void>(resolve=>setImmediate(resolve))
      expect(modelFetch).not.toHaveBeenCalled()
      expect(recordUsage).not.toHaveBeenCalled()
      expect(lateRunUsage).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledOnce()
    } finally { release(); await reading.catch(()=>undefined) }
  })

  it('does not hide a failed billing tail from DSH', async () => {
    let output = ''
    for await (const event of filterProxySse(sseBody('event: tabtin.billing\ndata: {"charge_status":"failed","error_category":"budget_exceeded"}\n\ndata: [DONE]\n\n'))) output += event
    expect(output).toContain('budget_exceeded')
    expect(output).toContain('tabtin_gateway_error')
  })

  it('does not call upstream without the loopback token', async () => {
    const upstreamFetch = vi.fn()
    const gateway = new DshModelGateway({
      serverUrl: 'http://127.0.0.1:7070',
      organizationId: 'organization-1',
      credential: 'daemon-secret',
      token: 'loopback-token',
      port: 0,
      fetchImpl: upstreamFetch as typeof fetch,
    })
    gateways.push(gateway)
    await gateway.start()

    const response = await fetch(`http://127.0.0.1:${gateway.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })

    expect(response.status).toBe(401)
    expect(upstreamFetch).not.toHaveBeenCalled()
  })
})
