import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { StreamEvent } from '@muse/agent-runtime'
import {
  DefaultDeliveryCoordinator,
  type DeliveryPersistenceSinks,
} from '../src/delivery/delivery-coordinator.js'
import type {
  DeliveryTransportPort,
  LocalStreamPort,
  RelayTransportAck,
} from '../src/delivery/delivery-transport-port.js'
import { formatRelayFailureMessage } from '../src/delivery/relay-transport.js'
import {
  FileLlmSnapshotLedgerDirectory,
  LlmSnapshotHttpLedger,
} from '../src/delivery/llm-snapshot-http-ledger.js'
import { LlmSnapshotHttpError } from '../src/delivery/llm-snapshot-http.js'

function doneEvent(extra: Record<string, unknown> = {}): StreamEvent {
  return { type: 'agent.stream.done', payload: { ...extra } } as StreamEvent
}

function createTransport(opts: {
  ack?: RelayTransportAck
  hangSend?: boolean
  headless?: boolean
  /**
   * NAK descriptor the fake `sendRelayBatch` throws with. The platform transport
   * contract (delivery-transport-port.ts) is *throw on failure*; a NAK is a thrown
   * Error whose message carries `error_code` / `retryable` (relay-transport.ts).
   */
  nak?: { errorCode: string; retryable: boolean }
  /** Throw the NAK for the first N send attempts, then succeed. */
  failAttempts?: number
  /** Throw the NAK on every send attempt. */
  alwaysFail?: boolean
  uploadLlmSnapshot?: DeliveryTransportPort['uploadLlmSnapshot']
} = {}) {
  const localEmitted: StreamEvent[] = []
  const localClose = vi.fn()
  const localFail = vi.fn()
  const localStream: LocalStreamPort = {
    emit: (e) => localEmitted.push(e),
    close: localClose,
    fail: localFail,
    shouldAbortIteration: () => false,
  }
  const relayed: Array<{ organizationId: string; events: unknown[] }> = []
  let sendAttempts = 0
  const nak = opts.nak ?? { errorCode: 'sync_write_failed', retryable: true }
  const transport: DeliveryTransportPort = {
    openLocalStream: () => (opts.headless ? undefined : localStream),
    uploadLlmSnapshot: opts.uploadLlmSnapshot,
    sendRelayBatch: async (ctx, events) => {
      sendAttempts += 1
      // Record every *attempt* (including failing ones) so retries can be
      // asserted for whole-batch idempotency.
      relayed.push({ organizationId: ctx.organizationId, events })
      if (opts.hangSend) return new Promise<RelayTransportAck>(() => {})
      if (opts.alwaysFail || (opts.failAttempts && sendAttempts <= opts.failAttempts)) {
        throw new Error(formatRelayFailureMessage(nak))
      }
      return opts.ack ?? {}
    },
    createOutboxStore: () => ({
      persist: () => undefined,
      drain: async function* () { return },
      remove: () => undefined,
    }),
    subscribeReconnect: () => () => undefined,
  }
  return {
    transport,
    localStream,
    localEmitted,
    localClose,
    localFail,
    relayed,
    getSendAttempts: () => sendAttempts,
  }
}

function createSinks() {
  const sessionEvents: StreamEvent[] = []
  const eventLog: Array<{ type: string }> = []
  const snapshots: unknown[] = []
  const sinks: DeliveryPersistenceSinks = {
    appendSessionStreamEvent: (e) => { sessionEvents.push(e) },
    appendEventLog: (entry) => { eventLog.push(entry) },
    appendSnapshot: (p) => { snapshots.push(p) },
  }
  return { sinks, sessionEvents, eventLog, snapshots }
}

