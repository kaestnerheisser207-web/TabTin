/**
 * 墙钟 live：模拟三路并行子 Agent token 洪峰，看 deliver 合并后 IPC/WS 次数。
 */
import { describe, expect, it } from 'vitest'
import type { StreamEvent } from '@muse/agent-runtime'
import { DefaultDeliveryCoordinator } from '../src/delivery/delivery-coordinator.js'
import type {
  DeliveryTransportPort,
  LocalStreamPort,
  RelayTransportAck,
} from '../src/delivery/delivery-transport-port.js'
import { CONTENT_BLOCK_DELTA_TYPE } from '../src/delivery/relay-delta-coalesce.js'
import { OutboundStreamCoalesceBuffer } from '../src/delivery/outbound-stream-coalesce.js'

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function createTransport() {
  const localEmitted: StreamEvent[] = []
  const relayed: unknown[][] = []
  const localStream: LocalStreamPort = {
    emit: (e) => localEmitted.push(e),
    close: () => undefined,
    fail: () => undefined,
    shouldAbortIteration: () => false,
  }
  const transport: DeliveryTransportPort = {
    openLocalStream: () => localStream,
    sendRelayBatch: async (_ctx, events) => {
      relayed.push(events)
      return {} as RelayTransportAck
    },
    createOutboxStore: () => ({
      persist: () => undefined,
      drain: async function* () { return },
      remove: () => undefined,
    }),
    subscribeReconnect: () => () => undefined,
  }
  return { transport, localEmitted, relayed }
}

describe('live flood coalesce', () => {
  it('三路交错 12k delta：deliver 后 IPC/WS 同份合并结果', async () => {
    const t = createTransport()
    const turn = new DefaultDeliveryCoordinator({ transport: t.transport }).openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    const children = ['child-a', 'child-b', 'child-c']
    const perChild = 4000
    const started = Date.now()
    for (let i = 0; i < perChild; i++) {
      for (const id of children) {
        await turn.emitTransient({
          type: CONTENT_BLOCK_DELTA_TYPE,
          payload: {
            message_id: `msg-${id}`,
            index: 0,
            subagent_run_id: id,
            delta: { type: 'text_delta', text: 'x' },
          },
        } as StreamEvent)
      }
    }
    await turn.complete({ kind: 'succeeded' })
    await sleep(20)
    const elapsed = Date.now() - started
    const inbound = perChild * children.length
    const ipc = t.localEmitted.length
    const relayEvents = t.relayed.flat().length
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      pattern: 'deliver-round-robin-3-children',
      inbound,
      ipc,
      relayEvents,
      elapsedMs: elapsed,
    }))
    expect(ipc).toBe(children.length)
    expect(relayEvents).toBe(children.length)
  }, 15_000)

  it('三路各连续推完：记录合并比', async () => {
    const emit = { n: 0 }
    const buffer = new OutboundStreamCoalesceBuffer(() => { emit.n += 1 })
    const children = ['child-a', 'child-b', 'child-c']
    const perChild = 4000
    const started = Date.now()
    for (const id of children) {
      for (let i = 0; i < perChild; i++) {
        buffer.push({
          type: CONTENT_BLOCK_DELTA_TYPE,
          payload: {
            message_id: `msg-${id}`,
            index: 0,
            subagent_run_id: id,
            delta: { type: 'text_delta', text: 'x' },
          },
        })
      }
    }
    buffer.flush()
    const elapsed = Date.now() - started
    const inbound = perChild * children.length
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      pattern: 'sequential-per-child',
      inbound,
      outbound: emit.n,
      ratio: inbound / Math.max(emit.n, 1),
      elapsedMs: elapsed,
    }))
    expect(emit.n).toBe(children.length)
  }, 15_000)
})
