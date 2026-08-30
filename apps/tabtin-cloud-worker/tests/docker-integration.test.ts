import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { DockerCommandRunner } from '../src/command-runner.js'
import { DockerWorkspaceManager } from '../src/docker-workspace-manager.js'

const IMAGE = process.env.TABTIN_CLOUD_WORKER_DOCKER_TEST_IMAGE

describe.skipIf(!IMAGE)('DockerWorkspaceManager integration', () => {
  it('provisions, stops, restarts, and permanently removes one labelled allocation', async () => {
    const allocationId = randomUUID()
    const manager = new DockerWorkspaceManager(new DockerCommandRunner(), 'bridge')
    const identity = { allocationId, generation: 1 }

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
      expect((await manager.disable(identity)).state).toBe('stopped')
      expect((await manager.restart(identity)).state).toBe('running')
    } finally {
      await manager.deletePermanently(identity)
    }
    expect((await manager.status(identity)).state).toBe('missing')
  }, 60_000)
})
