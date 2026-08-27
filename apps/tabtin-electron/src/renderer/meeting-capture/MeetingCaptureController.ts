import type {
  AppendMeetingAudioChunkInput,
  AppendMeetingPcmChunkInput,
  MeetingArchiveScope,
  MeetingAudioSource,
  MeetingCaptureLevelEvent,
  MeetingCaptureSourceSelection,
  MeetingMediaProbeInput,
  MeetingMediaProbeResult,
  MeetingMicrophoneDevice,
  MeetingMicrophoneTestInput,
  MeetingMicrophoneTestLevelEvent,
  MeetingMicrophoneTestResult,
  MeetingSystemAudioSource,
} from '../../shared/meeting-recording-contract';
import { MeetingPcmCapture } from './MeetingPcmCapture';

const DEFAULT_CHUNK_DURATION_MS = 1_000;
const MIME_TYPE_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm'] as const;
const MAIN_DISPLAY_AUDIO_SOURCE_ID = 'main-display';

type CaptureState = 'idle' | 'recording' | 'stopping';

export interface MeetingCaptureSink {
  appendAudioChunk: (input: AppendMeetingAudioChunkInput) => Promise<unknown>;
  appendPcmChunk: (input: AppendMeetingPcmChunkInput) => Promise<unknown>;
  reportCaptureLevel?: (event: MeetingCaptureLevelEvent) => void;
  reportMicrophoneTestLevel?: (event: MeetingMicrophoneTestLevelEvent) => void;
}

interface MeetingPcmCaptureRuntime {
  start(stream: MediaStream): Promise<void>;
  stop(): Promise<void>;
}

export interface MeetingCaptureControllerOptions {
  mediaDevices?: Pick<
    MediaDevices,
    'getUserMedia' | 'getDisplayMedia' | 'enumerateDevices'
  >;
  mediaRecorderFactory?: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorder;
  mediaStreamFactory?: (tracks: MediaStreamTrack[]) => MediaStream;
  audioContextFactory?: () => AudioContext;
  isTypeSupported?: (mimeType: string) => boolean;
  now?: () => number;
  chunkDurationMs?: number;
  pcmCaptureFactory?: (input: {
    source: MeetingAudioSource;
    onChunk: (bytes: ArrayBuffer) => void;
    onLevel: (level: number) => void;
  }) => MeetingPcmCaptureRuntime;
  sink: MeetingCaptureSink;
}

interface ActiveTrackCapture {
  source: MeetingAudioSource;
  stream: MediaStream;
  recorder: MediaRecorder;
  lastChunkAt: number;
  pendingWrites: Promise<unknown>;
  pendingPcmWrites: Promise<unknown>;
  pcmCapture: MeetingPcmCaptureRuntime;
}

export function chooseMeetingAudioMimeType(
  isTypeSupported: (mimeType: string) => boolean,
): string {
  const supported = MIME_TYPE_CANDIDATES.find(isTypeSupported);
  if (!supported) {
    throw new Error('no supported meeting audio recorder format');
  }
  return supported;
}

function codecFromMimeType(mimeType: string): string {
  return mimeType.includes('opus') ? 'opus' : 'unknown';
}

function describeCaptureFailure(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException) {
    return `${error.name}: ${error.message || 'unknown error'}`;
  }
  if (error && typeof error === 'object') {
    const value = error as { name?: unknown; message?: unknown };
    const name = typeof value.name === 'string' ? value.name.trim() : '';
    const message =
      typeof value.message === 'string' ? value.message.trim() : '';
    if (name || message) return [name, message].filter(Boolean).join(': ');
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Fall through to the final stable message.
    }
  }
  const fallback = String(error);
  return fallback && fallback !== '[object Object]'
    ? fallback
    : 'unknown capture error';
}

function captureFailure(source: string, error: unknown): Error {
  return new Error(`${source} failed: ${describeCaptureFailure(error)}`);
}

export class MeetingCaptureController {
  private readonly mediaDevices: Pick<
    MediaDevices,
    'getUserMedia' | 'getDisplayMedia' | 'enumerateDevices'
  >;
  private readonly mediaRecorderFactory: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorder;
  private readonly isTypeSupported: (mimeType: string) => boolean;
  private readonly mediaStreamFactory: (
    tracks: MediaStreamTrack[],
  ) => MediaStream;
  private readonly audioContextFactory: () => AudioContext;
  private readonly now: () => number;
  private readonly chunkDurationMs: number;
  private readonly sink: MeetingCaptureSink;
  private readonly pcmCaptureFactory: NonNullable<
    MeetingCaptureControllerOptions['pcmCaptureFactory']
  >;
  private state: CaptureState = 'idle';
  private scope: MeetingArchiveScope | null = null;
  private captures: ActiveTrackCapture[] = [];

