import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  MeetingLocalArchive,
  MeetingRecordingStatus,
} from '@shared/meeting-recording-contract';
import { useAuthStore } from '@stores/useAuthStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';

import { Button, EmptyState } from '@components/ui';
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage';
import {
  MEETING_DETAIL_PREVIEW_ID,
  MEETING_LIVE_PREVIEW_ID,
} from './meetingViewNavigation';
import { MeetingDetailSessionView } from './MeetingDetailSessionView';
import { MeetingLiveSessionView } from './MeetingLiveSessionView';
import { MeetingPageIcon } from './meetingUi';

export type MeetingSessionSurface = 'live' | 'detail';

export function resolveMeetingSessionSurface(
  sessionId: string,
): MeetingSessionSurface | null {
  if (sessionId === MEETING_LIVE_PREVIEW_ID) return 'live';
  if (sessionId === MEETING_DETAIL_PREVIEW_ID) return 'detail';
  if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(sessionId)) return 'live';
  return null;
}

export const MeetingSessionView: React.FC<{
  sessionId: string;
  onBack: () => void;
}> = ({ sessionId, onBack }) => {
  const { t } = useTranslation('meeting');
  const surface = resolveMeetingSessionSurface(sessionId);
  const runtimeSession =
    surface === 'live' && sessionId !== MEETING_LIVE_PREVIEW_ID;
  const organizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  );
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const [runtimeStatus, setRuntimeStatus] =
    React.useState<MeetingRecordingStatus | null>(null);
  const [archive, setArchive] = React.useState<MeetingLocalArchive | null>(
    null,
  );
  const [loading, setLoading] = React.useState(runtimeSession);

  React.useEffect(() => {
    if (!runtimeSession) return;
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    void (async () => {
      const status = await bridge.getStatus();
      if (cancelled) return;
      if (status.active && status.manifest?.sessionId === sessionId) {
        setRuntimeStatus(status);
        setLoading(false);
        return;
      }
      if (!organizationId || !userId) {
        setLoading(false);
        return;
      }
      const loadedArchive = await bridge.getArchive({
        sessionId,
        organizationId: String(organizationId),
        userId: String(userId),
      });
      if (!cancelled) {
        setArchive(loadedArchive);
        setLoading(false);
      }
    })().catch(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [organizationId, runtimeSession, sessionId, userId]);

  if (surface === 'live' && !runtimeSession) {
    return <MeetingLiveSessionView sessionId={sessionId} onBack={onBack} />;
  }
  if (surface === 'detail') return <MeetingDetailSessionView />;
  if (runtimeStatus?.active) {
    return (
      <MeetingLiveSessionView
        sessionId={sessionId}
        onBack={onBack}
        initialStatus={runtimeStatus}
      />
    );
  }
  if (archive) return <MeetingDetailSessionView archive={archive} />;

  if (loading) {
    return (
      <StandaloneModulePage
        icon={<MeetingPageIcon />}
        title={t('common.title')}
        titleAs="h1"
        description={t('library.loading')}
        testId="meeting-records-session-loading"
      >
        <EmptyState icon="list" title={t('library.loading')} />
      </StandaloneModulePage>
    );
  }

  return (
    <StandaloneModulePage
      icon={<MeetingPageIcon />}
      title={t('common.title')}
      titleAs="h1"
      description={t('missing.description')}
      testId="meeting-records-session-missing"
    >
      <EmptyState
        icon="search"
        title={t('missing.title')}
        action={
          <Button type="button" onClick={onBack}>
            {t('common.backToLibrary')}
          </Button>
        }
      />
    </StandaloneModulePage>
  );
};

export default MeetingSessionView;
