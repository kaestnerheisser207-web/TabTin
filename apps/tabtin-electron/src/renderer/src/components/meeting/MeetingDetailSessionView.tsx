import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  CheckCircle2,
  CircleDot,
  Clock3,
  Download,
  FileX2,
  FileText,
  FolderKanban,
  Headphones,
  Link2,
  ListChecks,
  Pause,
  Play,
  Search,
  Share2,
  Trash2,
  Users,
} from 'lucide-react';

import {
  Button,
  ConfirmDialog,
  EmptyState,
  Input,
  PanelRangeSlider,
  RadioGroup,
  RadioGroupItem,
  TabsContent,
  TabsList,
  TabsRoot,
  TabsTrigger,
} from '@components/ui';
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage';
import { useIdentityLabels } from '@components/layout/useIdentityLabels';
import type { MeetingLocalArchive } from '@shared/meeting-recording-contract';
import { ProjectApiService } from '@/services/projectApi';
import {
  MeetingPageIcon,
  MeetingPartialNotice,
  MeetingPreviewBanner,
  MeetingSection,
  MeetingTranscriptTurn,
} from './meetingUi';
import {
  formatMeetingTranscriptTime,
  groupMeetingTranscriptTurns,
  resolveMeetingTranscript,
} from './meetingTranscript';
import { MeetingCopilotHistory } from './MeetingCopilotHistory';

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

const OverviewTab: React.FC<{ archive?: MeetingLocalArchive }> = ({
  archive,
}) => {
  const { t } = useTranslation('meeting');
  const manifest = archive?.manifest;
  const transcriptReady = (manifest?.transcriptFinalCount ?? 0) > 0;
  return (
    <div className="grid gap-4 xl:grid-cols-5">
      <MeetingSection
        title={t('detail.summary')}
        description={
          archive ? t('detail.recordedBrief') : t('detail.aiGenerated')
        }
        className="xl:col-span-3"
      >
        <p className="text-body leading-7 text-foreground/90">
          {manifest
            ? manifest.brief || t('detail.summaryUnavailable')
            : t('detail.summaryBody')}
        </p>
        {!manifest ? (
          <Button
            type="button"
            variant="link"
            size="sm"
            className="mt-3 h-auto px-0 text-accent-text"
            disabled
          >
            {t('detail.viewEvidence')}
          </Button>
        ) : null}
      </MeetingSection>
      <MeetingSection
        title={t('detail.processingStatus')}
        className="xl:col-span-2"
      >
        <div className="space-y-3 text-body">
          {[
            [
              t('detail.microphoneTrack'),
              manifest
                ? t(`live.trackStatus.${manifest.tracks.local.status}`)
                : t('common.complete'),
            ],
            [
              t('detail.systemTrack'),
              manifest
                ? t(`live.trackStatus.${manifest.tracks.remote.status}`)
                : t('common.complete'),
            ],
            [
              t('detail.finalTranscript'),
              manifest
                ? t(`live.transcriptStatus.${manifest.transcriptionStatus}`)
                : t('detail.completed'),
            ],
            [
              t('detail.postAnalysis'),
              manifest ? t('detail.notGenerated') : t('detail.partialFailed'),
            ],
          ].map(([label, value]) => (
            <div
              key={label}
              className="flex items-center justify-between gap-3"
            >
              <span className="text-muted-foreground">{label}</span>
              <span className="font-medium text-foreground">{value}</span>
            </div>
          ))}
        </div>
      </MeetingSection>
      <MeetingSection title={t('detail.decisions')} className="xl:col-span-2">
        {manifest ? (
          <p className="text-body leading-6 text-muted-foreground">
            {transcriptReady
              ? t('detail.analysisPending')
              : t('detail.transcriptRequired')}
          </p>
        ) : (
          <ul className="space-y-2 text-body leading-6 text-foreground/90">
            <li>• {t('detail.decisionOne')}</li>
            <li>• {t('detail.decisionTwo')}</li>
            <li>• {t('detail.decisionThree')}</li>
          </ul>
        )}
      </MeetingSection>
      <MeetingSection title={t('detail.actions')} className="xl:col-span-3">
        {manifest ? (
          <p className="text-body leading-6 text-muted-foreground">
            {t('detail.actionsUnavailable')}
          </p>
        ) : (
          <div className="space-y-3">
            {[
              [
                t('detail.actionOne'),
                t('detail.productDevelopment'),
                t('detail.today'),
              ],
              [
                t('detail.actionTwo'),
                t('detail.client'),
                t('detail.pendingSchedule'),
              ],
            ].map(([task, owner, due]) => (
              <div
                key={task}
                className="grid gap-2 rounded-[12px] bg-background px-4 py-3 text-body sm:grid-cols-[minmax(0,1fr)_120px_90px]"
              >
                <span className="font-medium text-foreground">{task}</span>
                <span className="text-muted-foreground">{owner}</span>
                <span className="text-muted-foreground">{due}</span>
              </div>
            ))}
          </div>
        )}
      </MeetingSection>
    </div>
  );
};

