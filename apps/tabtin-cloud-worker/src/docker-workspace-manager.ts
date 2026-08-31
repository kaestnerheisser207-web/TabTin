import {
  CommandFailedError,
  type CommandRunner,
} from './command-runner.js'
import type {
  AllocationIdentity,
  ProvisionWorkspaceInput,
  WorkspaceRuntimeStatus,
} from './contracts.js'
import {
  XfsProjectQuotaManager,
  type StorageQuotaMode,
} from './storage-quota.js'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SAFE_VOLUME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/
const IMAGE_DIGEST = /^.+@sha256:[a-f0-9]{64}$/i
const LABEL_ALLOCATION = 'com.tabtin.cloud.allocation'
const LABEL_GENERATION = 'com.tabtin.cloud.generation'

interface DockerInspect {
  Id: string
  Config?: { Labels?: Record<string, string> }
  State?: { Running?: boolean }
}

export class StaleGenerationError extends Error {
  constructor(readonly currentGeneration: number) {
    super(`stale allocation generation; current=${currentGeneration}`)
    this.name = 'StaleGenerationError'
  }
}

export class DockerWorkspaceManager {
  constructor(
    private readonly runner: CommandRunner,
    private readonly network = 'tabtin-cloud-runtime',
    private readonly storageQuotaMode: StorageQuotaMode = 'none',
    private readonly runtimeStorageGb = 2,
    private readonly quotaManager: XfsProjectQuotaManager | null = null,
  ) {}

  async provision(input: ProvisionWorkspaceInput): Promise<WorkspaceRuntimeStatus> {
    validateProvisionInput(input)
    if (
      this.storageQuotaMode === 'podman-xfs'
      && input.volumeRef !== workspaceVolume(input.allocationId)
    ) {
      throw new Error('volumeRef must match the allocation id')
    }
    const container = containerName(input.allocationId)
    const existing = await this.inspect(container)
    if (existing) {
      const currentGeneration = readGeneration(existing)
      if (currentGeneration > input.generation) {
        throw new StaleGenerationError(currentGeneration)
      }
      if (currentGeneration === input.generation) {
        if (existing.State?.Running && await this.isDaemonInitialized(input)) {
          return statusOf(input, existing, 'running')
        }
        if (existing.State?.Running) {
          await this.runner.run(['stop', '--time', '30', container])
        }
        await this.writeBootstrapToken(input)
        await this.runner.run(['start', container])
        return await this.requireRunning(input)
      }
      await this.runner.run(['rm', '--force', container])
    }

    const volumeExisted = await this.volumeExists(input.volumeRef)
    await this.createVolume(input.volumeRef, input.allocationId, input.storageGb)
    await this.createVolume(
      runtimeVolume(input.volumeRef),
      input.allocationId,
      this.runtimeStorageGb,
    )
    await this.writeBootstrapToken(input)
    if (!volumeExisted && input.source.type === 'git') {
      await this.initializeGitWorkspace(input)
    }

    await this.runner.run([
      'create',
      '--name', container,
      '--label', `${LABEL_ALLOCATION}=${input.allocationId}`,
      '--label', `${LABEL_GENERATION}=${input.generation}`,
      '--restart', 'unless-stopped',
      '--cpus', String(input.cpuMillicores / 1000),
      '--memory', `${input.memoryMb}m`,
      '--pids-limit', '1024',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--network', this.network,
      '--mount', `type=volume,src=${input.volumeRef},dst=/workspace`,
      '--mount', `type=volume,src=${runtimeVolume(input.volumeRef)},dst=/var/lib/tabtin`,
      '--tmpfs', '/tmp:rw,nosuid,size=536870912',
      '--env', `TABTIN_CLOUD_ALLOCATION_ID=${input.allocationId}`,
      '--env', `TABTIN_CLOUD_GENERATION=${input.generation}`,
      '--env', 'TABTIN_WORKSPACE_ROOT=/workspace',
      '--env', 'DSH_HOME=/var/lib/tabtin/dsh',
      '--env', 'TABTIN_DAEMON_BOOTSTRAP_TOKEN_FILE=/var/lib/tabtin/bootstrap/install-token',
      input.image,
    ])
    await this.runner.run(['start', container])
    return await this.requireRunning(input)
  }

