import { create } from 'zustand';

export type MeetingRecordsView =
  | { kind: 'library' }
  | { kind: 'setup' }
  | { kind: 'session'; sessionId: string };

export const MEETING_LIVE_PREVIEW_ID = 'meeting-preview-live';
export const MEETING_DETAIL_PREVIEW_ID = 'meeting-preview-detail';

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
