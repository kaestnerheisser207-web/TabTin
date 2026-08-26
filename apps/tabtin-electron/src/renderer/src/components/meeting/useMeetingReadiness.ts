import React from 'react';

import type {
  MeetingAsrProbeResult,
  MeetingMediaSourceProbe,
  MeetingMicrophoneDevice,
  MeetingStorageProbeResult,
  MeetingMicrophoneTestResult,
} from '@shared/meeting-recording-contract';

export type MeetingReadinessState = 'idle' | 'checking' | 'ready' | 'failed';

export interface MeetingReadinessSnapshot {
  microphone: MeetingReadinessState;
  systemAudio: MeetingReadinessState;
  localStorage: MeetingReadinessState;
  realtimeTranscript: MeetingReadinessState;
  microphoneDetail: string;
  systemAudioDetail: string;
  storageDetail: string;
  realtimeTranscriptDetail: string;
  errorMessage: string | null;
  microphones: MeetingMicrophoneDevice[];
}

const initialSnapshot: MeetingReadinessSnapshot = {
  microphone: 'idle',
  systemAudio: 'idle',
  localStorage: 'idle',
  realtimeTranscript: 'idle',
  microphoneDetail: '',
  systemAudioDetail: '',
  storageDetail: '',
  realtimeTranscriptDetail: '',
  errorMessage: null,
  microphones: [],
};

