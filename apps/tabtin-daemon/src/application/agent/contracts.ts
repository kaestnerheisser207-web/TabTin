import type { AgentModeName } from '@muse/agent-modes'
import type { AppContext } from '@muse/agent-host/hooks'
import type { NativeBackendBootstrapResult } from '@muse/agent-host/native'
import type { HostedRuntime, RuntimeCacheKey } from '@muse/agent-host/runtime'
import type { AttachmentStrategy } from '@muse/agent-host/configuration'
import type { WorkingDirType } from '@muse/agent-prompt'
import type {
  ContentBlock,
  EngineConfig,
  EventEmitter,
  EventStorage,
  PersistedEntryOwner,
  SessionStorage,
  SnapshotStorage,
  StreamEvent,
  SubagentManager,
  ToolLogWriter,
} from '@muse/agent-runtime'
import type {
  SerializedPendingApproval,
  SerializedPendingSingleHitl,
} from '@muse/agent-runtime/engine'
import type { ExitFlushStore } from '@muse/agent-runtime'
import type {
  ManagedTaskStore,
  NotificationQueue,
  PtyManagerBridge,
} from '@muse/terminal-core'

import type { DaemonToolProvider } from './daemon-tool-provider.js'

export interface DaemonQueryRequestContract {
  /** Agent Harness; local/cloud execution plane is resolved from Workspace. */
  harness?: import('@muse/agent-host/runtime').RuntimeHarness
  prompt: string
  runId?: string
  sessionId: string
  taskId?: string
  relaySessionId?: string
  threadId?: string
  modelId?: string
  modelSupportsVideoInput?: boolean
  modelSupportsDocumentInput?: boolean
  systemPrompt?: string
  maxTurns?: number
  agentId?: string
  authorizationPreset?: 'cautious' | 'collaborative' | 'full_auto' | 'server_auto'
  yoloMode?: boolean
  approvalMode?: string
  approvalGrant?: string
  workspaceSnapshot?: import('@muse/security-policy').WorkspaceSnapshot
  userId?: string
  customRules?: string
  agentName?: string
  personalRules?: string
  attachments?: Array<{
    type: string
    file_id?: string
    filename?: string
    mime_type?: string
    size?: number
    url?: string
    preview_url?: string
  }>
  userMessageBlocks?: Array<Record<string, unknown>>
  attachmentStrategy?: AttachmentStrategy
  agentMode?: AgentModeName
  interactionMode?: 'interactive' | 'solo' | 'scheduled' | 'batch'
  spaceId?: string
  workspaceId?: string
  appContext?: AppContext
  enabledApps?: ReadonlyArray<{ key: string; cliKey?: string; displayName: string; capability: string; aliases?: readonly string[] }>
  spaceName?: string
  organizationName?: string
  cliReference?: string
  history?: Array<{ role: 'user' | 'assistant'; content: string | ContentBlock[] }>
  operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>
  disabledApps?: string[]
  disabledToolPrefixes?: string[]
  devicePermissions?: Record<string, 'allow' | 'confirm' | 'block'>
  executionLimits?: { max_iterations_per_run?: number; max_credits_per_run?: number }
  memoryCapability?: boolean
  workingDirType?: WorkingDirType
  isByokMode?: boolean
  cloudPressureThresholds?: { microCompactStart: number; llmSummaryStart: number; emergencyStart: number }
  clientMessageId?: string
  skillSlashInvoke?: { skillKey: string; args?: string }
  triggeredBy?: 'user' | 'push-notification'
  pendingApprovalsSerialized?: SerializedPendingApproval[]
  pendingSingleHitlSerialized?: SerializedPendingSingleHitl[]
  isGroupSpace?: boolean
}

export interface RuntimeBuildInputContract {
  modelId: string
  agentId: string | undefined
  authorizationPreset: 'cautious' | 'collaborative' | 'full_auto' | 'server_auto' | undefined
  customRules: string | undefined
  personalRules: string | undefined
  owner: PersistedEntryOwner
  spaceId: string | undefined
  operationSwitches: Record<string, 'allow' | 'confirm' | 'block'> | undefined
  disabledApps: string[]
  disabledToolPrefixes: string[]
  memoryCapability: boolean | undefined
  workingDirType: WorkingDirType | undefined
  executionLimits: { max_iterations_per_run?: number; max_credits_per_run?: number } | undefined
  yoloMode: boolean | undefined
  workspaceSnapshot: import('@muse/security-policy').WorkspaceSnapshot | undefined
  isByokMode: boolean | undefined
  enabledApps: DaemonQueryRequestContract['enabledApps']
  isGroupSpace: boolean | undefined
  spaceName: string | undefined
  organizationName: string | undefined
  cliReference: string | undefined
  threadId: string | undefined
  cloudPressureThresholds: DaemonQueryRequestContract['cloudPressureThresholds']
  workspaceId: string
}

export interface RuntimeCarryForwardContract {
  subagentManager: SubagentManager
}

export interface DaemonHostStateContract extends RuntimeCacheKey {
  runtime: HostedRuntime
  sessionId: string
  businessThreadId: string
  fileHistoryThreadId: string
  modelId: string
  customRules: string | undefined
  personalRules: string | undefined
  workspaceRoot: string | undefined
  owner: PersistedEntryOwner
  agentMode: AgentModeName
  spaceId: string | undefined
  workspaceId: string
  maxCreditsPerRun: number | undefined
  memoryCapability: boolean
  workingDirType: WorkingDirType | undefined
  disabledApps: string[]
  disabledToolPrefixes: string[]
  operationSwitches: Record<string, 'allow' | 'confirm' | 'block'> | undefined
  abortController: AbortController
  pauseController: import('@muse/agent-host/delivery').SessionPauseController
  sessionStorage: SessionStorage
  snapshotStorage: SnapshotStorage
  eventStorage: EventStorage
  toolLogWriter: ToolLogWriter | null
  toolProvider: DaemonToolProvider
  eventInterceptor?: (event: StreamEvent) => void
  eventEmitter: EventEmitter
  appContext: AppContext | null
  agentProfile: { agentName?: string; customRules?: string } | null
  engineConfig: EngineConfig
  backendBootstrap: NativeBackendBootstrapResult | null
  agentConfigV3: import('@muse/security-policy').AgentConfigV3 | null
  workspaceSnapshot: import('@muse/security-policy').WorkspaceSnapshot | null
  policyContext: {
    currentAgentMode: AgentModeName
    isGroupSpace: boolean
    requestedApprovalMode?: import('@muse/security-policy').ApprovalMode
  }
  subagentManager: SubagentManager
  subagentStreamSink: (event: StreamEvent) => void
}

export interface CatalogEntryContract {
  contextWindowTokens: number
  maxOutputTokens: number
  supportsVision: boolean
  supportsFunctionCalling: boolean
  supportsPromptCaching: boolean
  cacheType: 'explicit' | 'implicit' | 'none'
  reasoningHistoryPolicy?: 'drop' | 'preserve_for_tools' | 'preserve'
  id: string
  aliases?: string[]
  displayName?: string
  usageHint?: string
  providerScope?: string
}

export interface AgentTerminalPort extends PtyManagerBridge {
  getNotificationQueue(): NotificationQueue
  getManagedTaskStore(): ManagedTaskStore & ExitFlushStore
}

export type DaemonQueryResult = { success: boolean; error?: string }
