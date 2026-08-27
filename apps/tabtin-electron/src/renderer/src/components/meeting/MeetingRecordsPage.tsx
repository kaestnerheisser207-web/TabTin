import React from 'react';

import { MeetingLibraryView } from './MeetingLibraryView';
import { MeetingSessionView } from './MeetingSessionView';
import { MeetingSetupView } from './MeetingSetupView';
import {
  resolveContinuableMeetingSessionId,
  useMeetingViewNavigation,
} from './meetingViewNavigation';

export const MeetingRecordsPage: React.FC = () => {
  const view = useMeetingViewNavigation((state) => state.view);
  const openLibrary = useMeetingViewNavigation((state) => state.openLibrary);
  const openSetupView = useMeetingViewNavigation((state) => state.openSetup);
  const openSession = useMeetingViewNavigation((state) => state.openSession);
  const [runtimeChecked, setRuntimeChecked] = React.useState(
    () => !window.tabtin?.meetingRecording,
  );
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge) {
      setRuntimeChecked(true);
      return;
    }
    let cancelled = false;
    const applyStatus = (status: Parameters<typeof resolveContinuableMeetingSessionId>[0]) => {
      if (cancelled) return;
      setActiveSessionId(resolveContinuableMeetingSessionId(status));
      setRuntimeChecked(true);
    };
    void bridge.getStatus().then(applyStatus).catch(() => {
      if (!cancelled) setRuntimeChecked(true);
    });
    const unsubscribe = bridge.onStatusChanged(applyStatus);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, []);

  React.useEffect(() => {
    if (runtimeChecked && activeSessionId && view.kind === 'setup') {
      openSession(activeSessionId);
    }
  }, [activeSessionId, openSession, runtimeChecked, view.kind]);

  const openSetup = React.useCallback(() => {
    if (activeSessionId) {
      openSession(activeSessionId);
      return;
    }
    openSetupView();
  }, [activeSessionId, openSession, openSetupView]);

  if (view.kind === 'setup') {
    if (!runtimeChecked || activeSessionId) return null;
    return (
      <MeetingSetupView
        onBack={openLibrary}
        onStarted={openSession}
      />
    );
  }

  if (view.kind === 'session') {
    return (
      <MeetingSessionView sessionId={view.sessionId} onBack={openLibrary} />
    );
  }

  return (
    <MeetingLibraryView
      activeSessionId={activeSessionId}
      onStart={openSetup}
      onOpen={openSession}
    />
  );
};

export default MeetingRecordsPage;
