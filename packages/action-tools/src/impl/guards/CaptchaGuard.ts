/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/guards/CaptchaGuard.ts
 */
export {
  CaptchaGuard,
  getSharedCaptchaGuard,
} from '@muse/browser-core';
export type { CaptchaUserInterventionCallback } from '@muse/browser-core';

export type ViewGetter = (tabId: string) => any;
