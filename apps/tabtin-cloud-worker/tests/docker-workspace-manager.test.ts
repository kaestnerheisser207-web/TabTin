import { describe, expect, it } from 'vitest'
import { CommandFailedError, type CommandRunner } from '../src/command-runner.js'
import {
  DockerWorkspaceManager,
  StaleGenerationError,
} from '../src/docker-workspace-manager.js'
import type { ProvisionWorkspaceInput } from '../src/contracts.js'

const ALLOCATION_ID = '11111111-1111-4111-8111-111111111111'
const IMAGE = `ghcr.io/tabtin/cloud-runtime@sha256:${'a'.repeat(64)}`

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = []
  readonly stdins: Array<string | undefined> = []
  inspectResult: object[] | null = null
  volumes: string[] = []

  async run(args: readonly string[], stdin?: string) {
    this.calls.push([...args])
    this.stdins.push(stdin)
    if (args[0] === 'inspect') {
      if (!this.inspectResult) throw new CommandFailedError(1, 'No such object')
      return { stdout: JSON.stringify(this.inspectResult), stderr: '' }
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      throw new CommandFailedError(1, 'No such volume')
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      return { stdout: this.volumes.join('\n'), stderr: '' }
    }
    if (args[0] === 'start') {
      this.inspectResult = [{
        Id: 'container-id',
        Config: { Labels: { 'com.tabtin.cloud.generation': '1' } },
        State: { Running: true },
      }]
      return { stdout: 'container-id\n', stderr: '' }
    }
    return { stdout: '', stderr: '' }
  }
}

function provisionInput(overrides: Partial<ProvisionWorkspaceInput> = {}): ProvisionWorkspaceInput {
  return {
    allocationId: ALLOCATION_ID,
    generation: 1,
    image: IMAGE,
    volumeRef: 'cloud-workspace-test',
    cpuMillicores: 2000,
    memoryMb: 4096,
    storageGb: 20,
    source: { type: 'empty' },
    bootstrapToken: 'short-lived-install-token',
    ...overrides,
  }
}

describe('DockerWorkspaceManager', () => {
  it('creates an isolated runtime with persistent workspace and DSH_HOME volumes', async () => {
    const runner = new FakeRunner()
    const manager = new DockerWorkspaceManager(
      runner,
      'tabtin-cloud-runtime',
      'podman-xfs',
    )

    const status = await manager.provision(provisionInput())

    expect(status.state).toBe('running')
    const create = runner.calls.find(args => args[0] === 'create')
    expect(create).toContain('--cap-drop')
    expect(create).toContain('no-new-privileges')
    expect(create).toContain('type=volume,src=cloud-workspace-test,dst=/workspace')
    expect(create).toContain('type=volume,src=cloud-workspace-test-runtime,dst=/var/lib/tabtin')
    expect(create).toContain('DSH_HOME=/var/lib/tabtin/dsh')
    expect(create).not.toContain('short-lived-install-token')
    expect(runner.stdins).toContain('short-lived-install-token')
    expect(runner.calls).toContainEqual([
      'volume', 'create',
      '--label', `com.tabtin.cloud.allocation=${ALLOCATION_ID}`,
      '--opt', 'o=size=20G',
      'cloud-workspace-test',
    ])
    expect(runner.calls).toContainEqual([
      'volume', 'create',
      '--label', `com.tabtin.cloud.allocation=${ALLOCATION_ID}`,
      '--opt', 'o=size=2G',
      'cloud-workspace-test-runtime',
    ])
  })

  it('rejects a stale generation without touching the container', async () => {
    const runner = new FakeRunner()
    runner.inspectResult = [{
      Id: 'existing',
      Config: { Labels: { 'com.tabtin.cloud.generation': '3' } },
      State: { Running: true },
    }]
    const manager = new DockerWorkspaceManager(runner)

    await expect(manager.provision(provisionInput({ generation: 2 })))
      .rejects.toBeInstanceOf(StaleGenerationError)
    expect(runner.calls.some(args => args[0] === 'rm')).toBe(false)
  })

  it('permanent delete removes only volumes carrying the allocation label', async () => {
    const runner = new FakeRunner()
    runner.volumes = ['volume-a', 'volume-b']
    const manager = new DockerWorkspaceManager(runner)

    await manager.deletePermanently({ allocationId: ALLOCATION_ID, generation: 1 })

    expect(runner.calls).toContainEqual(['volume', 'rm', 'volume-a'])
    expect(runner.calls).toContainEqual(['volume', 'rm', 'volume-b'])
  })
})
