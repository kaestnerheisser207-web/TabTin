const TARGET_SAMPLE_RATE = 16_000;
const CHUNK_DURATION_MS = 200;
const TARGET_CHUNK_SAMPLES = (TARGET_SAMPLE_RATE * CHUNK_DURATION_MS) / 1_000;
const PROCESSOR_BUFFER_SIZE = 4_096;

export type MeetingPcmCaptureState =
  | 'idle'
  | 'starting'
  | 'recording'
  | 'paused'
  | 'stopping';

export interface MeetingPcmCaptureOptions {
  onChunk: (pcm16le: ArrayBuffer) => void;
  onLevel?: (level: number) => void;
  audioContextFactory?: () => AudioContext;
}

function disconnectQuietly(node: AudioNode | null): void {
  try {
    node?.disconnect();
  } catch {
    // Continue releasing the rest of the graph if one node is already detached.
  }
}

function floatSamplesToPcm16Le(samples: readonly number[]): ArrayBuffer {
  const buffer = new ArrayBuffer(samples.length * Int16Array.BYTES_PER_ELEMENT);
  const view = new DataView(buffer);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, samples[index] ?? 0));
    const integer = Math.round(sample * (sample < 0 ? 0x8000 : 0x7fff));
    view.setInt16(index * Int16Array.BYTES_PER_ELEMENT, integer, true);
  }
  return buffer;
}

/**
 * Produces fixed-size PCM16LE chunks without taking ownership of the input
 * MediaStream. MediaRecorder remains responsible for the stream lifecycle.
 */
export class MeetingPcmCapture {
  private readonly onChunk: (pcm16le: ArrayBuffer) => void;
  private readonly onLevel?: (level: number) => void;
  private readonly audioContextFactory: () => AudioContext;

  private state: MeetingPcmCaptureState = 'idle';
  private context: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private silentGain: GainNode | null = null;

  private sourceSampleRate = TARGET_SAMPLE_RATE;
  private sourceSamples: number[] = [];
  private sourcePosition = 0;
  private targetSamples: number[] = [];

  constructor(options: MeetingPcmCaptureOptions) {
    this.onChunk = options.onChunk;
    this.onLevel = options.onLevel;
    this.audioContextFactory =
      options.audioContextFactory ?? (() => new AudioContext());
  }

  getState(): MeetingPcmCaptureState {
    return this.state;
  }

  async start(stream: MediaStream): Promise<void> {
    if (this.state !== 'idle') {
      throw new Error('meeting PCM capture is already active');
    }
    if (stream.getAudioTracks().length === 0) {
      throw new Error('meeting PCM capture requires an audio track');
    }

    this.state = 'starting';
    try {
      const context = this.audioContextFactory();
      if (!Number.isFinite(context.sampleRate) || context.sampleRate <= 0) {
        await context.close().catch(() => undefined);
        throw new Error('meeting PCM capture received an invalid sample rate');
      }

      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(
        PROCESSOR_BUFFER_SIZE,
        1,
        1,
      );
      const silentGain = context.createGain();
      silentGain.gain.value = 0;

      this.context = context;
      this.source = source;
      this.processor = processor;
      this.silentGain = silentGain;
      this.resetBuffers(context.sampleRate);

      processor.onaudioprocess = (event) => {
        if (this.state !== 'recording' || this.processor !== processor) return;
        this.acceptInput(event.inputBuffer.getChannelData(0));
      };

      source.connect(processor);
      processor.connect(silentGain);
      silentGain.connect(context.destination);
      if (context.state === 'suspended') await context.resume();
      this.state = 'recording';
    } catch (error) {
      await this.releaseGraph();
      this.state = 'idle';
      throw error;
    }
  }

  pause(): void {
    if (this.state !== 'recording') {
      throw new Error('meeting PCM capture can only pause while recording');
    }
    this.state = 'paused';
    this.resetBuffers(this.sourceSampleRate);
  }

  resume(): void {
    if (this.state !== 'paused') {
      throw new Error('meeting PCM capture can only resume while paused');
    }
    this.resetBuffers(this.sourceSampleRate);
    this.state = 'recording';
  }

  async stop(): Promise<void> {
    if (this.state === 'idle') return;
    if (this.state !== 'recording' && this.state !== 'paused') {
      throw new Error('meeting PCM capture is not ready to stop');
    }

    this.state = 'stopping';
    try {
      await this.releaseGraph();
    } finally {
      this.state = 'idle';
    }
  }

  private resetBuffers(sourceSampleRate: number): void {
    this.sourceSampleRate = sourceSampleRate;
    this.sourceSamples = [];
    this.sourcePosition = 0;
    this.targetSamples = [];
  }

  private acceptInput(input: Float32Array): void {
    if (this.sourceSampleRate === TARGET_SAMPLE_RATE) {
      for (let index = 0; index < input.length; index += 1) {
        this.targetSamples.push(input[index] ?? 0);
      }
    } else {
      for (let index = 0; index < input.length; index += 1) {
        this.sourceSamples.push(input[index] ?? 0);
      }
      this.resampleAvailableInput();
    }
    this.emitCompleteChunks();
  }

  private resampleAvailableInput(): void {
    const sourceStep = this.sourceSampleRate / TARGET_SAMPLE_RATE;
    while (Math.floor(this.sourcePosition) + 1 < this.sourceSamples.length) {
      const lowerIndex = Math.floor(this.sourcePosition);
      const fraction = this.sourcePosition - lowerIndex;
      const lower = this.sourceSamples[lowerIndex] ?? 0;
      const upper = this.sourceSamples[lowerIndex + 1] ?? lower;
      this.targetSamples.push(lower + (upper - lower) * fraction);
      this.sourcePosition += sourceStep;
    }

    // Keep the fractional phase and any boundary sample for the next callback.
    // Rounding each callback independently would accumulate output-time drift.
    const consumedSamples = Math.floor(this.sourcePosition);
    if (consumedSamples > 0) {
      this.sourceSamples = this.sourceSamples.slice(consumedSamples);
      this.sourcePosition -= consumedSamples;
    }
  }

  private emitCompleteChunks(): void {
    while (this.targetSamples.length >= TARGET_CHUNK_SAMPLES) {
      const samples = this.targetSamples.splice(0, TARGET_CHUNK_SAMPLES);
      if (this.onLevel) {
        let sumOfSquares = 0;
        for (const sample of samples) sumOfSquares += sample * sample;
        this.onLevel(
          Math.min(1, Math.sqrt(sumOfSquares / TARGET_CHUNK_SAMPLES)),
        );
      }
      this.onChunk(floatSamplesToPcm16Le(samples));
    }
  }

  private async releaseGraph(): Promise<void> {
    const context = this.context;
    if (this.processor) this.processor.onaudioprocess = null;
    disconnectQuietly(this.source);
    disconnectQuietly(this.processor);
    disconnectQuietly(this.silentGain);

    this.context = null;
    this.source = null;
    this.processor = null;
    this.silentGain = null;
    this.resetBuffers(TARGET_SAMPLE_RATE);

    if (context) await context.close();
  }
}
