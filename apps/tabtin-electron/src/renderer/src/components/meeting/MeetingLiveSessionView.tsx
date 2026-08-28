import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ChevronUp,
  Mic2,
  RefreshCw,
  Sparkles,
  Square,
  Volume2,
} from 'lucide-react';

import {
  Button,
  ConfirmDialog,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Switch,
  toast,
} from '@components/ui';
import type {
  MeetingMicrophoneDevice,
  MeetingCopilotAnswerResult,
  MeetingCopilotRecord,
  MeetingCaptureSourceNoticeEvent,
  MeetingRecordingStatus,
  MeetingSystemAudioSource,
  MeetingTranscriptCheckpoint,
  MeetingTranscriptChangedEvent,
} from '@shared/meeting-recording-contract';
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage';
import { useIdentityLabels } from '@components/layout/useIdentityLabels';
import { createLogger } from '@/utils/logger';
import {
  MeetingPageIcon,
  MeetingPreviewBanner,
  MeetingSection,
  MeetingTranscriptTurn,
} from './meetingUi';
import { MEETING_LIVE_PREVIEW_ID } from './meetingViewNavigation';
import { MeetingCopilotHistory } from './MeetingCopilotHistory';
import {
  formatMeetingTranscriptTime,
  groupMeetingTranscriptTurns,
  resolveMeetingTranscript,
  upsertMeetingTranscript,
} from './meetingTranscript';

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(durationMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}

const AUDIO_LEVEL_IDLE_TIMEOUT_MS = 450;
const log = createLogger('MeetingLive');

const MeetingAudioLevelGlyph: React.FC<{
  source: 'local' | 'remote';
  rms: number;
  active: boolean;
  failed: boolean;
}> = ({ source, rms, active, failed }) => {
  const normalizedLevel = active ? Math.min(1, Math.max(0, rms) * 8) : 0;
  const toneClass = failed
    ? 'text-destructive'
    : active
      ? 'text-primary'
      : 'text-muted-foreground';
  const barWeights = [0.55, 1, 0.72];

  return (
    <span
      className={`flex h-4 w-5 items-center justify-center gap-[2px] ${toneClass}`}
      data-testid={`meeting-audio-level-${source}`}
      data-rms={rms.toFixed(3)}
      aria-hidden
    >
      {source === 'local' ? (
        <Mic2 className="h-3.5 w-3.5 shrink-0" />
      ) : (
        <Volume2 className="h-3.5 w-3.5 shrink-0" />
      )}
      <span className="flex h-3 w-[5px] shrink-0 items-center justify-between">
        {barWeights.map((weight, index) => (
          <span
            // The bars move only when the PCM capture reports a new RMS value.
            key={index}
            className="w-px rounded-full bg-current transition-[height] duration-100 motion-reduce:transition-none"
            style={{ height: `${3 + normalizedLevel * 9 * weight}px` }}
          />
        ))}
      </span>
    </span>
  );
};

