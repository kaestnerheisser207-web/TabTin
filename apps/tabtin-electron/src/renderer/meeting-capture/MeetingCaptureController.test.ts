import { describe, expect, it, vi } from 'vitest';

import {
  MeetingCaptureController,
  chooseMeetingAudioMimeType,
} from './MeetingCaptureController';

class FakeTrack extends EventTarget {
  stopped = false;
  private state: MediaStreamTrackState = 'live';
  constructor(
    readonly label = 'USB microphone',
    private readonly deviceId = 'mic-2',
  ) {
    super();
  }
  stop() {
    this.stopped = true;
    this.state = 'ended';
  }
  get readyState(): MediaStreamTrackState {
    return this.state;
  }
  getSettings() {
    return { sampleRate: 48_000, channelCount: 1, deviceId: this.deviceId };
  }
  end() {
    this.state = 'ended';
    this.dispatchEvent(new Event('ended'));
  }
}

class FakeStream {
  readonly audioTrack: FakeTrack;
  readonly videoTrack = new FakeTrack();
  constructor(
    private readonly includeAudio = true,
    label = 'USB microphone',
    deviceId = 'mic-2',
  ) {
    this.audioTrack = new FakeTrack(label, deviceId);
  }
  getAudioTracks() {
    return this.includeAudio ? [this.audioTrack] : [];
  }
  getTracks() {
    return [this.audioTrack, this.videoTrack];
  }
}

class FakeRecorder extends EventTarget {
  state: RecordingState = 'inactive';
  constructor(
    readonly stream: MediaStream,
    readonly options: MediaRecorderOptions,
  ) {
    super();
  }
  start = vi.fn((_timeslice?: number) => {
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.dispatchEvent(new Event('stop'));
  });
  emitData(bytes: number[]) {
    const event = new Event('dataavailable') as BlobEvent;
    Object.defineProperty(event, 'data', {
      value: {
        size: bytes.length,
        arrayBuffer: async () => new Uint8Array(bytes).buffer,
      },
    });
    this.dispatchEvent(event);
  }
}