  constructor(options: MeetingCaptureControllerOptions) {
    this.mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
    this.mediaRecorderFactory =
      options.mediaRecorderFactory ??
      ((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions));
    this.isTypeSupported =
      options.isTypeSupported ??
      MediaRecorder.isTypeSupported.bind(MediaRecorder);
    this.mediaStreamFactory =
      options.mediaStreamFactory ?? ((tracks) => new MediaStream(tracks));
    this.audioContextFactory =
      options.audioContextFactory ?? (() => new AudioContext());
    this.now = options.now ?? (() => performance.now());
    this.chunkDurationMs = options.chunkDurationMs ?? DEFAULT_CHUNK_DURATION_MS;
    this.sink = options.sink;
    this.pcmCaptureFactory =
      options.pcmCaptureFactory ??
      ((input) =>
        new MeetingPcmCapture({
          onChunk: input.onChunk,
          onLevel: input.onLevel,
        }));
  }

  getState(): CaptureState {
    return this.state;
  }

  private microphoneConstraints(deviceId?: string): MediaTrackConstraints {
    const normalizedDeviceId = deviceId?.trim() ?? '';
    const useSpecificDevice =
      normalizedDeviceId.length > 0 && normalizedDeviceId !== 'default';
    return {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(useSpecificDevice
        ? { deviceId: { exact: normalizedDeviceId } }
        : {}),
    };
  }

  private async openMicrophone(deviceId?: string): Promise<MediaStream> {
    const normalizedDeviceId = deviceId?.trim() ?? '';
    const useSpecificDevice =
      normalizedDeviceId.length > 0 && normalizedDeviceId !== 'default';
    try {
      return await this.mediaDevices.getUserMedia({
        audio: this.microphoneConstraints(normalizedDeviceId),
        video: false,
      });
    } catch (error) {
      const value =
        error && typeof error === 'object'
          ? (error as { name?: unknown })
          : null;
      const name = typeof value?.name === 'string' ? value.name : '';
      if (
        !useSpecificDevice ||
        (name !== 'OverconstrainedError' && name !== 'NotFoundError')
      ) {
        throw error;
      }
      return this.mediaDevices.getUserMedia({
        audio: this.microphoneConstraints(),
        video: false,
      });
    }
  }

  async listMicrophones(): Promise<MeetingMicrophoneDevice[]> {
    const devices = await this.mediaDevices.enumerateDevices();
    return devices
      .filter((device) => device.kind === 'audioinput' && device.deviceId)
      .map((device) => ({
        deviceId: device.deviceId,
        groupId: device.groupId,
        label: device.label || `Microphone ${device.deviceId.slice(0, 6)}`,
        isDefault: device.deviceId === 'default',
      }));
  }

  async listSystemAudioSources(): Promise<MeetingSystemAudioSource[]> {
    return [
      {
        sourceId: MAIN_DISPLAY_AUDIO_SOURCE_ID,
        label: 'System audio (main display)',
        isDefault: true,
      },
    ];
  }

