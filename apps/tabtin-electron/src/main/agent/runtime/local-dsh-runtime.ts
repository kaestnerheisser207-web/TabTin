import { app } from 'electron'
import type { LLMProvider } from '@muse/agent-runtime'
import path from 'node:path'
import { ManagedDshRuntime, type DshInteractionPort } from '@muse/agent-host/runtime/dsh'
import type { HostCapabilitySession, RuntimeDriverContext } from '@muse/agent-host/runtime'
import { TokenManager } from '../../auth.js'
import { API_BASE_URL } from '../../config/api.js'
import { requireLocalDshExecutable } from '../../dsh/local-dsh-installation.js'
import { createLogger } from '../../logger.js'

const logger = createLogger('LocalDshRuntime')
const liveRuntimes = new Set<LocalDshRuntime>()

export interface LocalDshRuntimeOptions extends RuntimeDriverContext {
  modelId: string
  localProvider?: LLMProvider
  interactions: DshInteractionPort
  capabilities: HostCapabilitySession
  permissionMode: 'read-only' | 'workspace-write'
}

/** Electron supplies authentication and paths; the runtime lifecycle is shared with Cloud. */
export class LocalDshRuntime extends ManagedDshRuntime {
  constructor(options: LocalDshRuntimeOptions) {
    super({
      ...options,
      dataRoot: app.getPath('userData'),
      pluginPath: app.isPackaged ? path.join(process.resourcesPath, 'dsh-muse-plugin', 'index.js') : undefined,
      serverUrl: API_BASE_URL,
      getExecutable: requireLocalDshExecutable,
      getCredential: async () => {
        const info: unknown = await TokenManager.getUserInfo()
        const user = info && typeof info === 'object' ? info as Record<string, unknown> : {}
        const userId = String(user.id ?? user.user_id ?? user.userId ?? '')
        if (userId !== options.owner.userId) throw new Error('Local DSH owner is no longer authenticated')
        const token = await TokenManager.getAccessToken()
        if (!token) throw new Error('Local DSH requires an authenticated Muse session')
        const latest: unknown = await TokenManager.getUserInfo()
        const latestUser = latest && typeof latest === 'object' ? latest as Record<string, unknown> : {}
        if (String(latestUser.id ?? latestUser.user_id ?? latestUser.userId ?? '') !== options.owner.userId) {
          throw new Error('Local DSH owner changed during credential refresh')
        }
        return token
      },
      logger,
    })
    liveRuntimes.add(this)
  }

  override async dispose(): Promise<void> {
    try { await super.dispose() } finally { liveRuntimes.delete(this) }
  }
}

export async function disposeLocalDshRuntimes(): Promise<void> {
  await Promise.all([...liveRuntimes].map(runtime => runtime.dispose()))
}