type PlaybackState = {
  source: 'local' | 'remote';
  currentMs: number;
  playing: boolean;
};

type TrackControlState = {
  currentMs: number;
  durationMs: number;
  playing: boolean;
};

function formatAudioControlTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

const TranscriptRecordingTab: React.FC<{ archive?: MeetingLocalArchive }> = ({
  archive,
}) => {
  const { t } = useTranslation('meeting');
  const { user, displayName } = useIdentityLabels();
  const localSpeakerName = displayName || t('common.speakerMe');
  const [search, setSearch] = React.useState('');
  const [playback, setPlayback] = React.useState<PlaybackState | null>(null);
  const [trackControls, setTrackControls] = React.useState<
    Record<'local' | 'remote', TrackControlState>
  >(() => ({
    local: {
      currentMs: 0,
      durationMs:
        archive?.manifest.tracks.local.durationMs ||
        archive?.manifest.durationMs ||
        0,
      playing: false,
    },
    remote: {
      currentMs: 0,
      durationMs:
        archive?.manifest.tracks.remote.durationMs ||
        archive?.manifest.durationMs ||
        0,
      playing: false,
    },
  }));
  const audioRefs = React.useRef<
    Partial<Record<'local' | 'remote', HTMLAudioElement>>
  >({});
  const turnRefs = React.useRef(new Map<string, HTMLDivElement>());
  const transcript = archive
    ? groupMeetingTranscriptTurns(resolveMeetingTranscript(archive.transcript))
    : null;
  const visibleTranscript = transcript?.filter((checkpoint) =>
    checkpoint.text.toLowerCase().includes(search.trim().toLowerCase()),
  );
  const activeCheckpoint = React.useMemo(() => {
    if (!transcript || !playback) return null;
    let active: (typeof transcript)[number] | null = null;
    for (const checkpoint of transcript) {
      if (checkpoint.source !== playback.source) continue;
      if (checkpoint.startMs > playback.currentMs) break;
      active = checkpoint;
    }
    return active;
  }, [playback, transcript]);
  const activeKey = activeCheckpoint
    ? `${activeCheckpoint.source}:${activeCheckpoint.externalId}`
    : null;

  React.useEffect(() => {
    if (!playback?.playing || !activeKey) return;
    turnRefs.current.get(activeKey)?.scrollIntoView({
      block: 'nearest',
      behavior: 'smooth',
    });
  }, [activeKey, playback?.playing]);

  const seekAndPlay = async (source: 'local' | 'remote', startMs: number) => {
    const audio = audioRefs.current[source];
    if (!audio) return;
    const otherSource = source === 'local' ? 'remote' : 'local';
    audioRefs.current[otherSource]?.pause();
    audio.currentTime = startMs / 1_000;
    setPlayback({ source, currentMs: startMs, playing: true });
    await audio.play().catch(() => {
      setPlayback({ source, currentMs: startMs, playing: false });
    });
  };

  const renderPlayer = (source: 'local' | 'remote') => {
    const sourceUrl = archive?.audioUrls[source];
    const control = trackControls[source];
    const label =
      source === 'local'
        ? t('detail.microphoneTrack')
        : t('detail.systemTrack');
    const progressPercent =
      control.durationMs > 0
        ? Math.min(100, (control.currentMs / control.durationMs) * 100)
        : 0;
    const updateTrackControl = (next: Partial<TrackControlState>) => {
      setTrackControls((current) => ({
        ...current,
        [source]: { ...current[source], ...next },
      }));
    };
    const togglePlayback = async () => {
      const audio = audioRefs.current[source];
      if (!audio) return;
      if (!audio.paused) {
        audio.pause();
        return;
      }
      const otherSource = source === 'local' ? 'remote' : 'local';
      audioRefs.current[otherSource]?.pause();
      await audio.play().catch(() => undefined);
    };
    return (
      <div className="flex min-w-0 items-center gap-3 py-1">
        <div className="flex w-24 shrink-0 items-center gap-2 text-body font-medium text-foreground">
          <Headphones className="h-4 w-4 text-muted-foreground" aria-hidden />
          {label}
        </div>
        {sourceUrl ? (
          <>
            <audio
              ref={(node) => {
                if (node) audioRefs.current[source] = node;
                else delete audioRefs.current[source];
              }}
              className="hidden"
              preload="metadata"
              src={sourceUrl}
              onLoadedMetadata={(event) => {
                const durationMs = event.currentTarget.duration * 1_000;
                if (Number.isFinite(durationMs) && durationMs > 0) {
                  updateTrackControl({ durationMs });
                }
              }}
              onPlay={(event) => {
                const otherSource = source === 'local' ? 'remote' : 'local';
                audioRefs.current[otherSource]?.pause();
                const currentMs = event.currentTarget.currentTime * 1_000;
                updateTrackControl({ currentMs, playing: true });
                setPlayback({ source, currentMs, playing: true });
              }}
              onTimeUpdate={(event) => {
                const currentMs = event.currentTarget.currentTime * 1_000;
                const playing = !event.currentTarget.paused;
                updateTrackControl({ currentMs, playing });
                setPlayback((current) =>
                  current?.source === source
                    ? { source, currentMs, playing }
                    : current,
                );
              }}
              onPause={() => {
                updateTrackControl({ playing: false });
                setPlayback((current) =>
                  current?.source === source
                    ? { ...current, playing: false }
                    : current,
                );
              }}
            />
            <div className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-interactive bg-muted px-2">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-interactive"
                onClick={() => void togglePlayback()}
                aria-label={
                  control.playing
                    ? `${t('detail.pauseRecording')} ${label}`
                    : `${t('detail.playRecording')} ${label}`
                }
              >
                {control.playing ? (
                  <Pause className="h-3.5 w-3.5" aria-hidden />
                ) : (
                  <Play className="h-3.5 w-3.5" aria-hidden />
                )}
              </Button>
              <span className="w-[70px] shrink-0 text-caption tabular-nums text-foreground-secondary">
                {formatAudioControlTime(control.currentMs)} /{' '}
                {formatAudioControlTime(control.durationMs)}
              </span>
              <label className="flex min-w-0 flex-1 items-center">
                <span className="sr-only">{label}</span>
                <PanelRangeSlider
                  min={0}
                  max={Math.max(1, control.durationMs)}
                  step={100}
                  value={Math.min(control.currentMs, control.durationMs || 0)}
                  onChange={(currentMs) => {
                    const audio = audioRefs.current[source];
                    if (audio) audio.currentTime = currentMs / 1_000;
                    updateTrackControl({ currentMs });
                    setPlayback((current) =>
                      current?.source === source
                        ? { ...current, currentMs }
                        : current,
                    );
                  }}
                  className="meeting-timeline-slider min-w-0"
                  style={
                    {
                      '--meeting-progress': `${progressPercent}%`,
                    } as React.CSSProperties
                  }
                />
              </label>
            </div>
          </>
        ) : (
          <p className="min-w-0 flex-1 text-body text-muted-foreground">
            {t('detail.audioUnavailable')}
          </p>
        )}
      </div>
    );
  };

  return (
    <section className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-[12px] bg-foreground/[0.03] p-5 dark:bg-foreground/[0.04]">
      <div className="grid shrink-0 gap-5 border-b border-foreground/[0.08] pb-3 dark:border-foreground/[0.1] lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_minmax(220px,320px)]">
        {renderPlayer('local')}
        {renderPlayer('remote')}
        <div className="flex min-w-0 items-center">
          <div className="relative w-full">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="h-9 pl-9"
              placeholder={t('detail.searchTranscript')}
              aria-label={t('detail.searchTranscriptAria')}
            />
          </div>
        </div>
      </div>
      <div className="mt-1 min-h-0 flex-1 overflow-y-auto pr-1 pt-1 scrollbar-hover">
        {visibleTranscript ? (
          visibleTranscript.length > 0 ? (
            <div className="divide-y divide-foreground/[0.06] dark:divide-foreground/[0.08]">
              {visibleTranscript.map((checkpoint) => {
                const checkpointKey = `${checkpoint.source}:${checkpoint.externalId}`;
                return (
                  <div
                    key={checkpointKey}
                    ref={(node) => {
                      if (node) turnRefs.current.set(checkpointKey, node);
                      else turnRefs.current.delete(checkpointKey);
                    }}
                  >
                    <MeetingTranscriptTurn
                      speaker={
                        checkpoint.source === 'local'
                          ? localSpeakerName
                          : t('common.speakerOther')
                      }
                      speakerId={
                        checkpoint.source === 'local'
                          ? user?.id
                          : 'meeting-remote'
                      }
                      avatarUrl={
                        checkpoint.source === 'local' ? user?.avatar : null
                      }
                      time={formatMeetingTranscriptTime(checkpoint.startMs)}
                      pending={!checkpoint.isFinal}
                      active={checkpointKey === activeKey}
                      onTimeClick={
                        archive?.audioUrls[checkpoint.source]
                          ? () =>
                              void seekAndPlay(
                                checkpoint.source,
                                checkpoint.startMs,
                              )
                          : undefined
                      }
                      timeActionLabel={`${t('detail.playSegment')} ${formatMeetingTranscriptTime(checkpoint.startMs)}`}
                    >
                      {checkpoint.text}
                    </MeetingTranscriptTurn>
                  </div>
                );
              })}
            </div>
          ) : (
            <EmptyState
              icon="search"
              title={t('detail.localTranscriptEmpty')}
            />
          )
        ) : (
          <div className="divide-y divide-foreground/[0.06] dark:divide-foreground/[0.08]">
            <MeetingTranscriptTurn
              speaker={t('common.speakerOther')}
              speakerId="meeting-remote"
              time="00:21:42"
            >
              {t('detail.shortQuestionOne')}
            </MeetingTranscriptTurn>
            <MeetingTranscriptTurn
              speaker={localSpeakerName}
              speakerId={user?.id}
              avatarUrl={user?.avatar}
              time="00:21:51"
            >
              {t('detail.shortAnswerOne')}
            </MeetingTranscriptTurn>
            <MeetingTranscriptTurn
              speaker={t('common.speakerOther')}
              speakerId="meeting-remote"
              time="00:22:16"
            >
              {t('detail.shortQuestionTwo')}
            </MeetingTranscriptTurn>
            <MeetingTranscriptTurn
              speaker={localSpeakerName}
              speakerId={user?.id}
              avatarUrl={user?.avatar}
              time="00:22:29"
            >
              {t('detail.shortAnswerTwo')}
            </MeetingTranscriptTurn>
          </div>
        )}
      </div>
    </section>
  );
};

