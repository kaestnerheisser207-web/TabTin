/**
 * subagentRunsFromMessages — 从已加载的 chat_message 派生子 Agent run 索引（聚合卡用）。
 *
 * 替代「读本地 jsonl 索引」的历史恢复路径：子 Agent 的 run 元数据完全可由父消息块恢复，
 * 无需本地 jsonl、无需新增表 / 接口（统一以 chat_message 为 SSoT，跨端 / 云端可恢复）。
 *
 * 派生口径（与 daemon 落库口径对齐）：
 *   - 父 `tool_use`（name ∈ agent/task）：`id`=parentToolCallId；`input` → task/label/model/role；
 *   - 与之配对的 `tool_result`（tool_use_id 相同）：
 *       · 文本里的 `[子 Agent ID: <id>]`（daemon `appendSubagentId` 写入）→ subagentRunId；
 *       · `is_error` → status（failed / completed）；content（去标记）→ summary。
 *   - 主消息与子代理消息都扫：子代理消息里的 agent tool_use 派生孙 Agent run，
 *     让 reload 后冷源能恢复孙 Agent 卡片。
 *   - 无 tool_result：仍从 `tool_use` 造行（status=running / 后台 pending），
 *     冷启动不再依赖 SUBAGENT_* 内存事件。
 */

import type { ChatMessage, MessageBlock } from '@muse/chat-client'
import type { SubagentRun, SubagentStatus } from '../../shared/types'
import {
  extractSubagentRunIdFromResult,
  stripSubagentIdMarker,
} from '../../messages/utils/contentBlockSemantics'
import {
  SUBAGENT_TOOL_NAMES,
  classifySubagentToolInput,
} from '../../../../components/chat/blocks/subagentToolNames'

/**
 * 取一条消息的内容块——**统一数据层入口**（ 阶段 5）。
 *
 * 口径：直接读 `message.blocks`（运行时 SSoT——实时 flush + 历史入口反序列化统一灌入）。
 * 实时 runtime 里已到达但尚未落库的块（譬如嵌套孙 Agent 的 tool_result marker）经
 * commit 进 message.blocks，与 turnArtifacts / 画板 / 主对话渲染同一份读模型，不再读
 * content_blocks_json。参数保留供单测覆盖。
 */
export type SubagentBlocksResolver = (m: ChatMessage) => readonly MessageBlock[]

const defaultBlocksResolver: SubagentBlocksResolver = (m) =>
  (m.blocks ?? []).map((e) => (e as { block: MessageBlock }).block)

function blockField<T = unknown>(block: MessageBlock, key: string): T | undefined {
  return (block as unknown as Record<string, unknown>)[key] as T | undefined
}

/**
 * 消息的「所属 Agent」（owner）—— `subagent_run_id` 标记本条消息是哪个子 Agent 产出。
 * 空 / undefined = 主 Agent。tool_use↔tool_result 配对必须**限定在同一 owner 内**。
 */
function messageOwner(m: ChatMessage): string {
  const owner = (m as unknown as { subagent_run_id?: unknown }).subagent_run_id
  return typeof owner === 'string' && owner.length > 0 ? owner : ''
}

export type PairedSubagentResult = {
  content: unknown
  isError?: boolean
  presentation?: { kind?: unknown; data?: Record<string, unknown> }
}

function presentationSubagentRunId(presentation: PairedSubagentResult['presentation']): string | undefined {
  const id = presentation?.data?.subagent_run_id
  return typeof id === 'string' && id.length > 0 ? id : undefined
}

function statusFromMessageBlocks(
  input: Record<string, unknown>,
  result: PairedSubagentResult | undefined,
): { status: SubagentStatus; archiveStatusSource: NonNullable<SubagentRun['archiveStatusSource']> } {
  if (!result) {
    return {
      status: input.background === true ? 'pending' : 'running',
      archiveStatusSource: 'message_tool_use',
    }
  }
  const presentationKind = result.presentation?.kind
  const persistedStatus = presentationKind === 'subagent_result' || presentationKind === 'subagent_dispatch'
    ? result.presentation?.data?.status
    : undefined
  const legacySummary = stripSubagentIdMarker(result.content)
  const legacyCancelled = legacySummary.startsWith('Sub-agent cancelled by user:')
    || legacySummary.startsWith('Sub-agent cancelled:')
  const backgroundDispatch =
    presentationKind === 'subagent_dispatch'
    || (presentationKind === undefined && input.background === true)
  const archiveStatusSource: NonNullable<SubagentRun['archiveStatusSource']> = presentationKind === 'subagent_result'
    ? 'presentation_result'
    : presentationKind === 'subagent_dispatch'
      ? 'presentation_dispatch'
      : input.background === true
        ? 'legacy_background'
        : 'legacy_result'
  const status: SubagentStatus = persistedStatus === 'cancelled'
    ? 'cancelled'
    : persistedStatus === 'completed'
      ? 'completed'
      : persistedStatus === 'failed'
        ? 'failed'
        : persistedStatus === 'queued'
          ? 'queued'
          : persistedStatus === 'running'
            ? 'running'
            : persistedStatus === 'pending'
              ? 'pending'
              : result.isError
                ? (legacyCancelled ? 'cancelled' : 'failed')
                : backgroundDispatch
                  ? 'pending'
                  : 'completed'
  return { status, archiveStatusSource }
}

