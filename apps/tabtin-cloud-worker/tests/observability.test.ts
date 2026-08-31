import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  WorkerMetrics,
  createJsonEventLogger,
  writeWorkerLifecycleEvent,
} from '../src/observability.js'

describe('Cloud Worker observability', () => {
  it('renders bounded Prometheus series with escaped immutable info labels', () => {
    const metrics = new WorkerMetrics()
    metrics.record({
      operation: 'restart',
      result: 'ok',
      statusCode: 200,
      durationMs: 250,
    })

    const payload = metrics.render({
      protocolVersion: '1',
      runtimeVersion: 'sha"quoted',
      storageQuotaMode: 'podman-xfs',
      resourceIsolationMode: 'cgroup-v2',
    })

    expect(payload).toContain('runtime_version="sha\\"quoted"')
    expect(payload).toContain(
      'tabtin_cloud_worker_requests_total{operation="restart",result="ok"} 1',
    )
    expect(payload).toContain(
      'tabtin_cloud_worker_request_duration_seconds_sum{operation="restart",result="ok"} 0.25',
    )
    expect(payload).not.toContain('allocation')
  })

  it('writes JSON lifecycle and request events without arbitrary error details', () => {
    const stdout = new PassThrough()
    const stderr = new PassThrough()
    let output = ''
    let errors = ''
    stdout.on('data', chunk => { output += chunk.toString('utf8') })
    stderr.on('data', chunk => { errors += chunk.toString('utf8') })

    const log = createJsonEventLogger(stdout, stderr)
    log({
      operation: 'provision',
      result: 'error',
      statusCode: 400,
      durationMs: 10,
      errorType: 'CommandFailedError',
    })
    writeWorkerLifecycleEvent('cloud_worker_started', { runtimeVersion: 'release-1' }, stdout)

    expect(output).toContain('"event":"cloud_worker_started"')
    expect(errors).toContain('"event":"cloud_worker_request_completed"')
    expect(errors).toContain('"errorType":"CommandFailedError"')
    expect(errors).not.toContain('stderr')
    expect(errors).not.toContain('token')
  })
})