function sourceDetail(source: MeetingMediaSourceProbe): string {
  if (!source.available) return source.errorMessage || source.errorName || '';
  return [
    source.deviceLabel,
    source.sampleRate ? `${source.sampleRate} Hz` : '',
    source.channelCount ? `${source.channelCount} ch` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

function storageDetail(storage: MeetingStorageProbeResult): string {
  if (!storage.ok) return storage.errorMessage || storage.errorCode || '';
  if (storage.availableBytes === null) return '';
  const gib = storage.availableBytes / 1024 / 1024 / 1024;
  return `${gib.toFixed(1)} GiB`;
}

function asrDetail(asr: MeetingAsrProbeResult): string {
  if (!asr.ready) return asr.message || asr.reason || '';
  return [asr.provider, asr.wsEndpoint].filter(Boolean).join(' · ');
}

function asrReadinessState(
  asr: MeetingAsrProbeResult | null,
): MeetingReadinessState {
  if (asr?.ready) return 'ready';
  if (!asr || asr.reason === 'gateway_error') return 'checking';
  return 'failed';
}

export function useMeetingReadiness(
  microphoneDeviceId?: string,
  organizationId?: string,
) {
  const [snapshot, setSnapshot] =
    React.useState<MeetingReadinessSnapshot>(initialSnapshot);

  const refresh = React.useCallback(
    async (requestedDeviceId = microphoneDeviceId) => {
      const bridge = window.tabtin?.meetingRecording;
      if (!bridge) {
        setSnapshot({
          ...initialSnapshot,
          microphone: 'failed',
          systemAudio: 'failed',
          localStorage: 'failed',
          realtimeTranscript: 'failed',
          errorMessage: 'Meeting recording runtime is unavailable',
        });
        return;
      }

      setSnapshot((current) => ({
        ...current,
        microphone: 'checking',
        systemAudio: 'checking',
        localStorage: 'checking',
        realtimeTranscript: 'checking',
        errorMessage: null,
      }));
      const [storageResult, mediaResult, asrResult] = await Promise.allSettled([
        bridge.probeStorage(),
        bridge.probeMedia({ microphoneDeviceId: requestedDeviceId }),
        bridge.probeAsr({ organizationId }),
      ]);

      const storage =
        storageResult.status === 'fulfilled' ? storageResult.value : null;
      const media =
        mediaResult.status === 'fulfilled' ? mediaResult.value : null;
      const asr = asrResult.status === 'fulfilled' ? asrResult.value : null;
      setSnapshot({
        microphone: media?.local.available ? 'ready' : 'failed',
        systemAudio: media?.remote.available ? 'ready' : 'failed',
        localStorage: storage?.ok ? 'ready' : 'failed',
        realtimeTranscript: asrReadinessState(asr),
        microphoneDetail: media ? sourceDetail(media.local) : '',
        systemAudioDetail: media ? sourceDetail(media.remote) : '',
        storageDetail: storage ? storageDetail(storage) : '',
        realtimeTranscriptDetail: asr
          ? asrDetail(asr)
          : asrResult.status === 'rejected'
            ? String(asrResult.reason)
            : '',
        errorMessage:
          storageResult.status === 'rejected'
            ? String(storageResult.reason)
            : mediaResult.status === 'rejected'
              ? String(mediaResult.reason)
              : null,
        microphones: media?.microphones ?? [],
      });
    },
    [microphoneDeviceId, organizationId],
  );

  const checkSystemAudio = React.useCallback(async () => {
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge) return;
    setSnapshot((current) => ({
      ...current,
      systemAudio: 'checking',
      errorMessage: null,
    }));
    try {
      const media = await bridge.probeMedia({ sources: ['remote'] });
      setSnapshot((current) => ({
        ...current,
        systemAudio: media.remote.available ? 'ready' : 'failed',
        systemAudioDetail: sourceDetail(media.remote),
        errorMessage: media.remote.available
          ? null
          : media.remote.errorMessage || media.remote.errorName || null,
      }));
    } catch (error) {
      setSnapshot((current) => ({
        ...current,
        systemAudio: 'failed',
        errorMessage: error instanceof Error ? error.message : String(error),
      }));
    }
  }, []);

  const applyMicrophoneTestResult = React.useCallback(
    (result: MeetingMicrophoneTestResult) => {
      setSnapshot((current) => ({
        ...current,
        microphone:
          result.available &&
          result.nonSilentFrames > 0 &&
          result.maxRms >= 0.002
            ? 'ready'
            : 'failed',
        microphoneDetail: result.deviceLabel || current.microphoneDetail,
        errorMessage: result.available
          ? null
          : result.errorMessage || result.errorName || null,
      }));
    },
    [],
  );

  const resetMicrophone = React.useCallback((deviceLabel = '') => {
    setSnapshot((current) => ({
      ...current,
      microphone: 'idle',
      microphoneDetail: deviceLabel,
      errorMessage: null,
    }));
  }, []);

  React.useEffect(() => {
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge) return;
    let cancelled = false;
    let asrRetryTimer: number | null = null;
    const probeAsrUntilSettled = async (): Promise<void> => {
      let asr: MeetingAsrProbeResult | null = null;
      let requestError = '';
      try {
        asr = await bridge.probeAsr({ organizationId });
      } catch (error) {
        requestError = error instanceof Error ? error.message : String(error);
      }
      if (cancelled) return;
      const state = asrReadinessState(asr);
      setSnapshot((current) => ({
        ...current,
        realtimeTranscript: state,
        realtimeTranscriptDetail: asr
          ? asrDetail(asr)
          : requestError || 'realtime transcription gateway is reconnecting',
      }));
      if (state === 'checking') {
        asrRetryTimer = window.setTimeout(() => {
          void probeAsrUntilSettled();
        }, 3_000);
      }
    };
    void probeAsrUntilSettled();
    void Promise.allSettled([
      bridge.probeStorage(),
      bridge.listMicrophones(),
    ]).then(([storageResult, devicesResult]) => {
      if (cancelled) return;
      const storage =
        storageResult.status === 'fulfilled' ? storageResult.value : null;
      setSnapshot((current) => ({
        ...current,
        localStorage: storage?.ok ? 'ready' : 'failed',
        storageDetail: storage ? storageDetail(storage) : '',
        microphones:
          devicesResult.status === 'fulfilled' ? devicesResult.value : [],
        errorMessage:
          storageResult.status === 'rejected'
            ? String(storageResult.reason)
            : devicesResult.status === 'rejected'
              ? String(devicesResult.reason)
              : null,
      }));
    });
    return () => {
      cancelled = true;
      if (asrRetryTimer !== null) window.clearTimeout(asrRetryTimer);
    };
  }, [organizationId]);

  return {
    snapshot,
    refresh,
    checkSystemAudio,
    applyMicrophoneTestResult,
    resetMicrophone,
  };
}
