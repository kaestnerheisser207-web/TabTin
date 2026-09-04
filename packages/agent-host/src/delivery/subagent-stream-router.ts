/**
 * subagent-stream-sink —— 子 Agent 实时流的 **session 级统一出口**（W4a S2）。
 *
 * 父会话历史与 query 投递必须拆开：
 *   - **历史**：`persist_message` / `compaction` 写父 session 的 message-blocks。
 *     与当前有没有 eventInterceptor 无关。后台子 outlive 父 turn 时也走这里，
 *     终态不再只进 subagents.jsonl。
 *   - **投递**：query 内走 interceptor；query 外走 client + relay。
 *     persist 事实不再经 interceptor 落盘，避免「投递通道兼落盘」的分叉。
 */

import { StreamEvents } from '@muse/agent-wire'
import type { StreamEvent } from '@muse/agent-runtime'
import {
  routeDeliveryEvent,
  type DeliveryEventSource,
} from './delivery-event-routing.js'
import { OutboundStreamCoalesceBuffer } from './outbound-stream-coalesce.js'

export function isParentSessionHistoryEvent(event: StreamEvent): boolean {
  return event.type === StreamEvents.PERSIST_MESSAGE
    || event.type === StreamEvents.COMPACTION
}

export interface SubagentStreamRouterDeps {
  /**
   * 推给「当前活跃客户端」的通道（Electron：IPC；Daemon：省略）。
   * 仅 query 外的实时事件使用；query 内由 interceptor → deliver 统一出站。
   */
  sendToActiveClient?: (event: StreamEvent) => void;
  /**
   * 取「当前 in-query relay」——即 `HostState.eventInterceptor`。**仅 query 内
   * 非空**（query 结束 finally 清空）。只投递实时事件，不负责父会话历史落盘。
   */
  getInQueryRelay: () => ((event: StreamEvent) => void) | undefined;
  /**
   * 观测层 / Django relay。历史事件始终走这里（与 query 无关）；
   * 实时事件仅在无 interceptor 时走这里。
   */
  relayOutOfQuery: (event: StreamEvent) => void;
  /**
   * 父会话历史落盘。`persist_message` / `compaction` 必经此口，与 query 生命周期无关。
   */
  persistParentSession: (event: StreamEvent) => void | Promise<void>;
  source?: DeliveryEventSource;
  log?: (msg: string, err?: unknown) => void;
}

function invokeSafely(
  label: string,
  fn: () => void | Promise<void>,
  log: (msg: string, err?: unknown) => void,
): void {
  try {
    const result = fn()
    if (result && typeof (result as Promise<void>).then === 'function') {
      void (result as Promise<void>).catch((err) => log(`${label} rejected`, err))
    }
  } catch (err) {
    log(`${label} threw`, err)
  }
}

/**
 * 构造 session 级子 Agent 流出口。返回的函数即 `HostState.subagentStreamSink`。
 */
export function createSubagentStreamRouter(
  deps: SubagentStreamRouterDeps,
): (event: StreamEvent) => void {
  const log = deps.log ?? (() => {});
  const source = deps.source ?? 'subagent_stream';
  const fanoutOutOfQuery = (event: StreamEvent): void => {
    if (deps.sendToActiveClient) {
      invokeSafely('sendToActiveClient', () => deps.sendToActiveClient?.(event), log)
    }
    if (routeDeliveryEvent(event, source) === 'transient') return;
    invokeSafely('relayOutOfQuery', () => deps.relayOutOfQuery(event), log)
  };
  const coalesce = new OutboundStreamCoalesceBuffer((event) => {
    fanoutOutOfQuery(event as StreamEvent)
  })
  return (event: StreamEvent): void => {
    if (isParentSessionHistoryEvent(event)) {
      invokeSafely('persistParentSession', () => deps.persistParentSession(event), log)
      invokeSafely('relayOutOfQuery', () => deps.relayOutOfQuery(event), log)
      return
    }

    let inQueryRelay: ((event: StreamEvent) => void) | undefined;
    try {
      inQueryRelay = deps.getInQueryRelay();
    } catch (err) {
      log('getInQueryRelay threw', err);
      inQueryRelay = undefined;
    }

    if (inQueryRelay) {
      invokeSafely('inQueryRelay', () => inQueryRelay?.(event), log)
      return;
    }

    coalesce.push(event)
  }
}
