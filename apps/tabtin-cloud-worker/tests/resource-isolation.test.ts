import { describe, expect, it } from 'vitest'
import type { CommandRunner } from '../src/command-runner.js'
import { verifyResourceIsolationSupport } from '../src/resource-isolation.js'

class FakeRunner implements CommandRunner {
  constructor(private readonly info: unknown) {}

  async run() {
    return { stdout: JSON.stringify(this.info), stderr: '' }
  }
}

describe('resource isolation startup gate', () => {
  it('accepts Podman cgroup v2 with systemd management', async () => {
    await expect(verifyResourceIsolationSupport(
      new FakeRunner({ host: { cgroupVersion: 'v2', cgroupManager: 'systemd' } }),
      'cgroup-v2',
    )).resolves.toBeUndefined()
  })

  it('accepts Docker cgroup v2 with systemd driver', async () => {
    await expect(verifyResourceIsolationSupport(
      new FakeRunner({ CgroupVersion: '2', CgroupDriver: 'systemd' }),
      'cgroup-v2',
    )).resolves.toBeUndefined()
  })

  it('rejects a runtime that would ignore hard limits', async () => {
    await expect(verifyResourceIsolationSupport(
      new FakeRunner({ host: { cgroupVersion: 'v1', cgroupManager: 'cgroupfs' } }),
      'cgroup-v2',
    )).rejects.toThrow('cgroup v2')
  })
})
