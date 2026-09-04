import { spawn, type ChildProcess } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
  mcpUrl: string
  mcpToken: string
  logger: {
    info(message: string): void
    warn(message: string): void
  }
  executable?: string
}

/** Own the loopback DSH Web/ApiProxy process inside one Cloud runtime. */
export class DshProcessService {
  private child: ChildProcess | null = null
  private readonly startupOutput: string[] = []

  constructor(private readonly options: DshProcessOptions) {}

  async start(): Promise<void> {
    if (this.child) return
    this.startupOutput.length = 0
    await mkdir(this.options.dshHome, { recursive: true })
    const patchPath = join(this.options.dshHome, 'tabtin-mcp.patch.yml')
    await writeFile(patchPath, DSH_PATCH, { encoding: 'utf8', mode: 0o600 })
    const api = new URL(this.options.apiUrl)
    if (
      api.protocol !== 'http:'
      || !['127.0.0.1', 'localhost', '::1'].includes(api.hostname)
    ) throw new Error('DSH process API must bind loopback')
    const child = spawn(this.options.executable ?? 'dsh', [
      '--profile', 'web',
      '--patch', patchPath,
      '--host', api.hostname,
      '--port', api.port || '3080',
      '--no-open',
    ], {
      cwd: this.options.workspaceRoot,
      env: {
        ...process.env,
        DSH_HOME: this.options.dshHome,
        DSH_TELEMETRY_MODE: 'DISABLED',
        DSH_PERMISSION_MODE: process.env.DSH_PERMISSION_MODE ?? 'workspace-write',
        DEEPSEEK_API_KEY: this.options.modelGatewayToken,
        DEEPSEEK_BASE_URL: this.options.modelGatewayUrl,
        MUSE_MCP_URL: this.options.mcpUrl,
        MUSE_MCP_TOKEN: this.options.mcpToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.child = child
    child.stdout?.on('data', chunk => {
      const line = chunk.toString('utf8').trim()
      if (line) {
        this.captureStartupOutput(line)
        this.options.logger.info(`[DSH] ${line}`)
      }
    })
    child.stderr?.on('data', chunk => {
      const line = chunk.toString('utf8').trim()
      if (line) {
        this.captureStartupOutput(line)
        this.options.logger.warn(`[DSH] ${line}`)
      }
    })
    try {
      await waitUntilReady(this.options.apiUrl, child)
    } catch (error) {
      await this.stop()
      const output = this.startupOutput.join('\n')
      throw new Error(output ? `${String(error)}\n${output}` : String(error))
    }
  }

  private captureStartupOutput(output: string): void {
    const redacted = output
      .replaceAll(this.options.modelGatewayToken, '[REDACTED]')
      .replaceAll(this.options.mcpToken, '[REDACTED]')
    this.startupOutput.push(redacted)
    if (this.startupOutput.length > 20) this.startupOutput.shift()
  }

  async stop(): Promise<void> {
    const child = this.child
    this.child = null
    if (!child || child.exitCode !== null) return
    child.kill('SIGTERM')
    await Promise.race([
      new Promise<void>(resolve => child.once('exit', () => resolve())),
      new Promise<void>(resolve => setTimeout(() => {
        if (child.exitCode === null) child.kill('SIGKILL')
        resolve()
      }, 5_000)),
    ])
  }
}

async function waitUntilReady(url: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`DSH process exited during startup: ${child.exitCode}`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) })
      if (response.ok) return
    } catch {
      // Startup polling is bounded by deadline.
    }
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  throw new Error('DSH process startup timed out')
}