const CopilotTab: React.FC<{ archive?: MeetingLocalArchive }> = ({
  archive,
}) => {
  const { t } = useTranslation('meeting');
  return (
    <MeetingSection
      title={t('common.meetingCopilot')}
      description={t('detail.copilotDescription')}
    >
      {archive ? (
        <MeetingCopilotHistory records={archive.copilotRecords ?? []} />
      ) : (
        <div className="space-y-3">
          <div className="rounded-[12px] border border-foreground/[0.06] bg-background p-4 dark:border-foreground/[0.08]">
            <p className="text-caption text-muted-foreground">
              {t('detail.otherQuestion')}
            </p>
            <p className="mt-1 text-body font-medium text-foreground">
              {t('detail.copilotQuestion')}
            </p>
            <div className="mt-3 rounded-[12px] bg-accent/5 p-3 text-body leading-6 text-foreground/90">
              {t('detail.copilotAnswer')}
            </div>
            <p className="mt-2 text-caption text-muted-foreground">
              {t('detail.sourceReliability')}
            </p>
          </div>
          <Button type="button" variant="outline" disabled>
            {t('detail.continueAsk')}
          </Button>
        </div>
      )}
    </MeetingSection>
  );
};

const ResourcesTab: React.FC<{
  archive?: MeetingLocalArchive;
  projectDisplayName: string;
}> = ({ archive, projectDisplayName }) => {
  const { t } = useTranslation('meeting');
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <MeetingSection title={t('detail.relatedProject')}>
        <div className="flex items-center gap-3 rounded-[12px] bg-background p-4">
          <FolderKanban className="h-5 w-5 text-accent-text" aria-hidden />
          <div>
            <p className="text-body font-medium text-foreground">
              {archive ? projectDisplayName : t('detail.meetingCapability')}
            </p>
            <p className="text-caption text-muted-foreground">
              {archive
                ? t('detail.linkedProjectId')
                : t('detail.currentProject')}
            </p>
          </div>
        </div>
      </MeetingSection>
      <MeetingSection title={t('detail.authorizedResources')}>
        {archive ? (
          <p className="text-body leading-6 text-muted-foreground">
            {t('detail.resourcesUnavailable')}
          </p>
        ) : (
          <div className="space-y-2">
            {[
              t('detail.resourceRequirements'),
              t('detail.resourceBrief'),
              t('detail.resourceSpike'),
            ].map((name) => (
              <div
                key={name}
                className="flex items-center gap-2 rounded-[12px] bg-background px-4 py-3 text-body text-foreground"
              >
                <Link2 className="h-4 w-4 text-muted-foreground" aria-hidden />
                <span>{name}</span>
              </div>
            ))}
          </div>
        )}
      </MeetingSection>
    </div>
  );
};

