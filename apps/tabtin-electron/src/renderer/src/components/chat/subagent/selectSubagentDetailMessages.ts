/**
 * selectSubagentDetailMessages — 子代理详情 transcript 源选择
 *
 * 父会话 `message.blocks`（按 subagent_run_id 滤出）是 SSoT。live / jsonl 只在
 * 父消息还没追上（流式领先）或父消息为空时补位。三套 message_id 体系不同，
 * 不能按 id merge。
 */

import type { ChatMessage } from '@muse/chat-client'
import { iterableMessageBlocks } from '../../../stores/chat/messages/utils/contentBlockSemantics'

const DETAIL_STEP_TYPES = new Set([
  'thinking',
  'redacted_thinking',
  'tool_use',
  'mcp_tool_use',
])

function blockTypeOf(block: unknown): string | undefined {
  if (!block || typeof block !== 'object') return undefined
  const direct = (block as { type?: unknown }).type
  if (typeof direct === 'string') return direct
  const nested = (block as { block?: { type?: unknown } }).block?.type
  return typeof nested === 'string' ? nested : undefined
}

function iterableBlocksOf(message: ChatMessage): readonly unknown[] {
  return iterableMessageBlocks(message)
}

/**
 * 详情可见步：thinking + tool_use（与 BlockTimeline「执行详情」计数同口径）。
 */
export function countSubagentDetailSteps(messages: readonly ChatMessage[]): number {
  let count = 0
  for (const message of messages) {
    for (const block of iterableBlocksOf(message)) {
      const type = blockTypeOf(block)
      if (type && DETAIL_STEP_TYPES.has(type)) count += 1
    }
  }
  return count
}

export function selectSubagentDetailMessages(
  live: readonly ChatMessage[],
  archive: readonly ChatMessage[],
  parent: readonly ChatMessage[] = [],
): ChatMessage[] {
  const liveList = live as ChatMessage[]
  const archiveList = archive as ChatMessage[]
  const parentList = parent as ChatMessage[]
  const liveSteps = countSubagentDetailSteps(liveList)
  const archiveSteps = countSubagentDetailSteps(archiveList)
  const parentSteps = countSubagentDetailSteps(parentList)
  const maxSteps = Math.max(parentSteps, liveSteps, archiveSteps)

  const liveOrArchiveMax = Math.max(liveSteps, archiveSteps)
  if (parentList.length > 0 && parentSteps > liveOrArchiveMax) return parentList
  if (liveList.length === 0 && archiveList.length === 0) return parentList
  if (archiveList.length > 0 && archiveSteps === maxSteps && archiveSteps > liveSteps) {
    return archiveList
  }
  if (archiveSteps === liveSteps && archiveList.length > liveList.length) {
    return archiveList
  }
  if (liveList.length > 0) return liveList
  if (archiveList.length > 0) return archiveList
  return parentList
}
