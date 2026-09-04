import { describe, it, expect } from 'vitest';
import { buildTabtinRuntimeEnv } from '../runtime-env.js';
import type {
  ToolContext,
} from '../../../engine/contracts/tools.js';

// §17.6 D4：ToolContext.sessionId → runtimeId（runtime UUID）+ threadId 业务对话；
// env 变量名 MUSE_SESSION_ID → MUSE_THREAD_ID（D4.b），值改用 context.threadId。
function ctx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    threadId: 't',
    runtimeId: 'rt',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [],
    ...overrides,
  };
}

//  RB2：spaceId / organizationId 已从 ToolContext / EngineState
// 核心契约移出，改由 host 装配期烘焙成 per-runtime 常量，经 ShellCap 以显式
// 参数传入 buildTabtinRuntimeEnv(context, spaceId, organizationId, agentId)。
describe('buildTabtinRuntimeEnv', () => {
  it('returns only fields with non-empty values', () => {
    const env = buildTabtinRuntimeEnv(ctx({
      threadId: 'thread-1',
      agentRunId: 'run-1',
      workspaceRoot: '/w',
    }), 'sp', 'wt', 'agent-1');
    expect(env).toEqual({
      MUSE_WORKSPACE: '/w',
      MUSE_THREAD_ID: 'thread-1',
      MUSE_AGENT_RUN_ID: 'run-1',
      MUSE_AGENT_ID: 'agent-1',
      MUSE_SPACE_ID: 'sp',
      MUSE_ORGANIZATION_ID: 'wt',
      MUSE_TOOL_USE_ID: 'mock-tool-use',
    });
  });

  it('omits optional fields when context lacks them', () => {
    const env = buildTabtinRuntimeEnv(ctx({ threadId: 'thread-1' }), undefined, undefined);
    expect(env).toEqual({
      MUSE_THREAD_ID: 'thread-1',
      MUSE_TOOL_USE_ID: 'mock-tool-use',
    });
    expect(env.MUSE_AGENT_RUN_ID).toBeUndefined();
    expect(env.MUSE_WORKSPACE).toBeUndefined();
    expect(env.MUSE_SPACE_ID).toBeUndefined();
    expect(env.MUSE_ORGANIZATION_ID).toBeUndefined();
  });

  it('returns empty object when nothing is populated', () => {
    // threadId is required by ToolContext, but allow the helper to behave
    // sensibly even if a degenerate context arrives (e.g. early boot).
    const env = buildTabtinRuntimeEnv(ctx({
      threadId: '' as unknown as string,
      toolUseId: '' as unknown as string,
    }), undefined, undefined);
    expect(env).toEqual({});
  });

  it('does not leak secrets into the env (only injects path/identity strings)', () => {
    // Defensive: even if context grows fields like `apiKey` later, this
    // helper must keep its MUSE_* allowlist explicit.
    const env = buildTabtinRuntimeEnv(ctx({
      threadId: 't',
      agentRunId: 'run-1',
      workspaceRoot: '/w',
    }), 'sp', 'wt', 'agent-1');
    const keys = Object.keys(env).sort();
    expect(keys).toEqual([
      'MUSE_AGENT_ID',
      'MUSE_AGENT_RUN_ID',
      'MUSE_ORGANIZATION_ID',
      'MUSE_SPACE_ID',
      'MUSE_THREAD_ID',
      'MUSE_TOOL_USE_ID',
      'MUSE_WORKSPACE',
    ]);
  });
});
