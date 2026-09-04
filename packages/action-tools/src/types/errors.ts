/**
 * 统一错误类型定义
 *
 * 从 @muse/browser-core re-export，避免两套定义不一致。
 */
export {
  ToolErrorCode,
  ToolErrorFactory,
  isRetriableError,
  isFatalError,
} from '@muse/browser-core';
export type { ToolError, StandardToolOutput } from '@muse/browser-core';
