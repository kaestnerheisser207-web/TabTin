import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import type { LocalDshStatus } from '../../shared/types/local-dsh'

export const LOCAL_DSH_VERSION = '0.1.1-rc.2'
const PACKAGE_NAME = '@deepseek-ai/dsh'
const REGISTRY = 'https://registry.npmjs.org/'

type Run = (file: string, args: string[], options: {
  cwd?: string; env: NodeJS.ProcessEnv; timeout: number
}) => Promise<string>

const run: Run = (file, args, options) => new Promise((resolve, reject) => {
  execFile(file, args, { ...options, shell: false, windowsHide: true, maxBuffer: 512 * 1024 }, (error, stdout) => {
    // Do not expose npm output: it can contain proxy credentials or registry tokens.
    if (error) reject(new Error(error.killed ? '命令执行超时，请检查网络后重试。' : '命令执行失败，请检查 Node.js、npm 和网络连接后重试。'))
    else resolve(stdout.trim())
  })
})

export function createLocalDshInstallation(options: {
  userData: () => string
  env?: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  run?: Run
}) {
  const platform = options.platform ?? process.platform
  const getEnv = options.env ?? (() => process.env)
  const execute = options.run ?? run
  let pending: Promise<LocalDshStatus> | null = null
  let lastError: string | null = null
  const prefix = () => path.join(options.userData(), 'runtimes', 'dsh')
  const managedExecutable = () => platform === 'win32' ? path.join(prefix(), 'dsh.cmd') : path.join(prefix(), 'bin', 'dsh')
  const completionMarker = () => path.join(prefix(), '.muse-installed-version')
  const pathDirs = () => [...new Set((getEnv().PATH ?? getEnv().Path ?? '').split(path.delimiter).filter(dir => path.isAbsolute(dir)))]
  const accessible = async (file: string, executable = false) => {
    try { await access(file, executable && platform !== 'win32' ? constants.X_OK : constants.R_OK); return true } catch { return false }
  }

  async function inspect(candidate: string): Promise<{ executable: string; version: string } | null> {
    try {
      if (!await accessible(candidate, true)) return null
      const target = await realpath(candidate)
      // npm on Windows creates a .cmd shim beside node_modules; Unix uses a symlink.
      const starts = [path.dirname(target)]
      if (platform === 'win32') starts.push(path.join(path.dirname(candidate), 'node_modules', PACKAGE_NAME))
      for (const start of starts) {
        let directory = start
        for (let depth = 0; depth < 6; depth++) {
          try {
            const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'))
            if (manifest.name === PACKAGE_NAME && typeof manifest.version === 'string') {
              const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.dsh
              if (typeof bin !== 'string') return null
              const entry = await realpath(path.resolve(directory, bin))
              const isShim = platform === 'win32' && (await readFile(candidate, 'utf8')).replaceAll('\\', '/').includes('@deepseek-ai/dsh/')
              if (entry === target || isShim) return { executable: candidate, version: manifest.version }
            }
          } catch { /* Try the package ancestor, not an unrelated executable's --version. */ }
          const parent = path.dirname(directory)
          if (parent === directory) break
          directory = parent
        }
      }
    } catch { /* A stale or incomplete installation is unavailable. */ }
    return null
  }

  async function findDsh() {
    const name = platform === 'win32' ? 'dsh.cmd' : 'dsh'
    const managed = managedExecutable()
    let incompatible: { executable: string; version: string } | null = null
    for (const directory of pathDirs()) {
      const candidate = path.join(directory, name)
      if (candidate === managed) continue
      const result = await inspect(candidate)
      if (!result) continue
      if (result.version === LOCAL_DSH_VERSION) return { available: result, incompatible: null }
      incompatible ??= result
    }
    const found = await inspect(managed)
    if (found) {
      try {
        // npm can leave package/bin after a failed install; only accept a
        // completed managed installation, and keep incompatible globals intact.
        if ((await readFile(completionMarker(), 'utf8')).trim() === found.version) {
          if (found.version === LOCAL_DSH_VERSION) return { available: found, incompatible: null }
          incompatible ??= found
        }
      } catch { /* Incomplete managed install can be retried explicitly. */ }
    }
    return { available: null, incompatible }
  }

  async function findNode() {
    for (const directory of pathDirs()) {
      const candidate = path.join(directory, platform === 'win32' ? 'node.exe' : 'node')
      if (await accessible(candidate, true)) return candidate
    }
    return null
  }

  async function nodeReady(node: string | null): Promise<boolean> {
    if (!node) return false
    try {
      const version = await execute(node, ['--version'], { env: getEnv(), timeout: 10_000 })
      const match = version.match(/^v?(\d+)\.(\d+)\.(\d+)/)
      return Boolean(match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 12)))
    } catch { return false }
  }

  async function findInstaller() {
    const node = await findNode()
    if (!node) return null
    for (const directory of pathDirs()) {
      const candidates = [path.join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js')]
      try { candidates.unshift(await realpath(path.join(directory, 'npm'))) } catch { /* npm may only expose npm.cmd. */ }
      for (const cli of candidates) {
        if (path.basename(cli) !== 'npm-cli.js' || !await accessible(cli)) continue
        return { node, cli }
      }
    }
    return null
  }

  async function getLocalDshStatus(): Promise<LocalDshStatus> {
    const [{ available: found, incompatible }, node, installer] = await Promise.all([findDsh(), findNode(), findInstaller()])
    const versionError = incompatible ? `本机 DSH ${incompatible.version} 与当前 Muse 不兼容，请安装兼容版本 ${LOCAL_DSH_VERSION}；现有 DSH 将保持不变。` : null
    const ready = await nodeReady(node)
    if (found && ready) lastError = null
    return {
      installed: Boolean(found && ready), executable: found?.executable ?? null, version: found?.version ?? incompatible?.version ?? null,
      installing: pending !== null, canInstall: !found && Boolean(installer) && ready,
      detail: !ready ? '请先安装 Node.js 22.12 或更新版本，再重新检测。'
        : !found && !installer ? '未检测到 npm，请安装包含 npm 的 Node.js 后重新检测。' : null,
      error: lastError ?? versionError,
      ...(incompatible ? { supportedVersion: LOCAL_DSH_VERSION } : {}),
      ...(!lastError && versionError ? { errorCode: 'DSH_VERSION_INCOMPATIBLE' as const } : {}),
    }
  }

  async function requireLocalDshExecutable(): Promise<string> {
    const status = await getLocalDshStatus()
    if (status.installed && status.executable) return status.executable
    throw Object.assign(new Error(status.detail ?? status.error ?? '尚未安装 DeepSeek Harness，请先在安装引导中安装 DSH。'), { code: 'DSH_NOT_INSTALLED' })
  }

  function installLocalDsh(): Promise<LocalDshStatus> {
    if (pending) return pending
    const operation = async () => {
      lastError = null
      try {
        const existing = await findDsh()
        if (existing.available) return // Never upgrade or overwrite a compatible user installation.
        const installer = await findInstaller()
        if (!installer) throw new Error('未检测到 Node.js 和 npm，请先安装 Node.js 22.12 或更新版本，再重新检测。')
        if (!await nodeReady(installer.node)) throw new Error('DSH 需要 Node.js 22.12 或更新版本，请升级 Node.js 后重新检测。')
        await mkdir(prefix(), { recursive: true })
        const config = path.join(prefix(), '.npmrc')
        await writeFile(config, '', { mode: 0o600 })
        const env = { ...getEnv() }
        for (const key of Object.keys(env)) if (/^npm_config_/i.test(key)) delete env[key]
        env.npm_config_userconfig = config
        env.npm_config_globalconfig = config
        env.PATH = [path.dirname(installer.node), env.PATH ?? env.Path ?? ''].join(path.delimiter)
        await execute(installer.node, [installer.cli, 'install', '--global', '--prefix', prefix(), '--registry', REGISTRY,
          '--no-audit', '--no-fund', `${PACKAGE_NAME}@${LOCAL_DSH_VERSION}`], {
          cwd: prefix(), env, timeout: 300_000,
        })
        const installed = await inspect(managedExecutable())
        if (!installed || installed.version !== LOCAL_DSH_VERSION) throw new Error('安装命令已结束，但未找到可用的 DSH，请重试安装。')
        await writeFile(completionMarker(), installed.version, { mode: 0o600 })
      } catch (error) {
        lastError = error instanceof Error ? error.message : 'DSH 安装失败，请重试。'
      }
    }
    pending = operation().then(async () => {
      pending = null
      return getLocalDshStatus()
    }, error => { pending = null; throw error })
    return pending
  }

  return { getLocalDshStatus, requireLocalDshExecutable, installLocalDsh }
}

const installation = createLocalDshInstallation({ userData: () => app.getPath('userData') })
export const getLocalDshStatus = installation.getLocalDshStatus
export const requireLocalDshExecutable = installation.requireLocalDshExecutable
export const installLocalDsh = installation.installLocalDsh
