import { spawn } from 'node:child_process'

export interface CommandResult {
  stdout: string
  stderr: string
}

export interface CommandRunner {
  run(args: readonly string[], stdin?: string): Promise<CommandResult>
}

export class CommandFailedError extends Error {
  constructor(
    readonly exitCode: number,
    readonly stderr: string,
    readonly executable = 'container runtime',
  ) {
    super(`${executable} command failed with exit code ${exitCode}: ${stderr.trim()}`)
    this.name = 'CommandFailedError'
  }
}

export class ProcessCommandRunner implements CommandRunner {
  constructor(private readonly executable = 'docker') {}

  run(args: readonly string[], stdin?: string): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.executable, [...args], {
        stdio: [stdin === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
        shell: false,
      })
      let stdout = ''
      let stderr = ''
      const append = (current: string, chunk: Buffer): string => {
        const next = current + chunk.toString('utf8')
        return next.length > 1_000_000 ? next.slice(-1_000_000) : next
      }
      if (!child.stdout || !child.stderr) {
        child.kill()
        reject(new Error('docker command output pipes are unavailable'))
        return
      }
      child.stdout.on('data', chunk => { stdout = append(stdout, chunk) })
      child.stderr.on('data', chunk => { stderr = append(stderr, chunk) })
      child.once('error', reject)
      child.once('close', code => {
        if (code === 0) resolve({ stdout, stderr })
        else reject(new CommandFailedError(code ?? -1, stderr, this.executable))
      })
      if (stdin !== undefined) {
        if (!child.stdin) {
          child.kill()
          reject(new Error('docker command stdin pipe is unavailable'))
          return
        }
        child.stdin.end(stdin)
      }
    })
  }
}
