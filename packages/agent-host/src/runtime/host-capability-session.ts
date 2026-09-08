import { createHostCapabilityRun, resolveHostCapabilityModel, type EngineConfig, type QueryParams, type StreamEvent, type ToolResult } from '@muse/agent-runtime';

export interface HostModelUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; costUsd?: number; modelId?: string; runId?: string }
export interface HostModelRequestTicket { agentId?: string; modelId?: string; runId: string; signal: AbortSignal; billingIdempotencyScope?: string; requestSource?: string; recordUsage(usage: HostModelUsage): void; close(): void }
export interface HostCapabilityCall { callId: string; name: string; arguments: Record<string, unknown>; nativeTimeoutMs?: number }
export interface HostCapabilitySnapshot {
  model: { id: string; contextWindowTokens?: number; maxOutputTokens?: number; supportsVision: boolean };
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  systemPrompt: string;
  context: string;
  runId: string;
  hooks: string[];
  policies: string[];
  controls: string[];
}
export interface HostCapabilitySession {
  beforeModelRequest(): Promise<HostModelRequestTicket>;
  recordModelUsage(usage: HostModelUsage): void;
  beginRun(params: QueryParams): Promise<void>;
  endRun(): Promise<void>;
  snapshot(): Promise<HostCapabilitySnapshot>;
  invoke(call: HostCapabilityCall, signal: AbortSignal): Promise<ToolResult>;
  beforeNative(call: HostCapabilityCall, signal: AbortSignal): Promise<{ allowed: boolean; reason?: string }>;
  afterNative(call: HostCapabilityCall & { result: unknown }, signal: AbortSignal): Promise<void>;
  dispose(): Promise<void>;
}

type Run = ReturnType<typeof createHostCapabilityRun>;
type Permission = { allowed: boolean; reason?: string };
interface Entry {
  fingerprint: string;
  kind: 'invoke' | 'native';
  result: Promise<ToolResult>;
  permission?: Promise<Permission>;
  complete?: (result: ToolResult) => void;
  completionFingerprint?: string;
  finished?: boolean;
}
function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
}
function asToolResult(value: unknown): ToolResult {
  if (value && typeof value === 'object' && 'content' in value) {
    const result = value as ToolResult;
    if (typeof result.content === 'string' || Array.isArray(result.content)) return result;
  }
  return { content: typeof value === 'string' ? value : JSON.stringify(value) ?? '' };
}

