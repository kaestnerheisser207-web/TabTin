import { DockerCommandRunner } from './command-runner.js'
import { DockerWorkspaceManager } from './docker-workspace-manager.js'
import { createWorkerServer, listenWorkerServer } from './server.js'
import { verifyStorageQuotaSupport } from './storage-quota.js'
import { verifyResourceIsolationSupport } from './resource-isolation.js'

const token = process.env.TABTIN_CLOUD_WORKER_TOKEN ?? ''
const host = process.env.TABTIN_CLOUD_WORKER_HOST ?? '127.0.0.1'
const port = Number(process.env.TABTIN_CLOUD_WORKER_PORT ?? '8090')
const protocolVersion = process.env.TABTIN_CLOUD_WORKER_PROTOCOL_VERSION ?? '1'
const runtimeVersion = process.env.TABTIN_CLOUD_WORKER_RUNTIME_VERSION ?? 'dev'
const network = process.env.TABTIN_CLOUD_RUNTIME_NETWORK ?? 'tabtin-cloud-runtime'
const storageQuotaMode = process.env.TABTIN_CLOUD_STORAGE_QUOTA_MODE === 'podman-xfs'
  ? 'podman-xfs'
  : 'none'
const runtimeStorageGb = Number(process.env.TABTIN_CLOUD_RUNTIME_STORAGE_GB ?? '2')
const resourceIsolationMode = process.env.TABTIN_CLOUD_RESOURCE_ISOLATION_MODE === 'cgroup-v2'
  ? 'cgroup-v2'
  : 'unverified'
if (!Number.isSafeInteger(runtimeStorageGb) || runtimeStorageGb < 1) {
  throw new Error('TABTIN_CLOUD_RUNTIME_STORAGE_GB must be a positive integer')
}

const runner = new DockerCommandRunner()
await verifyStorageQuotaSupport(runner, storageQuotaMode)
await verifyResourceIsolationSupport(runner, resourceIsolationMode)
const manager = new DockerWorkspaceManager(
  runner,
  network,
  storageQuotaMode,
  runtimeStorageGb,
)
const server = createWorkerServer({
  manager,
  token,
  protocolVersion,
  runtimeVersion,
  storageQuotaMode,
  resourceIsolationMode,
})
const address = await listenWorkerServer(server, host, port)
process.stdout.write(`TabTin Cloud Worker listening on ${address.address}:${address.port}\n`)
