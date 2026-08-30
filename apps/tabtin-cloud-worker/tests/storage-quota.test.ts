import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../src/command-runner.js'
import { verifyStorageQuotaSupport } from '../src/storage-quota.js'

class FakeRunner implements CommandRunner {
  calls: string[][] = []
  failCreate = false

  async run(args: readonly string[]) {
    this.calls.push([...args])
    if (this.failCreate && args[0] === 'volume' && args[1] === 'create') {
      throw new Error('quota unsupported')
    }
    return { stdout: '', stderr: '' }
  }
}

describe('storage quota startup probe', () => {
  it('creates, inspects, and removes one bounded Podman XFS volume', async () => {
    const runner = new FakeRunner()
    await verifyStorageQuotaSupport(runner, 'podman-xfs')

    expect(runner.calls[0]).toEqual(expect.arrayContaining([
      'volume', 'create', '--opt', 'o=size=1M',
    ]))
    expect(runner.calls.some(args => args[0] === 'volume' && args[1] === 'inspect'))
      .toBe(true)
    expect(runner.calls.some(args => args[0] === 'volume' && args[1] === 'rm'))
      .toBe(true)
  })

  it('fails startup when the backend cannot enforce the quota', async () => {
    const runner = new FakeRunner()
    runner.failCreate = true

    await expect(verifyStorageQuotaSupport(runner, 'podman-xfs'))
      .rejects.toThrow('XFS prjquota/pquota')
  })
})