  async status(identity: AllocationIdentity): Promise<WorkspaceRuntimeStatus> {
    validateIdentity(identity)
    const inspected = await this.inspect(containerName(identity.allocationId))
    if (!inspected) {
      return { ...identity, state: 'missing' }
    }
    const currentGeneration = readGeneration(inspected)
    requireCurrentGeneration(currentGeneration, identity.generation)
    return statusOf(
      identity,
      inspected,
      inspected.State?.Running ? 'running' : 'stopped',
    )
  }

  async disable(identity: AllocationIdentity): Promise<WorkspaceRuntimeStatus> {
    validateIdentity(identity)
    const current = await this.status(identity)
    if (current.state === 'missing') return current
    await this.runner.run(['stop', '--time', '30', containerName(identity.allocationId)])
    return { ...current, state: 'stopped' }
  }

  async restart(identity: AllocationIdentity): Promise<WorkspaceRuntimeStatus> {
    validateIdentity(identity)
    const current = await this.status(identity)
    if (current.state === 'missing') return current
    await this.runner.run(['restart', '--time', '30', containerName(identity.allocationId)])
    return await this.requireRunning(identity)
  }

  async deletePermanently(identity: AllocationIdentity): Promise<void> {
    validateIdentity(identity)
    const current = await this.status(identity)
    if (current.state !== 'missing') {
      await this.runner.run(['rm', '--force', containerName(identity.allocationId)])
    }
    if (this.storageQuotaMode === 'podman-xfs') {
      const workspace = workspaceVolume(identity.allocationId)
      for (const volume of [workspace, runtimeVolume(workspace)]) {
        if (await this.dockerVolumeExists(volume)) {
          await this.runner.run(['volume', 'rm', volume])
        }
        await this.requireQuotaManager().delete(volume)
      }
      return
    }
    const volumes = await this.findAllocationVolumes(identity.allocationId)
    for (const volume of volumes) await this.runner.run(['volume', 'rm', volume])
  }

  private async initializeGitWorkspace(input: ProvisionWorkspaceInput): Promise<void> {
    if (input.source.credentialRef) {
      throw new Error('credential_ref requires the Credential Broker and cannot be sent to Docker')
    }
    const gitArgs = ['clone', '--depth', '1']
    if (input.source.gitRef) gitArgs.push('--branch', input.source.gitRef)
    gitArgs.push(input.source.gitUrl!, '/workspace')
    await this.runner.run([
      'run', '--rm',
      '--pids-limit', '256',
      '--network', this.network,
      '--mount', `type=volume,src=${input.volumeRef},dst=/workspace`,
      '--entrypoint', 'git',
      input.image,
      ...gitArgs,
    ])
  }

  private async writeBootstrapToken(input: ProvisionWorkspaceInput): Promise<void> {
    await this.runner.run([
      'run', '--rm', '--interactive',
      '--pids-limit', '256',
      '--network', 'none',
      '--cap-drop', 'ALL',
      '--cap-add', 'CHOWN',
      '--cap-add', 'DAC_OVERRIDE',
      '--cap-add', 'FOWNER',
      '--security-opt', 'no-new-privileges',
      '--user', '0:0',
      '--mount', `type=volume,src=${runtimeVolume(input.volumeRef)},dst=/var/lib/tabtin`,
      '--mount', `type=volume,src=${input.volumeRef},dst=/workspace`,
      '--entrypoint', 'sh',
      input.image,
      '-c',
      'umask 077; mkdir -p /var/lib/tabtin/bootstrap; cat > /var/lib/tabtin/bootstrap/install-token; chown -R 1000:1000 /var/lib/tabtin /workspace',
    ], input.bootstrapToken)
  }

  private async isDaemonInitialized(input: ProvisionWorkspaceInput): Promise<boolean> {
    const result = await this.runner.run([
      'run', '--rm',
      '--pids-limit', '256',
      '--network', 'none',
      '--cap-drop', 'ALL',
      '--security-opt', 'no-new-privileges',
      '--mount', `type=volume,src=${runtimeVolume(input.volumeRef)},dst=/var/lib/tabtin,readonly`,
      '--entrypoint', 'sh',
      input.image,
      '-c',
      'if [ -f /var/lib/tabtin/daemon/config.json ]; then printf initialized; else printf uninitialized; fi',
    ])
    return result.stdout.trim() === 'initialized'
  }

  private async requireRunning(identity: AllocationIdentity): Promise<WorkspaceRuntimeStatus> {
    const inspected = await this.inspect(containerName(identity.allocationId))
    if (!inspected?.State?.Running) {
      throw new Error('workspace runtime failed to reach running state')
    }
    requireCurrentGeneration(readGeneration(inspected), identity.generation)
    return statusOf(identity, inspected, 'running')
  }

