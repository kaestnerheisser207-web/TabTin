import { app, shell } from 'electron'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { createLogger } from '../logger'
import { getMainWindow } from '../window-manager'

export { createOAuthAuthorizeUrlParser } from './mcp-oauth-url'

const log = createLogger('McpOAuthWindow')

/**
 * mcp-remote 会调用系统 `open` 跳出默认浏览器。
 * 探测用 stdio 子进程把本 shim 插到 PATH 最前，吞掉 http(s) URL；
 * TabTin 解析 stderr 中的授权 URL 后统一交给系统默认浏览器打开，避免重复唤起。
 */
export function ensureMcpOpenShimDir(): string {
  const dir = join(app.getPath('userData'), 'mcp-open-shim')
  mkdirSync(dir, { recursive: true })
  const shimPath = join(dir, 'open')
  const script = `#!/bin/sh
# TabTin: intercept mcp-remote URL opens; defer to real open otherwise.
for arg in "$@"; do
  case "$arg" in
    http://*|https://*)
      exit 0
      ;;
  esac
done
if [ -x /usr/bin/open ]; then
  exec /usr/bin/open "$@"
fi
exit 0
`
  let existing = ''
  try {
    existing = readFileSync(shimPath, 'utf8')
  } catch {
    existing = ''
  }
  if (existing !== script) {
    writeFileSync(shimPath, script, { encoding: 'utf8', mode: 0o755 })
    try {
      chmodSync(shimPath, 0o755)
    } catch {
      // ignore
    }
  }
  return dir
}

/** 给 stdio 子进程用：优先走 open shim，避免跳出系统浏览器。 */
export function withMcpOpenShimPath(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const shimDir = ensureMcpOpenShimDir()
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') next[key] = value
  }
  next.PATH = `${shimDir}${delimiter}${env.PATH ?? ''}`
  return next
}

/** 连接器 OAuth 始终交给系统默认浏览器，复用用户已有登录态与代理设置。 */
export function openConnectorOAuthWindow(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    log.warn('ignore invalid oauth url')
    return
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    log.warn('ignore non-http oauth url', parsed.protocol)
    return
  }

  const startedAt = Date.now()
  log.info('opening connector oauth in system browser', { host: parsed.hostname })
  void shell.openExternal(parsed.toString()).then(() => {
    log.info('system browser accepted connector oauth url', {
      host: parsed.hostname,
      durationMs: Date.now() - startedAt,
    })
  }).catch(error => {
    log.error('system browser open failed', { host: parsed.hostname, error })
  })
}

export function closeConnectorOAuthWindow(): void {
  // 系统浏览器窗口不归 TabTin 管理；授权任务的生命周期由调用方关闭。
}

/** 主动连接器 OAuth 成功后，把已运行的 TabTin 主窗口带回前台。 */
export function restoreConnectorOAuthClient(): void {
  const mainWindow = getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  if (!mainWindow.isVisible()) mainWindow.show()
  app.focus({ steal: true })
  mainWindow.focus()
  log.info('connector oauth completed; restored client window')
}
