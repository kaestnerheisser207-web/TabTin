import { describe, expect, it, vi } from 'vitest';

import {
  MeetingCaptureController,
  chooseMeetingAudioMimeType,
} from './MeetingCaptureController';

class FakeTrack {
  stopped = false;
  constructor(
    readonly label = 'USB microphone',
    private readonly deviceId = 'mic-2',
  ) {}
  stop() {
    this.stopped = true;
  }
  getSettings() {
    return { sampleRate: 48_000, channelCount: 1, deviceId: this.deviceId };
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
      isTypeSupported: () => true,
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

  it('falls back to the system default when a selected microphone disappears', async () => {
    const fallbackMicrophone = new FakeStream(
      true,
      'Built-in microphone',
      'built-in-mic',
    );
    const display = new FakeStream(true, 'System audio', 'display-1');
    const getUserMedia = vi
      .fn()
      .mockRejectedValueOnce(
        new DOMException('selected device disappeared', 'OverconstrainedError'),
      )
      .mockResolvedValueOnce(fallbackMicrophone);
    const controller = new MeetingCaptureController({
      mediaDevices: {
        getUserMedia,
        getDisplayMedia: vi.fn().mockResolvedValue(display),
        enumerateDevices: vi.fn().mockResolvedValue([]),
      },
      mediaRecorderFactory: (stream, options) =>
        new FakeRecorder(stream, options) as unknown as MediaRecorder,
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
      isTypeSupported: () => true,
      pcmCaptureFactory: () => createPcmRuntime(),
      sink: {
        appendAudioChunk: vi.fn().mockResolvedValue(undefined),
        appendPcmChunk: vi.fn().mockResolvedValue(undefined),
      },
    });

    const selections = await controller.start({
      scope: {
        organizationId: 'org-1',
        userId: 'user-1',
        sessionId: 'session-1',
      },
      microphoneDeviceId: 'continuity-phone-mic',
    });

    expect(getUserMedia).toHaveBeenNthCalledWith(1, {
      audio: expect.objectContaining({
        deviceId: { exact: 'continuity-phone-mic' },
      }),
      video: false,
    });
    expect(getUserMedia).toHaveBeenNthCalledWith(2, {
      audio: expect.not.objectContaining({ deviceId: expect.anything() }),
      video: false,
    });
    expect(selections[0]).toEqual({
      source: 'local',
      sourceId: 'built-in-mic',
      label: 'Built-in microphone',
    });
    await controller.stop();
  });

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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
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
        mediaStreamFactory: (tracks) =>
          ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
      isTypeSupported: () => true,
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
      isTypeSupported: () => true,
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
      microphoneDeviceId: 'mic-1',
    });

    await expect(
      controller.switchMicrophone({ deviceId: 'mic-2' }),
    ).resolves.toEqual({
      source: 'local',
      sourceId: 'mic-2',
      label: 'USB microphone',
    });
    expect(microphone.audioTrack.stopped).toBe(true);
    expect(replacementMicrophone.audioTrack.stopped).toBe(false);

    await expect(
      controller.switchSystemAudio({ sourceId: 'main-display' }),
    ).resolves.toEqual({
      source: 'remote',
      sourceId: 'main-display',
      label: 'System audio',
    });
    expect(display.audioTrack.stopped).toBe(true);
    expect(replacementDisplay.audioTrack.stopped).toBe(false);
    expect(recorders).toHaveLength(4);
    expect(controller.getState()).toBe('recording');

    await controller.stop();
    expect(replacementMicrophone.audioTrack.stopped).toBe(true);
    expect(replacementDisplay.audioTrack.stopped).toBe(true);
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
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
      mediaStreamFactory: (tracks) =>
        ({ getAudioTracks: () => tracks }) as unknown as MediaStream,
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
