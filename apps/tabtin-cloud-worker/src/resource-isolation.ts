import type { CommandRunner } from './command-runner.js'

export type ResourceIsolationMode = 'unverified' | 'cgroup-v2'

/** Require cgroup v2 + systemd delegation before advertising hard CPU/memory limits. */
export async function verifyResourceIsolationSupport(
  runner: CommandRunner,
  mode: ResourceIsolationMode,
): Promise<void> {
  if (mode === 'unverified') return
  const result = await runner.run(['info', '--format', '{{json .}}'])
  let info: Record<string, any>
  try {
    info = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error('container runtime info is not valid JSON', { cause: error })
  }
  const host = info.Host ?? info.host ?? {}
  const version = String(
    info.CgroupVersion
    ?? host.CgroupVersion
    ?? host.CgroupsVersion
    ?? host.cgroupVersion
    ?? '',
  ).replace(/^v/i, '')
  const manager = String(
    info.CgroupDriver
    ?? host.CgroupManager
    ?? host.cgroupManager
    ?? '',
  ).toLowerCase()
  if (version !== '2' || manager !== 'systemd') {
    throw new Error('hard resource limits require cgroup v2 with systemd delegation')
  }
}
