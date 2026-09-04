import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { ProcessCommandRunner } from '../src/command-runner.js'
import { DockerWorkspaceManager } from '../src/docker-workspace-manager.js'

const IMAGE = process.env.MUSE_CLOUD_WORKER_DOCKER_TEST_IMAGE

describe.skipIf(!IMAGE)('DockerWorkspaceManager integration', () => {
  it('provisions, stops, restarts, and permanently removes one labelled allocation', async () => {
    const allocationId = randomUUID()
    const runner = new ProcessCommandRunner()
    const manager = new DockerWorkspaceManager(runner, 'bridge')
    let identity = { allocationId, generation: 1 }

    try {
      const created = await manager.provision({
        ...identity,
        image: IMAGE!,
        volumeRef: `tabtin-cloud-test-${allocationId}`,
        cpuMillicores: 250,
        memoryMb: 256,
        storageGb: 1,
        source: { type: 'empty' },
        bootstrapToken: 'short-lived-test-token',
      })
      expect(created.state).toBe('running')
      await runner.run([
        'run', '--rm',
        '--mount', `type=volume,src=tabtin-cloud-test-${allocationId},dst=/workspace`,
        '--entrypoint', 'sh',
        IMAGE!,
        '-c', 'printf cloud-recovery > /workspace/recovery-marker',
      ])

      const restartedManager = new DockerWorkspaceManager(
        new ProcessCommandRunner(),
        'bridge',
      )
      const reattached = await restartedManager.provision({
        ...identity,
        image: IMAGE!,
        volumeRef: `tabtin-cloud-test-${allocationId}`,
        cpuMillicores: 250,
        memoryMb: 256,
        storageGb: 1,
        source: { type: 'empty' },
        bootstrapToken: 'same-generation-token',
      })
      expect(reattached.containerId).toBe(created.containerId)

      identity = { allocationId, generation: 2 }
      const upgraded = await restartedManager.provision({
        ...identity,
        image: IMAGE!,
        volumeRef: `tabtin-cloud-test-${allocationId}`,
        cpuMillicores: 250,
        memoryMb: 256,
        storageGb: 1,
        source: { type: 'empty' },
        bootstrapToken: 'generation-2-token',
      })
      expect(upgraded.containerId).not.toBe(created.containerId)
      const marker = await runner.run([
        'run', '--rm',
        '--mount', `type=volume,src=tabtin-cloud-test-${allocationId},dst=/workspace`,
        '--entrypoint', 'cat',
        IMAGE!,
        '/workspace/recovery-marker',
      ])
      expect(marker.stdout).toBe('cloud-recovery')
      expect((await restartedManager.disable(identity)).state).toBe('stopped')
      expect((await restartedManager.restart(identity)).state).toBe('running')
    } finally {
      await manager.deletePermanently(identity)
    }
    expect((await manager.status(identity)).state).toBe('missing')
  }, 60_000)
})
