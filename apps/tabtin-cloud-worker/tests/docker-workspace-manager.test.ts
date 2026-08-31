import { describe, expect, it } from 'vitest'
import { CommandFailedError, type CommandRunner } from '../src/command-runner.js'
import {
  DockerWorkspaceManager,
  GitWorkspaceInitializationError,
  StaleGenerationError,
} from '../src/docker-workspace-manager.js'
import { XfsProjectQuotaManager } from '../src/storage-quota.js'
import type { ProvisionWorkspaceInput } from '../src/contracts.js'

const ALLOCATION_ID = '11111111-1111-4111-8111-111111111111'
const IMAGE = `ghcr.io/tabtin/cloud-runtime@sha256:${'a'.repeat(64)}`

class FakeRunner implements CommandRunner {
  readonly calls: string[][] = []
  readonly stdins: Array<string | undefined> = []
  inspectResult: object[] | null = null
  volumes: string[] = []
  createdGeneration: number | null = null
  daemonInitialized = true
  gitInitialized = false
  failGitClone = false

  async run(args: readonly string[], stdin?: string) {
    this.calls.push([...args])
    this.stdins.push(stdin)
    if (args[0] === 'inspect') {
      if (!this.inspectResult) throw new CommandFailedError(1, 'No such object')
      return { stdout: JSON.stringify(this.inspectResult), stderr: '' }
    }
    if (args[0] === 'volume' && args[1] === 'inspect') {
      if (args[2] && this.volumes.includes(args[2])) {
        return { stdout: JSON.stringify([{ Name: args[2] }]), stderr: '' }
      }
      throw new CommandFailedError(1, 'No such volume')
    }
    if (args[0] === 'volume' && args[1] === 'ls') {
      return { stdout: this.volumes.join('\n'), stderr: '' }
    }
    if (
      args[0] === 'run'
      && args.some(value => value.includes('printf initialized; else printf uninitialized'))
    ) {
      return {
        stdout: this.daemonInitialized ? 'initialized' : 'uninitialized',
        stderr: '',
      }
    }
    if (args[0] === 'run' && args.includes('test -e /workspace/.tabtin-git-initialized')) {
      if (!this.gitInitialized) throw new CommandFailedError(1, '')
      return { stdout: '', stderr: '' }
    }
    if (args[0] === 'run' && args.includes('clone')) {
      if (this.failGitClone) throw new CommandFailedError(128, 'clone failed')
      this.gitInitialized = true
      return { stdout: '', stderr: '' }
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

class FakeQuotaRunner implements CommandRunner {
  readonly calls: string[][] = []
  readonly volumes = new Set<string>()

  async run(args: readonly string[]) {
    this.calls.push([...args])
    const [action, volume] = args
    if (!volume) throw new Error('missing volume')
    const path = `/Project/infrastructure/tabtin-cloud-runtime/volumes/${volume}`
    if (action === 'create') {
      this.volumes.add(volume)
      return { stdout: `${path}\n`, stderr: '' }
    }
    if (action === 'inspect') {
      if (!this.volumes.has(volume)) throw new CommandFailedError(1, 'volume not found')
      return { stdout: `${path}\n`, stderr: '' }
    }
    if (action === 'delete') {
      this.volumes.delete(volume)
      return { stdout: '', stderr: '' }
    }
    throw new Error('unsupported quota action')
  }
}

function provisionInput(overrides: Partial<ProvisionWorkspaceInput> = {}): ProvisionWorkspaceInput {
  return {
    allocationId: ALLOCATION_ID,
    generation: 1,
    image: IMAGE,
    volumeRef: `cloud-workspace-${ALLOCATION_ID}`,
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
    const quotaRunner = new FakeQuotaRunner()
    const manager = new DockerWorkspaceManager(
      runner,
      'tabtin-cloud-runtime',
      'podman-xfs',
      2,
      new XfsProjectQuotaManager(quotaRunner),
    )

    const status = await manager.provision(provisionInput())

    expect(status).toEqual({
      allocationId: ALLOCATION_ID,
      generation: 1,
      state: 'running',
      containerId: 'container-id',
    })
    expect(status).not.toHaveProperty('bootstrapToken')
    expect(status).not.toHaveProperty('image')
    const create = runner.calls.find(args => args[0] === 'create')
    expect(create).toContain('--cap-drop')
    expect(create).toContain('no-new-privileges')
    expect(create).toContain(`type=volume,src=cloud-workspace-${ALLOCATION_ID},dst=/workspace`)
    expect(create).toContain(`type=volume,src=cloud-workspace-${ALLOCATION_ID}-runtime,dst=/var/lib/tabtin`)
    expect(create).toContain('DSH_HOME=/var/lib/tabtin/dsh')
    expect(create).not.toContain('short-lived-install-token')
    expect(runner.stdins).toContain('short-lived-install-token')
    const bootstrap = runner.calls.find(
      args => args[0] === 'run' && args.includes('--interactive'),
    )
    expect(bootstrap).toEqual(expect.arrayContaining(['--pids-limit', '256']))
    expect(runner.calls).toContainEqual([
      'volume', 'create',
      '--label', `com.tabtin.cloud.allocation=${ALLOCATION_ID}`,
      '--opt', 'type=none',
      '--opt', `device=/Project/infrastructure/tabtin-cloud-runtime/volumes/cloud-workspace-${ALLOCATION_ID}`,
      '--opt', 'o=bind',
      `cloud-workspace-${ALLOCATION_ID}`,
    ])
    expect(runner.calls).toContainEqual([
      'volume', 'create',
      '--label', `com.tabtin.cloud.allocation=${ALLOCATION_ID}`,
      '--opt', 'type=none',
      '--opt', `device=/Project/infrastructure/tabtin-cloud-runtime/volumes/cloud-workspace-${ALLOCATION_ID}-runtime`,
      '--opt', 'o=bind',
      `cloud-workspace-${ALLOCATION_ID}-runtime`,
    ])
    expect(quotaRunner.calls).toContainEqual([
      'create', `cloud-workspace-${ALLOCATION_ID}`, '20',
    ])
    expect(quotaRunner.calls).toContainEqual([
      'create', `cloud-workspace-${ALLOCATION_ID}-runtime`, '2',
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

  it('bounds transient bootstrap and Git clone helper processes', async () => {
    const runner = new FakeRunner()
    const manager = new DockerWorkspaceManager(runner, 'tabtin-cloud-runtime')

    await manager.provision(provisionInput({
      source: {
        type: 'git',
        gitUrl: 'https://example.com/repository.git',
        gitRef: 'main',
      },
    }))

    const transientRuns = runner.calls.filter(args => args[0] === 'run')
    expect(transientRuns).toHaveLength(3)
    for (const args of transientRuns) {
      expect(args).toEqual(expect.arrayContaining(['--pids-limit', '256']))
    }
    expect(runner.calls.find(args => args.includes('clone'))).toContain(
      'git "$@" && touch /workspace/.tabtin-git-initialized',
    )
  })

  it('retries Git initialization instead of treating an existing quota volume as initialized', async () => {
    const runner = new FakeRunner()
    runner.failGitClone = true
    const manager = new DockerWorkspaceManager(runner, 'tabtin-cloud-runtime')
    const input = provisionInput({
      source: {
        type: 'git',
        gitUrl: 'https://example.com/private/repository.git',
      },
    })

    await expect(manager.provision(input)).rejects.toBeInstanceOf(GitWorkspaceInitializationError)
    await expect(manager.provision(input)).rejects.toBeInstanceOf(GitWorkspaceInitializationError)

    expect(runner.calls.filter(args => args[0] === 'run' && args.includes('clone'))).toHaveLength(2)
    expect(runner.calls.some(args => args[0] === 'create')).toBe(false)
  })

  it('does not report an existing running container ready when its Git workspace never initialized', async () => {
    const runner = new FakeRunner()
    runner.failGitClone = true
    runner.inspectResult = [{
      Id: 'existing',
      Config: { Labels: { 'com.tabtin.cloud.generation': '1' } },
      State: { Running: true },
    }]
    const manager = new DockerWorkspaceManager(runner, 'tabtin-cloud-runtime')

    await expect(manager.provision(provisionInput({
      source: {
        type: 'git',
        gitUrl: 'https://example.com/private/repository.git',
      },
    }))).rejects.toBeInstanceOf(GitWorkspaceInitializationError)

    expect(runner.calls).toContainEqual([
      'stop', '--time', '30', `tabtin-cloud-${ALLOCATION_ID}`,
    ])
    expect(runner.calls.filter(args => args[0] === 'run' && args.includes('clone'))).toHaveLength(1)
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
    expect(runner.calls).toEqual([
      ['inspect', `tabtin-cloud-${ALLOCATION_ID}`],
      expect.arrayContaining([
        'run', '--rm',
        '--pids-limit', '256',
        '--network', 'none',
        `type=volume,src=cloud-workspace-${ALLOCATION_ID}-runtime,dst=/var/lib/tabtin,readonly`,
      ]),
    ])
  })

  it('refreshes an expired bootstrap token for a running uninitialized generation', async () => {
    const runner = new FakeRunner()
    runner.daemonInitialized = false
    runner.inspectResult = [{
      Id: 'existing',
      Config: { Labels: { 'com.tabtin.cloud.generation': '1' } },
      State: { Running: true },
    }]

    const manager = new DockerWorkspaceManager(runner)
    const status = await manager.provision(provisionInput({
      bootstrapToken: 'replacement-install-token',
    }))

    expect(status).toMatchObject({ state: 'running', generation: 1 })
    expect(runner.calls).toContainEqual([
      'stop', '--time', '30', `tabtin-cloud-${ALLOCATION_ID}`,
    ])
    expect(runner.stdins).toContain('replacement-install-token')
    expect(runner.calls).toContainEqual(['start', `tabtin-cloud-${ALLOCATION_ID}`])
  })

  it('replaces an older generation while preserving the named workspace volumes', async () => {
    const runner = new FakeRunner()
    const quotaRunner = new FakeQuotaRunner()
    runner.inspectResult = [{
      Id: 'generation-1',
      Config: { Labels: { 'com.tabtin.cloud.generation': '1' } },
      State: { Running: true },
    }]
    const manager = new DockerWorkspaceManager(
      runner,
      'tabtin-cloud-runtime',
      'podman-xfs',
      2,
      new XfsProjectQuotaManager(quotaRunner),
    )

    const status = await manager.provision(provisionInput({
      generation: 2,
      bootstrapToken: 'generation-2-token',
    }))

    expect(status.generation).toBe(2)
    expect(runner.calls).toContainEqual(['rm', '--force', `tabtin-cloud-${ALLOCATION_ID}`])
    expect(runner.calls).toContainEqual([
      'volume', 'create',
      '--label', `com.tabtin.cloud.allocation=${ALLOCATION_ID}`,
      '--opt', 'type=none',
      '--opt', `device=/Project/infrastructure/tabtin-cloud-runtime/volumes/cloud-workspace-${ALLOCATION_ID}`,
      '--opt', 'o=bind',
      `cloud-workspace-${ALLOCATION_ID}`,
    ])
    expect(runner.calls.some(args => args[0] === 'volume' && args[1] === 'rm')).toBe(false)
    const create = runner.calls.find(args => args[0] === 'create')
    expect(create).toContain('com.tabtin.cloud.generation=2')
    expect(create).toContain(`type=volume,src=cloud-workspace-${ALLOCATION_ID},dst=/workspace`)
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

  it('permanent delete removes both rootless bindings before quota directories', async () => {
    const runner = new FakeRunner()
    const quotaRunner = new FakeQuotaRunner()
    const workspace = `cloud-workspace-${ALLOCATION_ID}`
    runner.volumes = [workspace, `${workspace}-runtime`]
    quotaRunner.volumes.add(workspace)
    quotaRunner.volumes.add(`${workspace}-runtime`)
    const manager = new DockerWorkspaceManager(
      runner,
      'tabtin-cloud-runtime',
      'podman-xfs',
      2,
      new XfsProjectQuotaManager(quotaRunner),
    )

    await manager.deletePermanently({ allocationId: ALLOCATION_ID, generation: 1 })

    expect(quotaRunner.calls).toContainEqual(['delete', workspace])
    expect(quotaRunner.calls).toContainEqual(['delete', `${workspace}-runtime`])
  })
})
