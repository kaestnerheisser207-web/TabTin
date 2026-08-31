import type { Writable } from 'node:stream'

export type WorkerOperation =
  | 'health'
  | 'metrics'
  | 'provision'
  | 'status'
  | 'disable'
  | 'restart'
  | 'delete'
  | 'unknown'

export interface WorkerRequestObservation {
  operation: WorkerOperation
  result: 'ok' | 'error' | 'unauthorized' | 'not_found' | 'method_not_allowed'
  statusCode: number
  durationMs: number
  allocationId?: string
  generation?: number
  errorType?: string
}

export interface WorkerInfo {
  protocolVersion: string
  runtimeVersion: string
  storageQuotaMode: string
  resourceIsolationMode: string
}

export type WorkerEventLogger = (observation: WorkerRequestObservation) => void

export class WorkerMetrics {
  private readonly counts = new Map<string, number>()
  private readonly durationSeconds = new Map<string, number>()

  record(observation: WorkerRequestObservation): void {
    const key = metricKey(observation.operation, observation.result)
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1)
    this.durationSeconds.set(
      key,
      (this.durationSeconds.get(key) ?? 0) + Math.max(0, observation.durationMs) / 1000,
    )
  }

  render(info: WorkerInfo): string {
    const lines = [
      '# HELP tabtin_cloud_worker_up Whether this Cloud Worker process is serving requests.',
      '# TYPE tabtin_cloud_worker_up gauge',
      'tabtin_cloud_worker_up 1',
      '# HELP tabtin_cloud_worker_info Immutable Worker capability and release information.',
      '# TYPE tabtin_cloud_worker_info gauge',
      `tabtin_cloud_worker_info{protocol_version="${escapeLabel(info.protocolVersion)}",runtime_version="${escapeLabel(info.runtimeVersion)}",storage_quota_mode="${escapeLabel(info.storageQuotaMode)}",resource_isolation_mode="${escapeLabel(info.resourceIsolationMode)}"} 1`,
      '# HELP tabtin_cloud_worker_requests_total Cloud Worker requests by bounded operation and outcome.',
      '# TYPE tabtin_cloud_worker_requests_total counter',
    ]
    for (const [key, count] of sortedEntries(this.counts)) {
      const [operation, result] = key.split('|')
      lines.push(`tabtin_cloud_worker_requests_total{operation="${operation}",result="${result}"} ${count}`)
    }
    lines.push(
      '# HELP tabtin_cloud_worker_request_duration_seconds Cloud Worker request duration by operation and outcome.',
      '# TYPE tabtin_cloud_worker_request_duration_seconds summary',
    )
    for (const [key, seconds] of sortedEntries(this.durationSeconds)) {
      const [operation, result] = key.split('|')
      const labels = `operation="${operation}",result="${result}"`
      lines.push(`tabtin_cloud_worker_request_duration_seconds_sum{${labels}} ${seconds}`)
      lines.push(`tabtin_cloud_worker_request_duration_seconds_count{${labels}} ${this.counts.get(key) ?? 0}`)
    }
    return `${lines.join('\n')}\n`
  }
}

export function createJsonEventLogger(
  stdout: Writable = process.stdout,
  stderr: Writable = process.stderr,
): WorkerEventLogger {
  return observation => {
    const stream = observation.result === 'ok' ? stdout : stderr
    stream.write(`${JSON.stringify({
      timestamp: new Date().toISOString(),
      service: 'tabtin-cloud-worker',
      event: 'cloud_worker_request_completed',
      ...observation,
    })}\n`)
  }
}

export function writeWorkerLifecycleEvent(
  event: 'cloud_worker_started' | 'cloud_worker_start_failed',
  fields: Record<string, string | number | boolean | undefined>,
  stream: Writable = event === 'cloud_worker_started' ? process.stdout : process.stderr,
): void {
  const safeFields = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== undefined),
  )
  stream.write(`${JSON.stringify({
    timestamp: new Date().toISOString(),
    service: 'tabtin-cloud-worker',
    event,
    ...safeFields,
  })}\n`)
}

function metricKey(operation: WorkerOperation, result: WorkerRequestObservation['result']): string {
  return `${operation}|${result}`
}

function sortedEntries(values: Map<string, number>): Array<[string, number]> {
  return [...values.entries()].sort(([left], [right]) => left.localeCompare(right))
}

function escapeLabel(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')
}