function createPcmRuntime() {
  return {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
}

function createAudioContextHarness() {
  const contexts: Array<{
    sources: Array<{
      stream: MediaStream;
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }>;
    gains: Array<{
      gain: { setValueAtTime: ReturnType<typeof vi.fn> };
      connect: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
    }>;
    outputStream: FakeStream;
    close: ReturnType<typeof vi.fn>;
  }> = [];
  const factory = () => {
    const sources: (typeof contexts)[number]['sources'] = [];
    const gains: (typeof contexts)[number]['gains'] = [];
    const outputStream = new FakeStream(true, 'Stable audio bus', 'bus');
    const outputNode = { stream: outputStream };
    const close = vi.fn().mockResolvedValue(undefined);
    const context = {
      state: 'running',
      currentTime: 42,
      createMediaStreamSource: vi.fn((stream: MediaStream) => {
        const source = {
          stream,
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        sources.push(source);
        return source;
      }),
      createGain: vi.fn(() => {
        const gain = {
          gain: { setValueAtTime: vi.fn() },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        gains.push(gain);
        return gain;
      }),
      createMediaStreamDestination: vi.fn(() => outputNode),
      resume: vi.fn().mockResolvedValue(undefined),
      close,
    };
    contexts.push({ sources, gains, outputStream, close });
    return context as unknown as AudioContext;
  };
  return { contexts, factory };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 8; index += 1) await Promise.resolve();
}

async function createSwitchHarness(options: {
  openReplacement: () => Promise<FakeStream>;
  mediaDeviceEvents?: EventTarget;
  devices?: MediaDeviceInfo[];
}) {
  const microphone = new FakeStream(true, 'Built-in microphone', 'mic-1');
  const display = new FakeStream(true, 'System audio', 'display-1');
  const getUserMedia = vi
    .fn()
    .mockResolvedValueOnce(microphone)
    .mockImplementation(options.openReplacement);
  const recorders: FakeRecorder[] = [];
  const audioContexts = createAudioContextHarness();
  const reportCaptureSourceEnded = vi.fn();
  const reportCaptureDevicesChanged = vi.fn();
  const controller = new MeetingCaptureController({
    mediaDevices: {
      getUserMedia,
      getDisplayMedia: vi.fn().mockResolvedValue(display),
      enumerateDevices: vi.fn().mockResolvedValue(
        options.devices ?? [
          {
            kind: 'audioinput',
            deviceId: 'mic-1',
            groupId: 'group-1',
            label: 'Built-in microphone',
            toJSON: () => ({}),
          } as MediaDeviceInfo,
        ],
      ),
      addEventListener: options.mediaDeviceEvents?.addEventListener.bind(
        options.mediaDeviceEvents,
      ),
      removeEventListener: options.mediaDeviceEvents?.removeEventListener.bind(
        options.mediaDeviceEvents,
      ),
    },
    mediaRecorderFactory: (stream, recorderOptions) => {
      const recorder = new FakeRecorder(stream, recorderOptions);
      recorders.push(recorder);
      return recorder as unknown as MediaRecorder;
    },
    isTypeSupported: () => true,
    audioContextFactory: audioContexts.factory,
    pcmCaptureFactory: () => createPcmRuntime(),
    sink: {
      appendAudioChunk: vi.fn().mockResolvedValue(undefined),
      appendPcmChunk: vi.fn().mockResolvedValue(undefined),
      reportCaptureSourceEnded,
      reportCaptureDevicesChanged,
    },
  });
  await controller.start({
    scope: {
      organizationId: 'org-1',
      userId: 'user-1',
      sessionId: 'session-1',
    },
    microphoneDeviceId: 'mic-1',
  });
  return {
    controller,
    microphone,
    display,
    recorders,
    audioContexts,
    reportCaptureSourceEnded,
    reportCaptureDevicesChanged,
  };
}

describe('MeetingCaptureController', () => {
  it('treats stop as idempotent after the hidden capture runtime is lost', async () => {
    const controller = new MeetingCaptureController({
      isTypeSupported: () => true,
      sink: {
        appendAudioChunk: vi.fn(),
        appendPcmChunk: vi.fn(),
      },
    });

    await expect(controller.stop()).resolves.toBeUndefined();
    expect(controller.getState()).toBe('idle');
  });

  it('chooses Opus WebM before the generic WebM fallback', () => {
    expect(chooseMeetingAudioMimeType(() => true)).toBe(
      'audio/webm;codecs=opus',
    );
    expect(chooseMeetingAudioMimeType((value) => value === 'audio/webm')).toBe(
      'audio/webm',
    );
  });

  it('starts two independent recorders and writes source-specific chunks', async () => {
    const microphone = new FakeStream();
    const display = new FakeStream();
    const recorders: FakeRecorder[] = [];
    const appendAudioChunk = vi.fn().mockResolvedValue(undefined);
    const appendPcmChunk = vi.fn().mockResolvedValue(undefined);
    const reportCaptureLevel = vi.fn();
    const pcmEmitters: Array<(bytes: ArrayBuffer) => void> = [];
    const pcmLevelEmitters: Array<(level: number) => void> = [];
    let now = 1_000;
    const audioContexts = createAudioContextHarness();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(microphone),
        getDisplayMedia: vi.fn().mockResolvedValue(display),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: (stream, options) => {
        const recorder = new FakeRecorder(stream, options);
        recorders.push(recorder);
        return recorder as unknown as MediaRecorder;
      },
      isTypeSupported: () => true,
      audioContextFactory: audioContexts.factory,
      now: () => now,
      pcmCaptureFactory: ({ onChunk, onLevel }) => {
        pcmEmitters.push(onChunk);
        pcmLevelEmitters.push(onLevel);
        return createPcmRuntime();
      },
      sink: { appendAudioChunk, appendPcmChunk, reportCaptureLevel },
    });

    const selections = await controller.start({
      scope: {
        organizationId: 'org-1',
        userId: 'user-1',
        sessionId: 'session-1',
      },
      microphoneDeviceId: 'mic-2',
    });
    expect(controller.getState()).toBe('recording');
    expect(selections).toEqual([
      {
        source: 'local',
        sourceId: 'mic-2',
        label: 'USB microphone',
      },
      {
        source: 'remote',
        sourceId: 'main-display',
        label: 'USB microphone',
      },
    ]);
    expect(recorders).toHaveLength(2);
    expect(
      recorders.every(
        (recorder) => recorder.start.mock.calls[0]?.[0] === 1_000,
      ),
    ).toBe(true);

    now = 6_000;
    recorders[0]!.emitData([1, 2]);
    recorders[1]!.emitData([3, 4]);
    await vi.waitFor(() => expect(appendAudioChunk).toHaveBeenCalledTimes(2));

    expect(appendAudioChunk).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'local', durationMs: 5_000 }),
    );
    expect(appendAudioChunk).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'remote', durationMs: 5_000 }),
    );
    pcmEmitters[0]!(new Uint8Array([5, 6]).buffer);
    pcmEmitters[1]!(new Uint8Array([7, 8]).buffer);
    await vi.waitFor(() => expect(appendPcmChunk).toHaveBeenCalledTimes(2));
    expect(appendPcmChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'local',
        sampleRate: 16_000,
        channelCount: 1,
      }),
    );
    expect(appendPcmChunk).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'remote' }),
    );
    pcmLevelEmitters[0]!(0.125);
    pcmLevelEmitters[1]!(1.5);
    expect(reportCaptureLevel).toHaveBeenNthCalledWith(1, {
      sessionId: 'session-1',
      organizationId: 'org-1',
      userId: 'user-1',
      source: 'local',
      rms: 0.125,
    });
    expect(reportCaptureLevel).toHaveBeenNthCalledWith(2, {
      sessionId: 'session-1',
      organizationId: 'org-1',
      userId: 'user-1',
      source: 'remote',
      rms: 1,
    });
  });

  it.each(['OverconstrainedError', 'NotFoundError'])(
    'does not fall back when a selected microphone fails with %s',
    async (errorName) => {
      const display = new FakeStream(true, 'System audio', 'display-1');
      const getUserMedia = vi
        .fn()
        .mockRejectedValue(
          new DOMException('selected device disappeared', errorName),
        );
      const controller = new MeetingCaptureController({
        mediaDevices: {
          getUserMedia,
          getDisplayMedia: vi.fn().mockResolvedValue(display),
          enumerateDevices: vi.fn().mockResolvedValue([]),
        },
        mediaRecorderFactory: (stream, options) =>
          new FakeRecorder(stream, options) as unknown as MediaRecorder,
        isTypeSupported: () => true,
        pcmCaptureFactory: () => createPcmRuntime(),
        sink: {
          appendAudioChunk: vi.fn().mockResolvedValue(undefined),
          appendPcmChunk: vi.fn().mockResolvedValue(undefined),
        },
      });

      await expect(
        controller.start({
          scope: {
            organizationId: 'org-1',
            userId: 'user-1',
            sessionId: 'session-1',
          },
          microphoneDeviceId: 'continuity-phone-mic',
        }),
      ).rejects.toThrow(
        `microphone capture failed: ${errorName}: selected device disappeared`,
      );

      expect(getUserMedia).toHaveBeenNthCalledWith(1, {
        audio: expect.objectContaining({
          deviceId: { exact: 'continuity-phone-mic' },
        }),
        video: false,
      });
      expect(getUserMedia).toHaveBeenCalledTimes(1);
      expect(display.audioTrack.stopped).toBe(true);
      expect(controller.getState()).toBe('idle');
    },
  );

  it('reports microphone and system audio independently during readiness probe', async () => {
    const microphone = new FakeStream();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(microphone),
        getDisplayMedia: vi
          .fn()
          .mockRejectedValue(new DOMException('denied', 'NotAllowedError')),
        enumerateDevices: vi.fn().mockResolvedValue([
          {
            kind: 'audioinput',
            deviceId: 'default',
            groupId: 'group-1',
            label: 'Default microphone',
          },
          {
            kind: 'audioinput',
            deviceId: 'mic-2',
            groupId: 'group-2',
            label: 'USB microphone',
          },
        ]),
      },
      mediaRecorderFactory: vi.fn(),
      isTypeSupported: () => true,
      sink: { appendAudioChunk: vi.fn(), appendPcmChunk: vi.fn() },
    });

    const result = await controller.probe();

    expect(result.local).toMatchObject({
      available: true,
      sampleRate: 48_000,
      channelCount: 1,
    });
    expect(result.remote).toMatchObject({
      available: false,
      errorName: 'NotAllowedError',
    });
    expect(result.microphones).toEqual([
      {
        deviceId: 'default',
        groupId: 'group-1',
        label: 'Default microphone',
        isDefault: true,
      },
      {
        deviceId: 'mic-2',
        groupId: 'group-2',
        label: 'USB microphone',
        isDefault: false,
      },
    ]);
    expect(microphone.audioTrack.stopped).toBe(true);
  });

  it('probes only remote audio when local audio is not requested', async () => {
    const display = new FakeStream();
    const getUserMedia = vi.fn();
    const getDisplayMedia = vi.fn().mockResolvedValue(display);
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia,
        getDisplayMedia,
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: vi.fn(),
      isTypeSupported: () => true,
      sink: { appendAudioChunk: vi.fn(), appendPcmChunk: vi.fn() },
    });

    const result = await controller.probe({ sources: ['remote'] });

    expect(result.local).toEqual({
      available: false,
      errorName: 'NotChecked',
    });
    expect(result.remote.available).toBe(true);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).toHaveBeenCalledOnce();
    expect(display.audioTrack.stopped).toBe(true);
  });

  it('probes only local audio when remote audio is not requested', async () => {
    const microphone = new FakeStream();
    const getUserMedia = vi.fn().mockResolvedValue(microphone);
    const getDisplayMedia = vi.fn();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia,
        getDisplayMedia,
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: vi.fn(),
      isTypeSupported: () => true,
      sink: { appendAudioChunk: vi.fn(), appendPcmChunk: vi.fn() },
    });

    const result = await controller.probe({ sources: ['local'] });

    expect(result.local.available).toBe(true);
    expect(result.remote).toEqual({
      available: false,
      errorName: 'NotChecked',
    });
    expect(getUserMedia).toHaveBeenCalledOnce();
    expect(getDisplayMedia).not.toHaveBeenCalled();
    expect(microphone.audioTrack.stopped).toBe(true);
  });

  it('reports raw microphone levels and always emits a final inactive event', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    try {
      const microphone = new FakeStream();
      const source = {
        connect: vi.fn(),
        disconnect: vi.fn(),
      };
      const analyser = {
        fftSize: 0,
        getFloatTimeDomainData: vi.fn((samples: Float32Array) => {
          samples.fill(0.25);
        }),
      };
      const context = {
        createMediaStreamSource: vi.fn(() => source),
        createAnalyser: vi.fn(() => analyser),
        close: vi.fn().mockResolvedValue(undefined),
      };
      const reportMicrophoneTestLevel = vi.fn();
      const appendAudioChunk = vi.fn();
      const appendPcmChunk = vi.fn();
      const controller = new MeetingCaptureController({
        mediaDevices: {
          getUserMedia: vi.fn().mockResolvedValue(microphone),
          getDisplayMedia: vi.fn(),
          enumerateDevices: vi.fn().mockResolvedValue([]),
        },
        mediaRecorderFactory: vi.fn(),
        audioContextFactory: () => context as unknown as AudioContext,
        isTypeSupported: () => true,
        now: () => Date.now(),
        sink: {
          appendAudioChunk,
          appendPcmChunk,
          reportMicrophoneTestLevel,
        },
      });

      const resultPromise = controller.testMicrophone({
        microphoneDeviceId: 'requested-mic',
        durationMs: 1_000,
      });
      await vi.advanceTimersByTimeAsync(1_000);
      const result = await resultPromise;

      expect(result).toMatchObject({
        available: true,
        deviceId: 'mic-2',
        deviceLabel: 'USB microphone',
        measuredFrames: 20,
        nonSilentFrames: 20,
        maxRms: 0.25,
      });
      const events = reportMicrophoneTestLevel.mock.calls.map(
        ([event]) => event,
      );
      expect(events[0]).toEqual({
        deviceId: 'requested-mic',
        deviceLabel: '',
        active: true,
        elapsedMs: 0,
        rms: 0,
        maxRms: 0,
        nonSilentFrames: 0,
      });
      expect(events[1]).toMatchObject({
        deviceId: 'mic-2',
        deviceLabel: 'USB microphone',
        active: true,
        elapsedMs: 50,
        rms: 0.25,
        maxRms: 0.25,
        nonSilentFrames: 1,
      });
      expect(events.at(-1)).toMatchObject({
        active: false,
        elapsedMs: 1_000,
        rms: 0.25,
        maxRms: 0.25,
        nonSilentFrames: 20,
      });
      expect(source.disconnect).toHaveBeenCalledOnce();
      expect(context.close).toHaveBeenCalledOnce();
      expect(microphone.audioTrack.stopped).toBe(true);
      expect(controller.getState()).toBe('idle');
      expect(appendAudioChunk).not.toHaveBeenCalled();
      expect(appendPcmChunk).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('emits an inactive microphone level event when access fails', async () => {
    const reportMicrophoneTestLevel = vi.fn();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia: vi
          .fn()
          .mockRejectedValue(new DOMException('denied', 'NotAllowedError')),
        getDisplayMedia: vi.fn(),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: vi.fn(),
      isTypeSupported: () => true,
      now: () => 10,
      sink: {
        appendAudioChunk: vi.fn(),
        appendPcmChunk: vi.fn(),
        reportMicrophoneTestLevel,
      },
    });

    await expect(controller.testMicrophone()).resolves.toMatchObject({
      available: false,
      errorName: 'NotAllowedError',
    });
    expect(
      reportMicrophoneTestLevel.mock.calls.map(([event]) => event.active),
    ).toEqual([true, false]);
  });

  it('enumerates microphone choices without opening an audio stream', async () => {
    const getUserMedia = vi.fn();
    const getDisplayMedia = vi.fn();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia,
        getDisplayMedia,
        enumerateDevices: vi.fn().mockResolvedValue([
          {
            kind: 'audioinput',
            deviceId: 'mic-2',
            groupId: 'group-2',
            label: 'USB microphone',
          },
          {
            kind: 'audiooutput',
            deviceId: 'speaker-1',
            groupId: 'group-3',
            label: 'Speaker',
          },
        ]),
      },
      mediaRecorderFactory: vi.fn(),
      isTypeSupported: () => true,
      sink: { appendAudioChunk: vi.fn(), appendPcmChunk: vi.fn() },
    });

    await expect(controller.listMicrophones()).resolves.toEqual([
      {
        deviceId: 'mic-2',
        groupId: 'group-2',
        label: 'USB microphone',
        isDefault: false,
      },
    ]);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(getDisplayMedia).not.toHaveBeenCalled();
  });

  it('stops both recorders together', async () => {
    const microphone = new FakeStream();
    const display = new FakeStream();
    const recorders: FakeRecorder[] = [];
    const audioContexts = createAudioContextHarness();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(microphone),
        getDisplayMedia: vi.fn().mockResolvedValue(display),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: (stream, options) => {
        const recorder = new FakeRecorder(stream, options);
        recorders.push(recorder);
        return recorder as unknown as MediaRecorder;
      },
      isTypeSupported: () => true,
      audioContextFactory: audioContexts.factory,
      pcmCaptureFactory: () => createPcmRuntime(),
      sink: {
        appendAudioChunk: vi.fn().mockResolvedValue(undefined),
        appendPcmChunk: vi.fn().mockResolvedValue(undefined),
      },
    });

    await controller.start({
      scope: {
        organizationId: 'org-1',
        userId: 'user-1',
        sessionId: 'session-1',
      },
    });
    await controller.stop();

    expect(controller.getState()).toBe('idle');
    expect(
      recorders.every((recorder) => recorder.stop.mock.calls.length === 1),
    ).toBe(true);
    expect(microphone.audioTrack.stopped).toBe(true);
    expect(display.videoTrack.stopped).toBe(true);
    expect(audioContexts.contexts).toHaveLength(2);
    expect(
      audioContexts.contexts.every(
        (context) => context.close.mock.calls.length === 1,
      ),
    ).toBe(true);
  });

  it('hot-switches microphone and system audio without restarting capture', async () => {
    const microphone = new FakeStream(true, 'Built-in microphone', 'mic-1');
    const display = new FakeStream(true, 'System audio', 'display-1');
    const replacementMicrophone = new FakeStream(
      true,
      'USB microphone',
      'mic-2',
    );
    const replacementDisplay = new FakeStream(
      true,
      'System audio',
      'display-1',
    );
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(microphone)
      .mockResolvedValueOnce(replacementMicrophone);
    const getDisplayMedia = vi
      .fn()
      .mockResolvedValueOnce(display)
      .mockResolvedValueOnce(replacementDisplay);
    const recorders: FakeRecorder[] = [];
    const pcmRuntimes = [createPcmRuntime(), createPcmRuntime()];
    const audioContexts = createAudioContextHarness();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia,
        getDisplayMedia,
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: (stream, options) => {
        const recorder = new FakeRecorder(stream, options);
        recorders.push(recorder);
        return recorder as unknown as MediaRecorder;
      },
      isTypeSupported: () => true,
      audioContextFactory: audioContexts.factory,
      pcmCaptureFactory: ({ source }) =>
        pcmRuntimes[source === 'local' ? 0 : 1]!,
      sink: {
        appendAudioChunk: vi.fn().mockResolvedValue(undefined),
        appendPcmChunk: vi.fn().mockResolvedValue(undefined),
      },
    });

    await controller.start({
      scope: {
        organizationId: 'org-1',
        userId: 'user-1',
        sessionId: 'session-1',
      },
      microphoneDeviceId: 'mic-1',
    });
    const localRecorder = recorders[0];
    const localDestinationTrack = localRecorder?.stream.getAudioTracks()[0];

    const preparedMicrophone = await controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    await expect(
      controller.commitSourceSwitch(preparedMicrophone),
    ).resolves.toEqual({
      source: 'local',
      sourceId: 'mic-2',
      label: 'USB microphone',
    });
    expect(microphone.audioTrack.stopped).toBe(false);
    expect(controller.finalizeSourceSwitch(preparedMicrophone)).toEqual({
      source: 'local',
      sourceId: 'mic-2',
      label: 'USB microphone',
    });
    expect(microphone.audioTrack.stopped).toBe(true);
    expect(replacementMicrophone.audioTrack.stopped).toBe(false);

    const preparedSystemAudio = await controller.prepareSystemAudioSwitch({
      sourceId: 'main-display',
    });
    await expect(
      controller.commitSourceSwitch(preparedSystemAudio),
    ).resolves.toEqual({
      source: 'remote',
      sourceId: 'main-display',
      label: 'System audio',
    });
    expect(display.audioTrack.stopped).toBe(false);
    await controller.finalizeSourceSwitch(preparedSystemAudio);
    expect(display.audioTrack.stopped).toBe(true);
    expect(replacementDisplay.audioTrack.stopped).toBe(false);
    expect(recorders).toHaveLength(2);
    expect(recorders[0]).toBe(localRecorder);
    expect(recorders[0]?.stream.getAudioTracks()[0]).toBe(
      localDestinationTrack,
    );
    expect(recorders.every((recorder) => recorder.stop.mock.calls.length === 0)).toBe(
      true,
    );
    expect(pcmRuntimes.every((runtime) => runtime.start.mock.calls.length === 1)).toBe(
      true,
    );
    expect(pcmRuntimes.every((runtime) => runtime.stop.mock.calls.length === 0)).toBe(
      true,
    );
    expect(audioContexts.contexts[0]?.sources).toHaveLength(2);
    expect(audioContexts.contexts[0]?.gains).toHaveLength(2);
    expect(audioContexts.contexts[0]?.gains[1]?.gain.setValueAtTime).toHaveBeenCalledWith(
      1,
      42,
    );
    expect(audioContexts.contexts[0]?.gains[0]?.gain.setValueAtTime).toHaveBeenLastCalledWith(
      0,
      42,
    );
    expect(audioContexts.contexts[0]?.sources[0]?.disconnect).toHaveBeenCalledOnce();
    expect(audioContexts.contexts[1]?.sources).toHaveLength(2);
    expect(audioContexts.contexts[1]?.sources[0]?.disconnect).toHaveBeenCalledOnce();
    expect(controller.getState()).toBe('recording');

    await controller.stop();
    expect(replacementMicrophone.audioTrack.stopped).toBe(true);
    expect(replacementDisplay.audioTrack.stopped).toBe(true);
  });

  it('stops a late microphone stream after its renderer-owned deadline', async () => {
    vi.useFakeTimers();
    try {
      const replacement = new FakeStream(true, 'USB microphone', 'mic-2');
      const pending = deferred<FakeStream>();
      const harness = await createSwitchHarness({
        openReplacement: () => pending.promise,
      });
      const switchPromise = harness.controller.prepareMicrophoneSwitch({
        deviceId: 'mic-2',
      });
      const rejection = expect(switchPromise).rejects.toThrow(
        'meeting capture source switch timed out',
      );
      await vi.advanceTimersByTimeAsync(15_000);
      await rejection;
      pending.resolve(replacement);
      await flushMicrotasks();

      expect(harness.microphone.audioTrack.stopped).toBe(false);
      expect(replacement.audioTrack.stopped).toBe(true);
      expect(harness.audioContexts.contexts[0]?.sources).toHaveLength(1);
      expect(harness.recorders).toHaveLength(2);
      await harness.controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a same-deadline device resolution win when it settles first', async () => {
    vi.useFakeTimers();
    try {
      const replacement = new FakeStream(true, 'USB microphone', 'mic-2');
      const pending = deferred<FakeStream>();
      const harness = await createSwitchHarness({
        openReplacement: () => pending.promise,
      });
      const switchPromise = harness.controller.prepareMicrophoneSwitch({
        deviceId: 'mic-2',
      });
      pending.resolve(replacement);
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(15_000);

      const prepared = await switchPromise;
      await harness.controller.commitSourceSwitch(prepared);
      expect(replacement.audioTrack.stopped).toBe(false);
      harness.controller.finalizeSourceSwitch(prepared);
      expect(harness.microphone.audioTrack.stopped).toBe(true);
      await harness.controller.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the active input when a prepared track ends before commit', async () => {
    const replacement = new FakeStream(true, 'USB microphone', 'mic-2');
    const harness = await createSwitchHarness({
      openReplacement: () => Promise.resolve(replacement),
    });
    const prepared = await harness.controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    replacement.audioTrack.end();

    await expect(
      harness.controller.commitSourceSwitch(prepared),
    ).rejects.toThrow('meeting capture source switch was cancelled');
    expect(harness.microphone.audioTrack.stopped).toBe(false);
    expect(replacement.audioTrack.stopped).toBe(true);
    expect(harness.audioContexts.contexts[0]?.sources[0]?.disconnect).not.toHaveBeenCalled();

    await harness.controller.stop();
  });

  it('keeps only the newest rapid microphone preparation', async () => {
    const first = deferred<FakeStream>();
    const firstReplacement = new FakeStream(true, 'First USB', 'mic-2');
    const secondReplacement = new FakeStream(true, 'Second USB', 'mic-3');
    const microphone = new FakeStream(true, 'Built-in microphone', 'mic-1');
    const display = new FakeStream(true, 'System audio', 'display-1');
    const getUserMedia = vi
      .fn()
      .mockResolvedValueOnce(microphone)
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(secondReplacement);
    const audioContexts = createAudioContextHarness();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia,
        getDisplayMedia: vi.fn().mockResolvedValue(display),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: (stream, options) =>
        new FakeRecorder(stream, options) as unknown as MediaRecorder,
      isTypeSupported: () => true,
      audioContextFactory: audioContexts.factory,
      pcmCaptureFactory: () => createPcmRuntime(),
      sink: {
        appendAudioChunk: vi.fn().mockResolvedValue(undefined),
        appendPcmChunk: vi.fn().mockResolvedValue(undefined),
      },
    });
    await controller.start({
      scope: {
        organizationId: 'org-1',
        userId: 'user-1',
        sessionId: 'session-1',
      },
    });

    const firstPromise = controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    const firstRejection = expect(firstPromise).rejects.toThrow(
      'meeting capture source switch was cancelled',
    );
    const secondPrepared = await controller.prepareMicrophoneSwitch({
      deviceId: 'mic-3',
    });
    await firstRejection;
    first.resolve(firstReplacement);
    await flushMicrotasks();
    await controller.commitSourceSwitch(secondPrepared);
    await controller.finalizeSourceSwitch(secondPrepared);

    expect(firstReplacement.audioTrack.stopped).toBe(true);
    expect(secondReplacement.audioTrack.stopped).toBe(false);
    expect(microphone.audioTrack.stopped).toBe(true);
    expect(audioContexts.contexts[0]?.sources).toHaveLength(2);
    await controller.stop();
  });

  it('preserves the active input when replacement preparation fails', async () => {
    const harness = await createSwitchHarness({
      openReplacement: () =>
        Promise.reject(new DOMException('denied', 'NotAllowedError')),
    });

    await expect(
      harness.controller.prepareMicrophoneSwitch({ deviceId: 'mic-2' }),
    ).rejects.toMatchObject({ name: 'NotAllowedError' });
    expect(harness.microphone.audioTrack.stopped).toBe(false);
    expect(harness.audioContexts.contexts[0]?.sources).toHaveLength(1);
    expect(
      harness.audioContexts.contexts[0]?.gains[0]?.gain.setValueAtTime,
    ).toHaveBeenLastCalledWith(1, 42);
    await harness.controller.stop();
  });

  it('stops immediately without waiting for a pending device request', async () => {
    const pending = deferred<FakeStream>();
    const replacement = new FakeStream(true, 'USB microphone', 'mic-2');
    const harness = await createSwitchHarness({
      openReplacement: () => pending.promise,
    });
    const preparePromise = harness.controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    const prepareRejection = expect(preparePromise).rejects.toThrow(
      'meeting capture source switch was cancelled',
    );

    await harness.controller.stop();
    await prepareRejection;
    expect(
      harness.recorders.every(
        (recorder) => recorder.stop.mock.calls.length === 1,
      ),
    ).toBe(true);
    pending.resolve(replacement);
    await flushMicrotasks();
    expect(replacement.audioTrack.stopped).toBe(true);
    expect(harness.controller.getState()).toBe('idle');
  });

  it('rolls back a committed switch when persistence fails', async () => {
    const replacement = new FakeStream(true, 'USB microphone', 'mic-2');
    const harness = await createSwitchHarness({
      openReplacement: () => Promise.resolve(replacement),
    });
    const recorder = harness.recorders[0];
    const destinationTrack = recorder?.stream.getAudioTracks()[0];
    const prepared = await harness.controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    await harness.controller.commitSourceSwitch(prepared);

    expect(harness.microphone.audioTrack.stopped).toBe(false);
    expect(replacement.audioTrack.stopped).toBe(false);
    const rolledBack = {
      source: 'local',
      sourceId: 'mic-1',
      label: 'Built-in microphone',
    } as const;
    expect(harness.controller.rollbackSourceSwitch(prepared)).toEqual(
      rolledBack,
    );
    expect(harness.controller.rollbackSourceSwitch(prepared)).toEqual(
      rolledBack,
    );
    expect(() => harness.controller.finalizeSourceSwitch(prepared)).toThrow(
      'meeting capture source switch was already rolled back',
    );
    expect(harness.microphone.audioTrack.stopped).toBe(false);
    expect(replacement.audioTrack.stopped).toBe(true);
    expect(harness.recorders[0]).toBe(recorder);
    expect(harness.recorders[0]?.stream.getAudioTracks()[0]).toBe(
      destinationTrack,
    );
    expect(
      harness.audioContexts.contexts[0]?.gains[0]?.gain.setValueAtTime,
    ).toHaveBeenLastCalledWith(1, 42);
    expect(
      harness.audioContexts.contexts[0]?.gains[1]?.gain.setValueAtTime,
    ).toHaveBeenLastCalledWith(0, 42);
    await harness.controller.stop();
  });

  it('finalizes a committed switch only after persistence succeeds', async () => {
    const replacement = new FakeStream(true, 'USB microphone', 'mic-2');
    const harness = await createSwitchHarness({
      openReplacement: () => Promise.resolve(replacement),
    });
    const prepared = await harness.controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    await harness.controller.commitSourceSwitch(prepared);

    expect(harness.microphone.audioTrack.stopped).toBe(false);
    const finalized = {
      source: 'local',
      sourceId: 'mic-2',
      label: 'USB microphone',
    } as const;
    expect(harness.controller.finalizeSourceSwitch(prepared)).toEqual(
      finalized,
    );
    expect(harness.controller.finalizeSourceSwitch(prepared)).toEqual(
      finalized,
    );
    expect(() => harness.controller.rollbackSourceSwitch(prepared)).toThrow(
      'meeting capture source switch was already finalized',
    );
    expect(harness.microphone.audioTrack.stopped).toBe(true);
    expect(replacement.audioTrack.stopped).toBe(false);
    await harness.controller.stop();
  });

  it('recovers a lost finalize response before accepting the next switch', async () => {
    const firstReplacement = new FakeStream(true, 'First USB', 'mic-2');
    const secondReplacement = new FakeStream(true, 'Second USB', 'mic-3');
    const replacements = [firstReplacement, secondReplacement];
    const harness = await createSwitchHarness({
      openReplacement: () => Promise.resolve(replacements.shift()!),
    });
    const firstPrepared = await harness.controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    await harness.controller.commitSourceSwitch(firstPrepared);
    const finalized = harness.controller.finalizeSourceSwitch(firstPrepared);
    expect(harness.controller.finalizeSourceSwitch(firstPrepared)).toEqual(
      finalized,
    );

    const secondPrepared = await harness.controller.prepareMicrophoneSwitch({
      deviceId: 'mic-3',
    });

    expect(harness.microphone.audioTrack.stopped).toBe(true);
    expect(firstReplacement.audioTrack.stopped).toBe(false);
    harness.controller.abortSourceSwitch(secondPrepared);
    expect(secondReplacement.audioTrack.stopped).toBe(true);
    await harness.controller.stop();
  });

  it('blocks prepare and stop while a committed transaction is unresolved', async () => {
    const replacement = new FakeStream(true, 'USB microphone', 'mic-2');
    const harness = await createSwitchHarness({
      openReplacement: () => Promise.resolve(replacement),
    });
    const prepared = await harness.controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    await harness.controller.commitSourceSwitch(prepared);

    await expect(
      harness.controller.prepareMicrophoneSwitch({ deviceId: 'mic-3' }),
    ).rejects.toThrow('meeting capture source switch is awaiting finalization');
    await expect(harness.controller.stop()).rejects.toThrow(
      'meeting capture source switch is awaiting transaction resolution',
    );
    expect(harness.controller.getState()).toBe('recording');
    expect(harness.microphone.audioTrack.stopped).toBe(false);
    expect(replacement.audioTrack.stopped).toBe(false);
    expect(
      harness.audioContexts.contexts[0]?.gains[0]?.gain.setValueAtTime,
    ).toHaveBeenLastCalledWith(0, 42);
    expect(
      harness.audioContexts.contexts[0]?.gains[1]?.gain.setValueAtTime,
    ).toHaveBeenLastCalledWith(1, 42);
    expect(
      harness.recorders.every(
        (candidate) => candidate.stop.mock.calls.length === 0,
      ),
    ).toBe(true);
    harness.controller.finalizeSourceSwitch(prepared);
    await harness.controller.stop();
    expect(replacement.audioTrack.stopped).toBe(true);
  });

  it('reports ended only for the currently committed source', async () => {
    const replacement = new FakeStream(true, 'USB microphone', 'mic-2');
    const harness = await createSwitchHarness({
      openReplacement: () => Promise.resolve(replacement),
    });
    const prepared = await harness.controller.prepareMicrophoneSwitch({
      deviceId: 'mic-2',
    });
    await harness.controller.commitSourceSwitch(prepared);

    harness.microphone.audioTrack.end();
    expect(harness.reportCaptureSourceEnded).not.toHaveBeenCalled();
    replacement.audioTrack.end();
    expect(harness.reportCaptureSourceEnded).toHaveBeenCalledOnce();
    expect(harness.reportCaptureSourceEnded).toHaveBeenCalledWith({
      organizationId: 'org-1',
      userId: 'user-1',
      sessionId: 'session-1',
      source: 'local',
      sourceId: 'mic-2',
      label: 'USB microphone',
    });
    harness.controller.finalizeSourceSwitch(prepared);
    await harness.controller.stop();
  });

  it('reports device-list changes without replacing the active capture', async () => {
    const mediaDeviceEvents = new EventTarget();
    const replacement = new FakeStream(true, 'Unused microphone', 'mic-2');
    const harness = await createSwitchHarness({
      openReplacement: () => Promise.resolve(replacement),
      mediaDeviceEvents,
    });

    mediaDeviceEvents.dispatchEvent(new Event('devicechange'));
    await flushMicrotasks();
    expect(harness.reportCaptureDevicesChanged).toHaveBeenCalledOnce();
    expect(harness.reportCaptureDevicesChanged).toHaveBeenCalledWith({
      changedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    });
    expect(harness.microphone.audioTrack.stopped).toBe(false);
    expect(harness.audioContexts.contexts[0]?.sources).toHaveLength(1);
    expect(harness.reportCaptureSourceEnded).not.toHaveBeenCalled();

    await harness.controller.stop();
    mediaDeviceEvents.dispatchEvent(new Event('devicechange'));
    expect(harness.reportCaptureDevicesChanged).toHaveBeenCalledOnce();
  });

  it('reports the active microphone unavailable when it disappears from the device list', async () => {
    const mediaDeviceEvents = new EventTarget();
    const harness = await createSwitchHarness({
      openReplacement: () =>
        Promise.resolve(new FakeStream(true, 'Unused microphone', 'mic-2')),
      mediaDeviceEvents,
      devices: [],
    });

    mediaDeviceEvents.dispatchEvent(new Event('devicechange'));
    await flushMicrotasks();

    expect(harness.reportCaptureDevicesChanged).toHaveBeenCalledOnce();
    expect(harness.reportCaptureSourceEnded).toHaveBeenCalledOnce();
    expect(harness.reportCaptureSourceEnded).toHaveBeenCalledWith(
      expect.objectContaining({
        source: 'local',
        sourceId: 'mic-1',
        label: 'Built-in microphone',
      }),
    );
    expect(harness.microphone.audioTrack.stopped).toBe(false);

    await harness.controller.stop();
  });

  it('fails closed when either required audio track is missing', async () => {
    const microphone = new FakeStream();
    const display = new FakeStream(false);
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(microphone),
        getDisplayMedia: vi.fn().mockResolvedValue(display),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: vi.fn(),
      isTypeSupported: () => true,
      sink: { appendAudioChunk: vi.fn(), appendPcmChunk: vi.fn() },
    });

    await expect(
      controller.start({
        scope: {
          organizationId: 'org-1',
          userId: 'user-1',
          sessionId: 'session-1',
        },
      }),
    ).rejects.toThrow('microphone and system audio tracks are both required');
    expect(controller.getState()).toBe('idle');
    expect(microphone.audioTrack.stopped).toBe(true);
    expect(display.videoTrack.stopped).toBe(true);
  });

  it('preserves the failing capture source and DOMException details', async () => {
    const microphone = new FakeStream();
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue(microphone),
        getDisplayMedia: vi
          .fn()
          .mockRejectedValue(
            new DOMException('permission denied', 'NotAllowedError'),
          ),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: vi.fn(),
      isTypeSupported: () => true,
      sink: { appendAudioChunk: vi.fn(), appendPcmChunk: vi.fn() },
    });

    await expect(
      controller.start({
        scope: {
          organizationId: 'org-1',
          userId: 'user-1',
          sessionId: 'session-1',
        },
      }),
    ).rejects.toThrow(
      'system audio capture failed: NotAllowedError: permission denied',
    );
    expect(controller.getState()).toBe('idle');
    expect(microphone.audioTrack.stopped).toBe(true);
  });
});
