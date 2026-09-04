/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/cdp/CDPConnectionManager.ts
 */
export {
  CDPConnectionManager,
  CDPConnectionProfile,
  getCDPConnectionManager,
  destroyCDPConnectionManager,
} from '@muse/browser-core';
export type {
  CDPConnectionStrategy,
  CDPConnectionConfig,
  TaskLifecycleEvent,
} from '@muse/browser-core';
