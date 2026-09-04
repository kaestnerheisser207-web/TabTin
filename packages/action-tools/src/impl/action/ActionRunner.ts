/**
 * Re-export from @muse/browser-core for backward compatibility.
 * Actual implementation lives in packages/browser-core/src/operations/ActionRunner.ts
 */
export {
  runSingleAction,
  runActionSequence,
  buildFailureEntry,
} from '@muse/browser-core';
export type {
  ActionEntry,
  ActionSequenceOptions,
  ActionSequenceResult,
} from '@muse/browser-core';