export const MeetingLiveSessionView: React.FC<{
  sessionId: string;
  onBack: () => void;
  initialStatus?: MeetingRecordingStatus | null;
}> = ({ sessionId, onBack, initialStatus = null }) => {
  const { t } = useTranslation('meeting');
  const { user, displayName } = useIdentityLabels();
  const localSpeakerName = displayName || t('common.speakerMe');
  const [copilotEnabled, setCopilotEnabled] = React.useState(false);
  const [copilotAnswer, setCopilotAnswer] =
    React.useState<MeetingCopilotAnswerResult | null>(null);
  const [copilotRecords, setCopilotRecords] = React.useState<
    MeetingCopilotRecord[]
  >([]);
  const [copilotAnswerPending, setCopilotAnswerPending] = React.useState(false);
  const [copilotRequestedQuestion, setCopilotRequestedQuestion] =
    React.useState<MeetingTranscriptCheckpoint | null>(null);
  const copilotAnswerPendingRef = React.useRef(false);
  const evaluatedCopilotTurnsRef = React.useRef(new Set<string>());
  const [runtimeStatus, setRuntimeStatus] =
    React.useState<MeetingRecordingStatus | null>(initialStatus);
  const [controlError, setControlError] = React.useState<string | null>(null);
  const [stopConfirmationOpen, setStopConfirmationOpen] = React.useState(false);
  const [stopping, setStopping] = React.useState(false);
  const [stopError, setStopError] = React.useState<string | null>(null);
  const [transcript, setTranscript] = React.useState<
    MeetingTranscriptCheckpoint[]
  >([]);
  const [displayDurationMs, setDisplayDurationMs] = React.useState(0);
  const [microphones, setMicrophones] = React.useState<
    MeetingMicrophoneDevice[]
  >([]);
  const [systemAudioSources, setSystemAudioSources] = React.useState<
    MeetingSystemAudioSource[]
  >([]);
  const [switchingSource, setSwitchingSource] = React.useState<
    'local' | 'remote' | null
  >(null);
  const [sourceSwitchError, setSourceSwitchError] = React.useState<
    'local' | 'remote' | 'list' | null
  >(null);
  const [captureSourceNotice, setCaptureSourceNotice] =
    React.useState<MeetingCaptureSourceNoticeEvent | null>(null);
  const [captureLevels, setCaptureLevels] = React.useState({
    local: 0,
    remote: 0,
  });
  const captureLevelTimersRef = React.useRef<
    Partial<Record<'local' | 'remote', number>>
  >({});
  const displaySessionIdRef = React.useRef<string | undefined>(undefined);
  const transcriptScrollRef = React.useRef<HTMLDivElement | null>(null);
  const transcriptAutoFollowRef = React.useRef(true);
  const isPreview = sessionId === MEETING_LIVE_PREVIEW_ID;

  React.useEffect(() => {
    if (isPreview) return;
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge) return;
    let cancelled = false;
    void bridge.getStatus().then((status) => {
      if (!cancelled && status.manifest?.sessionId === sessionId) {
        setRuntimeStatus(status);
      }
    });
    const unsubscribe = bridge.onStatusChanged((status) => {
      if (status.manifest?.sessionId === sessionId) setRuntimeStatus(status);
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [isPreview, sessionId]);

  const manifest = runtimeStatus?.manifest ?? null;
  const manifestSessionId = manifest?.sessionId;
  const manifestOrganizationId = manifest?.organizationId;
  const manifestUserId = manifest?.userId;
  const manifestDurationMs = manifest?.durationMs;
  const manifestStartedAt = manifest?.startedAt;
  const scope = React.useMemo(
    () =>
      manifestSessionId && manifestOrganizationId && manifestUserId
        ? {
            sessionId: manifestSessionId,
            organizationId: manifestOrganizationId,
            userId: manifestUserId,
          }
        : null,
    [manifestOrganizationId, manifestSessionId, manifestUserId],
  );
  const lifecycleStatus = manifest?.lifecycleStatus ?? 'recording';
  const resolvedTranscript = React.useMemo(
    () => resolveMeetingTranscript(transcript),
    [transcript],
  );
  const visibleTranscript = React.useMemo(
    () => groupMeetingTranscriptTurns(resolvedTranscript),
    [resolvedTranscript],
  );
  const latestTranscriptTurn = resolvedTranscript.at(-1) ?? null;
  const latestRemoteCompleteTurn =
    [...resolvedTranscript]
      .reverse()
      .find(
        (checkpoint) => checkpoint.isFinal && checkpoint.source === 'remote',
      ) ?? null;

  React.useEffect(() => {
    const container = transcriptScrollRef.current;
    if (!container || !transcriptAutoFollowRef.current) return;
    container.scrollTop = container.scrollHeight;
  }, [visibleTranscript]);

  React.useEffect(() => {
    if (displaySessionIdRef.current === manifestSessionId) return;
    displaySessionIdRef.current = manifestSessionId;
    setDisplayDurationMs(manifestDurationMs ?? 0);
  }, [manifestDurationMs, manifestSessionId]);

  React.useEffect(() => {
    if (manifestDurationMs === undefined) return;
    setDisplayDurationMs((current) => Math.max(current, manifestDurationMs));
  }, [manifestDurationMs, manifestSessionId]);

  React.useEffect(() => {
    if (isPreview || !manifestSessionId || lifecycleStatus !== 'recording')
      return;
    const timer = window.setInterval(() => {
      setDisplayDurationMs((current) => current + 1_000);
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [isPreview, lifecycleStatus, manifestSessionId]);

  const manifestCopilotEnabled = manifest?.copilotEnabled;
  React.useEffect(() => {
    if (manifestCopilotEnabled !== undefined) {
      setCopilotEnabled(manifestCopilotEnabled);
    }
  }, [manifestCopilotEnabled]);

  React.useEffect(() => {
    if (
      !manifestSessionId ||
      !manifestOrganizationId ||
      !manifestUserId ||
      isPreview
    )
      return;
    const activeScope = {
      sessionId: manifestSessionId,
      organizationId: manifestOrganizationId,
      userId: manifestUserId,
    };
    const bridge = window.tabtin.meetingRecording;
    let cancelled = false;
    setTranscript([]);
    const unsubscribe = bridge.onTranscriptChanged(
      (event: MeetingTranscriptChangedEvent) => {
        if (
          event.sessionId !== activeScope.sessionId ||
          event.organizationId !== activeScope.organizationId ||
          event.userId !== activeScope.userId
        ) {
          return;
        }
        const displayedAtMs = Date.now();
        const asrReceivedAtMs = Date.parse(event.checkpoint.recordedAt);
        const meetingStartedAtMs = manifestStartedAt
          ? Date.parse(manifestStartedAt)
          : Number.NaN;
        log.debug('transcript_latency', {
          source: event.checkpoint.source,
          isFinal: event.checkpoint.isFinal,
          externalId: event.checkpoint.externalId,
          asrToUiMs: Number.isFinite(asrReceivedAtMs)
            ? Math.max(0, displayedAtMs - asrReceivedAtMs)
            : null,
          captureToAsrMs:
            Number.isFinite(asrReceivedAtMs) &&
            Number.isFinite(meetingStartedAtMs)
              ? asrReceivedAtMs -
                (meetingStartedAtMs + event.checkpoint.endMs)
              : null,
        });
        setTranscript((current) =>
          upsertMeetingTranscript(current, event.checkpoint),
        );
      },
    );
    void bridge
      .getArchive(activeScope)
      .then((archive) => {
        if (cancelled) return;
        setTranscript((current) =>
          upsertMeetingTranscript(archive.transcript, current),
        );
        const nextCopilotRecords = archive.copilotRecords ?? [];
        setCopilotRecords((current) => {
          const merged = new Map(
            nextCopilotRecords.map((record) => [
              record.questionSegmentId,
              record,
            ]),
          );
          for (const record of current) {
            merged.set(record.questionSegmentId, record);
          }
          return [...merged.values()];
        });
        for (const record of nextCopilotRecords) {
          evaluatedCopilotTurnsRef.current.add(record.questionSegmentId);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [
    isPreview,
    manifestOrganizationId,
    manifestSessionId,
    manifestStartedAt,
    manifestUserId,
  ]);

  React.useEffect(() => {
    const bridge = window.tabtin?.meetingRecording;
    if (
      !manifestSessionId ||
      !manifestOrganizationId ||
      !manifestUserId ||
      isPreview ||
      !bridge?.onCaptureLevel
    )
      return;
    const timers = captureLevelTimersRef.current;
    const unsubscribe = bridge.onCaptureLevel((event) => {
      if (
        event.sessionId !== manifestSessionId ||
        event.organizationId !== manifestOrganizationId ||
        event.userId !== manifestUserId
      )
        return;
      const source = event.source;
      const rms = Math.min(1, Math.max(0, event.rms));
      setCaptureLevels((current) => ({ ...current, [source]: rms }));
      const existingTimer = timers[source];
      if (existingTimer !== undefined) window.clearTimeout(existingTimer);
      timers[source] = window.setTimeout(() => {
        setCaptureLevels((current) => ({ ...current, [source]: 0 }));
        delete timers[source];
      }, AUDIO_LEVEL_IDLE_TIMEOUT_MS);
    });
    return () => {
      unsubscribe();
      for (const timer of Object.values(timers)) {
        if (timer !== undefined) window.clearTimeout(timer);
      }
      captureLevelTimersRef.current = {};
    };
  }, [isPreview, manifestOrganizationId, manifestSessionId, manifestUserId]);

  React.useEffect(() => {
    if (lifecycleStatus === 'recording') return;
    setCaptureLevels({ local: 0, remote: 0 });
  }, [lifecycleStatus]);

  React.useEffect(() => {
    if (
      !manifestSessionId ||
      !manifestOrganizationId ||
      !manifestUserId ||
      isPreview
    )
      return;
    let cancelled = false;
    const bridge = window.tabtin.meetingRecording;
    let refreshGeneration = 0;
    const refreshCaptureDevices = () => {
      const generation = ++refreshGeneration;
    void Promise.all([
      bridge.listMicrophones(),
      bridge.listSystemAudioSources(),
    ])
      .then(([nextMicrophones, nextSystemAudioSources]) => {
          if (cancelled || generation !== refreshGeneration) return;
          setMicrophones(nextMicrophones);
          setSystemAudioSources(nextSystemAudioSources);
          setSourceSwitchError((current) =>
            current === 'list' ? null : current,
          );
      })
        .catch(() => {
          if (!cancelled && generation === refreshGeneration) {
            setSourceSwitchError('list');
        }
      });
    };
    refreshCaptureDevices();
    const unsubscribeDevices = bridge.onCaptureDevicesChanged(() => {
      refreshCaptureDevices();
    });
    const unsubscribeNotice = bridge.onCaptureSourceNotice((notice) => {
      if (
        notice.sessionId !== manifestSessionId ||
        notice.organizationId !== manifestOrganizationId ||
        notice.userId !== manifestUserId
      ) {
        return;
      }
      setCaptureSourceNotice(notice);
    });
    return () => {
      cancelled = true;
      unsubscribeDevices();
      unsubscribeNotice();
    };
  }, [isPreview, manifestOrganizationId, manifestSessionId, manifestUserId]);
  const stopRecording = async () => {
    if (!scope || stopping) return;
    setStopping(true);
    setStopError(null);
    setControlError(null);
    try {
      const next = await window.tabtin.meetingRecording.stop(scope);
      setRuntimeStatus(next);
      toast({ title: t('live.endSuccess') });
      onBack();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setStopError(message);
      setControlError(message);
      throw error;
    } finally {
      setStopping(false);
    }
  };

  const setCopilot = async (enabled: boolean) => {
    if (isPreview || !scope) {
      setCopilotEnabled(enabled);
      return;
    }
    setControlError(null);
    try {
      const next = await window.tabtin.meetingRecording.setCopilotEnabled(
        scope,
        enabled,
      );
      setRuntimeStatus(next);
      setCopilotEnabled(enabled);
    } catch (error) {
      setControlError(error instanceof Error ? error.message : String(error));
    }
  };

  const answerCopilotQuestion = React.useCallback(
    async (
    question: MeetingTranscriptCheckpoint,
    options: { retry?: boolean } = {},
  ) => {
    if (
      !scope ||
      isPreview ||
      copilotAnswerPendingRef.current ||
      !question.isFinal
    )
      return;
      if (
        !options.retry &&
        evaluatedCopilotTurnsRef.current.has(question.externalId)
      ) {
      return;
    }
    evaluatedCopilotTurnsRef.current.add(question.externalId);
    copilotAnswerPendingRef.current = true;
    setCopilotRequestedQuestion(question);
    setCopilotAnswerPending(true);
    try {
      const answer =
        await window.tabtin.meetingRecording.answerCopilotQuestion(
          scope,
          question.externalId,
        );
      setCopilotAnswer(answer);
      if (answer.status === 'answered' || answer.status === 'no_action') {
        setCopilotRecords((current) => [
          ...current.filter(
            (record) => record.questionSegmentId !== question.externalId,
          ),
          {
            questionSegmentId: question.externalId,
            evaluatedAt: new Date().toISOString(),
            result: answer,
          },
        ]);
      }
    } catch (error) {
      setCopilotAnswer({
        status: 'failed',
        error_code: 'request_failed',
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      copilotAnswerPendingRef.current = false;
      setCopilotAnswerPending(false);
      setCopilotRequestedQuestion(null);
    }
    },
    [isPreview, scope],
  );

  React.useEffect(() => {
    if (
      !copilotEnabled ||
      !latestRemoteCompleteTurn ||
      copilotAnswerPending ||
      isPreview ||
      !scope
    )
      return;
    if (
      evaluatedCopilotTurnsRef.current.has(latestRemoteCompleteTurn.externalId)
    ) {
      return;
    }
    const timer = window.setTimeout(() => {
      void answerCopilotQuestion(latestRemoteCompleteTurn);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [
    answerCopilotQuestion,
    copilotAnswerPending,
    copilotEnabled,
    isPreview,
    latestRemoteCompleteTurn,
    scope,
  ]);

  const switchCaptureSource = async (
    source: 'local' | 'remote',
    sourceId: string,
  ) => {
    if (!scope || isPreview || switchingSource) return;
    setSourceSwitchError(null);
    setCaptureSourceNotice(null);
    setSwitchingSource(source);
    try {
      const bridge = window.tabtin.meetingRecording;
      const next = await (source === 'local'
          ? bridge.switchMicrophone({ ...scope, deviceId: sourceId })
        : bridge.switchSystemAudio({ ...scope, sourceId }));
      setRuntimeStatus(next);
    } catch {
      setSourceSwitchError(source);
    } finally {
      setSwitchingSource(null);
    }
  };

  const trackTone = (source: 'local' | 'remote') => {
    const status = manifest?.tracks[source].status;
    if (status === 'failed' || status === 'missing') return 'failed' as const;
    if (status === 'interrupted') return 'warning' as const;
    return 'healthy' as const;
  };
  const audioSourceActions = (
    <div
      className="flex items-center gap-1"
      aria-label={t('live.audioSources')}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="relative h-8 w-8"
            disabled={!scope || switchingSource === 'local'}
            aria-label={t('live.changeMicrophone')}
            onClick={() => setSourceSwitchError(null)}
            title={manifest?.microphoneDeviceLabel || t('setup.systemDefault')}
          >
            {switchingSource === 'local' ? (
              <RefreshCw
                className="h-4 w-4 animate-spin text-warning motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <MeetingAudioLevelGlyph
                source="local"
                rms={captureLevels.local}
                active={
                  lifecycleStatus === 'recording' &&
                  trackTone('local') === 'healthy'
                }
                failed={trackTone('local') === 'failed'}
              />
            )}
            <ChevronUp
              className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 text-muted-foreground"
              aria-hidden
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" className="w-72">
          <DropdownMenuLabel>{t('common.microphone')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={manifest?.microphoneDeviceId || 'default'}
            onValueChange={(deviceId) =>
              void switchCaptureSource('local', deviceId)
            }
          >
            {(microphones.length > 0
              ? microphones
              : [
                  {
                    deviceId: 'default',
                    groupId: '',
                    label:
                      manifest?.microphoneDeviceLabel ||
                      t('setup.systemDefault'),
                    isDefault: true,
                  },
                ]
            ).map((device) => (
              <DropdownMenuRadioItem
                key={device.deviceId}
                value={device.deviceId}
              >
                {device.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="relative h-8 w-8"
            disabled={!scope || switchingSource === 'remote'}
            aria-label={t('live.changeSystemAudio')}
            onClick={() => setSourceSwitchError(null)}
            title={t('live.mainDisplayAudio')}
          >
            {switchingSource === 'remote' ? (
              <RefreshCw
                className="h-4 w-4 animate-spin text-warning motion-reduce:animate-none"
                aria-hidden
              />
            ) : (
              <MeetingAudioLevelGlyph
                source="remote"
                rms={captureLevels.remote}
                active={
                  lifecycleStatus === 'recording' &&
                  trackTone('remote') === 'healthy'
                }
                failed={trackTone('remote') === 'failed'}
              />
            )}
            <ChevronUp
              className="absolute bottom-0.5 right-0.5 h-2.5 w-2.5 text-muted-foreground"
              aria-hidden
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="end" className="w-72">
          <DropdownMenuLabel>{t('common.systemAudio')}</DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={manifest?.systemAudioSourceId || 'main-display'}
            onValueChange={(sourceId) =>
              void switchCaptureSource('remote', sourceId)
            }
          >
            {(systemAudioSources.length > 0
              ? systemAudioSources
              : [
                  {
                    sourceId: 'main-display',
                    label: t('live.mainDisplayAudio'),
                    isDefault: true,
                  },
                ]
            ).map((source) => (
              <DropdownMenuRadioItem
                key={source.sourceId}
                value={source.sourceId}
              >
                {source.sourceId === 'main-display'
                  ? t('live.mainDisplayAudio')
                  : source.label}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() =>
              void switchCaptureSource(
                'remote',
                manifest?.systemAudioSourceId || 'main-display',
              )
            }
          >
            <RefreshCw className="mr-2 h-4 w-4" aria-hidden />
            {t('live.reconnectSystemAudio')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
  return (
    <>
      <StandaloneModulePage
      icon={<MeetingPageIcon />}
      title={manifest?.title || t('common.productReviewTitle')}
      titleAs="h1"
      description={
        manifest
          ? t('live.runtimeDescription', {
              duration: formatDuration(displayDurationMs),
            })
          : t('live.description')
      }
      actions={
        <div className="flex items-center gap-2">
          {audioSourceActions}
          <span className="mx-0.5 h-5 w-px bg-foreground/[0.1]" aria-hidden />
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={isPreview || !scope || stopping}
            className="gap-1.5"
            onClick={() => {
              setStopError(null);
              setStopConfirmationOpen(true);
            }}
          >
            <Square className="h-3.5 w-3.5" aria-hidden />
            {t('live.end')}
          </Button>
        </div>
      }
      testId="meeting-records-live"
    >
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-hidden">
        <div className="contents">
          {isPreview ? (
            <MeetingPreviewBanner>
              {t('live.previewNotice')}
            </MeetingPreviewBanner>
          ) : null}

          {controlError ? (
            <p role="alert" className="text-body text-destructive">
              {controlError}
            </p>
          ) : null}
          {sourceSwitchError ? (
            <p role="alert" className="text-caption text-destructive">
                {sourceSwitchError === 'local'
                  ? t('live.microphoneSwitchFailedPreserved')
                  : sourceSwitchError === 'remote'
                    ? t('live.systemAudioSwitchFailedPreserved')
                    : t('live.audioSourceListFailed')}
              </p>
            ) : null}
            {captureSourceNotice ? (
              <p
                role={
                  captureSourceNotice.kind === 'fallback_failed'
                    ? 'alert'
                    : 'status'
                }
                className={`text-caption ${
                  captureSourceNotice.kind === 'fallback_failed'
                    ? 'text-destructive'
                    : 'text-success'
                }`}
              >
                {captureSourceNotice.source === 'local'
                  ? captureSourceNotice.kind === 'fallback_succeeded'
                    ? t('live.microphoneFallbackSucceeded', {
                        device: captureSourceNotice.currentLabel,
                      })
                    : t('live.microphoneFallbackFailed')
                  : captureSourceNotice.kind === 'fallback_succeeded'
                    ? t('live.systemAudioFallbackSucceeded', {
                        source: captureSourceNotice.currentLabel,
                      })
                    : t('live.systemAudioFallbackFailed')}
            </p>
          ) : null}

          <div className="grid min-h-0 flex-1 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(320px,0.75fr)]">
            <MeetingSection
              title={t('live.transcriptTitle')}
              description={t('live.transcriptDescription')}
              className="flex min-h-0 flex-col bg-background"
              contentClassName="flex min-h-0 flex-1 flex-col"
            >
              {!isPreview && manifest?.transcriptionStatus === 'failed' ? (
                <div className="mb-2 shrink-0 rounded-interactive bg-destructive/5 px-3 py-2 text-caption text-destructive">
                  {manifest.transcriptionError ||
                    t('live.runtimeTranscriptEmpty')}
                </div>
              ) : null}
              {isPreview ? (
                <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-foreground/[0.06] pr-1 scrollbar-hover dark:divide-foreground/[0.08]">
                  <MeetingTranscriptTurn
                    speaker={t('common.speakerOther')}
                    speakerId="meeting-remote"
                    time="00:21:42"
                  >
                    {t('live.questionOne')}
                  </MeetingTranscriptTurn>
                  <MeetingTranscriptTurn
                    speaker={localSpeakerName}
                    speakerId={user?.id}
                    avatarUrl={user?.avatar}
                    time="00:21:51"
                  >
                    {t('live.answerOne')}
                  </MeetingTranscriptTurn>
                  <MeetingTranscriptTurn
                    speaker={t('common.speakerOther')}
                    speakerId="meeting-remote"
                    time="00:22:16"
                  >
                    {t('live.questionTwo')}
                  </MeetingTranscriptTurn>
                  <MeetingTranscriptTurn
                    speaker={localSpeakerName}
                    speakerId={user?.id}
                    avatarUrl={user?.avatar}
                    time="00:22:29"
                    pending
                  >
                    {t('live.answerTwo')}
                  </MeetingTranscriptTurn>
                </div>
              ) : visibleTranscript.length > 0 ? (
                <div
                  ref={transcriptScrollRef}
                  className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hover"
                  onScroll={(event) => {
                    const container = event.currentTarget;
                    transcriptAutoFollowRef.current =
                      container.scrollHeight -
                        container.scrollTop -
                        container.clientHeight <
                      64;
                  }}
                >
                  <div className="divide-y divide-foreground/[0.06] dark:divide-foreground/[0.08]">
                    {visibleTranscript.map((checkpoint) => (
                      <MeetingTranscriptTurn
                        key={`${checkpoint.source}:${checkpoint.externalId}`}
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
                      >
                        {checkpoint.text}
                      </MeetingTranscriptTurn>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="min-h-0 flex-1 rounded-[12px] border border-foreground/[0.06] bg-foreground/[0.025] px-4 py-4 text-body leading-6 text-muted-foreground dark:border-foreground/[0.08] dark:bg-foreground/[0.035]">
                  {manifest?.transcriptionStatus === 'failed'
                    ? t('live.transcriptAudioContinues')
                    : manifest?.transcriptionStatus === 'connecting' ||
                        manifest?.transcriptionStatus === 'recovering'
                      ? t('live.transcriptPending')
                      : t('live.waitingForSpeech')}
                </div>
              )}
            </MeetingSection>

            <MeetingSection
              title={t('common.meetingCopilot')}
              description={t('live.copilotDescription')}
              className="flex min-h-0 flex-col bg-background"
              contentClassName="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hover"
            >
              <div className="space-y-4">
                <div className="flex items-center justify-between gap-4 rounded-[12px] border border-foreground/[0.06] bg-background px-4 py-3 dark:border-foreground/[0.08]">
                  <div className="min-w-0">
                    <p className="text-body font-medium text-foreground">
                      {copilotEnabled
                        ? copilotAnswerPending
                          ? t('live.copilotUnderstanding')
                          : t('live.copilotReady')
                        : t('live.copilotDisabled')}
                    </p>
                    <p className="mt-0.5 text-caption leading-5 text-muted-foreground">
                      {copilotEnabled
                        ? t('live.copilotReadyDetail')
                        : t('live.copilotToggleDescription')}
                    </p>
                  </div>
                  <Switch
                    checked={copilotEnabled}
                    onCheckedChange={(enabled) => void setCopilot(enabled)}
                    aria-label={t('live.copilotToggleAria')}
                  />
                </div>

                {copilotEnabled ? (
                  <>
                    <div className="rounded-[12px] border border-foreground/[0.06] bg-foreground/[0.025] p-4 dark:border-foreground/[0.08] dark:bg-foreground/[0.035]">
                      <p className="text-caption font-medium text-muted-foreground">
                        {t('live.currentContext')}
                      </p>
                      <p className="mt-1 text-body font-medium leading-6 text-foreground">
                        {isPreview
                          ? t('live.question')
                          : latestTranscriptTurn?.text ||
                            t('live.waitingForSpeech')}
                      </p>
                      {!isPreview &&
                      latestTranscriptTurn &&
                      !latestTranscriptTurn.isFinal ? (
                        <p className="mt-2 text-caption text-muted-foreground">
                          {t('live.listening')}
                        </p>
                      ) : null}
                    </div>

                    <Button
                      type="button"
                      className="w-full gap-2"
                      disabled={
                        isPreview ||
                        !scope ||
                        !latestRemoteCompleteTurn ||
                        copilotAnswerPending
                      }
                      onClick={() => {
                        if (latestRemoteCompleteTurn) {
                            void answerCopilotQuestion(
                              latestRemoteCompleteTurn,
                              {
                            retry: true,
                              },
                            );
                        }
                      }}
                    >
                      {copilotAnswerPending ? (
                        <RefreshCw
                          className="h-4 w-4 animate-spin motion-reduce:animate-none"
                          aria-hidden
                        />
                      ) : (
                        <Sparkles className="h-4 w-4" aria-hidden />
                      )}
                      {copilotAnswerPending
                        ? t('live.understandingContext')
                        : t('live.analyzeNow')}
                    </Button>

                    {copilotAnswerPending && copilotRequestedQuestion ? (
                      <div className="rounded-[12px] border border-accent/15 bg-accent/5 px-4 py-3">
                        <p className="text-caption font-medium text-accent-text">
                          {t('live.understandingContext')}
                        </p>
                        <p className="mt-1 text-body leading-6 text-foreground">
                          {copilotRequestedQuestion.text}
                        </p>
                        <p className="mt-2 text-caption text-muted-foreground">
                          {t('live.recordingContinues')}
                        </p>
                      </div>
                    ) : null}

                    <MeetingCopilotHistory records={copilotRecords} />

                    {copilotAnswer &&
                    copilotAnswer.status !== 'answered' &&
                    copilotAnswer.status !== 'no_action' ? (
                      <div
                        role={
                          copilotAnswer.status === 'failed'
                            ? 'alert'
                            : undefined
                        }
                        className={`rounded-[12px] border px-4 py-4 text-body leading-6 ${
                          copilotAnswer.status === 'failed'
                            ? 'border-destructive/15 bg-destructive/5 text-destructive'
                            : 'border-foreground/[0.06] bg-foreground/[0.025] text-muted-foreground'
                        }`}
                      >
                        {copilotAnswer.message}
                        <p className="mt-1 text-caption opacity-80">
                          {t('live.recordingContinues')}
                        </p>
                      </div>
                    ) : null}
                  </>
                ) : (
                  <div className="rounded-[12px] border border-foreground/[0.06] bg-foreground/[0.025] px-4 py-5 text-body leading-6 text-muted-foreground dark:border-foreground/[0.08] dark:bg-foreground/[0.035]">
                    {t('live.copilotDisabledNotice')}
                  </div>
                )}
              </div>
            </MeetingSection>
          </div>
        </div>
      </div>
      </StandaloneModulePage>
      <ConfirmDialog
        open={stopConfirmationOpen}
        onOpenChange={(open) => {
          if (!stopping) setStopConfirmationOpen(open);
        }}
        title={t('live.endConfirmTitle')}
        description={
          stopping
            ? t('live.endingDescription')
            : t('live.endConfirmDescription')
        }
        confirmText={t('live.endConfirmAction')}
        cancelText={t('setup.cancel')}
        variant="destructive"
        isLoading={stopping}
        onConfirm={stopRecording}
      >
        {stopping ? (
          <div
            role="status"
            className="flex items-center gap-2 rounded-lg bg-foreground/[0.035] px-3 py-2 text-body text-muted-foreground"
          >
            <RefreshCw
              className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none"
              aria-hidden
            />
            {t('live.endingStatus')}
          </div>
        ) : stopError ? (
          <p role="alert" className="text-body text-destructive">
            {stopError}
          </p>
        ) : null}
      </ConfirmDialog>
    </>
  );
};
