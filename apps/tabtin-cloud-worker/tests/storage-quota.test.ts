import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CommandFailedError, type CommandRunner } from '../src/command-runner.js'
import {
  UnixSocketQuotaCommandRunner,
  verifyStorageQuotaSupport,
  XfsProjectQuotaManager,
} from '../src/storage-quota.js'

class FakeRunner implements CommandRunner {
  calls: string[][] = []
  failCreate = false

  async run(args: readonly string[]) {
    this.calls.push([...args])
    if (this.failCreate && args[0] === 'create') {
      throw new Error('quota unsupported')
    }
    if (args[0] === 'inspect') throw new CommandFailedError(1, 'volume not found')
    if (args[0] === 'create') {
      return {
        stdout: `/Project/infra/tabtin-cloud-runtime/volumes/${args[1]}\n`,
        stderr: '',
      }
    }
    return { stdout: '', stderr: '' }
  }
}

describe('storage quota startup probe', () => {
  it('uses the bounded line protocol exposed by the root-owned Unix socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tabtin-quota-socket-'))
    const socketPath = join(directory, 'helper.sock')
    let request = ''
    const server = createServer(socket => {
      socket.setEncoding('utf8')
      socket.on('data', chunk => { request += chunk })
      socket.once('end', () => socket.end(
        'OK\t/Project/infra/tabtin-cloud-runtime/volumes/cloud-workspace-test\n',
      ))
    })
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(socketPath, resolve)
      })
      const runner = new UnixSocketQuotaCommandRunner(socketPath)
      const result = await runner.run(['inspect', 'cloud-workspace-test'])
      expect(request).toBe('inspect\tcloud-workspace-test\n')
      expect(result.stdout).toContain('/Project/infra/tabtin-cloud-runtime/volumes/')
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()))
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('creates, inspects, and removes one quota-backed rootless bind volume', async () => {
    const dockerRunner = new FakeRunner()
    const quotaRunner = new FakeRunner()
    await verifyStorageQuotaSupport(
      dockerRunner,
      new XfsProjectQuotaManager(quotaRunner),
      'podman-xfs',
    )

    expect(dockerRunner.calls[0]).toEqual(expect.arrayContaining([
      'volume', 'create', '--opt', 'type=none', '--opt', 'o=bind',
    ]))
    expect(dockerRunner.calls.some(args => args[0] === 'volume' && args[1] === 'inspect'))
      .toBe(true)
    expect(dockerRunner.calls.some(args => args[0] === 'volume' && args[1] === 'rm'))
      .toBe(true)
    expect(quotaRunner.calls.some(args => args[0] === 'create' && args[2] === '1'))
      .toBe(true)
    expect(quotaRunner.calls.some(args => args[0] === 'delete')).toBe(true)
  })

  it('fails startup when the backend cannot enforce the quota', async () => {
    const dockerRunner = new FakeRunner()
    const quotaRunner = new FakeRunner()
    quotaRunner.failCreate = true

    await expect(verifyStorageQuotaSupport(
      dockerRunner,
      new XfsProjectQuotaManager(quotaRunner),
      'podman-xfs',
    )).rejects.toThrow('root-owned XFS quota helper')
  })
})
