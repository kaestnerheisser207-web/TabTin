import React from 'react';

import { MeetingLibraryView } from './MeetingLibraryView';
import { MeetingSessionView } from './MeetingSessionView';
import { MeetingSetupView } from './MeetingSetupView';
import { useMeetingViewNavigation } from './meetingViewNavigation';

export const MeetingRecordsPage: React.FC = () => {
  const view = useMeetingViewNavigation((state) => state.view);
  const openLibrary = useMeetingViewNavigation((state) => state.openLibrary);
  const openSetup = useMeetingViewNavigation((state) => state.openSetup);
  const openSession = useMeetingViewNavigation((state) => state.openSession);

  if (view.kind === 'setup') {
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

  return <MeetingLibraryView onStart={openSetup} onOpen={openSession} />;
};

export default MeetingRecordsPage;