  async probe(
    input: MeetingMediaProbeInput = {},
  ): Promise<MeetingMediaProbeResult> {
    if (this.state !== 'idle') {
      throw new Error(
        'media probe is unavailable while meeting capture is active',
      );
    }
    const requestedSources = new Set<MeetingAudioSource>(
      input.sources ?? ['local', 'remote'],
    );
    const settle = async (
      request: () => Promise<MediaStream>,
    ): Promise<PromiseSettledResult<MediaStream>> => {
      try {
        return { status: 'fulfilled', value: await request() };
      } catch (reason) {
        return { status: 'rejected', reason };
      }
    };
    const [microphoneResult, displayResult] = await Promise.all([
      requestedSources.has('local')
        ? settle(() => this.openMicrophone(input.microphoneDeviceId))
        : null,
      requestedSources.has('remote')
        ? settle(() =>
            this.mediaDevices.getDisplayMedia({
              audio: true,
              video: {
                width: { ideal: 320 },
                height: { ideal: 180 },
                frameRate: { ideal: 1 },
              },
            }),
          )
        : null,
    ]);

    const toProbe = (result: PromiseSettledResult<MediaStream> | null) => {
      if (!result) {
        return {
          available: false,
          errorName: 'NotChecked',
        };
      }
      if (result.status === 'rejected') {
        const reason =
          result.reason && typeof result.reason === 'object'
            ? (result.reason as { name?: unknown; message?: unknown })
            : null;
        return {
          available: false,
          errorName:
            typeof reason?.name === 'string' ? reason.name : 'UnknownError',
          errorMessage:
            typeof reason?.message === 'string'
              ? reason.message
              : String(result.reason),
        };
      }
      const track = result.value.getAudioTracks()[0];
      const settings = track?.getSettings();
      return track
        ? {
            available: true,
            trackState: track.readyState,
            deviceId: settings?.deviceId,
            deviceLabel: track.label,
            sampleRate: settings?.sampleRate,
            channelCount: settings?.channelCount,
          }
        : {
            available: false,
            errorName: 'MissingAudioTrack',
            errorMessage: 'capture returned no audio track',
          };
    };

    const microphones = await this.listMicrophones().catch(() => []);
    const result = {
      local: toProbe(microphoneResult),
      remote: toProbe(displayResult),
      microphones,
    };
    if (microphoneResult?.status === 'fulfilled') {
      this.stopStream(microphoneResult.value);
    }
    if (displayResult?.status === 'fulfilled') {
      this.stopStream(displayResult.value);
    }
    return result;
  }

