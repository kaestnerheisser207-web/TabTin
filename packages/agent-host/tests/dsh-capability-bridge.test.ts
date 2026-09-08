import { afterEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { DshCapabilityBridge } from '../src/runtime/dsh/dsh-capability-bridge.js'
import type { HostCapabilitySession } from '../src/runtime/host-capability-session.js'

const bridges: DshCapabilityBridge[] = []
const peers: WebSocket[] = []
function fixture() {
  const capabilities: HostCapabilitySession = {
    beginRun: vi.fn(async () => undefined), endRun: vi.fn(async () => undefined),
    snapshot: vi.fn(async () => ({ runId: 'run-1', systemPrompt: 'Muse', context: '', tools: [
      { name: 'read_test', description: 'Read fixture', inputSchema: { type: 'object', properties: {} } },
    ] })),
    invoke: vi.fn(async () => ({ content: 'result', isError: false })),
    beforeNative: vi.fn(async () => ({ allowed: true })), afterNative: vi.fn(async () => undefined),
    dispose: vi.fn(async () => undefined),
  }
  const bridge = new DshCapabilityBridge(capabilities)
  bridges.push(bridge)
  return { bridge, capabilities }
}
async function request(bridge: DshCapabilityBridge, route: string, body?: unknown, authorization = `Bearer ${bridge.token}`) {
  const response = await fetch(`${bridge.url}${route}`, {
    method: body ? 'POST' : 'GET', headers: { authorization, 'content-type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return { status: response.status, body: await response.json() as any }
}
afterEach(async () => {
  for (const peer of peers.splice(0)) peer.terminate()
  await Promise.all(bridges.splice(0).map(bridge => bridge.stop()))
})

describe('DSH capability bridge transport', () => {
  it('requires the instance credential, exposes MCP schemas, rejects stale calls before execution', async () => {
    const { bridge, capabilities } = fixture()
    await bridge.start()
    expect((await request(bridge, '/context', undefined, 'Bearer invalid')).status).toBe(401)
    const listing = await request(bridge, '/mcp', { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(listing.body.result.tools[0].name).toBe('read_test')
    const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: {
      name: 'read_test', arguments: {}, _meta: { callId: 'call-1', runId: 'run-1' },
    } }
    expect((await request(bridge, '/mcp', call)).body.error.message).toContain('Missing, stale')
    expect(capabilities.invoke).not.toHaveBeenCalled()
    await bridge.beginRun({ prompt: 'test', hostRunId: 'run-1' })
    const result = await request(bridge, '/mcp', call)
    expect(JSON.parse(result.body.result.content[0].text)).toEqual({ content: 'result', isError: false })
    await bridge.endRun()
    expect((await request(bridge, '/mcp', call)).body.error.message).toContain('Missing, stale')
    expect(capabilities.invoke).toHaveBeenCalledTimes(1)
  })

  it('binds native admission/completion to the same host run and call identity', async () => {
    const { bridge, capabilities } = fixture()
    await bridge.start()
    await bridge.beginRun({ prompt: 'test', hostRunId: 'run-1' })
    const native = { runId: 'run-1', callId: 'native-1', name: 'write_file', arguments: { file_path: '/workspace/a' } }
    expect((await request(bridge, '/native/before', { ...native, runId: 'other' })).status).toBe(400)
    expect(capabilities.beforeNative).not.toHaveBeenCalled()
    expect((await request(bridge, '/native/before', native)).body.allowed).toBe(true)
    await request(bridge, '/native/after', { ...native, result: { content: 'written' } })
    expect(capabilities.afterNative).toHaveBeenCalledWith({ callId: 'native-1', name: 'write_file', arguments: native.arguments, result: { content: 'written' } }, expect.any(AbortSignal))
  })

  it('waits for a compatible plugin handshake and rejects pending control on disconnect', async () => {
    const { bridge } = fixture()
    await bridge.start()
    const peer = new WebSocket(bridge.url.replace('http:', 'ws:') + '/control', { headers: { authorization: `Bearer ${bridge.token}` } })
    peers.push(peer)
    await new Promise<void>((resolve, reject) => { peer.once('open', resolve); peer.once('error', reject) })
    peer.send(JSON.stringify({ id: 'hello', method: 'hello', params: { protocolVersion: 1 } }))
    await bridge.waitUntilReady()
    peer.on('message', raw => {
      const message = JSON.parse(raw.toString())
      if (message.method === 'initialize') peer.send(JSON.stringify({ id: message.id, result: { initialized: true } }))
      if (message.method === 'compact') peer.close()
    })
    await expect(bridge.control('initialize', { sessionId: 's1' })).resolves.toEqual({ initialized: true })
    await expect(bridge.control('compact', { sessionId: 's1' })).rejects.toThrow('disconnected')
  })

  it('does not confuse browser origin access or another runtime token with host authority', async () => {
    const { bridge } = fixture()
    const second = fixture().bridge
    await bridge.start()
    await second.start()
    expect((await request(bridge, '/context', undefined, `Bearer ${second.token}`)).status).toBe(401)
    const result = await fetch(`${bridge.url}/context`, { headers: { authorization: `Bearer ${bridge.token}`, origin: 'https://untrusted.example' } })
    expect(result.status).toBe(401)
  })
})