describe('DefaultDeliveryCoordinator', () => {
  it('emits critical events locally and relays them with the org id', async () => {
    const t = createTransport()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    await turn.emit(doneEvent())
    expect(t.localEmitted).toHaveLength(1)
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    expect(t.relayed[0].organizationId).toBe('org-1')
  })

  it('maps main runtime-local run_id to the business run at the emit boundary', async () => {
    const t = createTransport()
    const { sinks, sessionEvents } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      businessRunId: 'business-run-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    await turn.emit(doneEvent({
      run_id: 'runtime-local-run-1',
      trace_id: 'runtime-local-trace-1',
    }))

    expect(t.localEmitted[0]?.payload).toMatchObject({
      run_id: 'business-run-1',
      trace_id: 'runtime-local-trace-1',
    })
    expect(sessionEvents[0]?.payload).toMatchObject({
      run_id: 'business-run-1',
      trace_id: 'runtime-local-trace-1',
    })
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    expect((t.relayed[0].events[0] as StreamEvent).payload).toMatchObject({
      run_id: 'business-run-1',
      trace_id: 'runtime-local-trace-1',
    })
  })

  it('persists response llm_snapshot locally without projecting another relay snapshot', async () => {
    const t = createTransport()
    const { sinks, snapshots } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })

    await turn.emit({
      type: 'agent.stream.llm_snapshot',
      payload: {
        runId: 'run-1',
        iterationId: 'run-1:0',
        iteration: 0,
        phase: 'response',
        model: 'test-model',
      },
    } as StreamEvent)
    await new Promise((resolve) => setTimeout(resolve, 200))

    expect(snapshots).toEqual([
      expect.objectContaining({
        runId: 'run-1',
        iterationId: 'run-1:0',
        phase: 'response',
      }),
    ])
    expect(t.localEmitted).toHaveLength(1)
    expect(t.relayed).toHaveLength(0)
  })

  it('keeps full llm_request local and relays only the bounded snapshot projection', async () => {
    const t = createTransport()
    const { sinks, snapshots } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })

    await turn.emit({
      type: 'agent.stream.llm_request',
      payload: {
        runId: 'run-1',
        iterationId: 'run-1:0',
        iteration: 0,
        phase: 'request',
        model: 'test-model',
        messages: [{ role: 'user', content: 'private prompt' }],
      },
    } as StreamEvent)

    expect(snapshots).toHaveLength(1)
    expect(t.localEmitted.map((event) => event.type)).toEqual(['agent.stream.llm_request'])
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    expect((t.relayed[0].events as StreamEvent[]).map((event) => event.type)).toEqual([
      'agent.stream.llm_snapshot',
    ])
    expect(JSON.stringify(t.relayed[0].events).length).toBeLessThan(700_000)
  })

  it('holds llm_request HTTP snapshot until the turn ends and keeps it off the relay queue', async () => {
    const uploaded: Array<{ sessionId: string; payload: Record<string, unknown> }> = []
    const t = createTransport({
      uploadLlmSnapshot: async (ctx, payload) => {
        uploaded.push({ sessionId: ctx.sessionId, payload })
      },
    })
    const { sinks } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })

    await turn.emit({
      type: 'agent.stream.llm_request',
      payload: {
        runId: 'run-1',
        iterationId: 'run-1:0',
        iteration: 0,
        phase: 'request',
        model: 'test-model',
        messages: [{ role: 'user', content: 'private prompt' }],
      },
    } as StreamEvent)
    await turn.emit({
      type: 'agent.stream.persist_message',
      payload: { message_id: 'assistant-1', content: 'done' },
    } as StreamEvent)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(uploaded).toHaveLength(0)

    await turn.complete({ kind: 'succeeded' })
    await vi.waitFor(() => expect(uploaded).toHaveLength(1))
    expect(uploaded[0]?.sessionId).toBe('conversation-1')
    expect(uploaded[0]?.payload).toMatchObject({ runId: 'run-1', phase: 'request' })
    expect(t.relayed.map((batch) => (batch.events as StreamEvent[]).map((event) => event.type)))
      .toEqual([['agent.stream.persist_message']])
  })

  it('uploads one HTTP snapshot for request then response and keeps the latest in-flight payload', async () => {
    const uploaded: Array<Record<string, unknown>> = []
    let releaseFirst: (() => void) | undefined
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let uploadCount = 0
    const t = createTransport({
      uploadLlmSnapshot: async (_ctx, payload) => {
        uploadCount += 1
        if (uploadCount === 1) await firstGate
        uploaded.push(payload)
      },
    })
    const { sinks } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })

    await turn.emit({
      type: 'agent.stream.llm_request',
      payload: {
        runId: 'run-1',
        iteration: 0,
        phase: 'request',
        model: 'test-model',
      },
    } as StreamEvent)
    await turn.emit({
      type: 'agent.stream.llm_snapshot',
      payload: {
        runId: 'run-1',
        iteration: 0,
        phase: 'response',
        model: 'test-model',
      },
    } as StreamEvent)
    await turn.emit({
      type: 'agent.stream.llm_request',
      payload: {
        runId: 'run-1',
        iteration: 1,
        phase: 'request',
        model: 'test-model',
      },
    } as StreamEvent)
    await turn.emit({
      type: 'agent.stream.llm_snapshot',
      payload: {
        runId: 'run-1',
        iteration: 1,
        phase: 'response',
        model: 'test-model',
      },
    } as StreamEvent)

    await vi.waitFor(() => expect(uploadCount).toBe(1))
    expect(uploaded).toHaveLength(0)
    releaseFirst?.()
    await vi.waitFor(() => expect(uploaded).toHaveLength(2))
    expect(uploaded[0]).toMatchObject({ runId: 'run-1', iteration: 0, phase: 'response' })
    expect(uploaded[1]).toMatchObject({ runId: 'run-1', iteration: 1, phase: 'response' })
    expect(t.relayed).toHaveLength(0)
  })

  it('uploads response llm_snapshot via HTTP without adding a relay batch', async () => {
    const uploaded: Array<Record<string, unknown>> = []
    const t = createTransport({
      uploadLlmSnapshot: async (_ctx, payload) => {
        uploaded.push(payload)
      },
    })
    const { sinks } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })

    await turn.emit({
      type: 'agent.stream.llm_snapshot',
      payload: {
        runId: 'run-1',
        iterationId: 'run-1:0',
        iteration: 0,
        phase: 'response',
        model: 'test-model',
      },
    } as StreamEvent)
    await vi.waitFor(() => expect(uploaded).toHaveLength(1))
    expect(uploaded[0]).toMatchObject({ runId: 'run-1', phase: 'response' })
    expect(t.relayed).toHaveLength(0)
  })

  it('does not flush a held request when the next turn only drains the ledger', async () => {
    const uploaded: Array<Record<string, unknown>> = []
    const t = createTransport({
      uploadLlmSnapshot: async (_ctx, payload) => {
        uploaded.push(payload)
      },
    })
    const { sinks } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const firstTurn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    await firstTurn.emit({
      type: 'agent.stream.llm_request',
      payload: {
        runId: 'run-hold',
        iteration: 0,
        phase: 'request',
        model: 'test-model',
      },
    } as StreamEvent)
    coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(uploaded).toHaveLength(0)

    await firstTurn.complete({ kind: 'succeeded' })
    await vi.waitFor(() => expect(uploaded).toHaveLength(1))
    expect(uploaded[0]).toMatchObject({ runId: 'run-hold', phase: 'request' })
  })

  it('retries a transient HTTP snapshot failure in the same turn', async () => {
    const uploaded: Array<Record<string, unknown>> = []
    let attempts = 0
    const t = createTransport({
      uploadLlmSnapshot: async (_ctx, payload) => {
        attempts += 1
        if (attempts === 1) throw new Error('llm snapshot HTTP 500')
        uploaded.push(payload)
      },
    })
    const { sinks } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const firstTurn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    await firstTurn.emit({
      type: 'agent.stream.llm_snapshot',
      payload: {
        runId: 'run-retry',
        iteration: 0,
        phase: 'response',
        model: 'test-model',
      },
    } as StreamEvent)
    await vi.waitFor(() => expect(uploaded).toHaveLength(1))
    expect(uploaded[0]).toMatchObject({ runId: 'run-retry', phase: 'response' })
    expect(attempts).toBe(2)
  })

  it('drops a permanent HTTP 4xx snapshot instead of retrying it forever', async () => {
    const uploaded: Array<Record<string, unknown>> = []
    let attempts = 0
    const t = createTransport({
      uploadLlmSnapshot: async (_ctx, payload) => {
        attempts += 1
        throw new LlmSnapshotHttpError(400)
      },
    })
    const { sinks } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const firstTurn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    await firstTurn.emit({
      type: 'agent.stream.llm_snapshot',
      payload: {
        runId: 'run-poison',
        iteration: 0,
        phase: 'response',
        model: 'test-model',
      },
    } as StreamEvent)
    await vi.waitFor(() => expect(attempts).toBe(1))

    coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(attempts).toBe(1)
    expect(uploaded).toHaveLength(0)
  })

  it('does not put snapshots back on relay when HTTP is wired but organizationId is missing', async () => {
    const uploaded: Array<Record<string, unknown>> = []
    const t = createTransport({
      uploadLlmSnapshot: async (_ctx, payload) => {
        uploaded.push(payload)
      },
    })
    const { sinks } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      persist: sinks,
    })
    await turn.emit({
      type: 'agent.stream.llm_request',
      payload: {
        runId: 'run-no-org',
        iteration: 0,
        phase: 'request',
        model: 'test-model',
      },
    } as StreamEvent)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(t.relayed).toHaveLength(0)
    expect(uploaded).toHaveLength(0)
  })

  it('restores the snapshot ledger on recover and uploads leftover entries', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-snapshot-recover-'))
    const directory = new FileLlmSnapshotLedgerDirectory(tmpDir)
    const leftover = {
      runId: 'run-recover',
      iteration: 3,
      phase: 'response',
      model: 'test-model',
    }
    const seed = new LlmSnapshotHttpLedger(
      { sessionId: 'conversation-recover', organizationId: 'org-recover' },
      directory.storeFor('conversation-recover'),
    )
    seed.remember(leftover)
    seed.flushSync()

    const uploaded: Array<{ sessionId: string; payload: Record<string, unknown> }> = []
    const t = createTransport({
      uploadLlmSnapshot: async (ctx, payload) => {
        uploaded.push({ sessionId: ctx.sessionId, payload })
      },
    })
    const coordinator = new DefaultDeliveryCoordinator({
      transport: t.transport,
      llmSnapshotLedgerDirectory: directory,
    })
    await coordinator.kickRecoverAndBackfill({ activateOwner: false })
    await vi.waitFor(() => expect(uploaded).toHaveLength(1))
    expect(uploaded[0]?.sessionId).toBe('conversation-recover')
    expect(uploaded[0]?.payload).toMatchObject({ runId: 'run-recover', iteration: 3 })
    await vi.waitFor(() => {
      expect(directory.storeFor('conversation-recover').loadFile()).toBeNull()
    })
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('preserves subagent run_id and skips transient subagent stream event logs', async () => {
    const t = createTransport()
    const { sinks, sessionEvents, eventLog } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      businessRunId: 'business-run-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    await turn.emit({
      type: 'agent.stream.subagent_stream_event',
      payload: {
        run_id: 'child-run-1',
        subagent_run_id: 'child-run-1',
        child_event: { type: 'agent.stream.content_block_delta', payload: {} },
      },
    } as StreamEvent)

    await vi.waitFor(() => expect(t.localEmitted).toHaveLength(1))
    expect(t.localEmitted[0]?.payload).toMatchObject({
      run_id: 'child-run-1',
      subagent_run_id: 'child-run-1',
    })
    expect(sessionEvents).toHaveLength(0)
    expect(eventLog).toHaveLength(0)
  })

  it('projects relay message ids into a local persisted event', async () => {
    const t = createTransport({ ack: { messageIds: ['m1', 'm2'] } })
    const persistedMarker = { type: 'agent.stream.message_persisted', payload: {} } as StreamEvent
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      projectPersistedEvent: () => persistedMarker,
    })
    await turn.emit(doneEvent())
    await vi.waitFor(() =>
      expect(t.localEmitted.some((e) => e.type === 'agent.stream.message_persisted')).toBe(true),
    )
  })

  it('runs persistence sinks in order and injects task_id on done', async () => {
    const t = createTransport()
    const { sinks, sessionEvents, eventLog } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      taskId: 'prompt_123',
      persist: sinks,
    })
    await turn.emit(doneEvent())
    expect(sessionEvents).toHaveLength(1)
    // done goes to the event log too
    expect(eventLog.some((e) => e.type === 'agent.stream.done')).toBe(true)
    // task_id injected into the locally emitted done
    const localDone = t.localEmitted.find((e) => e.type === 'agent.stream.done')
    expect((localDone?.payload as { task_id?: string }).task_id).toBe('prompt_123')
  })

  it('delivers transient observer events without writing parent session storage', async () => {
    const t = createTransport()
    const { sinks, sessionEvents, eventLog, snapshots } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    const event = {
      type: 'agent.stream.content_block_delta',
      payload: { subagent_run_id: 'child-1' },
    } as StreamEvent
    const deliveredEvent = {
      ...event,
      payload: { ...event.payload, run_id: 'child-1' },
    }

    await turn.emitTransient(event)

    expect(sessionEvents).toHaveLength(0)
    expect(eventLog).toHaveLength(0)
    expect(snapshots).toHaveLength(0)
    await vi.waitFor(() => expect(t.localEmitted).toEqual([deliveredEvent]))
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    expect(t.relayed[0].events).toEqual([deliveredEvent])
  })

  it('keeps subagent stream wrappers live-only even on the normal emit path', async () => {
    const t = createTransport()
    const { sinks, sessionEvents, eventLog } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    const event = {
      type: 'agent.stream.subagent_stream_event',
      payload: {
        subagent_run_id: 'child-1',
        child_event: {
          type: 'agent.stream.content_block_delta',
          payload: { delta: { type: 'text_delta', text: 'token' } },
        },
      },
    } as StreamEvent
    const deliveredEvent = {
      ...event,
      payload: { ...event.payload, run_id: 'child-1' },
    }

    await turn.emit(event)

    expect(sessionEvents).toHaveLength(0)
    expect(eventLog).toHaveLength(0)
    await vi.waitFor(() => expect(t.localEmitted).toEqual([deliveredEvent]))
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    expect(t.relayed[0].events).toEqual([deliveredEvent])
  })

  it('keeps isomorphic child stream events live-only in the parent session', async () => {
    const t = createTransport()
    const { sinks, sessionEvents, eventLog } = createSinks()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
      persist: sinks,
    })
    const event = {
      type: 'agent.stream.content_block_delta',
      payload: {
        message_id: 'm-1',
        index: 0,
        delta: { type: 'text_delta', text: 'token' },
        subagent_run_id: 'child-1',
      },
    } as StreamEvent
    const deliveredEvent = {
      ...event,
      payload: { ...event.payload, run_id: 'child-1' },
    }

    await turn.emit(event)

    expect(sessionEvents).toHaveLength(0)
    expect(eventLog).toHaveLength(0)
    await vi.waitFor(() => expect(t.localEmitted).toEqual([deliveredEvent]))
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    expect(t.relayed[0].events).toEqual([deliveredEvent])
  })

  it('merges adjacent deltas once before local IPC and relay fan-out', async () => {
    const t = createTransport()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    const base = {
      message_id: 'm-merge',
      index: 0,
      subagent_run_id: 'child-1',
    }
    await turn.emitTransient({
      type: 'agent.stream.content_block_delta',
      payload: { ...base, delta: { type: 'text_delta', text: 'hel' } },
    } as StreamEvent)
    await turn.emitTransient({
      type: 'agent.stream.content_block_delta',
      payload: { ...base, delta: { type: 'text_delta', text: 'lo' } },
    } as StreamEvent)
    await turn.complete({ kind: 'succeeded' })

    expect(t.localEmitted).toHaveLength(1)
    expect(t.localEmitted[0]?.payload).toMatchObject({
      ...base,
      run_id: 'child-1',
      delta: { type: 'text_delta', text: 'hello' },
    })
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    expect(t.relayed[0].events).toHaveLength(1)
    expect(t.relayed[0].events[0]?.payload).toMatchObject({
      delta: { type: 'text_delta', text: 'hello' },
    })
  })

  it('does not relay subagent wrappers that contain a full llm_request', async () => {
    const t = createTransport()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    const event = {
      type: 'agent.stream.subagent_stream_event',
      payload: {
        subagent_run_id: 'child-1',
        child_event: {
          type: 'agent.stream.llm_request',
          payload: { messages: [{ role: 'user', content: 'private child prompt' }] },
        },
      },
    } as StreamEvent

    await turn.emit(event)
    await turn.settleRelay()

    expect(t.localEmitted).toHaveLength(1)
    expect(t.relayed).toHaveLength(0)
  })

  it('complete seals local stream immediately; settleRelay respects the ACK deadline', async () => {
    const t = createTransport({ hangSend: true })
    const coordinator = new DefaultDeliveryCoordinator({
      transport: t.transport,
      config: { terminalFlushDeadlineMs: 20 },
    })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    await turn.emit(doneEvent())
    const start = Date.now()
    await turn.complete({ kind: 'succeeded' })
    expect(Date.now() - start).toBeLessThan(50)
    expect(t.localClose).toHaveBeenCalledWith('completed')
    await turn.settleRelay()
    expect(Date.now() - start).toBeLessThan(500)
  })

  it('failed outcome flushes pending deltas before the lifecycle error', async () => {
    const t = createTransport()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    await turn.emit({
      type: 'agent.stream.content_block_delta',
      payload: {
        message_id: 'm1',
        index: 0,
        delta: { type: 'text_delta', text: 'hi' },
      },
    } as StreamEvent)
    const errorEvent = { type: 'agent.stream.lifecycle', payload: { phase: 'error' } } as StreamEvent
    await turn.complete({ kind: 'failed', error: new Error('boom'), lifecycleErrorEvent: errorEvent })
    expect(t.localEmitted.map((e) => e.type)).toEqual([
      'agent.stream.content_block_delta',
      'agent.stream.lifecycle',
    ])
    expect((t.localEmitted[0]?.payload as { delta?: { text?: string } }).delta?.text).toBe('hi')
    expect(t.localFail).toHaveBeenCalled()
  })

  it('failed outcome emits the lifecycle error and fails the local stream', async () => {
    const t = createTransport()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    const errorEvent = { type: 'agent.stream.lifecycle', payload: { phase: 'error' } } as StreamEvent
    await turn.complete({ kind: 'failed', error: new Error('boom'), lifecycleErrorEvent: errorEvent })
    expect(t.localEmitted.some((e) => e.type === 'agent.stream.lifecycle')).toBe(true)
    expect(t.localFail).toHaveBeenCalled()
  })

  it('maps runtime-local run_id on the complete lifecycle-error path', async () => {
    const t = createTransport()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      businessRunId: 'business-run-1',
      organizationId: 'org-1',
    })
    const errorEvent = {
      type: 'agent.stream.lifecycle',
      payload: {
        phase: 'error',
        run_id: 'runtime-local-run-1',
        trace_id: 'runtime-local-trace-1',
        subagent_run_id: 'runtime-local-subagent-1',
      },
    } as StreamEvent

    await turn.complete({
      kind: 'failed',
      error: new Error('boom'),
      lifecycleErrorEvent: errorEvent,
    })

    expect(t.localEmitted[0]?.payload).toMatchObject({
      run_id: 'runtime-local-run-1',
      trace_id: 'runtime-local-trace-1',
      subagent_run_id: 'runtime-local-subagent-1',
    })
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    expect((t.relayed[0].events[0] as StreamEvent).payload).toMatchObject({
      run_id: 'runtime-local-run-1',
      trace_id: 'runtime-local-trace-1',
      subagent_run_id: 'runtime-local-subagent-1',
    })
  })

  it('cancel closes the local stream as aborted and is idempotent with complete', async () => {
    const t = createTransport()
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    await turn.cancel()
    await turn.complete({ kind: 'succeeded' })
    expect(t.localClose).toHaveBeenCalledTimes(1)
    expect(t.localClose).toHaveBeenCalledWith('aborted')
  })

  it('headless host (no local stream) still relays', async () => {
    const t = createTransport({ headless: true })
    const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
    const turn = coordinator.openTurn({
      lifecycleSessionId: 'session-1',
      conversationId: 'conversation-1',
      organizationId: 'org-1',
    })
    await turn.emit(doneEvent())
    await vi.waitFor(() => expect(t.relayed).toHaveLength(1))
    await turn.complete({ kind: 'succeeded' })
    expect(t.localEmitted).toHaveLength(0)
  })
})

