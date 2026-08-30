import type { CommandRunner } from './command-runner.js'

export type StorageQuotaMode = 'none' | 'podman-xfs'

/** Prove the configured backend accepts an enforced project quota before health starts. */
export async function verifyStorageQuotaSupport(
  runner: CommandRunner,
  mode: StorageQuotaMode,
): Promise<void> {
  if (mode === 'none') return
  const volume = `tabtin-quota-probe-${process.pid}-${Date.now()}`
  let created = false
  try {
    await runner.run([
      'volume', 'create',
      '--label', 'com.tabtin.cloud.quota-probe=true',
      '--opt', 'o=size=1M',
      volume,
    ])
    created = true
    await runner.run(['volume', 'inspect', volume])
  } catch (error) {
    throw new Error(
      'podman-xfs storage quota probe failed; require XFS prjquota/pquota',
      { cause: error },
    )
  } finally {
    if (created) await runner.run(['volume', 'rm', volume]).catch(() => undefined)
  }
}
