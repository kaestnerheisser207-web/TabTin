import { createConnection } from 'node:net'
import { CommandFailedError } from './command-runner.js'
import type { CommandRunner } from './command-runner.js'

export type StorageQuotaMode = 'none' | 'podman-xfs'

export interface QuotaVolume {
  existed: boolean
  path: string
}

export class UnixSocketQuotaCommandRunner implements CommandRunner {
  constructor(
    private readonly socketPath = '/run/tabtin-cloud-volume-helper.sock',
  ) {}

  run(args: readonly string[]): Promise<{ stdout: string; stderr: string }> {
    if (
      args.length < 2
      || args.some(arg => arg.length === 0 || arg.includes('\n') || arg.includes('\t'))
    ) {
      return Promise.reject(new Error('invalid quota helper arguments'))
    }
    return new Promise((resolve, reject) => {
      const socket = createConnection(this.socketPath)
      let response = ''
      let settled = false
      const fail = (error: Error) => {
        if (settled) return
        settled = true
        socket.destroy()
        reject(error)
      }
      socket.setEncoding('utf8')
      socket.setTimeout(10_000, () => fail(new Error('quota helper timed out')))
      socket.once('error', fail)
      socket.once('close', () => {
        if (!settled) fail(new Error('quota helper closed before responding'))
      })
      socket.on('data', chunk => {
        response += chunk
        if (response.length > 4096) {
          fail(new Error('quota helper response is too large'))
          return
        }
        const newline = response.indexOf('\n')
        if (newline === -1 || settled) return
        settled = true
        socket.destroy()
        const line = response.slice(0, newline)
        const separator = line.indexOf('\t')
        const status = separator === -1 ? line : line.slice(0, separator)
        const payload = separator === -1 ? '' : line.slice(separator + 1).trim()
        if (status === 'OK') resolve({ stdout: payload, stderr: '' })
        else reject(new CommandFailedError(1, payload, 'quota helper'))
      })
      socket.once('connect', () => socket.end(`${args.join('\t')}\n`))
    })
  }
}

export class XfsProjectQuotaManager {
  constructor(private readonly runner: CommandRunner) {}

  async ensure(volume: string, sizeGb: number): Promise<QuotaVolume> {
    const existing = await this.inspect(volume)
    const result = await this.runner.run(['create', volume, String(sizeGb)])
    const path = result.stdout.trim()
    const expectedPath = `/Project/infra/tabtin-cloud-runtime/volumes/${volume}`
    if (path !== expectedPath) {
      throw new Error('quota helper returned an invalid volume path')
    }
    return { existed: existing !== null, path }
  }

  async inspect(volume: string): Promise<string | null> {
    try {
      const result = await this.runner.run(['inspect', volume])
      return result.stdout.trim() || null
    } catch (error) {
      if (
        error instanceof CommandFailedError
        && error.stderr.includes('volume not found')
      ) return null
      throw error
    }
  }

  async delete(volume: string): Promise<void> {
    await this.runner.run(['delete', volume])
  }
}

/** Prove the privileged XFS helper and rootless Podman bind-volume chain. */
export async function verifyStorageQuotaSupport(
  dockerRunner: CommandRunner,
  quotaManager: XfsProjectQuotaManager | null,
  mode: StorageQuotaMode,
): Promise<void> {
  if (mode === 'none') return
  if (!quotaManager) throw new Error('podman-xfs requires the quota helper')
  const suffix = `${process.pid.toString(16)}${Date.now().toString(16)}`.slice(-12).padStart(12, '0')
  const volume = `cloud-workspace-00000000-0000-4000-8000-${suffix}`
  let podmanVolumeCreated = false
  let quotaVolumeCreated = false
  try {
    const quotaVolume = await quotaManager.ensure(volume, 1)
    quotaVolumeCreated = true
    await dockerRunner.run([
      'volume', 'create',
      '--label', 'com.tabtin.cloud.quota-probe=true',
      '--opt', 'type=none',
      '--opt', `device=${quotaVolume.path}`,
      '--opt', 'o=bind',
      volume,
    ])
    podmanVolumeCreated = true
    await dockerRunner.run(['volume', 'inspect', volume])
  } catch (error) {
    throw new Error(
      'podman-xfs storage quota probe failed; require the root-owned XFS quota helper and rootless bind volumes',
      { cause: error },
    )
  } finally {
    if (podmanVolumeCreated) {
      await dockerRunner.run(['volume', 'rm', volume]).catch(() => undefined)
    }
    if (quotaVolumeCreated) await quotaManager.delete(volume).catch(() => undefined)
  }
}
