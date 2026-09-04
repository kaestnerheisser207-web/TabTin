/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/captcha/CaptchaDetector.ts
 */
export {
  buildDetectionScript,
  analyzeDetectionResult,
} from '@muse/browser-core';
export type {
  CaptchaInfo,
  CaptchaType,
  CaptchaSuggestedAction,
} from '@muse/browser-core';
