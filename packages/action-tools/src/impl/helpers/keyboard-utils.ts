/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/operations/keyboard-utils.ts
 */
export {
  splitKeyCombo,
  normalizeModifier,
  buildKeyDescriptor,
} from '@muse/browser-core';
export type { KeyDescriptor } from '@muse/browser-core';
