import type { WorkingDirType } from '@muse/agent-prompt'
import {
  ownersMatch,
  type PersistedEntryOwner,
} from '@muse/agent-runtime'
import type { RuntimeHarness } from './runtime-driver.js'

type OperationSwitches = Record<string, 'allow' | 'confirm' | 'block'>

interface EnabledApp {
  key: string
  displayName: string
}

export interface RuntimeCacheKey {
  harness: RuntimeHarness
  modelId: string
  customRules: string | undefined
  personalRules: string | undefined
  workspaceRoot: string | undefined
  owner: PersistedEntryOwner
  spaceId: string | undefined
  operationSwitchesHash: string | undefined
  maxCreditsPerRun: number | undefined
  memoryCapability: boolean
  workingDirType: WorkingDirType | undefined
  enabledAppsHash: string | undefined
}

export interface CreateRuntimeCacheKeyInput {
  harness?: RuntimeHarness
  modelId: string
  customRules?: string
  personalRules?: string
  workspaceRoot: string | undefined
  owner: PersistedEntryOwner
  spaceId: string | undefined
  operationSwitches?: OperationSwitches
  maxCreditsPerRun?: number
  memoryCapability?: boolean
  workingDirType?: WorkingDirType
  enabledApps?: ReadonlyArray<EnabledApp>
}

export function createRuntimeCacheKey(
  input: CreateRuntimeCacheKeyInput,
): RuntimeCacheKey {
  return {
    harness: input.harness ?? 'builtin',
    modelId: input.modelId,
    customRules: input.customRules?.trim() || undefined,
    personalRules: input.personalRules?.trim() || undefined,
    workspaceRoot: input.workspaceRoot,
    owner: input.owner,
    spaceId: input.spaceId,
    operationSwitchesHash: hashOperationSwitches(input.operationSwitches),
    maxCreditsPerRun: input.maxCreditsPerRun,
    memoryCapability: input.memoryCapability === true,
    workingDirType: normalizeWorkingDirType(input.workingDirType),
    enabledAppsHash: hashEnabledApps(input.enabledApps),
  }
}

export function runtimeCacheKeysMatch(
  existing: RuntimeCacheKey,
  requested: RuntimeCacheKey,
): boolean {
  return existing.harness === requested.harness
    && existing.modelId === requested.modelId
    && existing.customRules === requested.customRules
    && existing.personalRules === requested.personalRules
    && existing.workspaceRoot === requested.workspaceRoot
    && ownersMatch(existing.owner, requested.owner)
    && (existing.owner.agentId ?? undefined) === (requested.owner.agentId ?? undefined)
    && existing.spaceId === requested.spaceId
    && existing.operationSwitchesHash === requested.operationSwitchesHash
    && existing.maxCreditsPerRun === requested.maxCreditsPerRun
    && existing.memoryCapability === requested.memoryCapability
    && existing.workingDirType === requested.workingDirType
    && existing.enabledAppsHash === requested.enabledAppsHash
}

function hashOperationSwitches(
  operationSwitches: OperationSwitches | undefined,
): string | undefined {
  if (!operationSwitches || Object.keys(operationSwitches).length === 0) return undefined

  return JSON.stringify(
    Object.keys(operationSwitches)
      .sort()
      .reduce<Record<string, string>>((result, key) => {
        result[key] = operationSwitches[key]
        return result
      }, {}),
  )
}

function hashEnabledApps(
  enabledApps: ReadonlyArray<EnabledApp> | undefined,
): string | undefined {
  if (!enabledApps || enabledApps.length === 0) return undefined

  return JSON.stringify(
    [...enabledApps]
      .map(app => [app.key, app.displayName] as const)
      .sort(([left], [right]) => left.localeCompare(right)),
  )
}

function normalizeWorkingDirType(
  value: WorkingDirType | undefined,
): WorkingDirType | undefined {
  return value === 'code' || value === 'doc' || value === 'mixed'
    ? value
    : undefined
}
