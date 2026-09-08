import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
vi.mock('electron', () => ({ app: { getPath: () => '/unused-user-data' } }))
import { createLocalDshInstallation, LOCAL_DSH_VERSION } from './local-dsh-installation'

describe('local DSH installation', () => {
  let root: string
  let bin: string
  let userData: string
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'muse-dsh-test-'))
    bin = path.join(root, 'bin')
    userData = path.join(root, 'user-data')
    await mkdir(bin)
  })
  afterEach(async () => { await rm(root, { recursive: true, force: true }) })
  const executable = async (file: string, text = '#!/bin/sh\nexit 0\n') => {
    await mkdir(path.dirname(file), { recursive: true })
    await writeFile(file, text)
    await chmod(file, 0o755)
  }
  async function fakeDsh(prefix: string, version = LOCAL_DSH_VERSION, name = '@deepseek-ai/dsh') {
    const pkg = path.join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh')
    await mkdir(pkg, { recursive: true })
    await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name, version, bin: { dsh: 'bin.js' } }))
    await executable(path.join(pkg, 'bin.js'))
    await mkdir(path.join(prefix, 'bin'), { recursive: true })
    await symlink(path.join(pkg, 'bin.js'), path.join(prefix, 'bin', 'dsh'))
    return path.join(prefix, 'bin', 'dsh')
  }
  async function fakeNpm() {
    await executable(path.join(bin, 'node'))
    const cli = path.join(root, 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js')
    await executable(cli)
    await symlink(cli, path.join(bin, 'npm'))
  }
  function service(run = vi.fn(async (_file: string, _args: string[]) => 'v22.20.0')) {
    return createLocalDshInstallation({ userData: () => userData, platform: 'darwin', env: () => ({ PATH: bin }), run })
  }

  it('reuses the system DeepSeek package before managed DSH, never installing or upgrading it', async () => {
    await fakeNpm()
    const installed = await fakeDsh(root)
    await fakeDsh(path.join(userData, 'runtimes', 'dsh'))
    await writeFile(path.join(userData, 'runtimes', 'dsh', '.muse-installed-version'), LOCAL_DSH_VERSION)
    const run = vi.fn(async (_file: string, _args: string[]) => 'v22.20.0')
    const manager = service(run)
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: true, executable: installed, version: LOCAL_DSH_VERSION })
    expect(await manager.requireLocalDshExecutable()).toBe(installed)
    await manager.installLocalDsh()
    expect(run.mock.calls.every(([, args]) => args?.[0] === '--version')).toBe(true)
  })

  it('reports an incompatible global version without running or changing it', async () => {
    await fakeNpm()
    const executable = await fakeDsh(root, '0.1.0')
    const before = await realpath(executable)
    const run = vi.fn(async (_file: string, _args: string[]) => 'v22.20.0')
    const manager = service(run)
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: false, executable: null,
      version: '0.1.0', supportedVersion: LOCAL_DSH_VERSION, canInstall: true, errorCode: 'DSH_VERSION_INCOMPATIBLE', error: expect.stringContaining('0.1.0') })
    await expect(manager.requireLocalDshExecutable()).rejects.toMatchObject({ code: 'DSH_NOT_INSTALLED', message: expect.stringContaining('不兼容') })
    expect(await realpath(executable)).toBe(before)
    expect(run.mock.calls.every(([, args]) => args[0] === '--version')).toBe(true)
  })

  it('clears an old installation error when a recheck finds a compatible global version', async () => {
    await fakeNpm()
    const executable = await fakeDsh(root, '0.1.0')
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === '--version') return 'v22.20.0'
      throw new Error('network unavailable')
    })
    const manager = service(run)
    expect(await manager.installLocalDsh()).toMatchObject({ installed: false, error: 'network unavailable' })
    // Simulate an external user-managed update; the application only rechecks it.
    const manifestPath = path.join(path.dirname(await realpath(executable)), 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    await writeFile(manifestPath, JSON.stringify({ ...manifest, version: LOCAL_DSH_VERSION }))
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: true, executable, error: null })
  })

  it('selects a compatible managed version when global DSH is incompatible', async () => {
    await fakeNpm()
    await fakeDsh(root, '0.1.0')
    const managedPrefix = path.join(userData, 'runtimes', 'dsh')
    const managed = await fakeDsh(managedPrefix)
    await writeFile(path.join(managedPrefix, '.muse-installed-version'), LOCAL_DSH_VERSION)
    const run = vi.fn(async (_file: string, _args: string[]) => 'v22.20.0')
    const manager = service(run)
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: true, executable: managed, version: LOCAL_DSH_VERSION, error: null })
    expect(await manager.requireLocalDshExecutable()).toBe(managed)
    await manager.installLocalDsh()
    expect(run.mock.calls.every(([, args]) => args[0] === '--version')).toBe(true)
  })

  it('installs the compatible managed version without upgrading an incompatible global package', async () => {
    await fakeNpm()
    const global = await fakeDsh(root, '0.1.0')
    const globalTarget = await realpath(global)
    const globalManifest = path.join(path.dirname(globalTarget), 'package.json')
    const original = await readFile(globalManifest, 'utf8')
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === '--version') return 'v22.20.0'
      expect(args).toEqual(expect.arrayContaining(['--prefix', path.join(userData, 'runtimes', 'dsh'), '@deepseek-ai/dsh@0.1.1-rc.2']))
      await fakeDsh(path.join(userData, 'runtimes', 'dsh'))
      return ''
    })
    const manager = service(run)
    const status = await manager.installLocalDsh()
    expect(status).toMatchObject({ installed: true, version: LOCAL_DSH_VERSION, error: null })
    expect(status.executable).not.toBe(global)
    expect(await realpath(global)).toBe(globalTarget)
    expect(await readFile(globalManifest, 'utf8')).toBe(original)
  })

  it('rejects the same-name Dancer shell and reports missing without installing', async () => {
    await fakeNpm()
    await fakeDsh(root, '1.0.0', 'dancer-shell')
    const run = vi.fn(async (_file: string, _args: string[]) => 'v22.20.0')
    const manager = service(run)
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: false, executable: null, canInstall: true })
    await expect(manager.requireLocalDshExecutable()).rejects.toMatchObject({ code: 'DSH_NOT_INSTALLED' })
    expect(run.mock.calls.every(([, args]) => args?.[0] === '--version')).toBe(true)
  })

  it('does not accept an unrelated executable merely placed inside the DeepSeek package', async () => {
    await fakeNpm()
    const dsh = await fakeDsh(root)
    await rm(dsh)
    const other = path.join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'other.js')
    await executable(other)
    await symlink(other, dsh)
    expect(await service().getLocalDshStatus()).toMatchObject({ installed: false })
  })

  it('installs only on request, deduplicates concurrent clicks, pins version and registry in managed prefix', async () => {
    await fakeNpm()
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: Array<{ file: string; args: string[]; options: any }> = []
    const run = vi.fn(async (file: string, args: string[], options: any) => {
      if (args[0] === '--version') return 'v22.20.0'
      calls.push({ file, args, options })
      await gate
      await fakeDsh(path.join(userData, 'runtimes', 'dsh'))
      return ''
    })
    const manager = createLocalDshInstallation({ userData: () => userData, platform: 'darwin', env: () => ({ PATH: bin, npm_config_registry: 'https://invalid.example', NPM_CONFIG_TOKEN: 'private-token' }), run })
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: false, installing: false })
    const first = manager.installLocalDsh()
    expect(manager.installLocalDsh()).toBe(first)
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: false, installing: true })
    expect(calls[0].args).toEqual(expect.arrayContaining(['--prefix', path.join(userData, 'runtimes', 'dsh'), '--registry', 'https://registry.npmjs.org/', '@deepseek-ai/dsh@0.1.1-rc.2']))
    expect(calls[0].options.env).not.toHaveProperty('NPM_CONFIG_TOKEN')
    expect(calls[0].options.env).not.toHaveProperty('npm_config_registry')
    release()
    expect(await first).toMatchObject({ installed: true, installing: false, error: null })
  })

  it('does not report an incomplete managed installation as ready and repairs it on retry', async () => {
    await fakeNpm()
    let attempt = 0
    const run = vi.fn(async (_file: string, args: string[]) => {
      if (args[0] === '--version') return 'v22.20.0'
      if (attempt++ === 0) {
        await fakeDsh(path.join(userData, 'runtimes', 'dsh'))
        throw new Error('安装中断')
      }
      return ''
    })
    const manager = service(run)
    expect(await manager.installLocalDsh()).toMatchObject({ installed: false, canInstall: true, error: '安装中断' })
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: false })
    expect(await manager.installLocalDsh()).toMatchObject({ installed: true, error: null })
  })

  it('offers a Node/npm prerequisite when unavailable and makes no installation changes', async () => {
    const run = vi.fn(async (_file: string, _args: string[]) => '')
    const manager = service(run)
    expect(await manager.getLocalDshStatus()).toMatchObject({ installed: false, canInstall: false, detail: expect.stringContaining('Node.js') })
    expect(await manager.installLocalDsh()).toMatchObject({ installed: false, installing: false, error: expect.stringContaining('Node.js') })
    expect(run).not.toHaveBeenCalled()
  })

  it('rejects outdated Node before installing and releases the installation lock after failure', async () => {
    await fakeNpm()
    const run = vi.fn(async (_file: string, _args: string[]) => 'v20.0.0')
    const manager = service(run)
    expect(await manager.installLocalDsh()).toMatchObject({ installed: false, installing: false, error: expect.stringContaining('Node.js 22') })
    expect(run.mock.calls.every(([, args]) => args?.[0] === '--version')).toBe(true)
    run.mockResolvedValue('v22.20.0')
    expect(await manager.installLocalDsh()).toMatchObject({ installing: false, error: expect.stringContaining('未找到可用') })
  })
})
