import { ProcessCommandRunner } from './command-runner.js'
import { DockerWorkspaceManager } from './docker-workspace-manager.js'
import { createWorkerServer, listenWorkerServer } from './server.js'
import {
  UnixSocketQuotaCommandRunner,
  verifyStorageQuotaSupport,
  XfsProjectQuotaManager,
} from './storage-quota.js'
import { verifyResourceIsolationSupport } from './resource-isolation.js'
import {
  createJsonEventLogger,
  writeWorkerLifecycleEvent,
} from './observability.js'

const token = process.env.TABTIN_CLOUD_WORKER_TOKEN ?? ''
const host = process.env.TABTIN_CLOUD_WORKER_HOST ?? '127.0.0.1'
const port = Number(process.env.TABTIN_CLOUD_WORKER_PORT ?? '8090')
const protocolVersion = process.env.TABTIN_CLOUD_WORKER_PROTOCOL_VERSION ?? '1'
const runtimeVersion = process.env.TABTIN_CLOUD_WORKER_RUNTIME_VERSION ?? 'dev'
const network = process.env.TABTIN_CLOUD_RUNTIME_NETWORK ?? 'tabtin-cloud-runtime'
const containerCli = process.env.TABTIN_CLOUD_CONTAINER_CLI ?? 'docker'
const storageQuotaMode = process.env.TABTIN_CLOUD_STORAGE_QUOTA_MODE === 'podman-xfs'
  ? 'podman-xfs'
  : 'none'
const runtimeStorageGb = Number(process.env.TABTIN_CLOUD_RUNTIME_STORAGE_GB ?? '2')
const resourceIsolationMode = process.env.TABTIN_CLOUD_RESOURCE_ISOLATION_MODE === 'cgroup-v2'
  ? 'cgroup-v2'
  : 'unverified'
let startupStage = 'configuration'
let activeServer: ReturnType<typeof createWorkerServer> | undefined
try {
  if (!Number.isSafeInteger(runtimeStorageGb) || runtimeStorageGb < 1) {
    throw new Error('TABTIN_CLOUD_RUNTIME_STORAGE_GB must be a positive integer')
  }

  const runner = new ProcessCommandRunner(containerCli)
  const quotaManager = storageQuotaMode === 'podman-xfs'
    ? new XfsProjectQuotaManager(new UnixSocketQuotaCommandRunner())
    : null
  startupStage = 'storage_quota_probe'
  await verifyStorageQuotaSupport(runner, quotaManager, storageQuotaMode)
  startupStage = 'resource_isolation_probe'
  await verifyResourceIsolationSupport(runner, resourceIsolationMode)
  const manager = new DockerWorkspaceManager(
    runner,
    network,
    storageQuotaMode,
    runtimeStorageGb,
    quotaManager,
  )
  startupStage = 'server_init'
  activeServer = createWorkerServer({
    manager,
    token,
    protocolVersion,
    runtimeVersion,
    storageQuotaMode,
    resourceIsolationMode,
    log: createJsonEventLogger(),
  })
  startupStage = 'server_listen'
  const address = await listenWorkerServer(activeServer, host, port)
  writeWorkerLifecycleEvent('cloud_worker_started', {
    host: address.address,
    port: address.port,
    protocolVersion,
    runtimeVersion,
    storageQuotaMode,
    resourceIsolationMode,
  })
} catch (error) {
  if (activeServer?.listening) activeServer.close()
  writeWorkerLifecycleEvent('cloud_worker_start_failed', {
    startupStage,
    errorType: error instanceof Error ? error.name : typeof error,
    protocolVersion,
    runtimeVersion,
    storageQuotaMode,
    resourceIsolationMode,
  })
  process.exitCode = 1
}
