import { createHash, randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import path from 'node:path'
import type { LLMProvider, QueryParams, StreamEvent } from '@muse/agent-runtime'
import type { HostedRuntime, RuntimeDriverContext } from '../runtime-driver.js'
import type { HostCapabilitySession } from '../host-capability-session.js'
import { DshApiClient } from './dsh-api-client.js'
import { DshModelGateway } from './dsh-model-gateway.js'
import { DshProcessService } from './dsh-process-service.js'
import { DshRuntimeDriver, type DshInteractionPort } from './dsh-runtime-driver.js'
import { DshCapabilityBridge } from './dsh-capability-bridge.js'

export interface ManagedDshRuntimeOptions extends RuntimeDriverContext {
  modelId: string
  localProvider?: LLMProvider
  interactions: DshInteractionPort
  capabilities: HostCapabilitySession
  permissionMode: 'read-only' | 'workspace-write'
  dataRoot: string
  pluginPath?: string
  serverUrl: string
  getCredential(): Promise<string>
  getExecutable(): Promise<string>
  logger: { info(message: string): void; warn(message: string): void }
}

/** The same isolated process/bridge lifecycle on Electron and Cloud Daemon. */
export class ManagedDshRuntime implements HostedRuntime {
  private runtime: HostedRuntime | null = null
  private gateway: DshModelGateway | null = null
  private process: DshProcessService | null = null
  private bridge: DshCapabilityBridge | null = null
  private starting: Promise<HostedRuntime> | null = null
  private disposed = false
  private activeQuery: AbortController | null = null
  private readonly controller = new AbortController()

  constructor(private readonly options: ManagedDshRuntimeOptions) {}

  getRuntimeId(): string { return `muse-dsh:${this.options.threadId}` }

  async *query(params: QueryParams): AsyncGenerator<StreamEvent> {
    if (this.activeQuery) throw new Error('DSH query is already active')
    const controller = new AbortController()
    this.activeQuery = controller
    const signals = [controller.signal, this.controller.signal]
    if (params.signal) signals.push(params.signal)
    const signal = AbortSignal.any(signals)
    try {
      signal.throwIfAborted()
      const runtime = await this.ensureStarted(signal)
      signal.throwIfAborted()
      yield* runtime.query({ ...params, signal })
    } finally { this.activeQuery = null }
  }

  async compactCheckpoint(params: Parameters<NonNullable<HostedRuntime['compactCheckpoint']>>[0]) {
    if (this.activeQuery) throw new Error('Cannot compact an active DSH turn')
    const runtime = await this.ensureStarted(this.controller.signal)
    if (!runtime.compactCheckpoint) throw new Error('Muse DSH plugin does not support compaction')
    return runtime.compactCheckpoint(params)
  }

  abort(): void {
    this.activeQuery?.abort(new Error('DSH query aborted'))
    void this.runtime?.abort()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.controller.abort(new Error('DSH runtime disposed'))
    this.abort()
    await this.starting?.catch(() => undefined)
    const errors: unknown[] = []
    try { await this.runtime?.dispose?.() } catch (error) { errors.push(error) }
    const cleanup = await Promise.allSettled([
      this.process?.stop(), this.gateway?.stop(), this.bridge?.stop(false),
    ])
    for (const result of cleanup) if (result.status === 'rejected') errors.push(result.reason)
    try { await this.options.capabilities.dispose() } catch (error) { errors.push(error) }
    this.runtime = null
    this.process = null
    this.gateway = null
    this.bridge = null
    if (errors.length) throw new AggregateError(errors, 'DSH runtime cleanup failed')
  }

  private ensureStarted(signal: AbortSignal): Promise<HostedRuntime> {
    if (this.disposed) return Promise.reject(new Error('DSH runtime disposed'))
    if (this.runtime) return Promise.resolve(this.runtime)
    if (!this.starting) this.starting = this.start(signal).finally(() => { this.starting = null })
    return this.starting
  }

  private async start(signal: AbortSignal): Promise<HostedRuntime> {
    const executable = await waitForPreparation(() => this.options.getExecutable(), signal)
    const credential = await waitForPreparation(() => this.options.getCredential(), signal)
    signal.throwIfAborted()
    const { userId, organizationId } = this.options.owner
    if (!userId || !organizationId || !credential) throw new Error('DSH requires an authenticated execution owner')
    const scope = createHash('sha256').update(JSON.stringify([
      userId, organizationId, this.options.workspaceId, this.options.workspaceRoot,
      this.options.threadId, this.options.modelId, this.options.permissionMode,
    ])).digest('hex')
    const token = randomBytes(32).toString('hex')
    const gateway = new DshModelGateway({
      serverUrl: this.options.serverUrl, organizationId, credential,
      getCredential: this.options.getCredential, token, port: 0,
      modelId: this.options.modelId, sessionId: this.options.threadId,
      provider: this.options.localProvider,
      beforeRequest: async () => ({ ...await this.options.capabilities.beforeModelRequest(), summaryFocus: this.bridge?.compactionFocus }),
      onUsage: usage => this.options.capabilities.recordModelUsage(usage),
    })
    const bridge = new DshCapabilityBridge(this.options.capabilities)
    this.gateway = gateway
    this.bridge = bridge
    try {
      await gateway.start()
      await bridge.start()
      signal.throwIfAborted()
      const apiUrl = `http://127.0.0.1:${await allocatePort()}`
      const dshHome = path.join(this.options.dataRoot, 'dsh', scope)
      const process = new DshProcessService({
        executable, workspaceRoot: this.options.workspaceRoot,
        dshHome, apiUrl,
        modelGatewayUrl: `http://127.0.0.1:${gateway.port}/v1`, modelGatewayToken: token,
        capabilityBridgeUrl: bridge.url, capabilityBridgeToken: bridge.token,
        pluginPath: this.options.pluginPath,
        logger: this.options.logger, permissionMode: this.options.permissionMode,
      })
      this.process = process
      await process.start(signal)
      await bridge.waitUntilReady(signal)
      signal.throwIfAborted()
      const session = await new DshRuntimeDriver(new DshApiClient(apiUrl), this.options.interactions, this.options.modelId, bridge, {
        bindingPath: path.join(dshHome, 'muse-session-binding.json'),
        terminateUnconfirmedRun: () => process.stop(),
      })
        .create(this.options)
      this.runtime = session.runtime
      this.options.logger.info(`DSH process connected; awaiting turn capability initialization: thread=${this.options.threadId}, model=${this.options.modelId}`)
      return session.runtime
    } catch (error) {
      const cleanup = await Promise.allSettled([this.process?.stop(), gateway.stop(), bridge.stop(false)])
      for (const result of cleanup) {
        if (result.status === 'rejected') this.options.logger.warn('DSH startup resource cleanup failed')
      }
      this.process = null
      this.gateway = null
      this.bridge = null
      throw error
    }
  }
}

/** Detection/auth may not expose cancellation, but must not hold a stopped run open. */
async function waitForPreparation<T>(prepare: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let onAbort!: () => void
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  try {
    const result = await Promise.race([prepare(), aborted])
    signal.throwIfAborted()
    return result
  } finally { signal.removeEventListener('abort', onAbort) }
}

async function allocatePort(): Promise<number> {
  const server = createServer()
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Cannot allocate DSH loopback port')
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  return address.port
}
