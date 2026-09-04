/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/BrowserToolImpl.ts
 */
export {
  BrowserToolImpl,
  getSharedBrowserToolImpl,
  resetSharedBrowserToolImpl,
} from '@muse/browser-core';
export type { CaptchaUserInterventionCallback } from '@muse/browser-core';
