import type { ActionExecutorAdapter } from '@muse/action-tools/headless'
import type { McpContentApiPort, McpTablePort } from './ports.js'

export interface McpServerConfig {
  contentApi: McpContentApiPort
  table?: McpTablePort
  adapter?: ActionExecutorAdapter
  workspaceRoot?: string
  getWorkspaceSnapshot?: () => import('@muse/security-policy').WorkspaceSnapshot | null
}

export interface McpToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpRequestContext {
  disabledApps: string[]
  disabledToolPrefixes: string[]
}
