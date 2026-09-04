import type { CollabSyncMode } from '@muse/collab-core'

export function shouldConsumeTableRecordDelta(syncMode: CollabSyncMode): boolean {
  return syncMode === 'legacy'
}
