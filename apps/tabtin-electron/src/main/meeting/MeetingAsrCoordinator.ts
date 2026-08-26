import type {
  MeetingAsrProbeResult,
  MeetingAudioSource,
  MeetingTranscriptCheckpoint,
} from '../../shared/meeting-recording-contract';

const AUDIO_SOURCES: readonly MeetingAudioSource[] = ['local', 'remote'];
const DEFAULT_MAX_QUEUED_CHUNKS_PER_SOURCE = 256;
const DEFAULT_SAMPLE_RATE = 16_000;
const START_TIMEOUT_MS = 10_000;
const DEFAULT_STOP_GRACE_PERIOD_MS = 1_500;

interface GatewayResponse {
  ok: boolean;
  type: string;
  payload?: Record<string, unknown>;
  error?: { code?: string; message?: string };
}

interface GatewayRequestOptions {
  organizationId?: string;
  timeoutMs?: number;
}

type GatewayEventHandler = (
  payload: Record<string, unknown>,
  envelope?: unknown,
) => void;

export interface MeetingAsrGateway {
  requestWithLastAuth(
    messageType: string,
    payload: Record<string, unknown>,
    options?: GatewayRequestOptions,
  ): Promise<GatewayResponse>;
  send(
    messageType: string,
    payload: Record<string, unknown>,
    options?: GatewayRequestOptions,
  ): boolean;
  on(eventType: string, handler: GatewayEventHandler): () => void;
  onReconnect(handler: () => void): () => void;
}

export type MeetingTranscriptSink = (
  checkpoint: MeetingTranscriptCheckpoint,
) => void | Promise<void>;

export interface MeetingAsrCoordinatorOptions {
  gateway: MeetingAsrGateway;
  transcriptSink: MeetingTranscriptSink;
  sessionId: string;
  organizationId?: string;
  sampleRate?: number;
  maxQueuedChunksPerSource?: number;
  startPayload?: Record<string, unknown>;
  now?: () => Date;
  stopGracePeriodMs?: number;
  onStatusChange?: (
    status: 'connecting' | 'active' | 'recovering' | 'failed',
    errorMessage?: string,
  ) => void;
}

interface SourceState {
  streamId: string | null;
  streamOrdinal: number;
  queue: Uint8Array[];
  timelineCursorMs: number;
  streamTimelineOffsetMs: number;
  streamPauseAdjustmentMs: number;
}

function createSourceState(): SourceState {
  return {
    streamId: null,
    streamOrdinal: 0,
    queue: [],
    timelineCursorMs: 0,
    streamTimelineOffsetMs: 0,
    streamPauseAdjustmentMs: 0,
  };
}

function toFiniteNumber(value: unknown, fallback: number): number {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString(
    'base64',
  );
}

function responseErrorMessage(response: GatewayResponse): string {
  return (
    response.error?.message ||
    response.error?.code ||
    `unexpected ASR start response: ${response.type}`
  );
}

export async function probeMeetingAsrReadiness(
  gateway: MeetingAsrGateway,
  organizationId?: string,
): Promise<MeetingAsrProbeResult> {
  let response: GatewayResponse;
  try {
    response = await gateway.requestWithLastAuth(
      'asr.config.check',
      { provider: 'byteplus' },
      {
        ...(organizationId ? { organizationId } : {}),
        timeoutMs: START_TIMEOUT_MS,
      },
    );
  } catch (error) {
    return {
      ready: false,
      provider: 'byteplus',
      reason: 'gateway_error',
      message:
        error instanceof Error && error.message
          ? error.message
          : 'realtime transcription gateway is reconnecting',
    };
  }
  if (!response.ok || response.type !== 'asr.config.status') {
    return {
      ready: false,
      provider: 'byteplus',
      reason: 'gateway_error',
      message: responseErrorMessage(response),
    };
  }
  const payload = response.payload ?? {};
  const ready = payload.ready === true;
  return {
    ready,
    provider:
      typeof payload.provider === 'string' ? payload.provider : 'byteplus',
    ...(ready
      ? {
          resourceId:
            typeof payload.resource_id === 'string'
              ? payload.resource_id
              : undefined,
          wsEndpoint:
            typeof payload.ws_endpoint === 'string'
              ? payload.ws_endpoint
              : undefined,
        }
      : {
          reason:
            payload.reason === 'internal_error'
              ? 'internal_error'
              : payload.reason === 'credential_error'
                ? 'credential_error'
              : 'not_configured',
          message:
            typeof payload.message === 'string'
              ? payload.message
              : undefined,
        }),
  };
}