/**
 * 从一对 SSoT message block（tool_use + 可选 tool_result）派生单条 SubagentRun。
 * 卡片历史回放与 `deriveSubagentRunsFromMessages` 共用，避免 store miss 时再猜状态。
 */
function isTerminalSubagentStatus(status: SubagentStatus): boolean {
  return status === 'cancelled' || status === 'completed' || status === 'failed'
}

function isActiveSubagentStatus(status: SubagentStatus): boolean {
  return status === 'running' || status === 'pending' || status === 'queued'
}

function isBlockTerminalSource(source: SubagentRun['archiveStatusSource']): boolean {
  return source === 'presentation_result' || source === 'legacy_result'
}

/**
 * store 是 live 投影；块上已有终态 presentation / 旧回执时以块为准，避免丢 COMPLETED 后卡 running。
 */
export function preferBlockTerminalOverStore(
  storeRun: SubagentRun | undefined,
  fromBlocks: SubagentRun | null | undefined,
): SubagentRun | undefined {
  if (!storeRun) return fromBlocks ?? undefined
  if (
    fromBlocks
    && isTerminalSubagentStatus(fromBlocks.status)
    && isBlockTerminalSource(fromBlocks.archiveStatusSource)
    && isActiveSubagentStatus(storeRun.status)
  ) {
    return {
      ...storeRun,
      status: fromBlocks.status,
      summary: fromBlocks.summary ?? storeRun.summary,
      error: fromBlocks.error ?? storeRun.error,
      errorKind: fromBlocks.errorKind ?? storeRun.errorKind,
      archiveStatusSource: fromBlocks.archiveStatusSource,
      isOptimistic: false,
    }
  }
  return storeRun
}

export function deriveSubagentRunFromToolPair(args: {
  parentToolCallId: string
  owner?: string
  input?: Record<string, unknown>
  result?: PairedSubagentResult
  startedAt?: number
}): SubagentRun | null {
  const input = args.input ?? {}
  const result = args.result
  const realIdFromResult = result
    ? (extractSubagentRunIdFromResult(result.content) ?? presentationSubagentRunId(result.presentation))
    : undefined
  const resumeId = typeof input.resume_agent_id === 'string' && input.resume_agent_id
    ? input.resume_agent_id
    : undefined
  if (result && !realIdFromResult) return null
  const hasRealChildId = Boolean(realIdFromResult || resumeId)
  const subagentRunId = realIdFromResult ?? resumeId ?? args.parentToolCallId
  if (!subagentRunId) return null
  const { status, archiveStatusSource } = statusFromMessageBlocks(input, result)
  const summary = result ? (stripSubagentIdMarker(result.content) || undefined) : undefined
  return {
    subagentRunId,
    parentToolCallId: args.parentToolCallId,
    dispatchedByRunId: args.owner,
    status,
    task: typeof input.prompt === 'string' ? input.prompt : undefined,
    label: typeof input.description === 'string' ? input.description : undefined,
    model: typeof input.model === 'string' ? input.model : undefined,
    role: typeof input.role === 'string' ? input.role : undefined,
    templateId: typeof input.template_id === 'string' ? input.template_id : undefined,
    background: input.background === true ? true : undefined,
    archiveStatusSource,
    summary,
    startedAt: args.startedAt,
    ...(!hasRealChildId ? { isOptimistic: true as const } : {}),
    ...(result?.isError
      ? { errorKind: status === 'cancelled' ? 'cancelled' as const : 'failed' as const, error: summary }
      : {}),
  }
}

