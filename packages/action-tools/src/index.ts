/**
 * @muse/action-tools — Public SDK Surface
 *
 * Keep this entry intentionally tiny.
 * Internal consumers should use subpath imports:
 *   @muse/action-tools/types      — Type definitions
 *   @muse/action-tools/tools      — Tool instances and groups
 *   @muse/action-tools/runtime    — Runtime bridge injection (internal)
 *   @muse/action-tools/impl       — Implementation classes (internal)
 *   @muse/action-tools/adapters   — Adapter classes (internal)
 *   @muse/action-tools/cdp        — CDP connection management (internal)
 *   @muse/action-tools/manifest   — Tool manifest queries
 *   @muse/action-tools/errors     — Error codes and factories
 */

// ===== Types =====
export type {
  ToolResult,
  AgentTool,
  ToolExecutorConfig,
} from './types';
export type {
  ToolExecutionTarget,
  ToolParameters,
  ToolManifest,
} from './types/manifest';

// ===== Errors =====
export {
  ToolErrorCode,
  ToolErrorFactory,
  isRetriableError,
  isFatalError,
  type ToolError,
  type StandardToolOutput,
} from './types/errors';
export { mapToToolErrorCode } from './utils/error';

// ===== Manifest =====
export {
  toolManifests,
  getToolManifests,
  getToolCapabilityMap,
} from './manifest';
