import { buildRunObservationsInjectorHook } from '../policy-hooks/run-observations-injector.js';
import { buildThreadNotificationsInjectorHook } from '../policy-hooks/thread-notifications-injector.js';
import { buildIterationBudgetPolicyHook } from '../policy-hooks/iteration-budget-policy.js';
import { buildToolLoopGuardHook } from '../policy-hooks/tool-loop-guard.js';
import { normalizeIterationBudgetConfig } from '../guards/iteration-budget.js';
import { emitTelemetryEvent } from '../../telemetry/emitter.js';
import { TokenEstimator } from '../context/token-budget.js';
import { createSkillSlashHook, buildToolSkillContext, emitSkillInjectedUserEvents } from './skill-slash.js';
/** Shared tool/hook execution without constructing a model loop. */
import { syncStateFromTracker } from '../guards/budget-state-sync.js';
import { randomUUID } from 'node:crypto';
import type { EngineConfig, EngineState, QueryParams } from '../contracts/kernel.js';
import type { Tool, ToolContext, ToolResult } from '../contracts/tools.js';
import type { StreamEvent } from '../contracts/wire-protocol.js';
import { HookRunner } from '../core/hook-runner.js';
import { ToolStreamEmitter } from '../wire/tool-stream-emitter.js';
import { EnvelopeEmitter } from '../wire/envelope-emitter.js';
import { flattenSystemPrompt } from '../context/system-prompt-text.js';
import { ToolRegistry } from './tool-system.js';
import { runTools } from './tool-orchestration.js';
import { createInterruptAdapter } from '../../permissions/interrupt-adapter.js';

export function resolveHostCapabilityModel(config: EngineConfig, id = config.model) {
  const normalized = id.trim().toLowerCase();
  const entry = config.modelCatalog?.find(model => model.id.toLowerCase() === normalized
    || model.aliases?.some(alias => alias.toLowerCase() === normalized));
  const isConfiguredModel = id === config.model;
  const capabilities = isConfiguredModel ? config.modelCapabilities ?? entry?.capabilities : entry?.capabilities;
  const positive = (value: number | undefined) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  return { id, supportsVision: capabilities?.supportsVision === true,
    contextWindowTokens: positive(isConfiguredModel ? config.contextWindowTokens ?? capabilities?.contextWindowTokens
      : capabilities?.contextWindowTokens),
    maxOutputTokens: positive(isConfiguredModel ? config.maxOutputTokens ?? capabilities?.maxOutputTokens
      : capabilities?.maxOutputTokens) };
}