  async testMicrophone(
    input: MeetingMicrophoneTestInput = {},
  ): Promise<MeetingMicrophoneTestResult> {
    if (this.state !== 'idle') {
      throw new Error(
        'microphone test is unavailable while meeting capture is active',
      );
    }
    const durationMs = Math.min(
      10_000,
      Math.max(1_000, input.durationMs ?? 4_000),
    );
    const startedAt = this.now();
    let deviceId = input.microphoneDeviceId ?? 'default';
    let deviceLabel = '';
    let measuredFrames = 0;
    let nonSilentFrames = 0;
    let lastRms = 0;
    let maxRms = 0;
    let stream: MediaStream | null = null;
    let context: AudioContext | null = null;
    let source: MediaStreamAudioSourceNode | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    const reportLevel = (active: boolean): void => {
      try {
        this.sink.reportMicrophoneTestLevel?.({
          deviceId,
          deviceLabel,
          active,
          elapsedMs: Math.max(0, Math.round(this.now() - startedAt)),
          rms: lastRms,
          maxRms,
          nonSilentFrames,
        });
      } catch {
        // Level reporting must not change the microphone test outcome.
      }
    };
    reportLevel(true);
    try {
      stream = await this.openMicrophone(input.microphoneDeviceId);
      const track = stream.getAudioTracks()[0];
      if (!track) throw new Error('microphone test returned no audio track');
      const settings = track.getSettings();
      deviceId = settings.deviceId ?? deviceId;
      deviceLabel = track.label;
      context = this.audioContextFactory();
      source = context.createMediaStreamSource(stream);
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      timer = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        lastRms = Math.sqrt(sum / samples.length);
        measuredFrames += 1;
        if (lastRms >= 0.002) nonSilentFrames += 1;
        maxRms = Math.max(maxRms, lastRms);
        reportLevel(true);
      }, 50);
      await new Promise((resolve) => setTimeout(resolve, durationMs));
      return {
        available: true,
        deviceId,
        deviceLabel,
        measuredFrames,
        nonSilentFrames,
        maxRms,
      };
    } catch (error) {
      const reason =
        error && typeof error === 'object'
          ? (error as { name?: unknown; message?: unknown })
          : null;
      return {
        available: false,
        deviceId: input.microphoneDeviceId ?? 'default',
        deviceLabel: '',
        measuredFrames: 0,
        nonSilentFrames: 0,
        maxRms: 0,
        errorName:
          typeof reason?.name === 'string' ? reason.name : 'UnknownError',
        errorMessage:
          typeof reason?.message === 'string' ? reason.message : String(error),
      };
    } finally {
      if (timer) clearInterval(timer);
      source?.disconnect();
      if (stream) this.stopStream(stream);
      await context?.close().catch(() => undefined);
      reportLevel(false);
    }
  }

  private stopStream(stream: MediaStream): void {
    for (const track of stream.getTracks()) track.stop();
  }

  private async createStreams(
    microphoneDeviceId?: string,
  ): Promise<Record<MeetingAudioSource, MediaStream>> {
    const [microphoneResult, displayResult] = await Promise.allSettled([
      this.openMicrophone(microphoneDeviceId),
      this.mediaDevices.getDisplayMedia({
        audio: true,
        video: {
          width: { ideal: 320 },
          height: { ideal: 180 },
          frameRate: { ideal: 1 },
        },
      }),
    ]);

    if (
      microphoneResult.status === 'rejected' ||
      displayResult.status === 'rejected'
    ) {
      if (microphoneResult.status === 'fulfilled') {
        this.stopStream(microphoneResult.value);
      }
      if (displayResult.status === 'fulfilled') {
        this.stopStream(displayResult.value);
      }
      if (microphoneResult.status === 'rejected') {
        throw captureFailure('microphone capture', microphoneResult.reason);
      }
      if (displayResult.status === 'rejected') {
        throw captureFailure('system audio capture', displayResult.reason);
      }
      throw new Error('meeting media capture failed');
    }

    const microphone = microphoneResult.value;
    const display = displayResult.value;

    const systemAudioTracks = display.getAudioTracks();
    if (
      microphone.getAudioTracks().length === 0 ||
      systemAudioTracks.length === 0
    ) {
      this.stopStream(microphone);
      this.stopStream(display);
      throw new Error('microphone and system audio tracks are both required');
    }

    return {
      local: microphone,
      remote: display,
    };
  }

  private createCapture(
    source: MeetingAudioSource,
    stream: MediaStream,
    mimeType: string,
  ): ActiveTrackCapture {
    const audioOnlyStream = this.mediaStreamFactory(stream.getAudioTracks());
    const recorder = this.mediaRecorderFactory(audioOnlyStream, {
      mimeType,
      audioBitsPerSecond: 64_000,
    });
    const capture = {} as ActiveTrackCapture;
    const pcmCapture = this.pcmCaptureFactory({
      source,
      onLevel: (rms) => {
        if (!this.scope) return;
        this.sink.reportCaptureLevel?.({
          ...this.scope,
          source,
          rms: Math.max(0, Math.min(1, rms)),
        });
      },
      onChunk: (buffer) => {
        if (!this.scope) return;
        const scope = this.scope;
        capture.pendingPcmWrites = capture.pendingPcmWrites
          .catch(() => undefined)
          .then(() =>
            this.sink.appendPcmChunk({
              ...scope,
              source,
              bytes: new Uint8Array(buffer),
              sampleRate: 16_000,
              channelCount: 1,
            }),
          );
      },
    });
    Object.assign(capture, {
      source,
      stream,
      recorder,
      lastChunkAt: this.now(),
      pendingWrites: Promise.resolve(),
      pendingPcmWrites: Promise.resolve(),
      pcmCapture,
    });

    recorder.addEventListener('dataavailable', (event: BlobEvent) => {
      if (!this.scope || event.data.size === 0) return;
      const chunkAt = this.now();
      const durationMs = Math.max(0, Math.round(chunkAt - capture.lastChunkAt));
      capture.lastChunkAt = chunkAt;
      const scope = this.scope;
      capture.pendingWrites = capture.pendingWrites
        .catch(() => undefined)
        .then(async () => {
          const buffer = await event.data.arrayBuffer();
          const settings = stream.getAudioTracks()[0]?.getSettings();
          return this.sink.appendAudioChunk({
            ...scope,
            source,
            bytes: new Uint8Array(buffer),
            durationMs,
            sampleRate: settings?.sampleRate ?? 0,
            channelCount: settings?.channelCount ?? 0,
            codec: codecFromMimeType(mimeType),
            container: 'webm',
          });
        });
    });
    return capture;
  }

  private async finishCapture(capture: ActiveTrackCapture): Promise<void> {
    if (capture.recorder.state !== 'inactive') {
      await new Promise<void>((resolve) => {
        capture.recorder.addEventListener('stop', () => resolve(), {
          once: true,
        });
        capture.recorder.stop();
      });
    }
    await capture.pendingWrites;
    await capture.pcmCapture.stop().catch(() => undefined);
    await capture.pendingPcmWrites;
    this.stopStream(capture.stream);
  }

  private async replaceCapture(
    source: MeetingAudioSource,
    stream: MediaStream,
  ): Promise<MeetingCaptureSourceSelection> {
    if (this.state !== 'recording') {
      this.stopStream(stream);
      throw new Error('meeting capture source can only change while active');
    }
    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) {
      this.stopStream(stream);
      throw new Error('replacement capture returned no audio track');
    }
    const mimeType = chooseMeetingAudioMimeType(this.isTypeSupported);
    const nextCapture = this.createCapture(source, stream, mimeType);
    try {
      await nextCapture.pcmCapture.start(nextCapture.stream);
      nextCapture.recorder.start(this.chunkDurationMs);
    } catch (error) {
      await nextCapture.pcmCapture.stop().catch(() => undefined);
      this.stopStream(stream);
      throw error;
    }
    const index = this.captures.findIndex(
      (capture) => capture.source === source,
    );
    if (index < 0) {
      await this.finishCapture(nextCapture);
      throw new Error(`active ${source} capture was not found`);
    }
    const previous = this.captures[index];
    this.captures[index] = nextCapture;
    await this.finishCapture(previous);
    const settings = audioTrack.getSettings();
    return {
      source,
      sourceId:
        source === 'local'
          ? settings.deviceId || 'default'
          : MAIN_DISPLAY_AUDIO_SOURCE_ID,
      label:
        audioTrack.label ||
        (source === 'local' ? 'Microphone' : 'System audio (main display)'),
    };
  }

  async switchMicrophone(input: {
    deviceId: string;
  }): Promise<MeetingCaptureSourceSelection> {
    const stream = await this.openMicrophone(input.deviceId);
    return this.replaceCapture('local', stream);
  }

  async switchSystemAudio(input: {
    sourceId: string;
  }): Promise<MeetingCaptureSourceSelection> {
    if (input.sourceId !== MAIN_DISPLAY_AUDIO_SOURCE_ID) {
      throw new Error('unsupported system audio source');
    }
    const stream = await this.mediaDevices.getDisplayMedia({
      audio: true,
      video: {
        width: { ideal: 320 },
        height: { ideal: 180 },
        frameRate: { ideal: 1 },
      },
    });
    return this.replaceCapture('remote', stream);
  }

  async start(input: {
    scope: MeetingArchiveScope;
    microphoneDeviceId?: string;
  }): Promise<MeetingCaptureSourceSelection[]> {
    if (this.state !== 'idle')
      throw new Error('meeting capture is already active');
    this.scope = input.scope;
    const mimeType = chooseMeetingAudioMimeType(this.isTypeSupported);
    let streams: Record<MeetingAudioSource, MediaStream> | null = null;
    try {
      streams = await this.createStreams(input.microphoneDeviceId);
      this.captures = [
        this.createCapture('local', streams.local, mimeType),
        this.createCapture('remote', streams.remote, mimeType),
      ];
      try {
        await Promise.all(
          this.captures.map((capture) =>
            capture.pcmCapture.start(capture.stream),
          ),
        );
      } catch (error) {
        throw captureFailure('audio processing initialization', error);
      }
      try {
        for (const capture of this.captures) {
          capture.recorder.start(this.chunkDurationMs);
        }
      } catch (error) {
        throw captureFailure('audio recorder initialization', error);
      }
      this.state = 'recording';
      const localTrack = streams.local.getAudioTracks()[0]!;
      const localSettings = localTrack.getSettings();
      const remoteTrack = streams.remote.getAudioTracks()[0]!;
      return [
        {
          source: 'local',
          sourceId: localSettings.deviceId || 'default',
          label: localTrack.label || 'Microphone',
        },
        {
          source: 'remote',
          sourceId: MAIN_DISPLAY_AUDIO_SOURCE_ID,
          label: remoteTrack.label || 'System audio (main display)',
        },
      ];
    } catch (error) {
      await Promise.allSettled(
        this.captures.map((capture) => capture.pcmCapture.stop()),
      );
      if (streams) {
        this.stopStream(streams.local);
        this.stopStream(streams.remote);
      }
      this.scope = null;
      this.captures = [];
      this.state = 'idle';
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') return;
    if (this.state !== 'recording') {
      throw new Error('meeting capture is not active');
    }
    this.state = 'stopping';
    const captures = [...this.captures];
    await Promise.all(captures.map((capture) => this.finishCapture(capture)));
    this.captures = [];
    this.scope = null;
    this.state = 'idle';
  }
}
