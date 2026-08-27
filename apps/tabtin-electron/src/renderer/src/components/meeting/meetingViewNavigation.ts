import { create } from 'zustand';
import type { MeetingRecordingStatus } from '@shared/meeting-recording-contract';

export type MeetingRecordsView =
  | { kind: 'library' }
  | { kind: 'setup' }
  | { kind: 'session'; sessionId: string };

export const MEETING_LIVE_PREVIEW_ID = 'meeting-preview-live';
export const MEETING_DETAIL_PREVIEW_ID = 'meeting-preview-detail';

export function resolveContinuableMeetingSessionId(
  status: MeetingRecordingStatus | null | undefined,
): string | null {
  const lifecycleStatus = status?.manifest?.lifecycleStatus;
  if (
    !status?.active ||
    lifecycleStatus !== 'recording'
  ) {
    return null;
  }
  return status.manifest?.sessionId ?? null;
}

interface MeetingViewNavigationState {
  view: MeetingRecordsView;
  openLibrary: () => void;
  openSetup: () => void;
  openSession: (sessionId: string) => void;
}

export const useMeetingViewNavigation = create<MeetingViewNavigationState>(
  (set) => ({
    view: { kind: 'library' },
    openLibrary: () => set({ view: { kind: 'library' } }),
    openSetup: () => set({ view: { kind: 'setup' } }),
    openSession: (sessionId) => set({ view: { kind: 'session', sessionId } }),
  }),
);