export function deriveSubagentRunsFromMessages(
  messages: readonly ChatMessage[],
  getBlocks: SubagentBlocksResolver = defaultBlocksResolver,
): SubagentRun[] {
  // tool_use↔tool_result 配对：**按 owner（subagent_run_id）分桶 + 桶内顺序 FIFO**。
  //
  // 背景：provider 发的 tool_use id（如 `agent_0`）只在单个 session 单轮内唯一。群协作
  // 里，主 Agent + 各子 Agent（组长 A/B/C）的消息都落进同一个父会话的 content_blocks，
  // 每个 owner 各自从 `agent_0` 重编号 → 全局撞车。若不分 owner，组长C 的 `agent_0`
  // result 会被错配给 组长B 的 `agent_0` use，角色错乱、部分 run 丢失。
  //
  // 正确口径：配对键 = `owner \0 toolUseId`（tool_use 与其 result 同 owner——result 是
  // 派发方收到的回执）；桶内再按文档顺序 FIFO（第 N 个 use 配第 N 个 result，result 总
  // 在其 use 之后顺序到达）。
  const key = (owner: string, tuid: string): string => `${owner}\u0000${tuid}`
  const resultsByKey = new Map<string, Array<{
    content: unknown
    isError: boolean
    presentation?: { kind?: unknown; data?: Record<string, unknown> }
  }>>()
  for (const m of messages) {
    const blocks = getBlocks(m)
    if (blocks.length === 0) continue
    const owner = messageOwner(m)
    for (const b of blocks) {
      if (blockField<string>(b, 'type') !== 'tool_result') continue
      const tuid = blockField<string>(b, 'tool_use_id')
      if (typeof tuid === 'string') {
        const k = key(owner, tuid)
        const arr = resultsByKey.get(k) ?? []
        arr.push({
          content: blockField(b, 'content'),
          isError: blockField(b, 'is_error') === true,
          presentation: blockField(b, 'presentation'),
        })
        resultsByKey.set(k, arr)
      }
    }
  }
  // 每个 (owner,id) 的消费游标（已配对到第几个 result）。
  const consumeCursor = new Map<string, number>()

  const consumeResultFactsForUse = (k: string): Array<{
    content: unknown
    isError: boolean
    presentation?: { kind?: unknown; data?: Record<string, unknown> }
  }> | undefined => {
    const arr = resultsByKey.get(k)
    if (!arr) return undefined
    const idx = consumeCursor.get(k) ?? 0
    if (idx >= arr.length) return undefined
    const first = arr[idx]
    const subagentRunId = extractSubagentRunIdFromResult(first.content)
    if (!subagentRunId) {
      consumeCursor.set(k, idx + 1)
      return [first]
    }
    const facts = [first]
    let nextIdx = idx + 1
    while (nextIdx < arr.length) {
      const candidate = arr[nextIdx]
      const candidateRunId = extractSubagentRunIdFromResult(candidate.content)
      if (candidateRunId !== subagentRunId) break
      facts.push(candidate)
      nextIdx += 1
    }
    consumeCursor.set(k, nextIdx)
    return facts
  }

  // 同时扫主消息与子代理消息：子代理（child）消息里的 agent tool_use 派生出孙
  // Agent run（reload 后冷源恢复孙卡片），parentToolCallId 即子的 agent tool_use id。
  const runs: SubagentRun[] = []
  const seen = new Set<string>()
  for (const m of messages) {
    const blocks = getBlocks(m)
    if (blocks.length === 0) continue
    const owner = messageOwner(m)

    for (const b of blocks) {
      if (blockField<string>(b, 'type') !== 'tool_use') continue
      const name = blockField<string>(b, 'name')
      if (typeof name !== 'string' || !SUBAGENT_TOOL_NAMES.has(name)) continue
      // 只有 spawn / resume 派生 run。`check_agent_id` 是查询，`wait_agent_ids`
      // 是父 run 等待屏障；两者都不创建子 Agent。unknown 在冷源里保留兼容：
      // 老归档可能缺 input，后续仍必须拿到真实 `[子 Agent ID]` marker 才会成 run。
      const intent = classifySubagentToolInput(blockField(b, 'input'))
      if (intent === 'check' || intent === 'wait') continue
      const parentToolCallId = blockField<string>(b, 'id')
      if (typeof parentToolCallId !== 'string') continue
      const k = key(owner, parentToolCallId)
      const resultFacts = consumeResultFactsForUse(k)
      const result = resultFacts?.[resultFacts.length - 1]
      const input = (blockField<Record<string, unknown>>(b, 'input') ?? {}) as Record<string, unknown>
      const startedAt = Date.parse(m.created_at)
      const run = deriveSubagentRunFromToolPair({
        parentToolCallId,
        owner,
        input,
        result,
        startedAt: Number.isFinite(startedAt) ? startedAt : undefined,
      })
      if (!run || run.isOptimistic) continue
      // resume 会复用同一个 subagentRunId；真正区分“这一次工具调用”的是
      // 派发边 parentToolCallId（再加 owner，避免嵌套子 Agent 的 agent_0 撞车）。
      const runKey = key(owner, `${parentToolCallId}\u0000${run.subagentRunId}`)
      if (seen.has(runKey)) continue
      seen.add(runKey)
      runs.push(run)
    }
  }
  return runs
}
