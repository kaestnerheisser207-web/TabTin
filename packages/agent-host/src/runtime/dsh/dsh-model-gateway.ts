import { createHash, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { deriveApiBaseUrl, joinApiPath } from '@muse/config'
import { normalizeProxySseUsage, type LLMProvider } from '@muse/agent-runtime'
import { streamProviderChat } from './provider-chat-facade.js'

const MAX_REQUEST_BYTES = 4 * 1024 * 1024

export interface DshModelRequestTicket {
  agentId?: string; modelId?: string; runId?: string; signal?: AbortSignal; summaryFocus?: string
  billingIdempotencyScope?: string; requestSource?: string
  recordUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number; modelId?: string }) => void
  close?: () => void
}

export interface DshModelGatewayOptions {
  serverUrl: string
  organizationId: string
  credential: string
  token: string
  host?: string
  port?: number
  fetchImpl?: typeof fetch
  modelId?: string
  sessionId?: string
  provider?: LLMProvider
  getCredential?: () => Promise<string>
  beforeRequest?: () => Promise<DshModelRequestTicket>
  onUsage?: (usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number; modelId?: string }) => void
}

/**
 * Loopback OpenAI-compatible facade for DSH.
 *
 * DSH sees only a per-container loopback token. The daemon credential stays in
 * this process and is attached solely to the exact TabTin LLM Proxy endpoint.
 */
export class DshModelGateway {
  private server: Server | null = null
  private credential: string
  private billingRunId: string | undefined
  private readonly billingCalls = new Map<string, { index: number; attempt: number }>()

  constructor(private readonly options: DshModelGatewayOptions) {
    this.credential = options.credential
    if (!options.token) throw new Error('MUSE_DSH_GATEWAY_TOKEN is required')
  }

  updateCredential(credential: string): void {
    this.credential = credential
  }

  get port(): number | null {
    const address = this.server?.address()
    return address && typeof address === 'object' ? address.port : null
  }

