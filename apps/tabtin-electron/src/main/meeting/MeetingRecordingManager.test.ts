import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingArchiveStore } from './MeetingArchiveStore';
import { MeetingRecordingManager } from './MeetingRecordingManager';
import type { MeetingServerSync } from './MeetingServerSync';

const scope = {
  organizationId: 'org-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

describe('MeetingRecordingManager', () => {
  let rootPath = '';
  let manager: MeetingRecordingManager;
  const onStatusChanged = vi.fn();
  const captureHost = {
    listMicrophones: vi.fn().mockResolvedValue([]),
    listSystemAudioSources: vi.fn().mockResolvedValue([
      {
        sourceId: 'main-display',
        label: 'System audio (main display)',
        isDefault: true,
      },
    ]),
    probe: vi.fn().mockResolvedValue({
      local: { available: true },
      remote: { available: true },
      microphones: [],
    }),
    testMicrophone: vi.fn().mockResolvedValue({
      available: true,
      deviceId: 'default',
      deviceLabel: 'Default microphone',
      measuredFrames: 80,
      nonSilentFrames: 40,
      maxRms: 0.2,
    }),
    switchMicrophone: vi.fn().mockResolvedValue({
      source: 'local',
      sourceId: 'mic-2',
      label: 'USB microphone',
    }),
    switchSystemAudio: vi.fn().mockResolvedValue({
      source: 'remote',
      sourceId: 'main-display',
      label: 'System audio (main display)',
    }),
    start: vi.fn().mockResolvedValue([
      {
        source: 'local',
        sourceId: 'built-in-mic',
        label: 'Built-in microphone',
      },
      {
        source: 'remote',
        sourceId: 'main-display',
        label: 'System audio (main display)',
      },
    ]),
    stop: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn(),
  };
  const asrRuntime = {
    start: vi.fn().mockResolvedValue(undefined),
    appendPcm: vi.fn(),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const createAsrRuntime = vi.fn(() => asrRuntime);

  beforeEach(async () => {
    rootPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-meeting-manager-'),
    );
    onStatusChanged.mockClear();
    for (const method of [
      'probe',
      'listMicrophones',
      'listSystemAudioSources',
      'testMicrophone',
      'switchMicrophone',
      'switchSystemAudio',
      'start',
      'stop',
      'destroy',
    ] as const) {
      captureHost[method].mockClear();
    }
    createAsrRuntime.mockClear();
    for (const method of [
      'start',
      'appendPcm',
      'stop',
    ] as const) {
      asrRuntime[method].mockClear();
    }
    manager = new MeetingRecordingManager({
      archiveStore: new MeetingArchiveStore({
        rootPath,
        finalizeMediaFile: async (inputPath, outputPath) => {
          await fs.copyFile(inputPath, outputPath);
        },
      }),
      onStatusChanged,
      captureHost,
      createAsrRuntime,
    });
  });

  afterEach(async () => {
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  it('owns the prepare, start, and stop lifecycle', async () => {
    expect(
      (
        await manager.prepare({
          ...scope,
          title: 'Product review',
          consentConfirmed: true,
        })
      ).manifest?.lifecycleStatus,
    ).toBe('preparing');
    const started = await manager.start(scope);
    expect(started.manifest).toMatchObject({
      lifecycleStatus: 'recording',
      microphoneDeviceId: 'built-in-mic',
      microphoneDeviceLabel: 'Built-in microphone',
    });
    const stopped = await manager.stop(scope);
    expect(stopped.active).toBe(false);
    expect(stopped.manifest?.lifecycleStatus).toBe('stopped');
    expect(onStatusChanged).toHaveBeenCalledTimes(3);
    expect(captureHost.start).toHaveBeenCalledWith(scope, {
      microphoneDeviceId: 'default',
    });
    expect(captureHost.stop).toHaveBeenCalledTimes(1);
    expect(asrRuntime.start).toHaveBeenCalledTimes(1);
    expect(asrRuntime.stop).toHaveBeenCalledTimes(1);
  });

  it('returns independent media readiness from the capture host', async () => {
    await expect(manager.probeMedia()).resolves.toEqual({
      local: { available: true },
      remote: { available: true },
      microphones: [],
    });
    expect(captureHost.probe).toHaveBeenCalledTimes(1);
  });

  it('switches capture sources during recording and persists the selection', async () => {
    await manager.prepare({
      ...scope,
      title: 'Device switch',
      consentConfirmed: true,
    });
    await manager.start(scope);

    const microphoneStatus = await manager.switchMicrophone({
      ...scope,
      deviceId: 'mic-2',
    });
    const systemStatus = await manager.switchSystemAudio({
      ...scope,
      sourceId: 'main-display',
    });

    expect(captureHost.switchMicrophone).toHaveBeenCalledWith('mic-2');
    expect(captureHost.switchSystemAudio).toHaveBeenCalledWith('main-display');
    expect(microphoneStatus.manifest).toMatchObject({
      microphoneDeviceId: 'mic-2',
      microphoneDeviceLabel: 'USB microphone',
    });
    expect(systemStatus.manifest).toMatchObject({
      systemAudioSourceId: 'main-display',
      systemAudioSourceLabel: 'System audio (main display)',
    });
  });

  it('releases the lifecycle queue when a capture source switch hangs', async () => {
    captureHost.switchMicrophone.mockImplementationOnce(
      () => new Promise(() => undefined),
    );
    manager = new MeetingRecordingManager({
      archiveStore: new MeetingArchiveStore({
        rootPath,
        finalizeMediaFile: async (inputPath, outputPath) => {
          await fs.copyFile(inputPath, outputPath);
        },
      }),
      captureHost,
      createAsrRuntime,
      sourceSwitchTimeoutMs: 10,
    });
    await manager.prepare({
      ...scope,
      title: 'Hung device switch',
      consentConfirmed: true,
    });
    await manager.start(scope);

    await expect(
      manager.switchMicrophone({ ...scope, deviceId: 'mic-hung' }),
    ).rejects.toThrow('meeting capture source switch timed out');
    await expect(
      manager.switchSystemAudio({ ...scope, sourceId: 'main-display' }),
    ).resolves.toMatchObject({
      manifest: { lifecycleStatus: 'recording' },
    });
    expect(captureHost.switchSystemAudio).toHaveBeenCalledTimes(1);
  });

  it('rejects a second active meeting', async () => {
    await manager.prepare({ ...scope, title: 'First', consentConfirmed: true });

    await expect(
      manager.prepare({
        ...scope,
        sessionId: 'session-2',
        title: 'Second',
        consentConfirmed: true,
      }),
    ).rejects.toThrow('another meeting recording is already active');
  });

  it('accepts chunks only while recording', async () => {
    await manager.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    const input = {
      ...scope,
      source: 'local' as const,
      bytes: new Uint8Array([1, 2]),
      durationMs: 200,
      sampleRate: 16_000,
      channelCount: 1,
      codec: 'pcm_s16le',
      container: 'pcm',
    };

    await expect(manager.appendAudioChunk(input)).rejects.toThrow(
      'audio chunks are accepted only while recording',
    );
    await manager.start(scope);
    await expect(manager.appendAudioChunk(input)).resolves.toMatchObject({
      manifest: { tracks: { local: { bytes: 2 } } },
    });
  });

  it('keeps transcript checkpoints independent from audio chunks', async () => {
    await manager.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    await manager.start(scope);

    await expect(
      manager.appendTranscriptCheckpoint(scope, {
        externalId: 'segment-1',
        source: 'remote',
        startMs: 0,
        endMs: 800,
        text: 'Question',
        isFinal: true,
        recordedAt: new Date().toISOString(),
      }),
    ).resolves.toBeUndefined();
  });

  it('forwards source-specific PCM to ASR without writing it as archive audio', async () => {
    await manager.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    await manager.start(scope);

    manager.appendPcmChunk({
      ...scope,
      source: 'remote',
      bytes: new Uint8Array([1, 2, 3]),
      sampleRate: 16_000,
      channelCount: 1,
    });

    expect(asrRuntime.appendPcm).toHaveBeenCalledWith(
      'remote',
      new Uint8Array([1, 2, 3]),
    );
    expect((await manager.getArchive(scope)).manifest.tracks.remote.bytes).toBe(
      0,
    );
  });

  it('queues the first PCM chunk while the capture host is still preparing', async () => {
    await manager.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    captureHost.start.mockImplementationOnce(async () => {
      manager.appendPcmChunk({
        ...scope,
        source: 'local',
        bytes: new Uint8Array([4, 5]),
        sampleRate: 16_000,
        channelCount: 1,
      });
    });

    await manager.start(scope);

    expect(asrRuntime.appendPcm).toHaveBeenCalledWith(
      'local',
      new Uint8Array([4, 5]),
    );
  });

  it('lets MediaRecorder flush its final chunk before the stopped state', async () => {
    await manager.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    await manager.start(scope);
    captureHost.stop.mockImplementationOnce(async () => {
      await manager.appendAudioChunk({
        ...scope,
        source: 'remote',
        bytes: new Uint8Array([5, 6, 7]),
        durationMs: 120,
        sampleRate: 48_000,
        channelCount: 1,
        codec: 'opus',
        container: 'webm',
      });
    });

    const stopped = await manager.stop(scope);

    expect(stopped.manifest?.lifecycleStatus).toBe('stopped');
    expect(stopped.manifest?.tracks.remote.bytes).toBe(3);
    expect(stopped.manifest?.tracks.remote.status).toBe('completed');
  });

  it('projects lifecycle, tracks, transcript, and Copilot to the ordered server queue', async () => {
    const flushResult = {
      sessionId: scope.sessionId,
      status: 'synced' as const,
      syncedCount: 1,
      pendingCount: 0,
    };
    const serverSync = {
      createSession: vi.fn(),
      updateLifecycle: vi.fn(),
      createTranscriptRun: vi.fn(),
      checkpointTrack: vi.fn(),
      upsertTranscriptSegments: vi.fn(),
      updateTranscriptRun: vi.fn(),
      updateCopilotState: vi.fn(),
      flushSession: vi.fn().mockResolvedValue(flushResult),
      retrySession: vi.fn().mockResolvedValue(flushResult),
    } as unknown as MeetingServerSync;
    const syncManager = new MeetingRecordingManager({
      archiveStore: new MeetingArchiveStore({
        rootPath,
        finalizeMediaFile: async (inputPath, outputPath) => {
          await fs.copyFile(inputPath, outputPath);
        },
      }),
      captureHost,
      createAsrRuntime,
      serverSync,
    });

    await syncManager.prepare({
      ...scope,
      projectId: 'project-1',
      title: 'Synced meeting',
      brief: 'Decision review',
      consentConfirmed: true,
      copilotEnabled: false,
    });
    await syncManager.start(scope);
    await syncManager.appendAudioChunk({
      ...scope,
      source: 'local',
      bytes: new Uint8Array([1, 2, 3]),
      durationMs: 200,
      sampleRate: 48_000,
      channelCount: 1,
      codec: 'opus',
      container: 'webm',
    });
    await syncManager.appendTranscriptCheckpoint(scope, {
      externalId: 'local-1',
      source: 'local',
      startMs: 0,
      endMs: 200,
      text: 'hello',
      isFinal: true,
      recordedAt: '2026-08-26T00:00:00.000Z',
    });
    await syncManager.setCopilotEnabled(scope, true);
    await syncManager.stop(scope);
    await syncManager.retryActiveServerSync();

    expect(serverSync.createSession).toHaveBeenCalledWith(
      expect.objectContaining({
        id: scope.sessionId,
        projectId: 'project-1',
        consentConfirmed: true,
      }),
    );
    expect(serverSync.createTranscriptRun).toHaveBeenCalledTimes(1);
    expect(serverSync.createTranscriptRun).toHaveBeenCalledWith(
      scope.sessionId,
      expect.objectContaining({
        provider: 'byteplus',
        model: 'bigmodel',
      }),
    );
    expect(serverSync.checkpointTrack).toHaveBeenCalledWith(
      scope.sessionId,
      expect.objectContaining({ source: 'local', localAvailable: true }),
    );
    expect(serverSync.upsertTranscriptSegments).toHaveBeenCalledWith(
      scope.sessionId,
      expect.any(String),
      [expect.objectContaining({ externalId: 'local-1', isFinal: true })],
    );
    expect(serverSync.updateCopilotState).toHaveBeenCalledWith(
      scope.sessionId,
      { enabled: true },
    );
    expect(serverSync.updateLifecycle).toHaveBeenLastCalledWith(
      scope.sessionId,
      expect.objectContaining({ status: 'stopped' }),
    );
  });

  it('does not put a slow Copilot answer request on the recording control queue', async () => {
    let resolveAnswer!: (value: { status: 'failed'; message: string }) => void;
    const answerPromise = new Promise<{
      status: 'failed';
      message: string;
    }>((resolve) => {
      resolveAnswer = resolve;
    });
    const flushResult = {
      sessionId: scope.sessionId,
      status: 'synced' as const,
      syncedCount: 1,
      pendingCount: 0,
    };
    const serverSync = {
      createSession: vi.fn(),
      updateLifecycle: vi.fn(),
      createTranscriptRun: vi.fn(),
      checkpointTrack: vi.fn(),
      upsertTranscriptSegments: vi.fn(),
      updateTranscriptRun: vi.fn(),
      updateCopilotState: vi.fn(),
      answerCopilot: vi.fn(() => answerPromise),
      flushSession: vi.fn().mockResolvedValue(flushResult),
      retrySession: vi.fn().mockResolvedValue(flushResult),
    } as unknown as MeetingServerSync;
    const syncManager = new MeetingRecordingManager({
      archiveStore: new MeetingArchiveStore({
        rootPath,
        finalizeMediaFile: async (inputPath, outputPath) => {
          await fs.copyFile(inputPath, outputPath);
        },
      }),
      captureHost,
      createAsrRuntime,
      serverSync,
    });

    await syncManager.prepare({
      ...scope,
      title: 'Copilot isolation',
      consentConfirmed: true,
      copilotEnabled: true,
    });
    await syncManager.start(scope);
    await syncManager.appendTranscriptCheckpoint(scope, {
      externalId: 'question-1',
      source: 'remote',
      startMs: 1_000,
      endMs: 2_000,
      text: 'Can we deliver Friday?',
      isFinal: true,
      recordedAt: '2026-08-26T00:00:00.000Z',
    });
    const pendingAnswer = syncManager.answerCopilotQuestion(
      scope,
      'question-1',
    );
    await vi.waitFor(() => expect(serverSync.answerCopilot).toHaveBeenCalled());
    expect(serverSync.answerCopilot).toHaveBeenCalledWith(
      scope.sessionId,
      expect.any(Array),
      'question-1',
      '',
    );

    await expect(syncManager.stop(scope)).resolves.toMatchObject({
      manifest: { lifecycleStatus: 'stopped' },
    });
    resolveAnswer({
      status: 'failed',
      message: 'model timeout',
    });
    await expect(pendingAnswer).resolves.toEqual({
      status: 'failed',
      message: 'model timeout',
    });
  });
});
