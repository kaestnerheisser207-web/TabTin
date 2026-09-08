import { describe, it, expect, vi } from 'vitest';
import { BudgetTracker } from '@muse/agent-runtime';
import type { EngineConfig, Tool } from '@muse/agent-runtime';
import { createHostCapabilitySession } from '../src/runtime/host-capability-session.js';

function fixture(behavior: 'allow' | 'deny' = 'allow') {
  const execute = vi.fn(async () => ({ content: 'done' }));
  const beforeRun = vi.fn(async (ctx: any) => { ctx.state.systemPrompt += '\nskill instructions'; });
  const beforeTool = vi.fn(async () => {});
  const afterTool = vi.fn(async () => {});
  const tool: Tool = { name: 'write_file', description: 'test', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] }, isReadOnly: false, policyActionKind: 'file', execute };
  const policy: any = { resolveSnapshot: () => ({ workspace: { allowedPaths: ['/tmp'], allowedFiles: [] } }),
    judge: () => ({ behavior, reason: { type: 'test' } }), buildMemoPatternKey: () => 'x',
    forWorkspaceRoot() { return this; }, forReadonlyChild() { return this; } };
  const config = { model: 'test', provider: {}, tools: { getTools: () => [tool] },
    sessionConfig: { threadId: 'thread', sessionDir: '/tmp/capability-test' }, workspaceRoot: '/tmp',
    systemPrompt: 'base', hooks: { beforeRun, beforeTool, afterTool },
    permissionHandler: { requestPermissionsBatch: async () => [] }, toolRiskPolicy: policy,
    toolGate: { isRestrictedMode: () => false, evaluate: () => ({ allowed: true }), isPlanTargetGuarded: () => false },
  } as unknown as EngineConfig;
  const session = createHostCapabilitySession({ config, scope: { threadId: 'thread', workspaceId: 'workspace', owner: { userId: 'user', organizationId: 'org' } }, emit: vi.fn() });
  return { session, execute, beforeRun, beforeTool, afterTool, tool, config };
}
const call = { callId: 'call-1', name: 'write_file', arguments: { path: '/tmp/test' } };
const signal = () => new AbortController().signal;

