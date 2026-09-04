import type { OpenInput } from '@muse/platform-reach'

export interface ReachBrowserPortScope {
  spaceId?: string
  crawlspaceId?: string
  /** Agent 对话 id。盖膜必须挂这个，idle / LLM_ERROR 才能按会话揭开。 */
  threadId?: string
}

/**
 * reach 内部走 `/open` 的请求体。必须带 `_thread_id`，否则 lock 变成无主锁，
 * Agent 意外停止后 `unlockBySession` 揭不开蒙层。
 */
export function buildReachOpenBody(
  input: OpenInput,
  scope: ReachBrowserPortScope,
): Record<string, unknown> {
  return {
    ...(scope.spaceId ? { spaceId: scope.spaceId } : {}),
    ...(scope.crawlspaceId ? { crawlspaceId: scope.crawlspaceId } : {}),
    url: input.url,
    ...(input.tabId ? { tabId: input.tabId } : {}),
    // 适配器按平台契约拼详情 URL（如抖音 /video/<id>），不经页面观测；
    // 跳过二级页反幻觉守卫。仅 reach 内部端口设置，不暴露给 Agent CLI。
    skipNavigationEvidenceCheck: true,
    ...(scope.threadId ? { _thread_id: scope.threadId } : {}),
  }
}
