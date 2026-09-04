/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/operations/CDPOperationHelper.ts
 */
export {
  CDPOperationHelper,
  getSharedCDPOperationHelper,
  isCDPAction,
  isCoordinateClick,
} from '@muse/browser-core';
export type {
  CDPActionType,
  CDPActionOptions,
  CDPOperationResult,
} from '@muse/browser-core';