// ─── NAK / relay failure chain ───────────────────────────────────────
//
// Review 指出 NAK 分支零覆盖。这些用例锁定 relay batch send 失败（NAK）时的真实行为：
//
// 关键的源码事实（读 delivery-coordinator.ts + delivery-batch-buffer.ts +
// delivery-transport-port.ts 得出）：
//   1. DeliveryTransportPort.sendRelayBatch 的契约是 **失败即 throw**（端口文件
//      注释："Throws on failure; ACK returned on success"）。NAK 是一个 Error，
//      其 message 携带 `error_code` / `retryable`（relay-transport.ts 的
//      formatRelayFailureMessage / parseRelayFailureFromError 约定）。
//   2. coordinator 的 relayTransport.send 只读 `ack.messageIds`，**不解释返回值里的
//      `ack.ok`**——因此 NAK 必须以 throw 形式抛出才会进入失败链；一个以返回值
//      形式携带 `{ ack: { ok:false } }` 的 NAK 会被当成成功、静默吞掉（见文末 report）。
//   3. throw 之后由 DeliveryBatchBuffer 接管：**整批**指数退避重试 [2s,5s,12s]
//      （幂等，依赖 client_event_id），耗尽后 handoff 到 onExhausted，而不是
//      warn 后静默丢弃。此层 **不按 retryable 分支**——retryable=true→保留 /
//      false→归档 的判定在下游 RelayRetryQueue（relay-retry-queue.test.ts 已覆盖）。
describe('DefaultDeliveryCoordinator · NAK relay failure chain', () => {
  it('retries the whole batch idempotently on a transient (retryable) NAK and recovers', async () => {
    vi.useFakeTimers()
    try {
      // 第一次 send 抛 retryable NAK，第二次成功。
      const t = createTransport({
        failAttempts: 1,
        nak: { errorCode: 'sync_write_failed', retryable: true },
      })
      const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
      const turn = coordinator.openTurn({
        lifecycleSessionId: 'session-1',
        conversationId: 'conversation-1',
        organizationId: 'org-1',
      })
      // done 是 critical → 立即 flush → attempt 1 抛 NAK。
      await turn.emit(doneEvent({ client_event_id: 'evt-1' }))
      // 退避 2s 后重投 → attempt 2 成功。
      await vi.advanceTimersByTimeAsync(2_000)

      // 未被静默吞掉：确实重投了整批，共 2 次尝试。
      expect(t.getSendAttempts()).toBe(2)
      expect(t.relayed).toHaveLength(2)
      // 幂等重投：两次尝试是**同一整批**（同样的事件、同样的 payload）。
      expect(t.relayed[1].events).toEqual(t.relayed[0].events)
      expect((t.relayed[0].events as Array<{ type: string }>).map((e) => e.type)).toEqual([
        'agent.stream.done',
      ])
    } finally {
      vi.useRealTimers()
    }
  })

  it('bounds in-memory retries on a persistent NAK and hands the whole batch to onExhausted (not silently dropped)', async () => {
    vi.useFakeTimers()
    try {
      const t = createTransport({
        alwaysFail: true,
        nak: { errorCode: 'sync_write_failed', retryable: true },
      })
      const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
      const onExhausted = vi.fn()
      const turn = coordinator.openTurn({
        lifecycleSessionId: 'session-1',
        conversationId: 'conversation-1',
        organizationId: 'org-1',
        onExhausted,
      })
      await turn.emit(doneEvent({ client_event_id: 'evt-1' }))
      // 退避预算 [2s,5s,12s] 全部走完：初次 + 3 次重试 = 4 次尝试后耗尽。
      await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 12_000)

      // 有界重试：绝不无限循环，恰好 4 次尝试。
      expect(t.getSendAttempts()).toBe(4)
      // 每次都是整批重投（幂等）。
      for (const attempt of t.relayed) {
        expect((attempt.events as Array<{ type: string }>).map((e) => e.type)).toEqual([
          'agent.stream.done',
        ])
      }
      // 不静默丢弃：耗尽后把**整批**交给持久化 handoff。
      expect(onExhausted).toHaveBeenCalledTimes(1)
      const [sessionId, events] = onExhausted.mock.calls[0] as [string, Array<{ type: string }>]
      expect(sessionId).toBe('conversation-1')
      expect(events.map((e) => e.type)).toEqual(['agent.stream.done'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not retry or hand off for a non-retryable NAK', async () => {
    // retryable=false 代表 relay 已判定继续重放没有意义；buffer 直接 settle，
    // 避免权限类错误把出站队列拖进无效内存重试。
    vi.useFakeTimers()
    try {
      const t = createTransport({
        alwaysFail: true,
        nak: { errorCode: 'WS_1005_PERMISSION_DENIED', retryable: false },
      })
      const coordinator = new DefaultDeliveryCoordinator({ transport: t.transport })
      const onExhausted = vi.fn()
      const turn = coordinator.openTurn({
        lifecycleSessionId: 'session-1',
        conversationId: 'conversation-1',
        organizationId: 'org-1',
        onExhausted,
      })
      await turn.emit(doneEvent({ client_event_id: 'evt-1' }))
      await vi.advanceTimersByTimeAsync(2_000 + 5_000 + 12_000)

      expect(t.getSendAttempts()).toBe(1)
      expect(onExhausted).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('terminal barrier unlocks the local sentinel after the deadline when relay keeps NAKing', async () => {
    vi.useFakeTimers()
    try {
      const t = createTransport({
        alwaysFail: true,
        nak: { errorCode: 'sync_write_failed', retryable: true },
      })
      const coordinator = new DefaultDeliveryCoordinator({
        transport: t.transport,
        config: { terminalFlushDeadlineMs: 20 },
      })
      const turn = coordinator.openTurn({
        lifecycleSessionId: 'session-1',
        conversationId: 'conversation-1',
        organizationId: 'org-1',
      })
      // attempt 1 抛 NAK，退避重试挂在 2s 之后（远晚于 20ms 截止）。
      await turn.emit(doneEvent({ client_event_id: 'evt-1' }))
      await vi.advanceTimersByTimeAsync(0)
      expect(t.getSendAttempts()).toBe(1)

      // relay 仍在失败重试途中：complete 立即关本地流；settleRelay 在 deadline 后返回。
      await turn.complete({ kind: 'succeeded' })
      expect(t.localClose).toHaveBeenCalledWith('completed')

      const settling = turn.settleRelay()
      await vi.advanceTimersByTimeAsync(20)
      await settling
    } finally {
      vi.useRealTimers()
    }
  })
})
