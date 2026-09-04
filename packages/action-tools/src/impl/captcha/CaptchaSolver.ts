/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/captcha/CaptchaSolver.ts
 */
export { NoOpCaptchaSolver } from '@muse/browser-core';
export type {
  CaptchaSolver,
  CaptchaSolveParams,
  CaptchaSolveResult,
} from '@muse/browser-core';
