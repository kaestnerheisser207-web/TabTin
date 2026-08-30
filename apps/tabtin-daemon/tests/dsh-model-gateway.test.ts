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
      expect(headers.get('x-organization-id')).toBe('organization-1')
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
