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
  createdGeneration: number | null = null

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
    if (args[0] === 'create') {
      const generationLabel = args.find(value => value.startsWith('com.tabtin.cloud.generation='))
      this.createdGeneration = Number(generationLabel?.split('=')[1])
      return { stdout: 'container-id\n', stderr: '' }
    }
    if (args[0] === 'start') {
      const current = this.inspectResult?.[0] as {
        Config?: { Labels?: Record<string, string> }
      } | undefined
      const generation = this.createdGeneration
        ?? Number(current?.Config?.Labels?.['com.tabtin.cloud.generation'])
      this.inspectResult = [{
        Id: 'container-id',
        Config: { Labels: { 'com.tabtin.cloud.generation': String(generation) } },
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

  it('reattaches after a Worker process restart without recreating the same generation', async () => {
    const runner = new FakeRunner()
    runner.inspectResult = [{
      Id: 'existing',
      Config: { Labels: { 'com.tabtin.cloud.generation': '1' } },
      State: { Running: true },
    }]

    const restartedManager = new DockerWorkspaceManager(runner)
    const status = await restartedManager.provision(provisionInput())

    expect(status).toMatchObject({
      state: 'running',
      containerId: 'existing',
      generation: 1,
    })
    expect(runner.calls).toEqual([['inspect', `tabtin-cloud-${ALLOCATION_ID}`]])
  })

  it('replaces an older generation while preserving the named workspace volumes', async () => {
    const runner = new FakeRunner()
    runner.inspectResult = [{
      Id: 'generation-1',
      Config: { Labels: { 'com.tabtin.cloud.generation': '1' } },
      State: { Running: true },
    }]
    const manager = new DockerWorkspaceManager(runner, 'tabtin-cloud-runtime', 'podman-xfs')

    const status = await manager.provision(provisionInput({
      generation: 2,
      bootstrapToken: 'generation-2-token',
    }))

    expect(status.generation).toBe(2)
    expect(runner.calls).toContainEqual(['rm', '--force', `tabtin-cloud-${ALLOCATION_ID}`])
    expect(runner.calls).toContainEqual([
      'volume', 'create',
      '--label', `com.tabtin.cloud.allocation=${ALLOCATION_ID}`,
      '--opt', 'o=size=20G',
      'cloud-workspace-test',
    ])
    expect(runner.calls.some(args => args[0] === 'volume' && args[1] === 'rm')).toBe(false)
    const create = runner.calls.find(args => args[0] === 'create')
    expect(create).toContain('com.tabtin.cloud.generation=2')
    expect(create).toContain('type=volume,src=cloud-workspace-test,dst=/workspace')
    expect(runner.stdins).toContain('generation-2-token')
  })

  it('refuses lifecycle operations when the backend still exposes an older generation', async () => {
    const runner = new FakeRunner()
    runner.inspectResult = [{
      Id: 'generation-1',
      Config: { Labels: { 'com.tabtin.cloud.generation': '1' } },
      State: { Running: false },
    }]
    const manager = new DockerWorkspaceManager(runner)

    await expect(manager.restart({ allocationId: ALLOCATION_ID, generation: 2 }))
      .rejects.toThrow('generation mismatch')
    expect(runner.calls.some(args => args[0] === 'restart')).toBe(false)
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