/**
 * Owns the two independent realtime ASR streams for a meeting.
 *
 * The coordinator intentionally lives in the main process and has no renderer
 * lifecycle dependency. Audio is queued per source until its stream is ready;
 * reconnects replace both server-side streams and replay each source queue in
 * original order.
 */
export class MeetingAsrCoordinator {
  private readonly gateway: MeetingAsrGateway;
  private readonly transcriptSink: MeetingTranscriptSink;
  private readonly sessionId: string;
  private readonly organizationId?: string;
  private readonly sampleRate: number;
  private readonly maxQueuedChunksPerSource: number;
  private readonly startPayload: Record<string, unknown>;
  private readonly now: () => Date;
  private readonly stopGracePeriodMs: number;
  private readonly onStatusChange?: MeetingAsrCoordinatorOptions['onStatusChange'];
  private readonly sources: Record<MeetingAudioSource, SourceState> = {
    local: createSourceState(),
    remote: createSourceState(),
  };

  private started = false;
  private stopped = false;
  private stopping = false;
  private paused = false;
  private pausedAtMs: number | null = null;
  private streamGeneration = 0;
  private startPromise: Promise<void> | null = null;
  private sinkChain: Promise<void> = Promise.resolve();
  private readonly unsubscribe: Array<() => void> = [];
  private stopDoneResolver: (() => void) | null = null;

  constructor(options: MeetingAsrCoordinatorOptions) {
    this.gateway = options.gateway;
    this.transcriptSink = options.transcriptSink;
    this.sessionId = options.sessionId;
    this.organizationId = options.organizationId;
    this.sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
    this.maxQueuedChunksPerSource = Math.max(
      1,
      Math.floor(
        options.maxQueuedChunksPerSource ??
          DEFAULT_MAX_QUEUED_CHUNKS_PER_SOURCE,
      ),
    );
    this.startPayload = { ...options.startPayload };
    this.now = options.now ?? (() => new Date());
    this.stopGracePeriodMs = Math.max(
      0,
      options.stopGracePeriodMs ?? DEFAULT_STOP_GRACE_PERIOD_MS,
    );
    this.onStatusChange = options.onStatusChange;
  }

  async start(): Promise<void> {
    if (this.stopped) {
      throw new Error('meeting ASR coordinator has already stopped');
    }
    if (this.started) return;
    if (this.startPromise) return this.startPromise;

    this.registerListeners();
    this.onStatusChange?.('connecting');
    const generation = ++this.streamGeneration;
    this.startPromise = Promise.all(
      AUDIO_SOURCES.map((source) => this.createStream(source, generation)),
    )
      .then(() => {
        if (this.stopped || generation !== this.streamGeneration) return;
        this.started = true;
        this.onStatusChange?.('active');
        this.unsubscribe.push(
          this.gateway.onReconnect(() => {
            this.restartStreamsAfterReconnect();
          }),
        );
      })
      .catch((error) => {
        this.onStatusChange?.(
          'failed',
          error instanceof Error ? error.message : String(error),
        );
        this.disposeStreamsAndListeners();
        this.stopped = true;
        throw error;
      })
      .finally(() => {
        this.startPromise = null;
      });

    return this.startPromise;
  }

  appendPcm(source: MeetingAudioSource, pcm: Uint8Array): void {
    if (this.stopped || this.stopping || pcm.byteLength === 0) return;

    const bytes = Uint8Array.from(pcm);
    const state = this.sources[source];
    if (this.paused || !state.streamId) {
      this.enqueue(state, bytes);
      return;
    }

    if (!this.sendAudio(state, bytes)) {
      state.streamId = null;
      this.enqueue(state, bytes);
    }
  }

  pause(): void {
    if (this.stopped) return;
    this.paused = true;
    this.pausedAtMs = this.now().getTime();
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    const pausedDurationMs = Math.max(
      0,
      this.now().getTime() - (this.pausedAtMs ?? this.now().getTime()),
    );
    this.paused = false;
    this.pausedAtMs = null;
    for (const source of AUDIO_SOURCES) {
      this.sources[source].timelineCursorMs += pausedDurationMs;
      this.sources[source].streamPauseAdjustmentMs += pausedDurationMs;
      this.flushQueue(this.sources[source]);
    }
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      await this.sinkChain;
      return;
    }

