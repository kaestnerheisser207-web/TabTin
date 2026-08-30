import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { deriveApiBaseUrl, joinApiPath } from '@tabtin/config'

const MAX_REQUEST_BYTES = 4 * 1024 * 1024

export interface DshModelGatewayOptions {
  serverUrl: string
  organizationId: string
  credential: string
  token: string
  host?: string
  port?: number
  fetchImpl?: typeof fetch
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

  constructor(private readonly options: DshModelGatewayOptions) {
    this.credential = options.credential
    if (!options.token) throw new Error('TABTIN_DSH_GATEWAY_TOKEN is required')
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
        request.headers['x-deepseek-harness-session-id'] ?? '',
      ).slice(0, 255)
      const upstreamUrl = joinApiPath(
        deriveApiBaseUrl(this.options.serverUrl),
        '/llm/proxy',
      )
      const abort = new AbortController()
      response.once('close', () => abort.abort())
      const upstream = await (this.options.fetchImpl ?? fetch)(upstreamUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.credential}`,
          'x-organization-id': this.options.organizationId,
          'x-tabtin-session-id': sessionId,
          'x-tabtin-request-source': 'dsh',
        },
        body: JSON.stringify(parsed),
        signal: abort.signal,
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
      for await (const event of filterProxySse(upstream.body)) response.write(event)
      response.end()
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, 502, {
          error: { message: error instanceof Error ? error.message : String(error) },
        })
      } else {
        response.end()
      }
    }
  }
}

export async function* filterProxySse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder()
  let pending = ''
  for await (const chunk of body as any as AsyncIterable<Uint8Array>) {
    pending += decoder.decode(chunk, { stream: true })
    while (true) {
      const boundary = pending.indexOf('\n\n')
      if (boundary < 0) break
      const raw = pending.slice(0, boundary)
      pending = pending.slice(boundary + 2)
      const forwarded = filterSseEvent(raw)
      if (forwarded) yield `${forwarded}\n\n`
    }
  }
  pending += decoder.decode()
  const forwarded = filterSseEvent(pending)
  if (forwarded) yield `${forwarded}\n\n`
}

function filterSseEvent(raw: string): string | null {
  const lines = raw.split('\n')
  const data = lines
    .filter(line => line.startsWith('data:'))
    .map(line => line.slice(5).trimStart())
    .join('\n')
  if (!data) return null
  if (data === '[DONE]') return 'data: [DONE]'
  try {
    const parsed = JSON.parse(data)
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
