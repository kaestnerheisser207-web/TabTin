/**
 * 真实 session 落盘数据的解析（导出器的读取侧）。
 *
 * 数据源（platform-data/.../conversations/sessions/<sessionId>/）：
 *   messages.jsonl   envelope 事件流（message_start / content_block_* / message_stop），
 *                    是对话结构的权威来源（tool_use input、tool_result 原文都在这里）
 *   snapshots.jsonl  每轮 LLM 调用两条：请求快照 + 带 response 的增强快照
 *                    （当前 runtime CONTENT_PREVIEW_LIMIT=Infinity，contentPreview 即全文）
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ContentBlock, Message } from './runtime-adapter.js';
import type { FixtureToolDefinition } from './fixture-types.js';

// ─── messages.jsonl（envelope 事件流）→ Message[] ───────────────────

interface EnvelopeLine {
  type: string;
  payload: Record<string, any>;
}

export interface TranscriptMessage extends Message {
  messageId: string;
}

export function parseTranscript(messagesFile: string): TranscriptMessage[] {
  const lines: EnvelopeLine[] = fs
    .readFileSync(messagesFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const messages: TranscriptMessage[] = [];
  let current: { messageId: string; role: 'user' | 'assistant'; blocks: ContentBlock[] } | null = null;
  // index → 正在累积的块（delta 需要拼接）
  let pending = new Map<number, { block: any; jsonAcc: string }>();

  for (const line of lines) {
    const p = line.payload;
    switch (line.type) {
      case 'agent.stream.message_start':
        current = { messageId: p.message_id, role: p.role, blocks: [] };
        pending = new Map();
        break;

      case 'agent.stream.content_block_start':
        pending.set(p.index, { block: structuredClone(p.block), jsonAcc: '' });
        break;

      case 'agent.stream.content_block_delta': {
        const entry = pending.get(p.index);
        if (!entry) break;
        const delta = p.delta;
        if (delta.type === 'text_delta') entry.block.text = (entry.block.text ?? '') + delta.text;
        if (delta.type === 'thinking_delta')
          entry.block.thinking = (entry.block.thinking ?? '') + delta.thinking;
        if (delta.type === 'input_json_delta') entry.jsonAcc += delta.partial_json;
        break;
      }

      case 'agent.stream.content_block_stop': {
        const entry = pending.get(p.index);
        if (!entry || !current) break;
        if (entry.block.type === 'tool_use' && entry.jsonAcc) {
          try {
            entry.block.input = JSON.parse(entry.jsonAcc);
          } catch {
            entry.block.input = entry.jsonAcc; // 保底：留原始字符串
          }
        }
        // 剥掉引擎消息结构外的字段（signature 等 API 侧元数据）
        const { signature: _sig, ...block } = entry.block;
        current.blocks.push(block as ContentBlock);
        pending.delete(p.index);
        break;
      }

      case 'agent.stream.message_stop':
        if (current) {
          messages.push({
            messageId: current.messageId,
            role: current.role,
            content: current.blocks,
          });
          current = null;
        }
        break;
    }
  }
  return messages;
}

// ─── snapshots.jsonl ────────────────────────────────────────────────

export interface RawSnapshotMessage {
  role: 'user' | 'assistant';
  source: string;
  format: 'text' | 'blocks';
  contentPreview: string;
  charCount: number;
}

export interface RawSnapshot {
  timestamp: number;
  timestampISO: string;
  runId: string;
  iteration: number;
  model: string;
  maxTokens?: number;
  requestSource: string;
  system: { sections: Array<{ name: string; source: string; charCount: number; contentPreview: string }> };
  messages: RawSnapshotMessage[];
  messageCount: number;
  tools: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
  toolCount: number;
  response?: {
    format: 'text' | 'blocks';
    contentPreview: string;
    charCount: number;
    stopReason?: string;
  };
}

export interface SnapshotTurnPair {
  iteration: number;
  request: RawSnapshot;
  /** 同 iteration 带 response 的增强快照；录制中断时可能缺失。 */
  enriched: RawSnapshot | null;
}

export function parseSnapshots(snapshotsFile: string): SnapshotTurnPair[] {
  const snaps: RawSnapshot[] = fs
    .readFileSync(snapshotsFile, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

  const pairs = new Map<string, SnapshotTurnPair>();
  for (const s of snaps) {
    const key = `${s.requestSource}#${s.iteration}#${s.runId}`;
    let pair = pairs.get(key);
    if (!pair) {
      pair = { iteration: s.iteration, request: s, enriched: null };
      pairs.set(key, pair);
    }
    if (s.response) pair.enriched = s;
    else pair.request = s;
  }
  return [...pairs.values()].sort((a, b) => a.request.timestamp - b.request.timestamp);
}

/** snapshot 的 message 摘要 → 引擎 Message（contentPreview 为全文时无损）。 */
export function snapshotMessageToMessage(m: RawSnapshotMessage): Message {
  if (m.format === 'text') return { role: m.role, content: m.contentPreview };
  return { role: m.role, content: JSON.parse(m.contentPreview) as ContentBlock[] };
}

/** 从 iter0 快照的 sections 重建 system prompt 文本（preamble 保持裸文本，其余包回标签）。 */
export function rebuildSystemPrompt(snapshot: RawSnapshot): string {
  return snapshot.system.sections
    .map((s) =>
      s.name === 'preamble' || s.name === 'base_prompt'
        ? s.contentPreview
        : `<${s.name}>${s.contentPreview}</${s.name}>`,
    )
    .join('\n');
}

export function snapshotToolsToDefinitions(snapshot: RawSnapshot): FixtureToolDefinition[] {
  return snapshot.tools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));
}

// ─── session 目录定位 ───────────────────────────────────────────────

const DEFAULT_PLATFORM_DATA = path.join(
  process.env.HOME ?? '~',
  'Library/Application Support/Muse/platform-data',
);

/** 按 sessionId 在 platform-data 下搜索 session 目录。 */
export function findSessionDir(sessionId: string, platformDataRoot = DEFAULT_PLATFORM_DATA): string {
  const organizations = path.join(platformDataRoot, 'organizations');
  for (const wt of fs.readdirSync(organizations)) {
    const spaces = path.join(organizations, wt, 'spaces');
    if (!fs.existsSync(spaces)) continue;
    for (const sp of fs.readdirSync(spaces)) {
      const candidate = path.join(spaces, sp, 'conversations', 'sessions', sessionId);
      if (fs.existsSync(path.join(candidate, 'snapshots.jsonl'))) return candidate;
    }
  }
  throw new Error(`未找到 session ${sessionId}（在 ${platformDataRoot} 下）`);
}
