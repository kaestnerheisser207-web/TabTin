import React from 'react';
import { useTranslation } from 'react-i18next';
import type {
  MeetingArchiveScope,
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

const ARCHIVE_REFRESH_DELAYS_MS = [250, 750] as const;

function archiveNeedsFinalizeRefresh(
  archive: MeetingLocalArchive,
  status: MeetingRecordingStatus,
): boolean {
  const emptySnapshot =
    archive.transcript.length === 0 &&
    archive.copilotRecords.length === 0 &&
    Object.keys(archive.audioUrls).length === 0;
  if (archive.localAudioCleanupPending) return true;
  const manifest = archive.manifest;
  const statusStillSettling =
    status.manifest?.sessionId === manifest.sessionId &&
    (status.active || status.manifest.serverSyncStatus === 'pending');
  const archiveStillSettling =
    manifest.serverSyncStatus === 'pending' ||
    manifest.transcriptionStatus === 'connecting' ||
    manifest.transcriptionStatus === 'active' ||
    manifest.transcriptionStatus === 'recovering' ||
    Object.values(manifest.tracks).some(
      (track) => track.status === 'pending' || track.status === 'active',
    );
  return emptySnapshot || statusStillSettling || archiveStillSettling;
}

async function waitForArchiveRefresh(
  delayMs: number,
  cancelled: () => boolean,
): Promise<void> {
  await new Promise<void>((resolve) => window.setTimeout(resolve, delayMs));
  if (cancelled()) throw new Error('meeting archive refresh cancelled');
}

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
  const archiveScope = React.useMemo<MeetingArchiveScope | null>(() => {
    if (!runtimeSession || !organizationId || !userId) return null;
    return {
      sessionId,
      organizationId: String(organizationId),
      userId: String(userId),
    };
  }, [organizationId, runtimeSession, sessionId, userId]);

  React.useEffect(() => {
    if (!runtimeSession) return;
    const bridge = window.muse?.meetingRecording;
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
      if (!archiveScope) {
        setLoading(false);
        return;
      }
      let loadedArchive = await bridge.getArchive(archiveScope);
      for (const delayMs of ARCHIVE_REFRESH_DELAYS_MS) {
        if (!archiveNeedsFinalizeRefresh(loadedArchive, status)) break;
        await waitForArchiveRefresh(delayMs, () => cancelled);
        loadedArchive = await bridge.getArchive(archiveScope);
      }
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
  }, [archiveScope, runtimeSession, sessionId]);

  const deleteArchiveAudio = React.useCallback(async () => {
    const bridge = window.muse?.meetingRecording;
    if (!bridge || !archiveScope) {
      throw new Error(t('detail.deleteUnavailable'));
    }
    await bridge.deleteArchiveAudio(archiveScope);
    setArchive(await bridge.getArchive(archiveScope));
  }, [archiveScope, t]);

  const deleteArchive = React.useCallback(async () => {
    const bridge = window.muse?.meetingRecording;
    if (!bridge || !archiveScope) {
      throw new Error(t('detail.deleteUnavailable'));
    }
    await bridge.deleteArchive(archiveScope);
  }, [archiveScope, t]);

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
  if (archive) {
    return (
      <MeetingDetailSessionView
        archive={archive}
        onDeleteAudio={deleteArchiveAudio}
        onDeleteArchive={deleteArchive}
        onDeleted={onBack}
      />
    );
  }

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
