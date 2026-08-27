import React from 'react';
import { ChevronLeft } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@components/ui';
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage';
import type { MeetingLocalArchive } from '@shared/meeting-recording-contract';
import {
  MeetingHealthCard,
  MeetingPageIcon,
  MeetingSection,
  MeetingTranscriptTurn,
} from './meetingUi';
import {
  formatMeetingTranscriptTime,
  resolveMeetingTranscript,
} from './meetingTranscript';

export const MeetingLocalDetailView: React.FC<{
  archive: MeetingLocalArchive;
  onBack: () => void;
}> = ({ archive, onBack }) => {
  const { t } = useTranslation('meeting');
  const { manifest, audioUrls, transcript } = archive;
  const visibleTranscript = resolveMeetingTranscript(transcript);

  return (
    <StandaloneModulePage
      icon={<MeetingPageIcon />}
      title={manifest.title}
      titleAs="h1"
      description={t('detail.localArchiveDescription')}
      actions={
        <Button type="button" variant="ghost" size="sm" onClick={onBack}>
          <ChevronLeft className="mr-1.5 h-4 w-4" aria-hidden />
          {t('common.backToLibrary')}
        </Button>
      }
      testId="meeting-records-local-detail"
    >
      <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hover">
        <div className="space-y-4 pb-6">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <MeetingHealthCard
              label={t('detail.microphoneTrack')}
              value={t(`live.trackStatus.${manifest.tracks.local.status}`)}
              detail={`${manifest.tracks.local.bytes} B · ${manifest.tracks.local.sampleRate} Hz`}
              tone={
                manifest.tracks.local.status === 'completed'
                  ? 'healthy'
                  : 'warning'
              }
            />
            <MeetingHealthCard
              label={t('detail.systemTrack')}
              value={t(`live.trackStatus.${manifest.tracks.remote.status}`)}
              detail={`${manifest.tracks.remote.bytes} B · ${manifest.tracks.remote.sampleRate} Hz`}
              tone={
                manifest.tracks.remote.status === 'completed'
                  ? 'healthy'
                  : 'warning'
              }
            />
            <MeetingHealthCard
              label={t('detail.finalTranscript')}
              value={String(manifest.transcriptFinalCount)}
              detail={t(
                `live.transcriptStatus.${manifest.transcriptionStatus}`,
              )}
              tone={
                manifest.transcriptionStatus === 'failed'
                  ? 'failed'
                  : manifest.transcriptionStatus === 'partial'
                    ? 'warning'
                    : 'healthy'
              }
            />
            <MeetingHealthCard
              label={t('common.meetingCopilot')}
              value={t('live.copilotDisabled')}
              detail={t('live.copilotDisabledDetail')}
              tone="off"
            />
          </div>

          <MeetingSection
            title={t('detail.recordingTimeline')}
            description={t('detail.localRecordingDescription')}
            className="bg-background"
          >
            <div className="grid gap-4 lg:grid-cols-2">
              {(['local', 'remote'] as const).map((source) => (
                <div
                  key={source}
                  className="rounded-[12px] border border-foreground/[0.06] bg-foreground/[0.025] p-4 dark:border-foreground/[0.08] dark:bg-foreground/[0.035]"
                >
                  <p className="text-body font-medium text-foreground">
                    {source === 'local'
                      ? t('detail.microphoneTrack')
                      : t('detail.systemTrack')}
                  </p>
                  {audioUrls[source] ? (
                    <audio
                      className="mt-3 w-full"
                      controls
                      preload="metadata"
                      src={audioUrls[source]}
                    />
                  ) : (
                    <p className="mt-2 text-body text-muted-foreground">
                      {t('detail.audioUnavailable')}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </MeetingSection>

          <MeetingSection
            title={t('detail.transcriptTitle')}
            description={t('live.transcriptDescription')}
            className="bg-background"
          >
            {visibleTranscript.length > 0 ? (
              <div className="divide-y divide-foreground/[0.06] dark:divide-foreground/[0.08]">
                {visibleTranscript.map((checkpoint) => (
                  <MeetingTranscriptTurn
                    key={`${checkpoint.source}:${checkpoint.externalId}`}
                    speaker={
                      checkpoint.source === 'local'
                        ? t('common.speakerMe')
                        : t('common.speakerOther')
                    }
                    time={formatMeetingTranscriptTime(checkpoint.startMs)}
                    pending={!checkpoint.isFinal}
                  >
                    {checkpoint.text}
                  </MeetingTranscriptTurn>
                ))}
              </div>
            ) : (
              <p className="text-body leading-6 text-muted-foreground">
                {t('detail.localTranscriptEmpty')}
              </p>
            )}
          </MeetingSection>
        </div>
      </div>
    </StandaloneModulePage>
  );
};
