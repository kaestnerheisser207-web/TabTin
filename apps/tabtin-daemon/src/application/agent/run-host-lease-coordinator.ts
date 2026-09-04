import { joinApiPath } from '@muse/config'
import {
  RUN_HOST_LEASE_SECONDS,
  type RunHostLeaseApi,
} from '@muse/agent-host/state'

export { RunHostLeaseCoordinator } from '@muse/agent-host/state'

export function createRunHostLeaseHttpApi(input: {
  apiBaseUrl: string
  getAccessToken: () => string | null
}): RunHostLeaseApi {
  const post = async <T>(path: string, body: Record<string, unknown>): Promise<T> => {
    const token = input.getAccessToken()
    if (!token) throw new Error('run host lease: not authenticated')
    const response = await fetch(joinApiPath(input.apiBaseUrl, path), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!response.ok) throw new Error(`run host lease: HTTP ${response.status}`)
    return await response.json() as T
  }
  return {
    claim: (runId, hostId) => post(
      '/services/agent-engine/run-host-leases/claim/',
      { run_id: runId, host_id: hostId, lease_seconds: RUN_HOST_LEASE_SECONDS },
    ),
    heartbeat: (runId, hostId, leaseToken) => post(
      '/services/agent-engine/run-host-leases/heartbeat/',
      {
        run_id: runId,
        host_id: hostId,
        lease_token: leaseToken,
        lease_seconds: RUN_HOST_LEASE_SECONDS,
      },
    ),
    reconcile: (hostId, activeRuns) => post(
      '/services/agent-engine/run-host-leases/reconcile/',
      { host_id: hostId, active_runs: activeRuns, lease_seconds: RUN_HOST_LEASE_SECONDS },
    ),
  }
}
