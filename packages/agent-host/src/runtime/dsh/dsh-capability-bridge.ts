import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'
import type { QueryParams } from '@muse/agent-runtime'
import type { HostCapabilitySession } from '../host-capability-session.js'

const MAX_BODY_BYTES = 8 * 1024 * 1024
const PROTOCOL_VERSION = 1

/** A runtime-owned capability connection. The bearer binds identity outside model arguments. */
export class DshCapabilityBridge {
  readonly token = randomBytes(32).toString('hex')
  private server: Server | null = null
  private socketServer: WebSocketServer | null = null
  private peer: WebSocket | null = null
  private ready = false
  private serial = 0
  private runId: string | null = null
  private summaryFocus: string | undefined
  private runController: AbortController | null = null
  private runSignalCleanup: (() => void) | null = null
  private readonly lifetime = new AbortController()
  private readonly pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly readyWaiters = new Set<() => void>()

  constructor(private readonly capabilities: HostCapabilitySession) {}

  get url(): string {
    const address = this.server?.address()
    if (!address || typeof address === 'string') throw new Error('DSH capability bridge is not listening')
    return `http://127.0.0.1:${address.port}`
  }

  async start(): Promise<void> {
    if (this.server) return
    this.lifetime.signal.throwIfAborted()
    const server = createServer((req, res) => { void this.handle(req, res) })
    const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES })
    server.on('upgrade', (req, socket, head) => {
      if (req.url !== '/control' || !this.authorized(req) || this.peer) {
        socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
        socket.destroy()
        return
      }
      sockets.handleUpgrade(req, socket, head, peer => this.attach(peer))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    this.server = server
    this.socketServer = sockets
  }

  async beginRun(params: QueryParams): Promise<void> {
    if (this.runController) throw new Error('DSH capability run is already active')
    if (!params.hostRunId) throw new Error('DSH requires a host run identity')
    this.lifetime.signal.throwIfAborted()
    params.signal?.throwIfAborted()
    await this.capabilities.beginRun(params)
    this.runId = params.hostRunId
    this.runController = new AbortController()
    const controller = this.runController
    const abort = () => controller.abort(params.signal?.reason ?? new Error('DSH run cancelled'))
    params.signal?.addEventListener('abort', abort, { once: true })
    this.runSignalCleanup = () => params.signal?.removeEventListener('abort', abort)
    if (params.signal?.aborted) abort()
  }

  get compactionFocus(): string | undefined { return this.summaryFocus }

  setCompactionFocus(focus?: string): void {
    if (!this.runId) throw new Error('Compaction requires an active maintenance run')
    this.summaryFocus = focus?.trim() || undefined
  }

  async endRun(): Promise<void> {
    this.summaryFocus = undefined
    this.runSignalCleanup?.()
    this.runSignalCleanup = null
    this.runController?.abort(new Error('DSH run ended'))
    this.runController = null
    this.runId = null
    await this.capabilities.endRun()
  }

  async waitUntilReady(signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    combined.throwIfAborted()
    if (this.ready) return
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => { clearTimeout(timer); this.readyWaiters.delete(done); combined.removeEventListener('abort', abort) }
      const done = () => { cleanup(); resolve() }
      const abort = () => { cleanup(); reject(combined.reason) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('Muse DSH plugin handshake timed out')) }, 30_000)
      this.readyWaiters.add(done)
      combined.addEventListener('abort', abort, { once: true })
    })
  }

  async control<T = unknown>(method: string, params: unknown, signal?: AbortSignal): Promise<T> {
    await this.waitUntilReady(signal)
    const peer = this.peer
    if (!peer || peer.readyState !== WebSocket.OPEN) throw new Error('Muse DSH plugin is disconnected')
    const combined = signal ? AbortSignal.any([signal, this.lifetime.signal]) : this.lifetime.signal
    combined.throwIfAborted()
    const id = String(++this.serial)
    return await new Promise<T>((resolve, reject) => {
      const cleanup = () => { this.pending.delete(id); combined.removeEventListener('abort', abort) }
      const abort = () => {
        cleanup()
        if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ method: 'cancel', params: { id } }))
        reject(combined.reason)
      }
      this.pending.set(id, {
        resolve: value => { cleanup(); resolve(value as T) },
        reject: error => { cleanup(); reject(error) },
      })
      combined.addEventListener('abort', abort, { once: true })
      peer.send(JSON.stringify({ id, method, params }), error => {
        if (error) { cleanup(); reject(error) }
      })
    })
  }

  async stop(disposeCapabilities = true): Promise<void> {
    this.lifetime.abort(new Error('DSH capability bridge disposed'))
    this.peer?.terminate()
    this.peer = null
    this.ready = false
    for (const item of this.pending.values()) item.reject(new Error('DSH capability bridge disposed'))
    this.pending.clear()
    let failure: unknown
    try { await this.endRun() } catch (error) { failure = error }
    this.socketServer?.close()
    this.socketServer = null
    const server = this.server
    this.server = null
    if (server) {
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
    if (disposeCapabilities) {
      try { await this.capabilities.dispose() } catch (error) { failure ??= error }
    }
    if (failure) throw failure
  }

  private attach(peer: WebSocket): void {
    this.peer = peer
    peer.on('error', () => { /* close handles all outstanding controls */ })
    peer.on('close', () => {
      if (this.peer !== peer) return
      this.peer = null
      this.ready = false
      this.runController?.abort(new Error('Muse DSH plugin disconnected'))
      for (const item of this.pending.values()) item.reject(new Error('Muse DSH plugin disconnected'))
      this.pending.clear()
    })
    peer.on('message', data => {
      try {
        const message = JSON.parse(data.toString()) as Record<string, any>
        if (message.method === 'hello') {
          if (message.params?.protocolVersion !== PROTOCOL_VERSION) {
            peer.close(1008, 'Incompatible Muse plugin protocol')
            return
          }
          this.ready = true
          peer.send(JSON.stringify({ id: message.id, result: { protocolVersion: PROTOCOL_VERSION } }))
          for (const done of this.readyWaiters) done()
          return
        }
        const pending = this.pending.get(String(message.id))
        if (!pending) return
        if (message.error) pending.reject(new Error(String(message.error.message ?? 'DSH control failed')))
        else pending.resolve(message.result)
      } catch { peer.close(1008, 'Invalid Muse plugin control frame') }
    })
  }

  private authorized(req: IncomingMessage): boolean {
    // Browser origins have no authority to invoke this private runtime service.
    if (req.headers.origin) return false
    const actual = Buffer.from(req.headers.authorization ?? '')
    const expected = Buffer.from(`Bearer ${this.token}`)
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (!this.authorized(req)) { json(res, 401, { error: 'unauthorized' }); return }
    const controller = new AbortController()
    req.once('aborted', () => controller.abort(new Error('DSH request aborted')))
    res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('DSH response disconnected')) })
    const signals = [controller.signal, this.lifetime.signal]
    if (this.runController) signals.push(this.runController.signal)
    const signal = AbortSignal.any(signals)
    let rpcId: unknown
    try {
      if (req.method === 'GET' && req.url === '/context') {
        json(res, 200, await this.capabilities.snapshot())
        return
      }
      if (req.method !== 'POST') { json(res, 404, { error: 'not_found' }); return }
      const body = await readJson(req)
      if (req.url === '/mcp') {
        rpcId = body.id
        if (body.method === 'notifications/initialized') { res.writeHead(202).end(); return }
        let result: unknown
        if (body.method === 'initialize') result = {
          protocolVersion: '2024-11-05', capabilities: { tools: {} },
          serverInfo: { name: 'muse-host-capabilities', version: '1' },
        }
        else if (body.method === 'tools/list') result = { tools: (await this.capabilities.snapshot()).tools }
        else if (body.method === 'tools/call') {
          const params = object(body.params)
          const meta = object(params._meta)
          this.assertRun(meta.runId)
          const input = invocation({ ...params, callId: meta.callId })
          const output = await this.capabilities.invoke(input, signal)
          result = { content: [{ type: 'text', text: JSON.stringify(output) }], isError: output.isError === true }
        } else throw new Error('Unknown MCP method')
        json(res, 200, { jsonrpc: '2.0', id: rpcId, result })
        return
      }
      if (req.url === '/native/before' || req.url === '/native/after') {
        this.assertRun(body.runId)
        const input = { ...invocation(body), ...(body.nativeTimeoutMs !== undefined ? { nativeTimeoutMs: body.nativeTimeoutMs } : {}) }
        if (req.url === '/native/before') json(res, 200, await this.capabilities.beforeNative(input, signal))
        else {
          await this.capabilities.afterNative({ ...input, result: body.result }, signal)
          json(res, 200, { ok: true })
        }
        return
      }
      json(res, 404, { error: 'not_found' })
    } catch (error) {
      if (res.destroyed || res.writableEnded) return
      const message = error instanceof Error ? error.message : 'Capability request failed'
      if (rpcId !== undefined) json(res, 200, { jsonrpc: '2.0', id: rpcId, error: { code: -32000, message } })
      else json(res, 400, { error: message })
    }
  }

  private assertRun(runId: unknown): void {
    if (!this.runId || runId !== this.runId || !this.runController || this.runController.signal.aborted) {
      throw new Error('Missing, stale or cancelled Muse run identity')
    }
  }
}

function json(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
  res.end(JSON.stringify(value))
}
function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
  return value as Record<string, any>
}
function invocation(body: Record<string, any>): { callId: string; name: string; arguments: Record<string, unknown> } {
  if (typeof body.callId !== 'string' || !body.callId.trim() || typeof body.name !== 'string' || !body.name.trim()) {
    throw new Error('Missing tool call identity')
  }
  return { callId: body.callId, name: body.name, arguments: object(body.arguments) }
}
async function readJson(req: IncomingMessage): Promise<Record<string, any>> {
  let bytes = 0
  const chunks: Buffer[] = []
  for await (const part of req) {
    const chunk = Buffer.from(part)
    bytes += chunk.length
    if (bytes > MAX_BODY_BYTES) throw new Error('Capability request too large')
    chunks.push(chunk)
  }
  return object(JSON.parse(Buffer.concat(chunks).toString('utf8')))
}