    this.stopping = true;
    this.started = false;
    this.paused = true;
    this.streamGeneration += 1;
    const activeStreamIds = AUDIO_SOURCES.flatMap((source) => {
      const streamId = this.sources[source].streamId;
      return streamId ? [streamId] : [];
    });
    for (const streamId of activeStreamIds) {
      this.gateway.send(
        'asr.stream.stop',
        { stream_id: streamId },
        this.requestOptions,
      );
    }
    if (activeStreamIds.length > 0 && this.stopGracePeriodMs > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.stopGracePeriodMs);
        this.stopDoneResolver = () => {
          clearTimeout(timer);
          resolve();
        };
        this.resolveStopWhenStreamsFinish();
      });
    }
    this.stopped = true;
    this.stopping = false;
    this.stopDoneResolver = null;
    this.disposeStreamsAndListeners(false);
    await this.sinkChain;
  }

  private get requestOptions(): GatewayRequestOptions | undefined {
    return this.organizationId
      ? { organizationId: this.organizationId }
      : undefined;
  }

  private get startRequestOptions(): GatewayRequestOptions {
    return {
      ...(this.requestOptions ?? {}),
      timeoutMs: START_TIMEOUT_MS,
    };
  }

  private buildStartPayload(): Record<string, unknown> {
    return {
      audio_format: 'pcm',
      sample_rate: this.sampleRate,
      provider: 'byteplus',
      ws_endpoint: 'bigmodel_async',
      enable_itn: true,
      enable_punc: true,
      enable_ddc: true,
      show_utterances: true,
      enable_nonstream: true,
      enable_accelerate_text: true,
      accelerate_score: 10,
      ...this.startPayload,
    };
  }

  private registerListeners(): void {
    if (this.unsubscribe.length > 0) return;
    this.unsubscribe.push(
      this.gateway.on('asr.stream.event', (payload) => {
        this.handleTranscriptPayload(payload, false);
      }),
      this.gateway.on('asr.stream.done', (payload) => {
        this.handleTranscriptPayload(payload, true);
        const source = this.findSource(payload.stream_id);
        if (source) {
          this.sources[source].streamId = null;
          if (this.stopping) this.resolveStopWhenStreamsFinish();
          else {
            this.onStatusChange?.('recovering');
            this.restartSource(source);
          }
        }
      }),
      this.gateway.on('asr.stream.error', (payload) => {
        const source = this.findSource(payload.stream_id);
        if (source) {
          this.sources[source].streamId = null;
          if (this.stopping) this.resolveStopWhenStreamsFinish();
          else {
            this.onStatusChange?.(
              'recovering',
              typeof payload.error === 'string' ? payload.error : undefined,
            );
            this.restartSource(source);
          }
        }
      }),
    );
  }

  private async createStream(
    source: MeetingAudioSource,
    generation: number,
  ): Promise<void> {
    const response = await this.gateway.requestWithLastAuth(
      'asr.stream.start',
      this.buildStartPayload(),
      this.startRequestOptions,
    );
    const streamId =
      typeof response.payload?.stream_id === 'string'
        ? response.payload.stream_id
        : '';

    if (!response.ok || response.type !== 'asr.stream.started' || !streamId) {
      throw new Error(responseErrorMessage(response));
    }

    if (this.stopped || generation !== this.streamGeneration) {
      this.gateway.send(
        'asr.stream.stop',
        { stream_id: streamId },
        this.requestOptions,
      );
      return;
    }

    const state = this.sources[source];
    state.streamId = streamId;
    state.streamOrdinal += 1;
    state.streamTimelineOffsetMs = state.timelineCursorMs;
    state.streamPauseAdjustmentMs = 0;
    this.flushQueue(state);
  }

  private restartStreamsAfterReconnect(): void {
    if (this.stopped || !this.started) return;

    const generation = ++this.streamGeneration;
    this.onStatusChange?.('recovering');
    for (const source of AUDIO_SOURCES) {
      this.sources[source].streamId = null;
    }
    void Promise.all(
      AUDIO_SOURCES.map((source) => this.createStream(source, generation)),
    )
      .then(() => this.onStatusChange?.('active'))
      .catch((error) =>
        this.onStatusChange?.(
          'failed',
          error instanceof Error ? error.message : String(error),
        ),
      );
  }

  private restartSource(source: MeetingAudioSource): void {
    if (this.stopped || this.stopping || !this.started) return;
    const generation = this.streamGeneration;
    void this.createStream(source, generation)
      .then(() => this.onStatusChange?.('active'))
      .catch((error) =>
        this.onStatusChange?.(
          'failed',
          error instanceof Error ? error.message : String(error),
        ),
      );
  }

  private resolveStopWhenStreamsFinish(): void {
    if (AUDIO_SOURCES.every((source) => !this.sources[source].streamId)) {
      this.stopDoneResolver?.();
    }
  }

  private enqueue(state: SourceState, bytes: Uint8Array): void {
    if (state.queue.length >= this.maxQueuedChunksPerSource) {
      const dropped = state.queue.shift();
      if (dropped) {
        state.timelineCursorMs +=
          (dropped.byteLength /
            Int16Array.BYTES_PER_ELEMENT /
            this.sampleRate) *
          1_000;
      }
    }
    state.queue.push(bytes);
  }

  private flushQueue(state: SourceState): void {
    if (this.paused || !state.streamId) return;

    while (state.queue.length > 0 && state.streamId) {
      const bytes = state.queue.shift()!;
      if (!this.sendAudio(state, bytes)) {
        state.queue.unshift(bytes);
        state.streamId = null;
      }
    }
  }

  private sendAudio(state: SourceState, bytes: Uint8Array): boolean {
    if (!state.streamId) return false;
    const sent = this.gateway.send(
      'asr.stream.audio',
      { stream_id: state.streamId, data: toBase64(bytes) },
      this.requestOptions,
    );
    if (sent) {
      state.timelineCursorMs +=
        (bytes.byteLength / Int16Array.BYTES_PER_ELEMENT / this.sampleRate) *
        1_000;
    }
    return sent;
  }

  private findSource(streamId: unknown): MeetingAudioSource | null {
    if (typeof streamId !== 'string') return null;
    for (const source of AUDIO_SOURCES) {
      if (this.sources[source].streamId === streamId) return source;
    }
    return null;
  }

  private handleTranscriptPayload(
    payload: Record<string, unknown>,
    eventIsFinal: boolean,
  ): void {
    if (this.stopped) return;
    const source = this.findSource(payload.stream_id);
    if (!source) return;

    const state = this.sources[source];
    const utterances = Array.isArray(payload.utterances)
      ? payload.utterances
      : [];
    let emittedUtterance = false;

    utterances.forEach((utterance, index) => {
      if (!utterance || typeof utterance !== 'object') return;
      const data = utterance as Record<string, unknown>;
      const text = typeof data.text === 'string' ? data.text : '';
      if (!text) return;

      const relativeStartMs = Math.max(0, toFiniteNumber(data.startTime, 0));
      const startMs = Math.round(
        state.streamTimelineOffsetMs +
          state.streamPauseAdjustmentMs +
          relativeStartMs,
      );
      const endMs = Math.max(
        startMs,
        Math.round(
          state.streamTimelineOffsetMs +
            state.streamPauseAdjustmentMs +
            toFiniteNumber(data.endTime, relativeStartMs),
        ),
      );
      emittedUtterance = true;
      this.emitCheckpoint({
        externalId: `${this.sessionId}:${source}:asr:${state.streamOrdinal}:${index}`,
        source,
        startMs,
        endMs,
        text,
        isFinal: eventIsFinal || data.definite === true,
        recordedAt: this.now().toISOString(),
      });
    });

    if (emittedUtterance) return;
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (!text) return;
    const audioInfo =
      payload.audioInfo && typeof payload.audioInfo === 'object'
        ? (payload.audioInfo as Record<string, unknown>)
        : {};
    const relativeDurationMs = Math.max(
      0,
      toFiniteNumber(audioInfo.duration, 0),
    );
    const startMs = Math.round(
      state.streamTimelineOffsetMs + state.streamPauseAdjustmentMs,
    );
    const durationMs = Math.round(startMs + relativeDurationMs);
    this.emitCheckpoint({
      externalId: `${this.sessionId}:${source}:asr:${state.streamOrdinal}:fallback`,
      source,
      startMs,
      endMs: durationMs,
      text,
      isFinal: eventIsFinal || payload.isFinal === true,
      recordedAt: this.now().toISOString(),
    });
  }

  private emitCheckpoint(checkpoint: MeetingTranscriptCheckpoint): void {
    this.sinkChain = this.sinkChain
      .then(() => this.transcriptSink(checkpoint))
      .then(() => undefined);
  }

  private disposeStreamsAndListeners(sendStop = true): void {
    for (const source of AUDIO_SOURCES) {
      const state = this.sources[source];
      if (sendStop && state.streamId) {
        this.gateway.send(
          'asr.stream.stop',
          { stream_id: state.streamId },
          this.requestOptions,
        );
      }
      state.streamId = null;
      state.queue.length = 0;
    }
    while (this.unsubscribe.length > 0) {
      this.unsubscribe.pop()?.();
    }
  }
}
