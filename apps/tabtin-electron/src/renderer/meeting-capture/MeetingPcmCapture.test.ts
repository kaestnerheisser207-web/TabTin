import { describe, expect, it, vi } from 'vitest';

import { MeetingPcmCapture } from './MeetingPcmCapture';

class FakeAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class FakeScriptProcessorNode extends FakeAudioNode {
  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;

  emit(samples: Float32Array): void {
    this.onaudioprocess?.({
      inputBuffer: {
        getChannelData: () => samples,
      },
    } as unknown as AudioProcessingEvent);
  }
}

class FakeAudioContext {
  state: AudioContextState = 'suspended';
  readonly destination = new FakeAudioNode();
  readonly source = new FakeAudioNode();
  readonly processor = new FakeScriptProcessorNode();
  readonly silentGain = Object.assign(new FakeAudioNode(), {
    gain: { value: 1 },
  });
  readonly createMediaStreamSource = vi.fn(() => this.source);
  readonly createScriptProcessor = vi.fn(() => this.processor);
  readonly createGain = vi.fn(() => this.silentGain);
  readonly resume = vi.fn(async () => {
    this.state = 'running';
  });
  readonly close = vi.fn(async () => {
    this.state = 'closed';
  });

  constructor(readonly sampleRate: number) {}
}

function createStream() {
  const track = { stop: vi.fn() };
  const stream = {
    getAudioTracks: vi.fn(() => [track]),
  } as unknown as MediaStream;
  return { stream, track };
}

function createCapture(
  context: FakeAudioContext,
  options: {
    onChunk?: (pcm: ArrayBuffer) => void;
    onLevel?: (level: number) => void;
  } = {},
): MeetingPcmCapture {
  return new MeetingPcmCapture({
    onChunk: options.onChunk ?? vi.fn(),
    onLevel: options.onLevel,
    audioContextFactory: () => context as unknown as AudioContext,
  });
}

function readPcm16Le(buffer: ArrayBuffer): number[] {
  const view = new DataView(buffer);
  return Array.from(
    { length: buffer.byteLength / Int16Array.BYTES_PER_ELEMENT },
    (_, index) => view.getInt16(index * Int16Array.BYTES_PER_ELEMENT, true),
  );
}

describe('MeetingPcmCapture', () => {
  it('emits a 200 ms mono PCM16LE chunk and an optional RMS level', async () => {
    const context = new FakeAudioContext(16_000);
    const onChunk = vi.fn<(pcm: ArrayBuffer) => void>();
    const onLevel = vi.fn<(level: number) => void>();
    const capture = createCapture(context, { onChunk, onLevel });
    const { stream } = createStream();

    await capture.start(stream);
    const input = new Float32Array(3_200);
    input.set([-2, -0.5, 0, 0.5, 2]);
    context.processor.emit(input);

    expect(onChunk).toHaveBeenCalledTimes(1);
    const pcm = onChunk.mock.calls[0]?.[0];
    expect(pcm?.byteLength).toBe(6_400);
    expect(readPcm16Le(pcm!).slice(0, 5)).toEqual([
      -32_768, -16_384, 0, 16_384, 32_767,
    ]);
    expect(onLevel).toHaveBeenCalledTimes(1);
    expect(onLevel.mock.calls[0]?.[0]).toBeGreaterThan(0);
  });

  it('keeps one resampling phase across callback boundaries', async () => {
    const context = new FakeAudioContext(44_100);
    const chunks: ArrayBuffer[] = [];
    const capture = createCapture(context, {
      onChunk: (pcm) => chunks.push(pcm),
    });
    const { stream } = createStream();
    await capture.start(stream);

    let remaining = 44_100;
    while (remaining > 0) {
      const callbackSamples = Math.min(128, remaining);
      context.processor.emit(new Float32Array(callbackSamples).fill(0.25));
      remaining -= callbackSamples;
    }

    expect(chunks).toHaveLength(5);
    expect(chunks.every((chunk) => chunk.byteLength === 6_400)).toBe(true);
    expect(readPcm16Le(chunks[4]!)[3_199]).toBe(8_192);
  });

  it('disconnects and closes the Web Audio graph without stopping the stream', async () => {
    const context = new FakeAudioContext(48_000);
    const capture = createCapture(context);
    const { stream, track } = createStream();

    await capture.start(stream);
    expect(context.createMediaStreamSource).toHaveBeenCalledWith(stream);
    expect(context.createScriptProcessor).toHaveBeenCalledWith(4_096, 1, 1);
    expect(context.resume).toHaveBeenCalledOnce();

    await capture.stop();

    expect(capture.getState()).toBe('idle');
    expect(context.processor.onaudioprocess).toBeNull();
    expect(context.source.disconnect).toHaveBeenCalledOnce();
    expect(context.processor.disconnect).toHaveBeenCalledOnce();
    expect(context.silentGain.disconnect).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(track.stop).not.toHaveBeenCalled();
  });
});