  async start(): Promise<void> {
    if (this.server) return
    const host = this.options.host ?? '127.0.0.1'
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error('DSH Model Gateway must bind loopback')
    }
    const server = createServer((request, response) => {
      void this.handle(request, response)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.port ?? 3090, host, resolve)
    })
    this.server = server
  }

  async stop(): Promise<void> {
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve())
    })
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    let ticket: DshModelRequestTicket | undefined
    const abort = new AbortController()
    const disconnected = () => abort.abort(new Error('DSH model request disconnected'))
    request.once('aborted', disconnected)
    response.once('close', disconnected)
    try {
      if (
        request.method !== 'POST'
        || request.url !== '/v1/chat/completions'
      ) return sendJson(response, 404, { error: { message: 'not_found' } })
      if (!authorized(request.headers.authorization, this.options.token)) {
        return sendJson(response, 401, { error: { message: 'unauthorized' } })
      }
      const body = await readBody(request)
      const parsed = JSON.parse(body) as Record<string, unknown>
      const sessionId = String(
        this.options.sessionId ?? request.headers['x-deepseek-harness-session-id'] ?? '',
      ).slice(0, 255)
      const pendingTicket = this.options.beforeRequest?.()
      if (pendingTicket) void pendingTicket.then(value => { if (abort.signal.aborted) value.close?.() }, () => undefined)
      const target = pendingTicket ? await withCancellation(pendingTicket, abort.signal) : undefined
      ticket = target
      const modelSignal = target?.signal ? AbortSignal.any([abort.signal, target.signal]) : abort.signal
      modelSignal.throwIfAborted()
      if (target?.modelId || this.options.modelId) parsed.model = target?.modelId ?? this.options.modelId
      if (target?.summaryFocus) {
        if (!Array.isArray(parsed.messages)) throw new Error('Compaction messages are required')
        parsed.messages = [...parsed.messages, { role: 'user', content: `Summarization focus requested by the user: ${target.summaryFocus}` }]
      }
      if (this.options.getCredential) this.credential = await withCancellation(this.options.getCredential(), modelSignal)
      const billingHeaders: Record<string, string> = {}
      const source = target?.requestSource ?? 'dsh'
      if (target?.billingIdempotencyScope && target.runId) {
        if (this.billingRunId !== target.runId) { this.billingCalls.clear(); this.billingRunId = target.runId }
        const fingerprint = createHash('sha256').update(JSON.stringify(parsed)).digest('hex')
        let call = this.billingCalls.get(fingerprint)
        if (!call) { call = { index: this.billingCalls.size, attempt: 0 }; this.billingCalls.set(fingerprint, call) }
        const logicalKey = `agent-turn:${target.billingIdempotencyScope}:${source}:${call.index}`
        const attempt = call.attempt++
        const attemptKey = `${logicalKey}:attempt:${attempt}`
        billingHeaders['x-tabtin-billing-logical-key'] = logicalKey
        billingHeaders['x-tabtin-billing-attempt-key'] = attemptKey
        billingHeaders['x-tabtin-billing-idempotency-key'] = attemptKey
        billingHeaders['x-tabtin-billing-attempt-index'] = String(attempt)
      }
      const upstreamUrl = joinApiPath(
        deriveApiBaseUrl(this.options.serverUrl),
        '/llm/proxy',
      )
      const upstream = this.options.provider
        ? new Response(providerBody(streamProviderChat(this.options.provider, parsed, modelSignal, {
            requestSource: source, logicalBillingKey: billingHeaders['x-tabtin-billing-logical-key'],
          })), { headers: { 'content-type': 'text/event-stream' } })
        : await (this.options.fetchImpl ?? fetch)(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.credential}`,
          'x-tabtin-organization-id': this.options.organizationId,
          'x-tabtin-session-id': sessionId,
          'x-tabtin-request-source': source,
          ...(target?.agentId ? { 'x-tabtin-agent-id': target.agentId } : {}),
          ...billingHeaders,
        },
        body: JSON.stringify(parsed),
        signal: modelSignal,
      })
      if (!upstream.ok || !upstream.body) {
        return sendJson(response, upstream.status, {
          error: { message: `TabTin Model Gateway returned HTTP ${upstream.status}` },
        })
      }
      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      })
      const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, modelId: String(parsed.model ?? '') }
      let hasUsage = false
      try {
        for await (const event of filterProxySse(upstream.body, (value, eventType) => {
          const u = value.usage
          if (u && typeof u === 'object') {
            hasUsage = true
            const normalized = normalizeProxySseUsage({ ...u, prompt_tokens: u.prompt_tokens ?? u.input_tokens })
            usage.inputTokens = Math.max(usage.inputTokens, finite(normalized.inputTokens))
            usage.outputTokens = Math.max(usage.outputTokens, finite(u.completion_tokens ?? u.output_tokens))
            usage.cacheReadTokens = Math.max(usage.cacheReadTokens, finite(normalized.cacheRead))
            usage.cacheWriteTokens = Math.max(usage.cacheWriteTokens, finite(normalized.cacheCreation))
          }
          if (eventType === 'tabtin.billing') {
            hasUsage = true
            // Keep the same accounting unit as Builtin's proxy-provider cost_usd field.
            usage.costUsd = finite(value.credits_charged)
          }
        }, modelSignal)) response.write(event)
      } finally {
        if (hasUsage) (target?.recordUsage ?? this.options.onUsage)?.(usage)
      }
      response.end()
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 502, {
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      } else {
        response.end()
      }
    } finally {
      request.removeListener('aborted', disconnected)
      response.removeListener('close', disconnected)
      ticket?.close?.()
    }
  }
}

export async function* filterProxySse(
  body: ReadableStream<Uint8Array>,
  observe?: (value: Record<string, any>, eventType: string) => void,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pending = ''
  const reader = body.getReader()
  try {
    while (true) {
      signal?.throwIfAborted()
      const pendingRead = reader.read()
      const { value: chunk, done } = signal ? await withCancellation(pendingRead, signal) : await pendingRead
      if (done) break
      pending += decoder.decode(chunk, { stream: true })
      while (true) {
        const boundary = pending.indexOf('\n\n')
        if (boundary < 0) break
        const raw = pending.slice(0, boundary)
        pending = pending.slice(boundary + 2)
        const forwarded = filterSseEvent(raw, observe)
        if (forwarded) yield `${forwarded}\n\n`
      }
    }
  } finally {
    // Cancelling an async provider iterator may wait for uncancellable auth;
    // initiate cleanup but release this request and its model ticket immediately.
    if (signal?.aborted) void reader.cancel(signal.reason).catch(() => undefined)
    reader.releaseLock()
  }
  pending += decoder.decode()
  const forwarded = filterSseEvent(pending, observe)
  if (forwarded) yield `${forwarded}\n\n`
}

function filterSseEvent(raw: string, observe?: (value: Record<string, any>, eventType: string) => void): string | null {
  const lines = raw.split('\n')
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  if (data === '[DONE]') return 'data: [DONE]'
  try {
    const parsed = JSON.parse(data)
    const eventType = lines.find(line => line.startsWith('event:'))?.slice(6).trim() ?? ''
    observe?.(parsed, eventType)
    if (eventType === 'tabtin.billing' && parsed.charge_status === 'failed') {
      return `data: ${JSON.stringify({ error: { message: 'Muse model billing failed', type: 'tabtin_gateway_error', code: parsed.error_category ?? 'billing_charge_failed' } })}`
    }
    if (Array.isArray(parsed?.choices)) return `data: ${data}`
    if (parsed?.error) {
      const message = String(
        parsed.error.message
        ?? parsed.error.user_message
        ?? parsed.error_message
        ?? 'TabTin Model Gateway error',
      )
      return `data: ${JSON.stringify({
        error: {
          message,
          type: 'tabtin_gateway_error',
          code: parsed.error.code ?? parsed.error_code ?? 'gateway_error',
        },
      })}`
    }
  } catch {
    return null
  }
  return null
}

function authorized(raw: string | undefined, expected: string): boolean {
  const supplied = raw?.startsWith('Bearer ') ? raw.slice(7) : ''
  const left = Buffer.from(supplied)
  const right = Buffer.from(expected)
  return left.length === right.length && timingSafeEqual(left, right)
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = ''
  for await (const chunk of request) {
    body += Buffer.from(chunk).toString('utf8')
    if (body.length > MAX_REQUEST_BYTES) throw new Error('request body too large')
  }
  if (!body) throw new Error('request body is required')
  return body
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
  })
  response.end(body)
}

function finite(value: unknown): number { return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0 }

function providerBody(source: AsyncIterable<string>): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]()
  const encoder = new TextEncoder()
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next()
        if (next.done) controller.close()
        else controller.enqueue(encoder.encode(next.value))
      } catch (error) { controller.error(error) }
    },
    async cancel() { await iterator.return?.() },
  })
}

function withCancellation<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void operation.catch(() => undefined); return Promise.reject(signal.reason) }
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener('abort', abort); reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    operation.then(value => { signal.removeEventListener('abort', abort); resolve(value) }, error => { signal.removeEventListener('abort', abort); reject(error) })
  })
}
