import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { DshApiClient } from './dsh-api-client.js'

const DSH_PATCH = `
- insert:
    - id: mcp-tabtin
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: muse
        transport: streamable-http
        url: !!js process.env.MUSE_MCP_URL
        headers:
          Authorization: !!js '\`Bearer \${process.env.MUSE_MCP_TOKEN}\`'
        failOnStartupError: true
        reconnect:
          enabled: true
          initialDelayMs: 500
          maxDelayMs: 30000
          maxAttempts: 10
`

export interface DshProcessOptions {
  workspaceRoot: string
  dshHome: string
  apiUrl: string
  modelGatewayUrl: string
  modelGatewayToken: string
  mcpUrl?: string
  mcpToken?: string
  permissionMode?: string
  capabilityBridgeUrl?: string
  capabilityBridgeToken?: string
  pluginPath?: string
  logger: {
    info(message: string): void
    warn(message: string): void
  }
  executable?: string
}

/** Own a dedicated loopback DSH process; never attach to the user's web service. */
export class DshProcessService {
  private child: ChildProcess | null = null
  private readonly startupOutput: string[] = []

  constructor(private readonly options: DshProcessOptions) {}

  async start(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted()
    if (this.child) return
    this.startupOutput.length = 0
    await mkdir(this.options.dshHome, { recursive: true, mode: 0o700 })
    const patchPath = join(this.options.dshHome, 'muse-managed.patch.yml')
    const patches: string[] = []
    if (this.options.mcpUrl && this.options.mcpToken) patches.push(DSH_PATCH)
    if (this.options.capabilityBridgeUrl || this.options.capabilityBridgeToken) {
      if (!this.options.capabilityBridgeUrl || !this.options.capabilityBridgeToken) throw new Error('Muse DSH capability bridge requires both URL and token')
      const pluginPath = this.options.pluginPath ?? fileURLToPath(import.meta.resolve('@muse/dsh-muse-plugin'))
      await access(pluginPath)
      const plugin = await import(pathToFileURL(pluginPath).href) as { managedAgentPreset?: unknown }
      if (typeof plugin.managedAgentPreset !== 'string') throw new Error('Muse DSH plugin lacks its managed agent preset')
      const presetRoot = join(this.options.dshHome,'muse-presets')
      await mkdir(join(presetRoot,'muse'),{recursive:true,mode:0o700})
      await writeFile(join(presetRoot,'muse','agent.cordis.yml'),plugin.managedAgentPreset,{encoding:'utf8',mode:0o600})
      patches.push(`\n- id: agent-presets\n  disabled: true\n- insert:\n    - id: muse-agent-presets\n      name: '@deepseek-ai/dsh-agent-presets'\n      config:\n        default: muse\n        includeUserRoot: false\n        roots:\n          - path: ${JSON.stringify(presetRoot)}\n            trust: system\n- id: agent-default-model\n  config:\n    provider: deepseek-official\n    model: muse\n`)
      patches.push(`\n- id: session-title-llm\n  disabled: true\n- id: tool-skill\n  disabled: true\n- id: agent-instructions\n  disabled: true\n- insert:\n    - id: muse-capabilities\n      name: ${JSON.stringify(pluginPath)}\n      config:\n        bridgeUrl: !!js process.env.MUSE_DSH_CAPABILITY_URL\n        token: !!js process.env.MUSE_DSH_CAPABILITY_TOKEN\n`)
    }
    if (patches.length) await writeFile(patchPath, patches.join('\n'), { encoding: 'utf8', mode: 0o600 })
    const api = new URL(this.options.apiUrl)
    if (
      api.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '::1'].includes(api.hostname)
    ) throw new Error('DSH process API must bind loopback')
    signal?.throwIfAborted()
    const launch = await resolveDshLaunch(this.options.executable ?? 'dsh')
    signal?.throwIfAborted()
    const child = spawn(launch.executable, [
      ...launch.args,
      '--profile', 'web',
      ...(patches.length ? ['--patch', patchPath] : []),
      '--host', api.hostname,
      '--port', api.port || '3080',
      '--no-open',
    ], {
      cwd: this.options.workspaceRoot,
      env: {
        ...buildDshEnvironment(process.env),
        DSH_HOME: this.options.dshHome,
        DSH_TELEMETRY_MODE: 'DISABLED',
        DSH_PERMISSION_MODE: this.options.permissionMode ?? 'workspace-write',
        DEEPSEEK_API_KEY: this.options.modelGatewayToken,
        DEEPSEEK_BASE_URL: this.options.modelGatewayUrl,
        MUSE_MCP_URL: this.options.mcpUrl,
        MUSE_MCP_TOKEN: this.options.mcpToken,
        MUSE_DSH_CAPABILITY_URL: this.options.capabilityBridgeUrl,
        MUSE_DSH_CAPABILITY_TOKEN: this.options.capabilityBridgeToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    let spawnError: Error | undefined
    child.once('error', error => { spawnError = error })
    child.stdout?.on('data', chunk => {
      const line = chunk.toString('utf8').trim()
      if (line) {
        this.captureStartupOutput(line)
        this.options.logger.info(`[DSH] ${this.redact(line)}`)
      }
    })
    child.stderr?.on('data', chunk => {
      const line = chunk.toString('utf8').trim()
      if (line) {
        this.captureStartupOutput(line)
        this.options.logger.warn(`[DSH] ${this.redact(line)}`)
      }
    })
    try {
      await waitUntilReady(this.options.apiUrl, child, () => spawnError, signal)
    } catch (error) {
      await this.stop()
      const output = this.startupOutput.join('\n')
      throw new Error(output ? `${String(error)}\n${output}` : String(error))
    }
  }

  private captureStartupOutput(output: string): void {
    const redacted = this.redact(output)
    this.startupOutput.push(redacted)
    if (this.startupOutput.length > 20) this.startupOutput.shift()
  }

  private redact(output: string): string {
    for (const token of [this.options.modelGatewayToken, this.options.mcpToken, this.options.capabilityBridgeToken]) {
      if (token) output = output.replaceAll(token, '[REDACTED]')
    }
    return output
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve()
      }, 5_000)
      child.once('exit', () => { clearTimeout(timer); resolve() })
    })
  }
}

