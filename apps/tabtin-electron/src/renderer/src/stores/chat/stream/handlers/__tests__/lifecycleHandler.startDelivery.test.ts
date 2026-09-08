/**
 * ：lifecycle phase=start 清 sending 的行为断言（非源码嗅探）。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@muse/chat-client'
import type { HandlerContext } from '../streamHandlerTypes'

const storeState = {
  messagesBySessionId: {} as Record<string, ChatMessage[]>,
  patchMessageById: (
    sessionId: string,
    messageId: string,
    patcher: (message: ChatMessage) => ChatMessage,
  ) => {
    const prev = storeState.messagesBySessionId[sessionId] ?? []
    storeState.messagesBySessionId = {
      ...storeState.messagesBySessionId,
      [sessionId]: prev.map((m) => (m.id === messageId ? patcher(m) : m)),
    }
  },
}

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: typeof storeState) => unknown) => (
      typeof selector === 'function' ? selector(storeState) : storeState
    ),
    { getState: () => storeState },
  ),
}))

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

vi.mock('../lifecycleTerminalNotify', () => ({
  ackLifecycleSessionViewedIfPresent: vi.fn(),
  emitOrAckLifecycleTerminalNotification: vi.fn(),
}))

vi.mock('../sessionCleanup', () => ({
  cleanupSessionOnTerminal: vi.fn(),
}))

vi.mock('../assistantSessionState', () => ({
  clearActiveThinking: vi.fn(),
  clearAssistantErrorMeta: vi.fn(),
}))

vi.mock('../errorHandler', () => ({
  handleError: vi.fn(),
}))

vi.mock('../toolCallArgsBufferStore', () => ({
  clearToolCallArgsBuffers: vi.fn(),
  gcStaleToolCallArgsBuffers: vi.fn(),
}))

vi.mock('../../messages/messageCache', () => ({
  cacheMessages: vi.fn(),
}))

vi.mock('../../messages/actions/titleGenerationDedupe', () => ({
  defaultShouldGenerateTitle: () => false,
  requestTitleGenerationOnce: vi.fn(),
}))

vi.mock('../../execution/sessionRunProjection', () => ({
  isSessionBusy: () => false,
}))

vi.mock('../../execution/chatTelemetry', () => ({
  trackChatTelemetry: vi.fn(),
}))

vi.mock('@/services/compactNotificationSummary', () => ({
  compactNotificationSummary: (s: string) => s,
}))

vi.mock('@/utils/chatSessionTokenUsage', () => ({
  extractChatSessionTokenUsage: () => ({}),
  omitMonotonicTokenFields: (v: unknown) => v,
}))

import { handleLifecycleEvent } from '../lifecycleHandler'
import { DshEventTranslator } from '@muse/agent-host/runtime/dsh'

const CLIENT_ID = '11111111-1111-4111-8111-111111111111'
const RUN_ID = '9796076a-2faa-48ba-957b-ea76667a05be'
const SESSION_ID = 'session-1'

function makeCtx(overrides: Partial<HandlerContext> = {}): HandlerContext {
  const updateRunStateForSession = vi.fn()
  return {
    sessionId: SESSION_ID,
    spaceId: 'space-1',
    sessionTitle: '',
    notifyPrefix: '',
    get: () => ({
      agentStepsBySessionId: { [SESSION_ID]: [] },
      updateAgentStepForSession: vi.fn(),
      updateRunStateForSession,
    }),
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    client: {} as HandlerContext['client'],
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
    onLifecycleEnd: vi.fn(),
    ...overrides,
  } as unknown as HandlerContext
}

describe('handleLifecycleEvent phase=start · ', () => {
  beforeEach(() => {
    storeState.messagesBySessionId = {
      [SESSION_ID]: [
        {
          id: 'temp-user-1',
          role: 'user',
          content: '建一张表',
          created_at: '2026-07-22T00:00:00.000Z',
          metadata: { client_message_id: CLIENT_ID },
          sendStatus: 'sending',
        } as ChatMessage,
      ],
    }
  })

  it('携带 source_client_event_id 时标 sent（即使 run_id 不同）', () => {
    const ctx = makeCtx()
    handleLifecycleEvent(
      {
        type: 'agent.stream.lifecycle',
        payload: {
          phase: 'start',
          run_id: RUN_ID,
          source_client_event_id: CLIENT_ID,
        },
      },
      ctx,
    )
    const user = storeState.messagesBySessionId[SESSION_ID][0] as ChatMessage & {
      sendStatus?: string
    }
    expect(user.sendStatus).toBe('sent')
    expect(ctx.addStreamingSession).toHaveBeenCalledWith(SESSION_ID, RUN_ID)
  })

  it('仅有 run_id 时不标 sent（禁止错键）', () => {
    const ctx = makeCtx()
    handleLifecycleEvent(
      {
        type: 'agent.stream.lifecycle',
        payload: {
          phase: 'start',
          run_id: RUN_ID,
        },
      },
      ctx,
    )
    const user = storeState.messagesBySessionId[SESSION_ID][0] as ChatMessage & {
      sendStatus?: string
    }
    expect(user.sendStatus).toBe('sending')
  })
  it('consumes real DSH start/step events as planning before any model token arrives', () => {
    const ctx = makeCtx()
    const translator = new DshEventTranslator(SESSION_ID, RUN_ID, 'selected-model')
    const events = [
      ...translator.translate({ type: 'turn/start', seq: 0, time: 1000, data: { turn: 0 } }),
      ...translator.translate({ type: 'step/start', seq: 1, time: 1100, data: { turn: 0, step: 0 } }),
    ]
    expect(events.map(event => event.type)).toEqual(['agent.stream.lifecycle', 'agent.stream.lifecycle'])
    expect(events.map(event => event.payload.phase)).toEqual(['start', 'turn_start'])
    for (const event of events) handleLifecycleEvent(event, ctx)
    expect(ctx.addStreamingSession).toHaveBeenCalledWith(SESSION_ID, RUN_ID)
    expect(ctx.get().updateRunStateForSession).toHaveBeenCalledWith(SESSION_ID, expect.objectContaining({ phase: 'planning' }))
    expect(events.some(event => event.type === 'agent.stream.content_block_delta')).toBe(false)
  })

})