export function createHostCapabilityRun(config: EngineConfig, params: QueryParams, emit: (e: StreamEvent) => void) {
  if (!config.toolRiskPolicy) throw new Error('Host capability session requires toolRiskPolicy');
  const toolGate = config.toolGate ?? config.bindToolGate?.(config);
  if (!toolGate) throw new Error('Host capability session requires toolGate');
  if (!params.hostRunId?.trim()) throw new Error('Host capability session requires hostRunId');
  const runId = params.hostRunId;
  const abort = new AbortController();
  const externalAbort = () => abort.abort(params.signal?.reason);
  if (params.signal?.aborted) externalAbort();
  else params.signal?.addEventListener('abort', externalAbort, { once: true });
  const forceFinalRef = { current: null as { reason: string } | null };
  const state: EngineState = {
    messages: params.initialMessages ? structuredClone(params.initialMessages) : [{ role: 'user', content: params.prompt }],
    systemPrompt: flattenSystemPrompt(params.systemPrompt ?? config.systemPrompt), model: config.model,
    iteration: 0, totalInputTokens: 0, totalOutputTokens: 0, _cachedInputTokens: 0,
    totalCacheReadTokens: 0, totalCacheCreationTokens: 0, totalReasoningTokens: 0,
    compactInputTokens: 0, compactOutputTokens: 0, contextPressure: 0, creditsCharged: 0,
    abortController: abort, traceId: runId, __pendingNotices: [],
    currentAssistantMessageId: randomUUID(),
  };
  const initialMessages = new Set(state.messages);
  if (config.budgetTracker && !config.budgetScope) {
    state._budgetRunBaseline = config.budgetTracker.getAccumulated();
    state._budgetRunBaselineByModel = config.budgetTracker.getByModelRaw();
  }
  const activeSkillRef = { current: null as { skillKey: string; primaryEnv?: string } | null };
  const envelopeEmitter = new EnvelopeEmitter({ traceId: runId, runId, threadId: config.sessionConfig.threadId });
  const toolStreamEmitter = new ToolStreamEmitter(envelopeEmitter, { ...config, emitStreamEvent: emit }, () => state.model);
  const hooks = new HookRunner([
    buildRunObservationsInjectorHook({ getRecentRunObservations: config.getRecentRunObservations }),
    buildThreadNotificationsInjectorHook({ drainThreadNotifications: config.drainThreadNotifications }),
    config.hooks ?? {},
    createSkillSlashHook({ request: params.skillSlashInvoke, activation: config.skillActivation,
      deps: { generateUUID: randomUUID }, tokenEstimator: new TokenEstimator(), activeSkillRef }),
    buildIterationBudgetPolicyHook({ iterationBudgetConfig: normalizeIterationBudgetConfig(config.iterationBudget),
      budgetTracker: config.budgetTracker, budgetScope: config.budgetScope, sessionId: config.sessionConfig.threadId,
      getMaxTurns: () => params.maxTurns ?? config.maxTurns ?? Infinity, observe: emitTelemetryEvent }),
    buildToolLoopGuardHook({ toolFailureConfig: config.toolFailureTracker, toolRepetitionConfig: config.toolRepetitionTracker,
      sessionId: config.sessionConfig.threadId, observe: emitTelemetryEvent }),
  ], state, {
    runId, forceFinalRef, envelopeEmitter,
  });
  const interrupt = createInterruptAdapter({ emitStreamEvent: emit, waitForUserInput: config.waitForUserInput,
    userInteractiveChannel: config.userInteractiveChannel, threadId: config.sessionConfig.threadId });
  let ended = false;
  let allowlist: readonly string[] | null = null;
  const assertActive = () => {
    if (ended) throw new Error('Host capability run ended');
    abort.signal.throwIfAborted();
    if (config.budgetTracker?.isExhausted()) throw new Error('Host capability budget exhausted');
    if (forceFinalRef.current) throw new Error(`Host capability budget stopped: ${forceFinalRef.current.reason}`);
  };
  async function drain<T>(generator: AsyncGenerator<StreamEvent, T, undefined>): Promise<T> {
    while (true) {
      const next = await generator.next();
      if (next.done) return next.value;
      emit(next.value);
    }
  }
  function toolContext(signal: AbortSignal): ToolContext {
    const threadId = config.businessThreadId ?? config.sessionConfig.threadId;
    return { threadId, notificationThreadId: threadId, agentRunId: runId, runtimeId: runId,
      model: state.model, runtimeMode: typeof config.runtimeMode === 'function' ? config.runtimeMode() : config.runtimeMode ?? 'interactive', subagentDepth: config.subagentDepth ?? 0,
      billingIdempotencyScope: params.billingIdempotencyScope, workspaceRoot: config.workspaceRoot,
      workspaceSnapshot: config.toolRiskPolicy!.resolveSnapshot()?.workspace, abortSignal: signal,
      messages: state.messages, skillContext: buildToolSkillContext(activeSkillRef.current), assistantMessageId: state.currentAssistantMessageId,
      assistantSubagentRunId: config.subagentRunId, emitStreamEvent: emit, emitRichContentBlock: toolStreamEmitter.makeRichContentBlockEmitter(),
      waitForUserInput: config.waitForUserInput, interrupt,
      readFileState: config.readFileState, imageReadFileState: config.imageReadFileState,
      localDocReadFileState: config.localDocReadFileState, fileHistory: config.fileHistory,
      fileHistoryAnchorId: config.fileHistoryAnchorId ?? runId };
  }
  let preparedKey = '';
  let preparedSnapshot: ReturnType<typeof assembleSnapshot> | undefined;
  async function assembleSnapshot() {
    await drain(hooks.runIterationHook('beforeIteration', state.iteration));
    const sections: string[] = [];
    const outcome = await drain(hooks.runBeforeModel({ iteration: state.iteration,
      appendSystemSection: (_name, content) => { sections.push(content); } }));
    allowlist = outcome.toolAllowlist;
    if (outcome.terminate || outcome.graceTurn) forceFinalRef.current = { reason: 'tool_budget_exhausted' };
    assertActive();
    await config.tools.refreshTools?.();
    return { tools: config.tools.getTools().filter(tool => !allowlist || allowlist.includes(tool.name))
      .map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      systemPrompt: state.systemPrompt, model: resolveHostCapabilityModel(config, state.model),
      context: [...sections, ...state.messages.filter(message => !initialMessages.has(message))
        .map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content))].join('\n\n'), runId };
  }
  return {
    runId, signal: abort.signal,
    async begin() {
      assertActive();
      await config.fileHistory?.beginSnapshot(config.fileHistoryAnchorId ?? runId);
      if (params.skillSlashInvoke?.skillKey) await config.refreshSkillEnablementForSlash?.();
      await drain(hooks.runBeforeRun());
      assertActive();
    },
    async snapshot(advanceIteration = false) {
      assertActive();
      await params.waitIfPaused?.(abort.signal);
      syncStateFromTracker(state, config);
      const key = JSON.stringify([config.systemPrompt, config.agentMode, state.model, resolveHostCapabilityModel(config, state.model),
        config.tools.getTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))]);
      if (key !== preparedKey) { preparedSnapshot = undefined; preparedKey = key; }
      if (!preparedSnapshot) preparedSnapshot = assembleSnapshot();
      const snapshot = await preparedSnapshot;
      assertActive();
      if (advanceIteration) state.iteration++;
      return snapshot;
    },
    modelId() { assertActive(); return state.model; },
    recordModelUsage(usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number; modelId?: string }, allowEnded = false) {
      if (ended && !allowEnded) throw new Error('Usage belongs to an ended run');
      preparedSnapshot = undefined;
      for (const value of [usage.inputTokens, usage.outputTokens, usage.cacheReadTokens ?? 0, usage.cacheWriteTokens ?? 0, usage.costUsd ?? 0]) {
        if (!Number.isFinite(value) || value < 0) throw new Error('Invalid model usage');
      }
      if (config.budgetTracker) {
        config.budgetTracker.recordRequest({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadTokens, cacheCreationTokens: usage.cacheWriteTokens,
          costUsd: usage.costUsd, model: usage.modelId ?? state.model, source: 'react' }, config.budgetScope);
        syncStateFromTracker(state, config);
      } else {
        state.totalInputTokens += usage.inputTokens;
        state.totalOutputTokens += usage.outputTokens;
        state.totalCacheReadTokens += usage.cacheReadTokens ?? 0;
        state.totalCacheCreationTokens += usage.cacheWriteTokens ?? 0;
        state.creditsCharged += usage.costUsd ?? 0;
      }
    },
    async execute(call: { callId: string; name: string; arguments: Record<string, unknown>; nativeTimeoutMs?: number }, signal: AbortSignal,
      native?: (tool: Tool, context: ToolContext, authorizedInput: unknown) => Promise<ToolResult>) {
      assertActive();
      await params.waitIfPaused?.(abort.signal);
      syncStateFromTracker(state, config);
      assertActive();
      const combined = AbortSignal.any([abort.signal, signal]);
      combined.throwIfAborted();
      if (allowlist && !allowlist.includes(call.name)) throw new Error('Tool restricted by current policy');
      const tool = config.tools.getTools().find(item => item.name === call.name);
      if (!tool) throw new Error(`Unknown platform tool: ${call.name}`);
      if (call.nativeTimeoutMs !== undefined && (!native || !Number.isSafeInteger(call.nativeTimeoutMs) || call.nativeTimeoutMs < 1 || call.nativeTimeoutMs > 3600000)) {
        throw new Error('Invalid native execution deadline');
      }
      // Native execution waits for the external command to actually finish.
      // Builtin wait_ms is only its foreground observation window, so using
      // that timeout would expire a still-valid native command at 65 seconds.
      const selected = native ? { ...tool,
        ...(call.nativeTimeoutMs !== undefined ? { executionTimeoutMs: () => call.nativeTimeoutMs! + 5000 } : {}),
        execute: (authorizedInput: unknown, context: ToolContext) => native(tool, context, authorizedInput),
      } : tool;
      const registry = new ToolRegistry();
      registry.loadTools({ getTools: () => [selected] });
      const blocks = [{ type: 'tool_use' as const, id: call.callId, name: call.name, input: call.arguments }];
      const results = await drain(runTools({ toolUseBlocks: blocks, registry, context: toolContext(combined),
        permissionHandler: config.permissionHandler,
        beforeTool: input => hooks.runBeforeTool(input),
        options: { schemaValidation: 'strict', outputScan: config.toolOutputScan ?? true,
          toolGate, interrupt, observe: emitTelemetryEvent, toolRiskPolicy: config.toolRiskPolicy, agentMode: config.agentMode,
          judgeHomeDir: config.judgeHomeDir, osErrorBlacklist: config.osErrorBlacklist,
          onOSAccessError: config.onOSAccessError, isUntrustedShellCommand: config.isUntrustedShellCommand,
          sessionId: config.sessionConfig.threadId, isSubagent: !!config.budgetScope } }));
      for (const result of results) await drain(hooks.runAfterTool({ toolUseId: call.callId, tool,
        input: call.arguments, result: result.result }));
      const outcome = await drain(hooks.runAfterToolResult({ executionResults: results, rawExecutionResults: results,
        toolUseBlocks: blocks, iteration: state.iteration }));
      if (outcome.pendingHardStop || outcome.hostHandoff) forceFinalRef.current = { reason: 'tool_hook_stop' };
      const result = results[0]?.result;
      if (!result) throw new Error('Tool execution returned no result');
      if (result.newMessages) {
        state.messages.push(...result.newMessages);
        for (const event of emitSkillInjectedUserEvents(result.newMessages, { generateUUID: randomUUID })) emit(event);
      }
      if (result.contextModifier?.activeSkill !== undefined) activeSkillRef.current = result.contextModifier.activeSkill;
      if (result.contextModifier?.modelOverride) state.model = result.contextModifier.modelOverride;
      if (result.contextModifier?.modeOverride) state.systemPrompt = flattenSystemPrompt(config.systemPrompt);
      preparedSnapshot = undefined;
      return result;
    },
    cancel() { abort.abort(new Error('Host capability run ended')); },
    async end() {
      if (ended) return;
      ended = true;
      abort.abort(new Error('Host capability run ended'));
      params.signal?.removeEventListener('abort', externalAbort);
      await hooks.runAfterRun();
      await config.fileHistory?.flushNow?.();
    },
  };
}