describe('Host capability execution', () => {
  it('lists static tools without running hooks before beginRun', async () => {
    const f = fixture();
    expect((await f.session.snapshot()).tools[0].name).toBe('write_file');
    expect(f.beforeRun).not.toHaveBeenCalled();
    await f.session.dispose();
  });
  it('denied permission causes zero tool effects', async () => {
    const f = fixture('deny');
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    expect((await f.session.invoke(call, signal())).isError).toBe(true);
    expect(f.execute).not.toHaveBeenCalled();
    await f.session.dispose();
  });
  it('deduplicates concurrent calls and rejects conflicting arguments', async () => {
    const f = fixture();
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    await Promise.all([f.session.invoke(call, signal()), f.session.invoke(call, signal())]);
    expect(f.execute).toHaveBeenCalledTimes(1);
    await expect(f.session.invoke({ ...call, arguments: { path: '/tmp/other' } }, signal())).rejects.toThrow('conflicting');
    await f.session.dispose();
  });
  it('passes real run/tool contexts to hooks and emits dynamic system content', async () => {
    const f = fixture();
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    expect((await f.session.snapshot()).systemPrompt).toContain('skill instructions');
    await f.session.invoke(call, signal());
    expect(f.beforeRun.mock.calls[0][0].runId).toBe('run');
    expect(f.beforeTool).toHaveBeenCalledWith(expect.objectContaining({ runId: 'run', toolUseId: 'call-1', tool: f.tool, input: call.arguments, state: expect.any(Object) }));
    expect(f.afterTool).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ content: expect.stringContaining('done') }) }));
    await f.session.dispose();
  });
  it('native approval retains one execution through completion and after hooks', async () => {
    const f = fixture();
    const preflight = vi.fn(async (_input, _ctx, perform) => perform());
    f.tool.executeNative = preflight;
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    expect(await f.session.beforeNative(call, signal())).toEqual({ allowed: true });
    expect((await f.session.beforeNative(call, signal())).allowed).toBe(false);
    expect(f.afterTool).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    await f.session.afterNative({ ...call, result: { content: 'native done' } }, signal());
    await f.session.afterNative({ ...call, result: { content: 'native done' } }, signal());
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(f.afterTool).toHaveBeenCalledTimes(1);
    await f.session.dispose();
  });
  it('native deny cannot run preflight or accept completion', async () => {
    const f = fixture('deny');
    f.tool.executeNative = vi.fn();
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    expect((await f.session.beforeNative(call, signal())).allowed).toBe(false);
    expect(f.tool.executeNative).not.toHaveBeenCalled();
    await expect(f.session.afterNative({ ...call, result: 'done' }, signal())).rejects.toThrow('denied');
    await f.session.dispose();
  });
  it('cancellation rejects admission and expired run calls are refused', async () => {
    const f = fixture();
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    const controller = new AbortController(); controller.abort();
    await expect(f.session.invoke(call, controller.signal)).rejects.toThrow();
    expect(f.execute).not.toHaveBeenCalled();
    await f.session.endRun();
    await f.session.beginRun({ hostRunId: 'run2', prompt: 'test' });
    await expect(f.session.invoke(call, signal())).rejects.toThrow('expired');
    await f.session.dispose();
  });
  it('budget hook stop prevents side effects', async () => {
    const f = fixture();
    f.config.hooks!.beforeIteration = async ctx => { ctx.requestForceFinal('credits'); };
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    await expect(f.session.snapshot()).rejects.toThrow('budget');
    await expect(f.session.invoke(call, signal())).rejects.toThrow('budget');
    expect(f.execute).not.toHaveBeenCalled();
    await f.session.dispose();
  });
  it('accounts real model usage and rejects the next request after budget exhaustion', async () => {
    const f = fixture();
    f.config.budgetTracker = new BudgetTracker({ maxTotalTokens: 10 });
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    const ticket = await f.session.beforeModelRequest();
    expect(ticket).toEqual(expect.objectContaining({ modelId: 'test' })); ticket.close();
    f.session.recordModelUsage({ inputTokens: 8, outputTokens: 3, cacheReadTokens: 2 });
    expect(f.config.budgetTracker.getAccumulated().inputTokens).toBe(8);
    await expect(f.session.beforeModelRequest()).rejects.toThrow('budget');
    await f.session.dispose();
  });
  it('returns the model chosen by a tool context modifier', async () => {
    const f = fixture();
    f.tool.execute = async () => ({ content: 'changed', contextModifier: { modelOverride: 'next-model' } });
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    await f.session.invoke(call, signal());
    const ticket = await f.session.beforeModelRequest();
    expect(ticket).toEqual(expect.objectContaining({ modelId: 'next-model' })); ticket.close();
    await f.session.dispose();
  });
  it('ends an admitted native operation by cancellation without waiting for native completion', async () => {
    const f = fixture();
    f.tool.executeNative = async (_input, _ctx, perform) => perform();
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    expect((await f.session.beforeNative(call, signal())).allowed).toBe(true);
    await f.session.endRun();
    await expect(f.session.afterNative({ ...call, result: 'late' }, signal())).rejects.toThrow('active');
  });

  it('captures all inserted contexts by message identity without original history or user duplication', async () => {
    const f = fixture();
    f.config.hooks!.beforeRun = async ({ state }) => {
      state.messages.splice(2, 0, { role: 'user', content: 'context-alpha' }, { role: 'user', content: 'context-beta' });
      state.messages.unshift({ role: 'system', content: 'context-front' });
    };
    await f.session.beginRun({ hostRunId: 'run', prompt: 'current-user', initialMessages: [
      { role: 'user', content: 'old-user' }, { role: 'assistant', content: 'old-answer' }, { role: 'user', content: 'current-user' },
    ] });
    const result = await f.session.snapshot();
    for (const text of ['context-alpha', 'context-beta', 'context-front']) expect(result.context.split(text)).toHaveLength(2);
    for (const text of ['old-user', 'old-answer', 'current-user']) expect(result.context).not.toContain(text);
    await f.session.dispose();
  });
  it('assembles context once for snapshot plus model request and invalidates on tool completion', async () => {
    const f = fixture();
    const beforeIteration = vi.fn(async () => {});
    const beforeModel = vi.fn(async (ctx: any) => ctx.appendSystemSection('environment', 'fresh-context', 'test'));
    f.config.hooks!.beforeIteration = beforeIteration; f.config.hooks!.beforeModel = beforeModel;
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    await f.session.snapshot(); await f.session.snapshot(); (await f.session.beforeModelRequest()).close();
    expect(beforeIteration).toHaveBeenCalledTimes(1); expect(beforeModel).toHaveBeenCalledTimes(1);
    await f.session.invoke(call, signal()); await f.session.snapshot();
    expect(beforeIteration).toHaveBeenCalledTimes(2); expect(beforeModel).toHaveBeenCalledTimes(2);
    await f.session.dispose();
  });

  it('waits for frozen model ticket settlement before a new run baseline', async () => {
    const f = fixture(); f.config.budgetTracker = new BudgetTracker();
    await f.session.beginRun({ hostRunId: 'old-run', prompt: 'test' });
    const old = await f.session.beforeModelRequest();
    let ended = false; const ending = f.session.endRun().then(() => { ended = true; });
    await Promise.resolve(); expect(ended).toBe(false); expect(old.signal.aborted).toBe(true);
    await expect(f.session.beginRun({ hostRunId: 'new-run', prompt: 'test' })).rejects.toThrow('another run');
    old.recordUsage({ inputTokens: 7, outputTokens: 2, runId: 'old-run' });
    expect(() => old.recordUsage({ inputTokens: 7, outputTokens: 2 })).toThrow('already');
    old.close(); await ending;
    expect(f.config.budgetTracker.getAccumulated().inputTokens).toBe(7);
    await f.session.beginRun({ hostRunId: 'new-run', prompt: 'test' });
    expect(() => f.session.recordModelUsage({ inputTokens: 7, outputTokens: 2, runId: 'old-run' })).toThrow('mismatch');
    await f.session.dispose();
  });

  it('projects actual current model capabilities and catalog overrides without inherited vision', async () => {
    const f = fixture();
    f.config.modelCapabilities = { supportsVision: true, contextWindowTokens: 64000, maxOutputTokens: 4096 } as never;
    f.config.modelCatalog = [{ id: 'text-only', capabilities: { supportsVision: false, contextWindowTokens: 16000, maxOutputTokens: 2048 } as never }];
    expect((await f.session.snapshot()).model).toEqual({ id: 'test', supportsVision: true, contextWindowTokens: 64000, maxOutputTokens: 4096 });
    f.tool.execute = async () => ({ content: 'changed', contextModifier: { modelOverride: 'text-only' } });
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' }); await f.session.invoke(call, signal());
    expect((await f.session.snapshot()).model).toEqual({ id: 'text-only', supportsVision: false, contextWindowTokens: 16000, maxOutputTokens: 2048 });
    f.tool.execute = async () => ({ content: 'changed', contextModifier: { modelOverride: 'unknown-model' } });
    await f.session.invoke({ ...call, callId: 'call-2' }, signal());
    expect((await f.session.snapshot()).model).toEqual({ id: 'unknown-model', supportsVision: false, contextWindowTokens: undefined, maxOutputTokens: undefined });
    await f.session.dispose();
  });

  it('keeps an 80-second native operation admitted under its actual 120-second deadline', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.tool.executionTimeoutMs = () => 65000; // Builtin foreground wait + grace.
    f.tool.executeNative = async (_input, _ctx, perform) => perform();
    const native = { ...call, nativeTimeoutMs: 120000 };
    try {
      await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
      expect((await f.session.beforeNative(native, signal())).allowed).toBe(true);
      await vi.advanceTimersByTimeAsync(80000);
      await f.session.afterNative({ ...native, result: { content: '80-second test completed' } }, signal());
      expect(f.afterTool).toHaveBeenCalledTimes(1);
      expect(f.execute).not.toHaveBeenCalled();
    } finally { await f.session.dispose(); vi.useRealTimers(); }
  });
  it('expires native admission after its own deadline plus grace', async () => {
    vi.useFakeTimers(); const f = fixture();
    f.tool.executeNative = async (_input, _ctx, perform) => perform();
    const native = { ...call, nativeTimeoutMs: 120000 };
    try {
      await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
      expect((await f.session.beforeNative(native, signal())).allowed).toBe(true);
      await vi.advanceTimersByTimeAsync(125001);
      await expect(f.session.afterNative({ ...native, result: 'late' }, signal())).rejects.toThrow('expired');
    } finally { await f.session.dispose(); vi.useRealTimers(); }
  });
  it.each([0, -1, 1.5, 3600001, Infinity, NaN])('rejects unsafe native deadline %s before side effects', async nativeTimeoutMs => {
    const f = fixture(); f.tool.executeNative = vi.fn();
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    await expect(f.session.beforeNative({ ...call, nativeTimeoutMs }, signal())).rejects.toThrow('nativeTimeoutMs');
    expect(f.tool.executeNative).not.toHaveBeenCalled(); await f.session.dispose();
  });
  it('rejects conflicting native deadlines and forbids deadline overrides on platform invoke', async () => {
    const f = fixture(); f.tool.executeNative = async (_input, _ctx, perform) => perform();
    await f.session.beginRun({ hostRunId: 'run', prompt: 'test' });
    expect((await f.session.beforeNative({ ...call, nativeTimeoutMs: 120000 }, signal())).allowed).toBe(true);
    await expect(f.session.beforeNative({ ...call, nativeTimeoutMs: 60000 }, signal())).rejects.toThrow('conflicting');
    await expect(f.session.invoke({ ...call, callId: 'platform', nativeTimeoutMs: 120000 }, signal())).rejects.toThrow('only allowed');
    await f.session.endRun(); // Cancellation still promptly closes the long native reservation.
    await f.session.dispose();
  });

});