export const MeetingDetailSessionView: React.FC<{
  archive?: MeetingLocalArchive;
  onDeleteAudio?: () => Promise<void>;
  onDeleteArchive?: () => Promise<void>;
  onDeleted?: () => void;
}> = ({ archive, onDeleteAudio, onDeleteArchive, onDeleted }) => {
  const { t } = useTranslation('meeting');
  const manifest = archive?.manifest;
  const [deleteDialogOpen, setDeleteDialogOpen] = React.useState(false);
  const [deleteTarget, setDeleteTarget] = React.useState<'audio' | 'archive'>(
    'audio',
  );
  const [deleting, setDeleting] = React.useState(false);
  const [deleteError, setDeleteError] = React.useState('');
  const [resolvedProjectName, setResolvedProjectName] = React.useState(
    manifest?.projectName?.trim() || '',
  );
  const [projectLookupPending, setProjectLookupPending] = React.useState(false);
  React.useEffect(() => {
    const snapshotName = manifest?.projectName?.trim() || '';
    setResolvedProjectName(snapshotName);
    if (!manifest?.projectId || snapshotName) {
      setProjectLookupPending(false);
      return;
    }
    let cancelled = false;
    setProjectLookupPending(true);
    void ProjectApiService.getProject(manifest.projectId)
      .then((project) => {
        if (!cancelled) setResolvedProjectName(project.name.trim());
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setProjectLookupPending(false);
      });
    return () => {
      cancelled = true;
    };
  }, [manifest?.projectId, manifest?.projectName]);
  const projectDisplayName = manifest?.projectId
    ? resolvedProjectName ||
      (projectLookupPending
        ? t('setup.projectLoading')
        : t('detail.linkedProjectUnavailable'))
    : t('detail.noLinkedProject');
  const audioDeleted = Boolean(
    manifest &&
    manifest.tracks.local.storageStatus === 'deleted' &&
    manifest.tracks.remote.storageStatus === 'deleted',
  );
  const tracksComplete =
    !audioDeleted &&
    manifest?.tracks.local.status === 'completed' &&
    manifest.tracks.remote.status === 'completed';
  const openDeleteDialog = (): void => {
    setDeleteError('');
    setDeleteTarget(!audioDeleted && onDeleteAudio ? 'audio' : 'archive');
    setDeleteDialogOpen(true);
  };
  const confirmDelete = async (): Promise<void> => {
    if (deleting) return;
    setDeleting(true);
    setDeleteError('');
    try {
      if (deleteTarget === 'audio') {
        if (!onDeleteAudio) throw new Error(t('detail.deleteUnavailable'));
        await onDeleteAudio();
      } else {
        if (!onDeleteArchive) throw new Error(t('detail.deleteUnavailable'));
        await onDeleteArchive();
        onDeleted?.();
      }
    } catch (error) {
      const fallback =
        deleteTarget === 'audio'
          ? t('detail.deleteAudioFailed')
          : t('detail.deleteMeetingFailed');
      const reason = error instanceof Error ? error.message.trim() : '';
      setDeleteError(
        reason && reason !== fallback ? `${fallback}: ${reason}` : fallback,
      );
      throw error;
    } finally {
      setDeleting(false);
    }
  };
  return (
    <StandaloneModulePage
      icon={<MeetingPageIcon />}
      title={manifest?.title || t('common.productReviewTitle')}
      titleAs="h1"
      description={
        manifest
          ? `${new Date(manifest.createdAt).toLocaleString()} · ${formatDuration(manifest.durationMs)}`
          : t('detail.meta')
      }
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            className="gap-1.5"
          >
            <Download className="h-4 w-4" aria-hidden />
            {t('detail.export')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled
            className="gap-1.5"
          >
            <Share2 className="h-4 w-4" aria-hidden />
            {t('detail.share')}
          </Button>
          {archive && ((!audioDeleted && onDeleteAudio) || onDeleteArchive) ? (
            <Button
              type="button"
              variant="destructive"
              size="sm"
              disabled={deleting}
              className="gap-1.5"
              onClick={openDeleteDialog}
            >
              <Trash2 className="h-4 w-4" aria-hidden />
              {t('detail.delete')}
            </Button>
          ) : null}
        </div>
      }
      testId="meeting-records-detail"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-hidden">
        {!archive ? (
          <MeetingPreviewBanner>
            {t('detail.previewNotice')}
          </MeetingPreviewBanner>
        ) : null}
        {audioDeleted ? (
          <div
            role="status"
            className="flex items-start gap-2 rounded-[12px] border border-foreground/[0.08] bg-foreground/[0.025] px-4 py-3 text-body text-muted-foreground"
          >
            <FileX2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
            <span>{t('detail.audioDeletedNotice')}</span>
          </div>
        ) : null}
        {!archive ||
        manifest?.transcriptionStatus === 'partial' ||
        manifest?.transcriptionStatus === 'failed' ? (
          <MeetingPartialNotice>
            {archive
              ? archive.manifest.transcriptionError ||
                t('detail.transcriptionIncomplete')
              : t('detail.partialNotice')}
          </MeetingPartialNotice>
        ) : null}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 rounded-[12px] bg-foreground/[0.03] px-4 py-3 text-body dark:bg-foreground/[0.04]">
          <span className="inline-flex items-center gap-1.5">
            <Clock3 className="h-4 w-4 text-muted-foreground" aria-hidden />
            {manifest ? formatDuration(manifest.durationMs) : '43:28'}
          </span>
          {!manifest ? (
            <span className="inline-flex items-center gap-1.5">
              <Users className="h-4 w-4 text-muted-foreground" aria-hidden />
              {t('detail.participants')}
            </span>
          ) : null}
          <span className="inline-flex items-center gap-1.5">
            <FolderKanban
              className="h-4 w-4 text-muted-foreground"
              aria-hidden
            />
            {manifest ? projectDisplayName : t('detail.meetingCapability')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            {audioDeleted ? (
              <FileX2 className="h-4 w-4 text-muted-foreground" aria-hidden />
            ) : (
              <CheckCircle2 className="h-4 w-4 text-success" aria-hidden />
            )}
            {audioDeleted
              ? t('detail.audioDeletedStatus')
              : tracksComplete || !manifest
                ? t('detail.originalComplete')
                : t('detail.originalIncomplete')}
          </span>
        </div>

        <TabsRoot
          defaultValue="overview"
          className="flex min-h-0 flex-1 flex-col"
        >
          <TabsList
            aria-label={t('detail.tabsAria')}
            className="shrink-0 self-start"
          >
            <TabsTrigger value="overview">
              <CircleDot className="mr-1.5 h-4 w-4" aria-hidden />
              {t('detail.tabOverview')}
            </TabsTrigger>
            <TabsTrigger value="transcript">
              <FileText className="mr-1.5 h-4 w-4" aria-hidden />
              {t('detail.tabTranscriptRecording')}
            </TabsTrigger>
            <TabsTrigger value="copilot">
              <Bot className="mr-1.5 h-4 w-4" aria-hidden />
              {t('detail.tabCopilot')}
            </TabsTrigger>
            <TabsTrigger value="resources">
              <ListChecks className="mr-1.5 h-4 w-4" aria-hidden />
              {t('detail.tabResources')}
            </TabsTrigger>
          </TabsList>
          <TabsContent
            value="overview"
            className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hover"
          >
            <OverviewTab archive={archive} />
          </TabsContent>
          <TabsContent
            value="transcript"
            className="mt-4 min-h-0 flex-1 overflow-hidden data-[state=active]:flex"
          >
            <TranscriptRecordingTab archive={archive} />
          </TabsContent>
          <TabsContent
            value="copilot"
            className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hover"
          >
            <CopilotTab archive={archive} />
          </TabsContent>
          <TabsContent
            value="resources"
            className="mt-4 min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hover"
          >
            <ResourcesTab
              archive={archive}
              projectDisplayName={projectDisplayName}
            />
          </TabsContent>
        </TabsRoot>
      </div>
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={(open) => {
          if (!deleting) setDeleteDialogOpen(open);
        }}
        title={t('detail.deleteChoiceTitle')}
        description={t('detail.deleteChoiceDescription')}
        confirmText={
          deleteTarget === 'audio'
            ? t('detail.deleteAudioConfirmAction')
            : t('detail.deleteMeetingConfirmAction')
        }
        cancelText={t('setup.cancel')}
        variant="destructive"
        isLoading={deleting}
        onConfirm={confirmDelete}
      >
        <RadioGroup
          value={deleteTarget}
          onValueChange={(value) => {
            setDeleteError('');
            setDeleteTarget(value as 'audio' | 'archive');
          }}
          aria-label={t('detail.deleteChoiceLabel')}
          className="gap-2"
        >
          {!audioDeleted && onDeleteAudio ? (
            <label
              htmlFor="meeting-delete-audio"
              className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-foreground/[0.1] px-3.5 py-3 transition-colors hover:bg-foreground/[0.035]"
            >
              <RadioGroupItem
                id="meeting-delete-audio"
                value="audio"
                className="mt-0.5 shrink-0"
              />
              <span className="space-y-1">
                <span className="block text-body font-medium text-foreground">
                  {t('detail.deleteAudio')}
                </span>
                <span className="block text-small leading-5 text-muted-foreground">
                  {t('detail.deleteAudioConfirmDescription')}
                </span>
              </span>
            </label>
          ) : null}
          {onDeleteArchive ? (
            <label
              htmlFor="meeting-delete-archive"
              className="flex cursor-pointer items-start gap-3 rounded-[12px] border border-destructive/20 px-3.5 py-3 transition-colors hover:bg-destructive/[0.04]"
            >
              <RadioGroupItem
                id="meeting-delete-archive"
                value="archive"
                className="mt-0.5 shrink-0"
              />
              <span className="space-y-1">
                <span className="block text-body font-medium text-destructive">
                  {t('detail.deleteMeeting')}
                </span>
                <span className="block text-small leading-5 text-muted-foreground">
                  {t('detail.deleteMeetingConfirmDescription')}
                </span>
              </span>
            </label>
          ) : null}
        </RadioGroup>
        {deleteError ? (
          <p role="alert" className="text-body text-destructive">
            {deleteError}
          </p>
        ) : null}
      </ConfirmDialog>
    </StandaloneModulePage>
  );
};