async function waitUntilReady(url: string, child: ChildProcess, getSpawnError: () => Error | undefined, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + 30_000
  const client = new DshApiClient(url, 1_000)
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    const spawnError = getSpawnError()
    if (spawnError) throw spawnError
    if (child.exitCode !== null) {
      throw new Error(`DSH process exited during startup: ${child.exitCode}`)
    }
    try {
      const response = await client.sessions.list({}, signal)
      if (response.result.ok) return
    } catch {
      // Startup polling is bounded by deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('DSH process startup timed out')
}

/** npm's Windows shim must be invoked through Node, never through a shell. */
export async function resolveDshLaunch(
  executable: string,
  platform = process.platform,
  env = process.env,
): Promise<{ executable: string; args: string[] }> {
  if (platform !== 'win32' || !executable.toLowerCase().endsWith('.cmd')) {
    return { executable, args: [] }
  }
  const packageDir = join(dirname(executable), 'node_modules', '@deepseek-ai', 'dsh')
  const manifest: unknown = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  if (!manifest || typeof manifest !== 'object') throw new Error('Invalid DSH package')
  const data = manifest as { name?: unknown; bin?: unknown }
  const bin = typeof data.bin === 'string' ? data.bin
    : data.bin && typeof data.bin === 'object' ? (data.bin as Record<string, unknown>).dsh : undefined
  if (data.name !== '@deepseek-ai/dsh' || typeof bin !== 'string') throw new Error('Invalid DSH package executable')
  const script = resolve(packageDir, bin)
  if (!script.startsWith(resolve(packageDir) + sep)) throw new Error('DSH executable escapes its package')
  await access(script)
  const directories = [dirname(executable), ...(env.PATH ?? env.Path ?? '').split(delimiter)]
  for (const directory of directories) {
    if (!isAbsolute(directory)) continue
    const node = join(directory, 'node.exe')
    try { await access(node); return { executable: node, args: [script] } } catch { /* next PATH directory */ }
  }
  throw new Error('DSH requires Node.js on PATH')
}

/** Never transfer the Electron/Daemon application environment into the external harness. */
export function buildDshEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const allowed = new Set([
    'PATH','HOME','USER','LOGNAME','SHELL','TMPDIR','TMP','TEMP','LANG','LANGUAGE',
    'LC_ALL','LC_CTYPE','LC_MESSAGES','LC_TIME','LC_COLLATE','LC_MONETARY','LC_NUMERIC',
    'HTTP_PROXY','HTTPS_PROXY','ALL_PROXY','NO_PROXY',
    'SSL_CERT_FILE','SSL_CERT_DIR','NODE_EXTRA_CA_CERTS','NODE_USE_SYSTEM_CA','NODE_USE_ENV_PROXY','NODE_ENV',
    'SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','APPDATA','LOCALAPPDATA','PROGRAMDATA','PROGRAMFILES','PROGRAMFILES(X86)','USERPROFILE','HOMEDRIVE','HOMEPATH',
  ])
  return Object.fromEntries(Object.entries(source).filter(([key,value])=>value !== undefined && allowed.has(key.toUpperCase())))
}
