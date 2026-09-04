/**
 * createSubagentStreamRouter 单测（W4a S2，2026-05-30）。
 *
 * sink 是子 Agent 实时流的 session 级统一出口（跨 query 存活）。本测试钉死它的
 * 路由决策（两端 host 共用同一纯路由器，故只需测一处）：
 *
 *   1. **前台 query 内只走 interceptor**：不再另打 sendToActiveClient
 *      （IPC/WS 由 deliver 合并后分发）。
 *   2. **query 外 SUBAGENT_PROGRESS 仍到 relay/sink**：getInQueryRelay 返回
 *      undefined（无活跃 query）时——relayOutOfQuery 被调用（事件不丢），
 *      inQueryRelay 不调用。
 *   3. Daemon 形态（无 sendToActiveClient）：in-query 仅 interceptor、
 *      out-of-query 仅 relayOutOfQuery。
 *   4. 单次投递：同一事件不会既走 interceptor 又走 relayOutOfQuery（不双发）。
 *   5. 异常隔离：任一回调抛错不影响其他路由 / 不外抛。
 */

import { describe, it, expect, vi } from 'vitest';
import { createSubagentStreamRouter } from '../src/delivery/subagent-stream-router.js';
import { ContentBlockEvents, StreamEvents } from '@muse/agent-wire';
import type { StreamEvent } from '@muse/agent-runtime'

function persistParentSession() {
  return vi.fn();
}

function persistMessageEvent(): StreamEvent {
  return {
    type: StreamEvents.PERSIST_MESSAGE,
    payload: { message_id: 'm-term', message_kind: 'tool_artifact' },
  } as StreamEvent;
}

function progressEvent(runId = 'child-1'): StreamEvent {
  return {
    type: StreamEvents.SUBAGENT_PROGRESS,
    payload: { subagent_run_id: runId, step_count: 1 },
  } as StreamEvent;
}

function streamWrapperEvent(runId = 'child-1'): StreamEvent {
  return {
    type: StreamEvents.SUBAGENT_STREAM_EVENT,
    payload: {
      subagent_run_id: runId,
      child_event: {
        type: StreamEvents.SYSTEM_NOTICE,
        payload: { notice_type: 'tool_progress' },
      },
    },
  } as StreamEvent;
}

// ─── 1. 前台 query 内：等同 sender + interceptor ─────────────────────

describe('createSubagentStreamRouter: 前台 query 内（Electron 形态）', () => {
  it('in-query → 只走 inQueryRelay，不打 sendToActiveClient / relayOutOfQuery', () => {
    const sendToActiveClient = vi.fn();
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();

    const sink = createSubagentStreamRouter({
      sendToActiveClient,
      getInQueryRelay: () => inQueryRelay,
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
    });

    const evt = progressEvent();
    sink(evt);

    expect(sendToActiveClient).not.toHaveBeenCalled();
    expect(inQueryRelay).toHaveBeenCalledTimes(1);
    expect(inQueryRelay).toHaveBeenCalledWith(evt);
    expect(relayOutOfQuery).not.toHaveBeenCalled();
  });

  it('getInQueryRelay 每次都重新读（sink 跨 query：先 in-query 后 out-of-query）', () => {
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();
    let interceptor: ((e: StreamEvent) => void) | undefined = inQueryRelay;

    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => interceptor,
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
    });

    // query 内
    sink(progressEvent('a'));
    expect(inQueryRelay).toHaveBeenCalledTimes(1);
    expect(relayOutOfQuery).not.toHaveBeenCalled();

    // query 结束 → interceptor 清空
    interceptor = undefined;
    sink(progressEvent('b'));
    expect(inQueryRelay).toHaveBeenCalledTimes(1); // 仍 1
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1); // 现在走 out-of-query
  });
});

// ─── 2. query 外：事件不丢，走 relayOutOfQuery ───────────────────────

describe('createSubagentStreamRouter: query 外（后台子）', () => {
  it('out-of-query → relayOutOfQuery；不走 inQueryRelay', () => {
    const sendToActiveClient = vi.fn();
    const relayOutOfQuery = vi.fn();

    const sink = createSubagentStreamRouter({
      sendToActiveClient,
      getInQueryRelay: () => undefined, // 无活跃 query
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
    });

    const evt = progressEvent();
    sink(evt);

    // SUBAGENT_PROGRESS 仍到 relay（不丢）
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1);
    expect(relayOutOfQuery).toHaveBeenCalledWith(evt);
    // sendToActiveClient 仍尝试推（活跃客户端可能在，可能 destroyed → 内部守门）
    expect(sendToActiveClient).toHaveBeenCalledTimes(1);
  });

  it('out-of-query transient subagent stream wrappers stay client-only', () => {
    const sendToActiveClient = vi.fn();
    const relayOutOfQuery = vi.fn();

    const sink = createSubagentStreamRouter({
      sendToActiveClient,
      getInQueryRelay: () => undefined,
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
    });

    const evt = streamWrapperEvent();
    sink(evt);

    expect(sendToActiveClient).toHaveBeenCalledWith(evt);
    expect(relayOutOfQuery).not.toHaveBeenCalled();
  });
});

// ─── 3. Daemon 形态（无 sendToActiveClient）─────────────────────────