/** One immutable owner/workspace scope; call arguments cannot alter that scope. */
export function createHostCapabilitySession(input: {
  config: EngineConfig;
  scope: { threadId: string; workspaceId: string; owner: { userId: string; organizationId: string }; agentId?: string };
  emit: (event: StreamEvent) => void;
}): HostCapabilitySession {
  const { config, emit } = input;
  const scope = structuredClone(input.scope);
  if (!scope.owner.userId || !scope.owner.organizationId || !scope.workspaceId || !scope.threadId) throw new Error('Incomplete capability owner scope');
  if ((config.businessThreadId ?? config.sessionConfig.threadId) !== scope.threadId) throw new Error('Capability thread scope mismatch');
  let run: Run | undefined;
  let runParams: QueryParams | undefined;
  const modelTickets = new Set<Promise<void>>();
  let disposed = false;
  let ending = false;
  const entries = new Map<string, Entry>();
  const retiredCallIds = new Set<string>();
  const usedRunIds = new Set<string>();
  const active = () => {
    if (disposed || ending || !run) throw new Error('Capability session has no active run');
    run.signal.throwIfAborted();
    return run;
  };
  function existing(call: HostCapabilityCall, kind: Entry['kind']): Entry | undefined {
    if (!call.callId?.trim() || !call.name?.trim()) throw new Error('Capability call identity required');
    if (retiredCallIds.has(call.callId)) throw new Error('Capability call belongs to an expired run');
    const entry = entries.get(call.callId);
    if (entry && (entry.kind !== kind || entry.fingerprint !== canonical(call))) throw new Error('Capability callId reused with conflicting arguments');
    return entry;
  }
  const capabilities = () => ({
    hooks: Object.entries(config.hooks ?? {}).filter(([, value]) => typeof value === 'function').map(([name]) => name).sort(),
    policies: ['schemaValidation:strict', ...(config.toolRiskPolicy ? ['toolRiskPolicy'] : []), ...(config.toolGate || config.bindToolGate ? ['toolGate'] : []), 'iterationBudget', 'toolLoopGuard'],
    controls: ['cancel', 'callIdDedup', 'runInvalidation', ...(config.waitForUserInput ? ['waitForUserInput'] : []), ...(config.userInteractiveChannel ? ['userInteractiveChannel'] : [])],
  });
  const session: HostCapabilitySession = {
    async beforeModelRequest() {
      const current = active(); await current.snapshot(true);
      if (active() !== current) throw new Error('Model request run changed during preparation');
      const modelId = current.modelId(); let recorded = false; let closed = false;
      let finish!: () => void;
      const completion = new Promise<void>(resolve => { finish = resolve; });
      modelTickets.add(completion);
      return { agentId: scope.agentId, modelId, runId: current.runId, signal: current.signal,
        billingIdempotencyScope: runParams?.billingIdempotencyScope,
        requestSource: !config.querySource || config.querySource === 'user_message' ? '_main_chat' : config.querySource,
        recordUsage(usage) {
          if (closed) throw new Error('Model request ticket already closed');
          if (recorded) throw new Error('Model request usage already recorded');
          if (usage.runId && usage.runId !== current.runId) throw new Error('Model usage run identity mismatch');
          current.recordModelUsage({ ...usage, modelId: usage.modelId ?? modelId }, true);
          recorded = true;
        },
        close() { if (closed) return; closed = true; modelTickets.delete(completion); finish(); },
      };
    },
    recordModelUsage(usage) {
      if (!run || disposed) throw new Error('No run for model usage');
      if (usage.runId && usage.runId !== run.runId) throw new Error('Model usage run identity mismatch');
      run.recordModelUsage(usage);
    },
    async beginRun(params) {
      if (disposed || ending || run) throw new Error('Capability session cannot begin another run');
      if (!params.hostRunId || usedRunIds.has(params.hostRunId)) throw new Error('Capability runId must be fresh');
      usedRunIds.add(params.hostRunId);
      entries.clear();
      runParams = params;
      run = createHostCapabilityRun(config, params, emit);
      try { await run.begin(); } catch (error) { await run.end(); run = undefined; throw error; }
    },
    async endRun() {
      if (!run || ending) return;
      ending = true;
      const current = run;
      current.cancel();
      try {
        await Promise.allSettled([...entries.values()].map(entry => entry.result));
        await Promise.allSettled([...modelTickets]);
        await current.end();
      } finally { run = undefined; runParams = undefined; for (const id of entries.keys()) retiredCallIds.add(id); entries.clear(); ending = false; }
    },
    async snapshot() {
      if (disposed) throw new Error('Capability session disposed');
      if (run) return { ...await active().snapshot(), ...capabilities() };
      const prompt = config.systemPrompt;
      return { tools: config.tools.getTools().map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
        systemPrompt: typeof prompt === 'string' ? prompt : prompt?.map(block => block.text).join('\n\n') ?? '', context: '', runId: '', model: resolveHostCapabilityModel(config), ...capabilities() };
    },
    async invoke(call, signal) {
      if (call.nativeTimeoutMs !== undefined) throw new Error('nativeTimeoutMs is only allowed for native admission');
      const current = active();
      const prior = existing(call, 'invoke');
      if (prior) return prior.result;
      const frozen = structuredClone(call);
      const result = current.execute(frozen, signal);
      entries.set(call.callId, { fingerprint: canonical(frozen), kind: 'invoke', result });
      return result;
    },
    async beforeNative(call, signal) {
      if (call.nativeTimeoutMs !== undefined && (!Number.isSafeInteger(call.nativeTimeoutMs) || call.nativeTimeoutMs < 1 || call.nativeTimeoutMs > 3600000)) throw new Error('nativeTimeoutMs must be an integer from 1 to 3600000');
      const current = active();
      if (Object.keys(call.arguments).some(key => key.startsWith('_'))) throw new Error('Native arguments cannot override host execution context');
      const prior = existing(call, 'native');
      if (prior) return { allowed: false, reason: 'Duplicate native callId: execution is already admitted or completed; do not execute again' };
      const frozen = structuredClone(call);
      let permit!: (value: Permission) => void;
      const permission = new Promise<Permission>(resolve => { permit = resolve; });
      let complete!: (value: ToolResult) => void;
      const completion = new Promise<ToolResult>(resolve => { complete = resolve; });
      const result = current.execute(frozen, signal, async (tool, context, authorizedInput) => {
        if (!tool.executeNative) return { isError: true, content: 'Native operation has no shared execution guards' };
        return tool.executeNative(authorizedInput, context, async () => {
          context.abortSignal.throwIfAborted();
          permit({ allowed: true });
          let onAbort!: () => void;
          const cancelled = new Promise<never>((_resolve, reject) => {
            onAbort = () => reject(context.abortSignal.reason);
            context.abortSignal.addEventListener('abort', onAbort, { once: true });
          });
          try { return await Promise.race([completion, cancelled]); }
          finally { context.abortSignal.removeEventListener('abort', onAbort); }
        });
      });
      const entry: Entry = { fingerprint: canonical(frozen), kind: 'native', result, permission, complete };
      entries.set(call.callId, entry);
      void result.then(value => { entry.finished = true; permit({ allowed: false, reason: String(value.content) }); }, error => { entry.finished = true; permit({ allowed: false, reason: String(error) }); });
      return permission;
    },
    async afterNative(call, signal) {
      active();
      signal.throwIfAborted();
      const { result, ...request } = call;
      const entry = existing(request, 'native');
      if (!entry) throw new Error('Native completion without admission');
      const permission = await entry.permission!;
      if (!permission.allowed) throw new Error('Native completion for denied operation');
      if (entry.finished && !entry.completionFingerprint) throw new Error('Native admission expired before completion; execution outcome is unknown');
      const fingerprint = canonical(result);
      if (entry.completionFingerprint && entry.completionFingerprint !== fingerprint) throw new Error('Conflicting native completion');
      entry.completionFingerprint = fingerprint;
      entry.complete!(asToolResult(result));
      await entry.result;
    },
    async dispose() { await session.endRun(); disposed = true; },
  };
  return session;
}
