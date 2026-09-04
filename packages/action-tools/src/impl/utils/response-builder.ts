/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/utils/response-builder.ts
 */
export {
  buildToolError,
  safeSerialize,
  buildStopOnErrorResult,
  buildTabMissingResult,
  buildTopLevelErrorResult,
} from '@muse/browser-core';