  private async createVolume(
    volume: string,
    allocationId: string,
    storageGb: number,
  ): Promise<void> {
    const args = [
      'volume', 'create',
      '--label', `${LABEL_ALLOCATION}=${allocationId}`,
    ]
    if (this.storageQuotaMode === 'podman-xfs') {
      const quotaVolume = await this.requireQuotaManager().ensure(volume, storageGb)
      args.push(
        '--opt', 'type=none',
        '--opt', `device=${quotaVolume.path}`,
        '--opt', 'o=bind',
      )
    }
    args.push(volume)
    await this.runner.run(args)
  }

  private async volumeExists(volume: string): Promise<boolean> {
    if (this.storageQuotaMode === 'podman-xfs') {
      return await this.requireQuotaManager().inspect(volume) !== null
    }
    return await this.dockerVolumeExists(volume)
  }

  private async dockerVolumeExists(volume: string): Promise<boolean> {
    try {
      await this.runner.run(['volume', 'inspect', volume])
      return true
    } catch (error) {
      if (isNotFound(error)) return false
      throw error
    }
  }

  private async findAllocationVolumes(allocationId: string): Promise<string[]> {
    const result = await this.runner.run([
      'volume', 'ls', '--quiet', '--filter', `label=${LABEL_ALLOCATION}=${allocationId}`,
    ])
    return result.stdout.split('\n').map(value => value.trim()).filter(Boolean)
  }

  private requireQuotaManager(): XfsProjectQuotaManager {
    if (!this.quotaManager) throw new Error('podman-xfs requires the quota helper')
    return this.quotaManager
  }

  private async inspect(container: string): Promise<DockerInspect | null> {
    try {
      const result = await this.runner.run(['inspect', container])
      const parsed = JSON.parse(result.stdout) as DockerInspect[]
      return parsed[0] ?? null
    } catch (error) {
      if (isNotFound(error)) return null
      throw error
    }
  }
}

function validateProvisionInput(input: ProvisionWorkspaceInput): void {
  validateIdentity(input)
  if (!SAFE_VOLUME.test(input.volumeRef)) throw new Error('invalid volumeRef')
  if (!IMAGE_DIGEST.test(input.image)) throw new Error('image must use an immutable sha256 digest')
  if (!Number.isInteger(input.cpuMillicores) || input.cpuMillicores < 250) throw new Error('invalid cpuMillicores')
  if (!Number.isInteger(input.memoryMb) || input.memoryMb < 256) throw new Error('invalid memoryMb')
  if (!Number.isInteger(input.storageGb) || input.storageGb < 1) throw new Error('invalid storageGb')
  if (input.source.type === 'git' && !input.source.gitUrl) throw new Error('gitUrl is required')
  if (!input.bootstrapToken || input.bootstrapToken.length > 8192) throw new Error('invalid bootstrapToken')
}

function validateIdentity(identity: AllocationIdentity): void {
  if (!UUID.test(identity.allocationId)) throw new Error('invalid allocationId')
  if (!Number.isSafeInteger(identity.generation) || identity.generation < 1) {
    throw new Error('invalid generation')
  }
}

function readGeneration(inspect: DockerInspect): number {
  const raw = inspect.Config?.Labels?.[LABEL_GENERATION]
  const generation = Number(raw)
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error('container has no valid TabTin generation label')
  }
  return generation
}

function requireCurrentGeneration(current: number, expected: number): void {
  if (current > expected) throw new StaleGenerationError(current)
  if (current !== expected) {
    throw new Error(`workspace runtime generation mismatch; current=${current} expected=${expected}`)
  }
}

function statusOf(
  identity: AllocationIdentity,
  inspect: DockerInspect,
  state: 'running' | 'stopped',
): WorkspaceRuntimeStatus {
  return {
    allocationId: identity.allocationId,
    generation: identity.generation,
    state,
    containerId: inspect.Id,
  }
}

function containerName(allocationId: string): string {
  return `tabtin-cloud-${allocationId}`
}

function runtimeVolume(volume: string): string {
  return `${volume}-runtime`
}

function workspaceVolume(allocationId: string): string {
  return `cloud-workspace-${allocationId}`
}

function isNotFound(error: unknown): boolean {
  return error instanceof CommandFailedError
    && error.exitCode === 1
    && /no such (object|container|volume)/i.test(error.stderr)
}
