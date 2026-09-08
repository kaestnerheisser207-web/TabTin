import WebSocket from 'ws'
import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client'
import {
  serverRequestSchema,
  type ApiProxy,
  type HostFrame,
  type MuxFrame,
  type RpcRequest,
} from '@deepseek-ai/dsh-host-apiproxy/api'

/** Official DSH ApiProxy HTTP unary + WebSocket downlink client, loopback-only. */
export class DshApiClient extends AbstractApiClient {
  private readonly baseUrl: string

  constructor(baseUrl = 'http://127.0.0.1:3080', timeoutMs = 30_000) {
    super(timeoutMs)
    const parsed = new URL(baseUrl)
    if (
      parsed.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname)
      || parsed.username
      || parsed.password
    ) {
      throw new Error('DSH ApiProxy must use an unauthenticated loopback HTTP endpoint')
    }
    this.baseUrl = parsed.origin
  }

  protected override resolveBase(): string {
    return this.baseUrl
  }

  protected override doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const target = new URL(`${input.pathname}${input.search}`, this.baseUrl)
    return fetch(target, init)
  }

  protected override openMux(
    _payload: Parameters<ApiProxy['events']['mux']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<MuxFrame>> {
    return this.readWebSocket<MuxFrame>('/api/events.mux', signal, onOpen)
  }

  protected override openHost(
    _payload: Parameters<ApiProxy['events']['host']>[0]['payload'],
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncIterable<RpcRequest<HostFrame>> {
    return this.readWebSocket<HostFrame>('/api/events.host', signal, onOpen)
  }

  private async *readWebSocket<Frame extends MuxFrame | HostFrame>(
    path: string,
    signal: AbortSignal,
    onOpen?: () => void,
  ): AsyncGenerator<RpcRequest<Frame>> {
    const url = new URL(path, this.baseUrl)
    url.protocol = 'ws:'
    const socket = new WebSocket(url)
    const inbox: Array<
      | { kind: 'frame'; value: RpcRequest<Frame> }
      | { kind: 'error'; error: Error }
      | { kind: 'end' }
    > = []
    let wake: (() => void) | undefined
    const enqueue = (item: typeof inbox[number]) => {
      inbox.push(item)
      wake?.()
      wake = undefined
    }
    const abort = () => socket.close()
    socket.once('open', () => onOpen?.())
    socket.on('message', (data, isBinary) => {
      if (isBinary) return
      try {
        const full = serverRequestSchema.parse(JSON.parse(data.toString()))
        this.onEnvelope(full)
        enqueue({
          kind: 'frame',
          value: {
            rpcId: full.rpcId,
            payload: full.payload as Frame,
          },
        })
      } catch {
        // One malformed push must not kill the stream; reconnect/history owns gaps.
      }
    })
    socket.once('error', error => enqueue({ kind: 'error', error }))
    socket.once('close', () => enqueue({ kind: 'end' }))
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      while (true) {
        while (inbox.length > 0) {
          const item = inbox.shift()!
          if (item.kind === 'frame') yield item.value
          else if (item.kind === 'error') throw item.error
          else return
        }
        await new Promise<void>(resolve => { wake = resolve })
      }
    } finally {
      signal.removeEventListener('abort', abort)
      if (
        socket.readyState === WebSocket.CONNECTING
        || socket.readyState === WebSocket.OPEN
      ) socket.close()
    }
  }
}