describe('createSubagentStreamRouter: Daemon 形态（无 IPC sender）', () => {
  it('in-query 仅 interceptor；out-of-query 仅 relayOutOfQuery', () => {
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();
    let interceptor: ((e: StreamEvent) => void) | undefined = inQueryRelay;

    const sink = createSubagentStreamRouter({
      // 无 sendToActiveClient（Daemon 所有流走 gateway relay）
      getInQueryRelay: () => interceptor,
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
    });

    sink(progressEvent('a'));
    expect(inQueryRelay).toHaveBeenCalledTimes(1);
    expect(relayOutOfQuery).not.toHaveBeenCalled();

    interceptor = undefined;
    sink(progressEvent('b'));
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1);
  });
});

// ─── 4. 单次投递（不双发）────────────────────────────────────────────

describe('createSubagentStreamRouter: 单次投递', () => {
  it('同事件不会既走 inQueryRelay 又走 relayOutOfQuery', () => {
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => inQueryRelay,
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
    });
    sink(progressEvent());
    // 二选一，绝不双发（否则 query 内 Django 会收到两份）
    expect(inQueryRelay.mock.calls.length + relayOutOfQuery.mock.calls.length).toBe(1);
  });
});

// ─── 5. 异常隔离 ──────────────────────────────────────────────────────

describe('createSubagentStreamRouter: 异常隔离', () => {
  it('sendToActiveClient 抛错 → 仍走 relayOutOfQuery，不外抛', () => {
    const relayOutOfQuery = vi.fn();
    const sink = createSubagentStreamRouter({
      sendToActiveClient: () => { throw new Error('IPC dead'); },
      getInQueryRelay: () => undefined,
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
      log: () => {},
    });
    expect(() => sink(progressEvent())).not.toThrow();
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1);
  });

  it('getInQueryRelay 抛错 → 退化为 out-of-query relay，不外抛', () => {
    const relayOutOfQuery = vi.fn();
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => { throw new Error('lookup failed'); },
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
      log: () => {},
    });
    expect(() => sink(progressEvent())).not.toThrow();
    expect(relayOutOfQuery).toHaveBeenCalledTimes(1);
  });

  it('inQueryRelay 抛错被吞，不外抛', () => {
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => () => { throw new Error('relay boom'); },
      relayOutOfQuery: vi.fn(),
      persistParentSession: persistParentSession(),
      log: () => {},
    });
    expect(() => sink(progressEvent())).not.toThrow();
  });

  it('relayOutOfQuery 抛错被吞，不外抛', () => {
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => undefined,
      relayOutOfQuery: () => { throw new Error('gateway boom'); },
      persistParentSession: persistParentSession(),
      log: () => {},
    });
    expect(() => sink(progressEvent())).not.toThrow();
  });
});

describe('createSubagentStreamRouter: query 外出站合并后 fan-out', () => {
  it('相邻同键 wrapper delta 合并后再给 IPC，不写 relayOutOfQuery', () => {
    vi.useFakeTimers()
    const sendToActiveClient = vi.fn()
    const relayOutOfQuery = vi.fn()
    const sink = createSubagentStreamRouter({
      sendToActiveClient,
      getInQueryRelay: () => undefined,
      relayOutOfQuery,
      persistParentSession: persistParentSession(),
    })
    const wrap = (text: string): StreamEvent => ({
      type: StreamEvents.SUBAGENT_STREAM_EVENT,
      payload: {
        subagent_run_id: 'child-1',
        child_event: {
          type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
          payload: {
            message_id: 'm-1',
            index: 0,
            delta: { type: 'text_delta', text },
          },
        },
      },
    } as StreamEvent)
    sink(wrap('a'))
    sink(wrap('b'))

    expect(sendToActiveClient).not.toHaveBeenCalled()
    vi.advanceTimersByTime(16)
    expect(sendToActiveClient).toHaveBeenCalledTimes(1)
    expect(relayOutOfQuery).not.toHaveBeenCalled()
    const merged = sendToActiveClient.mock.calls[0][0] as StreamEvent
    expect(
      (merged.payload as { child_event?: { payload?: { delta?: { text?: string } } } })
        .child_event?.payload?.delta?.text,
    ).toBe('ab')
    vi.useRealTimers()
  })
});

describe('createSubagentStreamRouter: 父会话历史与 query 投递拆开', () => {
  it('persist_message 始终 persistParentSession，不经 interceptor', () => {
    const inQueryRelay = vi.fn();
    const relayOutOfQuery = vi.fn();
    const persist = persistParentSession();
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => inQueryRelay,
      relayOutOfQuery,
      persistParentSession: persist,
    });
    const evt = persistMessageEvent();
    sink(evt);
    expect(persist).toHaveBeenCalledWith(evt);
    expect(relayOutOfQuery).toHaveBeenCalledWith(evt);
    expect(inQueryRelay).not.toHaveBeenCalled();
  });

  it('query 外 persist_message 同样落父会话，不依赖 interceptor', () => {
    const persist = persistParentSession();
    const relayOutOfQuery = vi.fn();
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => undefined,
      relayOutOfQuery,
      persistParentSession: persist,
    });
    const evt = persistMessageEvent();
    sink(evt);
    expect(persist).toHaveBeenCalledWith(evt);
    expect(relayOutOfQuery).toHaveBeenCalledWith(evt);
  });

  it('实时 progress 不走 persistParentSession', () => {
    const persist = persistParentSession();
    const inQueryRelay = vi.fn();
    const sink = createSubagentStreamRouter({
      getInQueryRelay: () => inQueryRelay,
      relayOutOfQuery: vi.fn(),
      persistParentSession: persist,
    });
    sink(progressEvent());
    expect(persist).not.toHaveBeenCalled();
    expect(inQueryRelay).toHaveBeenCalledTimes(1);
  });
});
