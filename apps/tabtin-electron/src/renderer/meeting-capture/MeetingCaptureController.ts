import type {
  AppendMeetingAudioChunkInput,
  AppendMeetingPcmChunkInput,
  MeetingArchiveScope,
  MeetingAudioSource,
  MeetingCaptureLevelEvent,
  MeetingCaptureDevicesChangedEvent,
  MeetingCaptureSourceEndedEvent,
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
const SOURCE_SWITCH_DEADLINE_MS = 15_000;
const MIME_TYPE_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm'] as const;
const MAIN_DISPLAY_AUDIO_SOURCE_ID = 'main-display';

type CaptureState = 'idle' | 'recording' | 'stopping';

export interface MeetingCaptureSink {
  appendAudioChunk: (input: AppendMeetingAudioChunkInput) => Promise<unknown>;
  appendPcmChunk: (input: AppendMeetingPcmChunkInput) => Promise<unknown>;
  reportCaptureLevel?: (event: MeetingCaptureLevelEvent) => void;
  reportCaptureSourceEnded?: (event: MeetingCaptureSourceEndedEvent) => void;
  reportCaptureDevicesChanged?: (
    event: MeetingCaptureDevicesChangedEvent,
  ) => void;
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
  > &
    Partial<Pick<MediaDevices, 'addEventListener' | 'removeEventListener'>>;
  mediaRecorderFactory?: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorder;
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
  inputStream: MediaStream;
  audioContext: AudioContext;
  inputNode: MediaStreamAudioSourceNode;
  inputGainNode: GainNode;
  sourceId: string;
  label: string;
  sourceEndedReported: boolean;
  inputEndedListener?: () => void;
  outputNode: MediaStreamAudioDestinationNode;
  recorder: MediaRecorder;
  lastChunkAt: number;
  pendingWrites: Promise<unknown>;
  pendingPcmWrites: Promise<unknown>;
  pcmCapture: MeetingPcmCaptureRuntime;
}

export interface PreparedMeetingCaptureSourceSelection
  extends MeetingCaptureSourceSelection {
  operationId: string;
}

interface PreparedSourceSwitch extends PreparedMeetingCaptureSourceSelection {
  generation: number;
  stream: MediaStream;
  inputNode: MediaStreamAudioSourceNode;
  inputGainNode: GainNode;
}

interface PendingSourceSwitch {
  operationId: string;
  generation: number;
  reject: (error: Error) => void;
}

interface CommittedSourceSwitch {
  operationId: string;
  source: MeetingAudioSource;
  previousStream: MediaStream;
  previousInputNode: MediaStreamAudioSourceNode;
  previousInputGainNode: GainNode;
  previousSourceId: string;
  previousLabel: string;
  currentStream: MediaStream;
}

interface ResolvedSourceSwitch {
  operationId: string;
  resolution: 'finalized' | 'rolled_back';
  selection: MeetingCaptureSourceSelection;
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
  > &
    Partial<Pick<MediaDevices, 'addEventListener' | 'removeEventListener'>>;
  private readonly mediaRecorderFactory: (
    stream: MediaStream,
    options: MediaRecorderOptions,
  ) => MediaRecorder;
  private readonly isTypeSupported: (mimeType: string) => boolean;
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
  private readonly sourceSwitchGeneration: Record<MeetingAudioSource, number> = {
    local: 0,
    remote: 0,
  };
  private readonly preparedSourceSwitches = new Map<
    MeetingAudioSource,
    PreparedSourceSwitch
  >();
  private readonly pendingSourceSwitches = new Map<
    MeetingAudioSource,
    PendingSourceSwitch
  >();
  private readonly committedSourceSwitches = new Map<
    MeetingAudioSource,
    CommittedSourceSwitch
  >();
  private readonly resolvedSourceSwitches = new Map<
    MeetingAudioSource,
    ResolvedSourceSwitch
  >();
  private deviceChangeListenerInstalled = false;

  constructor(options: MeetingCaptureControllerOptions) {
    this.mediaDevices = options.mediaDevices ?? navigator.mediaDevices;
    this.mediaRecorderFactory =
      options.mediaRecorderFactory ??
      ((stream, recorderOptions) => new MediaRecorder(stream, recorderOptions));
    this.isTypeSupported =
      options.isTypeSupported ??
      MediaRecorder.isTypeSupported.bind(MediaRecorder);
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
    return this.mediaDevices.getUserMedia({
      audio: this.microphoneConstraints(normalizedDeviceId),
      video: false,
    });
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

  private describeSourceStream(
    source: MeetingAudioSource,
    stream: MediaStream,
  ): MeetingCaptureSourceSelection {
    const audioTrack = stream.getAudioTracks()[0];
    const settings = audioTrack?.getSettings();
    return {
      source,
      sourceId:
        source === 'local'
          ? settings?.deviceId || 'default'
          : MAIN_DISPLAY_AUDIO_SOURCE_ID,
      label:
        audioTrack?.label ||
        (source === 'local' ? 'Microphone' : 'System audio (main display)'),
    };
  }

  private detachInputEndedListener(capture: ActiveTrackCapture): void {
    if (!capture.inputEndedListener) return;
    capture.inputStream
      .getAudioTracks()[0]
      ?.removeEventListener('ended', capture.inputEndedListener);
    capture.inputEndedListener = undefined;
  }

  private attachInputEndedListener(capture: ActiveTrackCapture): void {
    const track = capture.inputStream.getAudioTracks()[0];
    if (!track) return;
    const listener = (): void => {
      if (
        this.state !== 'recording' ||
        capture.inputStream.getAudioTracks()[0] !== track ||
        !this.scope
      ) {
        return;
      }
      this.reportCaptureSourceEnded(capture);
    };
    capture.inputEndedListener = listener;
    track.addEventListener('ended', listener, { once: true });
  }

  private reportCaptureSourceEnded(capture: ActiveTrackCapture): void {
    if (capture.sourceEndedReported || !this.scope) return;
    capture.sourceEndedReported = true;
    this.sink.reportCaptureSourceEnded?.({
      ...this.scope,
      source: capture.source,
      sourceId: capture.sourceId,
      label: capture.label,
    });
  }

  private readonly handleDeviceChange = (): void => {
    if (this.state !== 'recording') return;
    this.sink.reportCaptureDevicesChanged?.({
      changedAt: new Date().toISOString(),
    });
    const scope = this.scope;
    void this.mediaDevices
      .enumerateDevices()
      .then((devices) => {
        if (this.state !== 'recording' || this.scope !== scope) return;
        const localCapture = this.captures.find(
          (capture) => capture.source === 'local',
        );
        if (
          !localCapture ||
          localCapture.sourceId === 'default' ||
          devices.some(
            (device) =>
              device.kind === 'audioinput' &&
              device.deviceId === localCapture.sourceId,
          )
        ) {
          return;
        }
        this.reportCaptureSourceEnded(localCapture);
      })
      .catch(() => undefined);
  };

  private installDeviceChangeListener(): void {
    if (this.deviceChangeListenerInstalled) return;
    this.mediaDevices.addEventListener?.(
      'devicechange',
      this.handleDeviceChange as EventListener,
    );
    this.deviceChangeListenerInstalled = true;
  }

  private removeDeviceChangeListener(): void {
    if (!this.deviceChangeListenerInstalled) return;
    this.mediaDevices.removeEventListener?.(
      'devicechange',
      this.handleDeviceChange as EventListener,
    );
    this.deviceChangeListenerInstalled = false;
  }

  private async createStableAudioBus(stream: MediaStream): Promise<{
    context: AudioContext;
    inputNode: MediaStreamAudioSourceNode;
    inputGainNode: GainNode;
    outputNode: MediaStreamAudioDestinationNode;
  }> {
    const context = this.audioContextFactory();
    try {
      const inputNode = context.createMediaStreamSource(stream);
      const inputGainNode = context.createGain();
      const outputNode = context.createMediaStreamDestination();
      inputGainNode.gain.setValueAtTime(1, context.currentTime);
      inputNode.connect(inputGainNode);
      inputGainNode.connect(outputNode);
      if (context.state === 'suspended') await context.resume();
      return { context, inputNode, inputGainNode, outputNode };
    } catch (error) {
      await context.close().catch(() => undefined);
      throw error;
    }
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

  private async createCapture(
    source: MeetingAudioSource,
    stream: MediaStream,
    mimeType: string,
  ): Promise<ActiveTrackCapture> {
    const bus = await this.createStableAudioBus(stream);
    const selection = this.describeSourceStream(source, stream);
    let recorder: MediaRecorder;
    try {
      recorder = this.mediaRecorderFactory(bus.outputNode.stream, {
        mimeType,
        audioBitsPerSecond: 64_000,
      });
    } catch (error) {
      bus.inputNode.disconnect();
      bus.inputGainNode.disconnect();
      this.stopStream(bus.outputNode.stream);
      await bus.context.close().catch(() => undefined);
      throw error;
    }
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
      inputStream: stream,
      audioContext: bus.context,
      inputNode: bus.inputNode,
      inputGainNode: bus.inputGainNode,
      sourceId: selection.sourceId,
      label: selection.label,
      sourceEndedReported: false,
      outputNode: bus.outputNode,
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
          const outputSettings = capture.outputNode.stream
            .getAudioTracks()[0]
            ?.getSettings();
          const inputSettings = capture.inputStream
            .getAudioTracks()[0]
            ?.getSettings();
          return this.sink.appendAudioChunk({
            ...scope,
            source,
            bytes: new Uint8Array(buffer),
            durationMs,
            sampleRate:
              outputSettings?.sampleRate ?? capture.audioContext.sampleRate,
            channelCount:
              outputSettings?.channelCount ?? inputSettings?.channelCount ?? 0,
            codec: codecFromMimeType(mimeType),
            container: 'webm',
          });
        });
    });
    return capture;
  }

  private async finishCapture(capture: ActiveTrackCapture): Promise<void> {
    this.detachInputEndedListener(capture);
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
    capture.inputNode.disconnect();
    capture.inputGainNode.disconnect();
    this.stopStream(capture.inputStream);
    this.stopStream(capture.outputNode.stream);
    await capture.audioContext.close().catch(() => undefined);
  }

  private disposePreparedSourceSwitch(prepared: PreparedSourceSwitch): void {
    prepared.inputNode.disconnect();
    prepared.inputGainNode.disconnect();
    this.stopStream(prepared.stream);
  }

  private invalidateSourceSwitch(source: MeetingAudioSource): void {
    this.sourceSwitchGeneration[source] += 1;
    const pending = this.pendingSourceSwitches.get(source);
    if (pending) {
      this.pendingSourceSwitches.delete(source);
      pending.reject(new Error('meeting capture source switch was cancelled'));
    }
    const prepared = this.preparedSourceSwitches.get(source);
    if (!prepared) return;
    this.preparedSourceSwitches.delete(source);
    this.disposePreparedSourceSwitch(prepared);
  }

  private async prepareSourceSwitch(
    source: MeetingAudioSource,
    openStream: () => Promise<MediaStream>,
  ): Promise<PreparedMeetingCaptureSourceSelection> {
    if (this.state !== 'recording') {
      throw new Error('meeting capture source can only change while active');
    }
    if (this.committedSourceSwitches.has(source)) {
      throw new Error('meeting capture source switch is awaiting finalization');
    }
    this.invalidateSourceSwitch(source);
    const generation = this.sourceSwitchGeneration[source];
    const operationId = `${source}-${generation}`;
    let rejectSwitch!: (error: Error) => void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectSwitch = reject;
    });
    const pending: PendingSourceSwitch = {
      operationId,
      generation,
      reject: rejectSwitch,
    };
    this.pendingSourceSwitches.set(source, pending);
    const deadline = setTimeout(() => {
      if (
        generation !== this.sourceSwitchGeneration[source] ||
        this.pendingSourceSwitches.get(source) !== pending
      ) {
        return;
      }
      this.sourceSwitchGeneration[source] += 1;
      this.pendingSourceSwitches.delete(source);
      rejectSwitch(new Error('meeting capture source switch timed out'));
    }, SOURCE_SWITCH_DEADLINE_MS);
    const prepare = Promise.resolve().then(openStream).then((stream) => {
      if (
        generation !== this.sourceSwitchGeneration[source] ||
        this.state !== 'recording'
      ) {
        this.stopStream(stream);
        throw new Error('meeting capture source switch was cancelled');
      }
      const capture = this.captures.find(
        (candidate) => candidate.source === source,
      );
      const audioTrack = stream.getAudioTracks()[0];
      if (!capture || !audioTrack || audioTrack.readyState !== 'live') {
        this.stopStream(stream);
        throw new Error(
          !capture
            ? `active ${source} capture was not found`
            : 'replacement capture returned no live audio track',
        );
      }

      let inputNode: MediaStreamAudioSourceNode | null = null;
      let inputGainNode: GainNode | null = null;
      try {
        inputNode = capture.audioContext.createMediaStreamSource(stream);
        inputGainNode = capture.audioContext.createGain();
        inputGainNode.gain.setValueAtTime(0, capture.audioContext.currentTime);
        inputNode.connect(inputGainNode);
        inputGainNode.connect(capture.outputNode);
      } catch (error) {
        inputNode?.disconnect();
        inputGainNode?.disconnect();
        this.stopStream(stream);
        throw error;
      }

      if (
        generation !== this.sourceSwitchGeneration[source] ||
        this.state !== 'recording'
      ) {
        inputNode.disconnect();
        inputGainNode.disconnect();
        this.stopStream(stream);
        throw new Error('meeting capture source switch was cancelled');
      }
      const settings = audioTrack.getSettings();
      const prepared: PreparedSourceSwitch = {
        operationId,
        generation,
        source,
        sourceId:
          source === 'local'
            ? settings.deviceId || 'default'
            : MAIN_DISPLAY_AUDIO_SOURCE_ID,
        label:
          audioTrack.label ||
          (source === 'local' ? 'Microphone' : 'System audio (main display)'),
        stream,
        inputNode,
        inputGainNode,
      };
      this.preparedSourceSwitches.set(source, prepared);
      return prepared;
    });

    try {
      const prepared = await Promise.race([prepare, cancelled]);
      return {
        operationId: prepared.operationId,
        source: prepared.source,
        sourceId: prepared.sourceId,
        label: prepared.label,
      };
    } finally {
      clearTimeout(deadline);
      if (this.pendingSourceSwitches.get(source) === pending) {
        this.pendingSourceSwitches.delete(source);
      }
    }
  }

  prepareMicrophoneSwitch(input: {
    deviceId: string;
  }): Promise<PreparedMeetingCaptureSourceSelection> {
    return this.prepareSourceSwitch('local', () =>
      this.openMicrophone(input.deviceId),
    );
  }

  prepareSystemAudioSwitch(input: {
    sourceId: string;
  }): Promise<PreparedMeetingCaptureSourceSelection> {
    if (input.sourceId !== MAIN_DISPLAY_AUDIO_SOURCE_ID) {
      return Promise.reject(new Error('unsupported system audio source'));
    }
    return this.prepareSourceSwitch('remote', () =>
      this.mediaDevices.getDisplayMedia({
        audio: true,
        video: {
          width: { ideal: 320 },
          height: { ideal: 180 },
          frameRate: { ideal: 1 },
        },
      }),
    );
  }

  async commitSourceSwitch(input: {
    operationId: string;
    source: MeetingAudioSource;
  }): Promise<MeetingCaptureSourceSelection> {
    const prepared = this.preparedSourceSwitches.get(input.source);
    const preparedTrack = prepared?.stream.getAudioTracks()[0];
    if (
      this.state !== 'recording' ||
      !prepared ||
      !preparedTrack ||
      preparedTrack.readyState !== 'live' ||
      prepared.operationId !== input.operationId ||
      prepared.generation !== this.sourceSwitchGeneration[input.source]
    ) {
      if (prepared?.operationId === input.operationId) {
        this.invalidateSourceSwitch(input.source);
      }
      throw new Error('meeting capture source switch was cancelled');
    }
    const capture = this.captures.find(
      (candidate) => candidate.source === input.source,
    );
    if (!capture) {
      this.invalidateSourceSwitch(input.source);
      throw new Error(`active ${input.source} capture was not found`);
    }

    const switchAt = capture.audioContext.currentTime;
    prepared.inputGainNode.gain.setValueAtTime(1, switchAt);
    capture.inputGainNode.gain.setValueAtTime(0, switchAt);
    this.preparedSourceSwitches.delete(input.source);
    this.detachInputEndedListener(capture);
    const previousInputNode = capture.inputNode;
    const previousInputGainNode = capture.inputGainNode;
    const previousStream = capture.inputStream;
    const previousSourceId = capture.sourceId;
    const previousLabel = capture.label;
    capture.inputNode = prepared.inputNode;
    capture.inputGainNode = prepared.inputGainNode;
    capture.inputStream = prepared.stream;
    capture.sourceId = prepared.sourceId;
    capture.label = prepared.label;
    capture.sourceEndedReported = false;
    this.attachInputEndedListener(capture);
    this.committedSourceSwitches.set(input.source, {
      operationId: input.operationId,
      source: input.source,
      previousStream,
      previousInputNode,
      previousInputGainNode,
      previousSourceId,
      previousLabel,
      currentStream: prepared.stream,
    });
    return {
      source: prepared.source,
      sourceId: prepared.sourceId,
      label: prepared.label,
    };
  }

  abortSourceSwitch(input: {
    operationId: string;
    source: MeetingAudioSource;
  }): void {
    const prepared = this.preparedSourceSwitches.get(input.source);
    if (!prepared || prepared.operationId !== input.operationId) return;
    this.invalidateSourceSwitch(input.source);
  }

  finalizeSourceSwitch(input: {
    operationId: string;
    source: MeetingAudioSource;
  }): MeetingCaptureSourceSelection {
    const resolved = this.resolvedSourceSwitches.get(input.source);
    if (resolved?.operationId === input.operationId) {
      if (resolved.resolution !== 'finalized') {
        throw new Error(
          'meeting capture source switch was already rolled back',
        );
      }
      return resolved.selection;
    }
    const transition = this.committedSourceSwitches.get(input.source);
    const capture = this.captures.find(
      (candidate) => candidate.source === input.source,
    );
    if (
      !transition ||
      transition.operationId !== input.operationId ||
      !capture ||
      capture.inputStream !== transition.currentStream
    ) {
      throw new Error('meeting capture source switch was cancelled');
    }
    this.committedSourceSwitches.delete(input.source);
    transition.previousInputNode.disconnect();
    transition.previousInputGainNode.disconnect();
    this.stopStream(transition.previousStream);
    const selection = {
      source: capture.source,
      sourceId: capture.sourceId,
      label: capture.label,
    };
    this.resolvedSourceSwitches.set(input.source, {
      operationId: input.operationId,
      resolution: 'finalized',
      selection,
    });
    return selection;
  }

  rollbackSourceSwitch(input: {
    operationId: string;
    source: MeetingAudioSource;
  }): MeetingCaptureSourceSelection {
    const resolved = this.resolvedSourceSwitches.get(input.source);
    if (resolved?.operationId === input.operationId) {
      if (resolved.resolution !== 'rolled_back') {
        throw new Error('meeting capture source switch was already finalized');
      }
      return resolved.selection;
    }
    const transition = this.committedSourceSwitches.get(input.source);
    const capture = this.captures.find(
      (candidate) => candidate.source === input.source,
    );
    if (
      this.state !== 'recording' ||
      !transition ||
      transition.operationId !== input.operationId ||
      !capture ||
      capture.inputStream !== transition.currentStream
    ) {
      throw new Error('meeting capture source switch was cancelled');
    }

    const switchAt = capture.audioContext.currentTime;
    transition.previousInputGainNode.gain.setValueAtTime(1, switchAt);
    capture.inputGainNode.gain.setValueAtTime(0, switchAt);
    this.committedSourceSwitches.delete(input.source);
    this.detachInputEndedListener(capture);
    const rejectedStream = capture.inputStream;
    const rejectedInputNode = capture.inputNode;
    const rejectedInputGainNode = capture.inputGainNode;
    capture.inputStream = transition.previousStream;
    capture.inputNode = transition.previousInputNode;
    capture.inputGainNode = transition.previousInputGainNode;
    capture.sourceId = transition.previousSourceId;
    capture.label = transition.previousLabel;
    capture.sourceEndedReported = false;
    this.attachInputEndedListener(capture);
    rejectedInputNode.disconnect();
    rejectedInputGainNode.disconnect();
    this.stopStream(rejectedStream);
    const selection = {
      source: capture.source,
      sourceId: capture.sourceId,
      label: capture.label,
    };
    this.resolvedSourceSwitches.set(input.source, {
      operationId: input.operationId,
      resolution: 'rolled_back',
      selection,
    });
    return selection;
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
      const localCapture = await this.createCapture(
        'local',
        streams.local,
        mimeType,
      );
      this.captures = [localCapture];
      const remoteCapture = await this.createCapture(
        'remote',
        streams.remote,
        mimeType,
      );
      this.captures.push(remoteCapture);
      try {
        await Promise.all(
          this.captures.map((capture) =>
            capture.pcmCapture.start(capture.outputNode.stream),
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
      for (const capture of this.captures) {
        this.attachInputEndedListener(capture);
      }
      this.installDeviceChangeListener();
      return [
        this.describeSourceStream('local', streams.local),
        this.describeSourceStream('remote', streams.remote),
      ];
    } catch (error) {
      this.removeDeviceChangeListener();
      await Promise.allSettled(
        this.captures.map((capture) => this.finishCapture(capture)),
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
    if (this.committedSourceSwitches.size > 0) {
      throw new Error(
        'meeting capture source switch is awaiting transaction resolution',
      );
    }
    this.state = 'stopping';
    this.removeDeviceChangeListener();
    this.invalidateSourceSwitch('local');
    this.invalidateSourceSwitch('remote');
    const captures = [...this.captures];
    await Promise.all(captures.map((capture) => this.finishCapture(capture)));
    this.captures = [];
    this.resolvedSourceSwitches.clear();
    this.scope = null;
    this.state = 'idle';
  }
}
