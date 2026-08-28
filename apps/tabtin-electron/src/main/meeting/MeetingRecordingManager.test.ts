import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingArchiveStore } from './MeetingArchiveStore';
import { MeetingRecordingManager } from './MeetingRecordingManager';
import {
  MeetingServerRequestError,
  type MeetingServerSync,
} from './MeetingServerSync';
import type { MeetingAudioUploader } from './MeetingAudioUploader';

const scope = {
  organizationId: 'org-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

describe('MeetingRecordingManager', () => {
  let rootPath = '';
  let manager: MeetingRecordingManager;
  const onStatusChanged = vi.fn();
  const onTranscriptChanged = vi.fn();
  const onCaptureSourceNotice = vi.fn();
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
    prepareMicrophoneSwitch: vi.fn().mockResolvedValue({
      operationId: 'local-op-1',
      source: 'local',
      sourceId: 'mic-2',
      label: 'USB microphone',
    }),
    prepareSystemAudioSwitch: vi.fn().mockResolvedValue({
      operationId: 'remote-op-1',
      source: 'remote',
      sourceId: 'main-display',
      label: 'System audio (main display)',
    }),
    commitSourceSwitch: vi.fn().mockImplementation(
      async (input: { source: 'local' | 'remote' }) =>
        input.source === 'local'
          ? {
              source: 'local' as const,
              sourceId: 'mic-2',
              label: 'USB microphone',
            }
          : {
              source: 'remote' as const,
              sourceId: 'main-display',
              label: 'System audio (main display)',
            },
    ),
    abortSourceSwitch: vi.fn().mockResolvedValue(undefined),
    finalizeSourceSwitch: vi.fn().mockImplementation(
      async (input: { source: 'local' | 'remote' }) =>
        input.source === 'local'
          ? {
              source: 'local' as const,
              sourceId: 'mic-2',
              label: 'USB microphone',
            }
          : {
              source: 'remote' as const,
              sourceId: 'main-display',
              label: 'System audio (main display)',
            },
    ),
    rollbackSourceSwitch: vi.fn().mockResolvedValue({
      source: 'local' as const,
      sourceId: 'built-in-mic',
      label: 'Built-in microphone',
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
    onTranscriptChanged.mockClear();
    onCaptureSourceNotice.mockClear();
    for (const method of [
      'probe',
      'listMicrophones',
      'listSystemAudioSources',
      'testMicrophone',
      'prepareMicrophoneSwitch',
      'prepareSystemAudioSwitch',
      'commitSourceSwitch',
      'abortSourceSwitch',
      'finalizeSourceSwitch',
      'rollbackSourceSwitch',
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
      onTranscriptChanged,
      onCaptureSourceNotice,
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

  it('uploads finalized tracks and persists the exact server file binding', async () => {
    const serverSync = {
      createSession: vi.fn(),
      updateLifecycle: vi.fn(),
      createTranscriptRun: vi.fn(),
      updateTranscriptRun: vi.fn(),
      checkpointTrack: vi.fn(),
      flushSession: vi.fn().mockResolvedValue({
        sessionId: scope.sessionId,
        status: 'synced',
        syncedCount: 1,
        pendingCount: 0,
      }),
      retrySession: vi.fn().mockResolvedValue({
        sessionId: scope.sessionId,
        status: 'synced',
        syncedCount: 0,
        pendingCount: 0,
      }),
    } as unknown as MeetingServerSync;
    const audioUploader = {
      uploadTrack: vi
        .fn()
        .mockImplementation(async (input: { source: 'local' | 'remote' }) => ({
          fileId: `file-${input.source}`,
          fileName: `${input.source}.webm`,
          fileKey: `meeting/org-1/session-1/${input.source}.webm`,
          fileSize: 4,
          accessUrl: '',
          cdnUrl: '',
        })),
      confirmTrack: vi.fn(),
    } as unknown as MeetingAudioUploader;
    const archiveStore = new MeetingArchiveStore({
      rootPath,
      finalizeMediaFile: async (inputPath, outputPath) => {
        await fs.copyFile(inputPath, outputPath);
      },
    });
    const syncManager = new MeetingRecordingManager({
      archiveStore,
      captureHost,
      createAsrRuntime,
      serverSync,
      audioUploader,
    });
    await syncManager.prepare({
      ...scope,
      title: 'Cloud archive',
      consentConfirmed: true,
    });
    await syncManager.start(scope);
    for (const source of ['local', 'remote'] as const) {
      await syncManager.appendAudioChunk({
        ...scope,
        source,
        bytes: new TextEncoder().encode('test'),
        durationMs: 1_000,
        sampleRate: 48_000,
        channelCount: 1,
        codec: 'opus',
        container: 'webm',
      });
    }
    await syncManager.stop(scope);

    await vi.waitFor(() => expect(audioUploader.uploadTrack).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () => {
      const manifest = await archiveStore.readManifest(scope);
      expect(manifest.tracks.local).toMatchObject({
        storageStatus: 'synced',
        fileRecordId: 'file-local',
      });
      expect(manifest.tracks.remote).toMatchObject({
        storageStatus: 'synced',
        fileRecordId: 'file-remote',
      });
    });
    expect(serverSync.checkpointTrack).toHaveBeenCalledWith(
      scope.sessionId,
      expect.objectContaining({
        source: 'local',
        storageStatus: 'synced',
        fileRecordId: 'file-local',
      }),
    );
  });

  it('opens a server-only archive on another device', async () => {
    const remoteSession = {
      id: scope.sessionId,
      version: 2,
      organization_id: scope.organizationId,
      project_id: null,
      title: 'Remote archive',
      brief: 'Stored on the VPS',
      lifecycle_status: 'stopped',
      copilot_initially_enabled: false,
      copilot_enabled: false,
      duration_ms: 5_000,
      created_at: '2026-08-28T00:00:00.000Z',
      started_at: '2026-08-28T00:00:00.000Z',
      ended_at: '2026-08-28T00:00:05.000Z',
      tracks: [
        {
          source: 'local',
          capture_status: 'completed',
          storage_status: 'synced',
          duration_ms: 5_000,
          file_size: 100,
          file_record_id: 'file-local',
          codec: 'opus',
          container: 'webm',
        },
        {
          source: 'remote',
          capture_status: 'completed',
          storage_status: 'synced',
          duration_ms: 5_000,
          file_size: 100,
          file_record_id: 'file-remote',
          codec: 'opus',
          container: 'webm',
        },
      ],
    };
    const serverSync = {
      listSessions: vi.fn().mockResolvedValue([remoteSession]),
      getSession: vi.fn().mockResolvedValue(remoteSession),
      getTranscript: vi.fn().mockResolvedValue({
        runs: [],
        segments: [
          {
            external_id: 'remote-segment',
            source: 'remote',
            start_ms: 1_000,
            end_ms: 2_000,
            display_text: 'Can we open this on another device?',
            is_final: true,
            created_at: '2026-08-28T00:00:02.000Z',
          },
        ],
        total: 1,
        offset: 0,
        limit: 1_000,
        next_offset: null,
      }),
      getTrackAudio: vi
        .fn()
        .mockImplementation(async (_sessionId: string, source: string) => ({
          track: {},
          url: `https://vps.example.test/audio/${source}`,
          access_mode: 'signed',
          expires_at: null,
          expires_in: 3_600,
        })),
    } as unknown as MeetingServerSync;
    const remoteManager = new MeetingRecordingManager({
      archiveStore: new MeetingArchiveStore({ rootPath }),
      serverSync,
    });

    await expect(
      remoteManager.listArchives({
        organizationId: scope.organizationId,
        userId: scope.userId,
      }),
    ).resolves.toMatchObject([
      { manifest: { sessionId: scope.sessionId, title: 'Remote archive' } },
    ]);
    await expect(remoteManager.getArchive(scope)).resolves.toMatchObject({
      manifest: {
        sessionId: scope.sessionId,
        serverSyncStatus: 'synced',
      },
      transcript: [
        {
          externalId: 'remote-segment',
          text: 'Can we open this on another device?',
        },
      ],
      audioUrls: {
        local: 'https://vps.example.test/audio/local',
        remote: 'https://vps.example.test/audio/remote',
      },
    });
  });

  it('rejects and removes a server-backed local cache after remote deletion', async () => {
    const archiveStore = new MeetingArchiveStore({ rootPath });
    await archiveStore.prepare({
      ...scope,
      title: 'Deleted elsewhere',
      consentConfirmed: true,
    });
    for (const source of ['local', 'remote'] as const) {
      await archiveStore.updateTrackUploadState(scope, source, {
        storageStatus: 'synced',
        fileRecordId: `file-${source}`,
      });
    }
    const serverSync = {
      getSession: vi.fn().mockRejectedValue(
        new MeetingServerRequestError({
          message: 'meeting session not found',
          reason: 'http',
          status: 404,
        }),
      ),
    } as unknown as MeetingServerSync;
    const remoteManager = new MeetingRecordingManager({
      archiveStore,
      serverSync,
    });

    await expect(remoteManager.getArchive(scope)).rejects.toThrow(
      'meeting archive not found',
    );
    await expect(archiveStore.readManifest(scope)).rejects.toThrow();
  });

  it('flushes active capture on exit and finalizes interrupted parts on restart', async () => {
    await manager.prepare({
      ...scope,
      title: 'Update interruption',
      consentConfirmed: true,
    });
    await manager.start(scope);
    for (const source of ['local', 'remote'] as const) {
      await manager.appendAudioChunk({
        ...scope,
        source,
        bytes: new Uint8Array(source === 'local' ? [1, 2] : [3, 4]),
        durationMs: 1_000,
        sampleRate: 48_000,
        channelCount: 1,
        codec: 'opus',
        container: 'webm',
      });
    }

    await manager.interruptForShutdown();

    expect(captureHost.stop).toHaveBeenCalledTimes(1);
    expect(asrRuntime.stop).toHaveBeenCalledTimes(1);
    expect(manager.getStatus().manifest?.lifecycleStatus).toBe('interrupted');

    const restarted = new MeetingRecordingManager({
      archiveStore: new MeetingArchiveStore({
        rootPath,
        finalizeMediaFile: async (inputPath, outputPath) => {
          await fs.copyFile(inputPath, outputPath);
        },
      }),
    });
    await restarted.recoverInterrupted();
    const archive = await restarted.getArchive(scope);
    expect(archive.audioUrls).toMatchObject({
      local: expect.stringContaining('local.webm'),
      remote: expect.stringContaining('remote.webm'),
    });
    expect(archive.manifest.lifecycleStatus).toBe('interrupted');
  });

  it('interrupts recording and stops ASR when the capture renderer terminates', async () => {
    await manager.prepare({
      ...scope,
      title: 'Capture renderer failure',
      consentConfirmed: true,
    });
    await manager.start(scope);
    await manager.appendAudioChunk({
      ...scope,
      source: 'local',
      bytes: new Uint8Array([1, 2, 3]),
      durationMs: 1_000,
      sampleRate: 48_000,
      channelCount: 1,
      codec: 'opus',
      container: 'webm',
    });

    await manager.interruptForCaptureTermination();

    expect(captureHost.stop).not.toHaveBeenCalled();
    expect(asrRuntime.stop).toHaveBeenCalledTimes(1);
    await manager.interruptForCaptureTermination();
    expect(asrRuntime.stop).toHaveBeenCalledTimes(1);
    expect(manager.getStatus()).toMatchObject({
      active: false,
      manifest: {
        lifecycleStatus: 'interrupted',
        tracks: { local: { bytes: 3, status: 'interrupted' } },
      },
    });
  });

  it('recovers orphaned parts from an already interrupted zero-byte manifest', async () => {
    const archiveStore = new MeetingArchiveStore({
      rootPath,
      finalizeMediaFile: async (inputPath, outputPath) => {
        await fs.copyFile(inputPath, outputPath);
      },
    });
    await archiveStore.prepare({
      ...scope,
      title: 'Orphan part recovery',
      consentConfirmed: true,
    });
    await archiveStore.updateLifecycle(scope, 'recording');
    await fs.writeFile(
      path.join(
        rootPath,
        'org-1/user-1/session-1/local/00000001.webm.part',
      ),
      new Uint8Array([1, 2, 3]),
    );
    await archiveStore.recoverInterrupted();
    const interrupted = await archiveStore.readManifest(scope);
    expect(interrupted.lifecycleStatus).toBe('interrupted');
    expect(interrupted.tracks.local.bytes).toBe(0);

    const restarted = new MeetingRecordingManager({ archiveStore });
    await restarted.recoverInterrupted();
    const recovered = await restarted.getArchive(scope);

    expect(recovered.audioUrls.local).toContain('local.webm');
    expect(recovered.manifest.tracks.local.status).toBe('interrupted');
    const contentHash = recovered.manifest.tracks.local.contentHash;
    await expect(restarted.recoverInterrupted()).resolves.toEqual([]);
    expect(
      (await restarted.getArchive(scope)).manifest.tracks.local.contentHash,
    ).toBe(contentHash);
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

    expect(captureHost.prepareMicrophoneSwitch).toHaveBeenCalledWith('mic-2');
    expect(captureHost.prepareSystemAudioSwitch).toHaveBeenCalledWith(
      'main-display',
    );
    expect(captureHost.commitSourceSwitch).toHaveBeenNthCalledWith(1, {
      operationId: 'local-op-1',
      source: 'local',
    });
    expect(captureHost.commitSourceSwitch).toHaveBeenNthCalledWith(2, {
      operationId: 'remote-op-1',
      source: 'remote',
    });
    expect(captureHost.finalizeSourceSwitch).toHaveBeenNthCalledWith(1, {
      operationId: 'local-op-1',
      source: 'local',
    });
    expect(captureHost.finalizeSourceSwitch).toHaveBeenNthCalledWith(2, {
      operationId: 'remote-op-1',
      source: 'remote',
    });
    expect(captureHost.rollbackSourceSwitch).not.toHaveBeenCalled();
    expect(microphoneStatus.manifest).toMatchObject({
      microphoneDeviceId: 'mic-2',
      microphoneDeviceLabel: 'USB microphone',
    });
    expect(systemStatus.manifest).toMatchObject({
      systemAudioSourceId: 'main-display',
      systemAudioSourceLabel: 'System audio (main display)',
    });
  });

  it('rolls back a committed source when manifest persistence fails', async () => {
    const archiveStore = new MeetingArchiveStore({
      rootPath,
      finalizeMediaFile: async (inputPath, outputPath) => {
        await fs.copyFile(inputPath, outputPath);
      },
    });
    manager = new MeetingRecordingManager({
      archiveStore,
      captureHost,
      createAsrRuntime,
    });
    await manager.prepare({
      ...scope,
      title: 'Source persistence failure',
      consentConfirmed: true,
    });
    await manager.start(scope);
    vi.spyOn(archiveStore, 'updateCaptureSource').mockRejectedValueOnce(
      new Error('manifest write failed'),
    );

    await expect(
      manager.switchMicrophone({ ...scope, deviceId: 'mic-2' }),
    ).rejects.toThrow('manifest write failed');

    expect(captureHost.commitSourceSwitch).toHaveBeenCalledWith({
      operationId: 'local-op-1',
      source: 'local',
    });
    expect(captureHost.rollbackSourceSwitch).toHaveBeenCalledOnce();
    expect(captureHost.rollbackSourceSwitch).toHaveBeenCalledWith({
      operationId: 'local-op-1',
      source: 'local',
    });
    expect(captureHost.finalizeSourceSwitch).not.toHaveBeenCalled();
    expect(captureHost.abortSourceSwitch).not.toHaveBeenCalled();
    expect(manager.getStatus().manifest).toMatchObject({
      lifecycleStatus: 'recording',
      microphoneDeviceId: 'built-in-mic',
      microphoneDeviceLabel: 'Built-in microphone',
    });
  });

  it('keeps a persisted source successful when finalization cleanup fails', async () => {
    captureHost.finalizeSourceSwitch.mockRejectedValueOnce(
      new Error('finalize response was lost'),
    );
    await manager.prepare({
      ...scope,
      title: 'Source finalize failure',
      consentConfirmed: true,
    });
    await manager.start(scope);

    await expect(
      manager.switchMicrophone({ ...scope, deviceId: 'mic-2' }),
    ).resolves.toMatchObject({
      manifest: {
        lifecycleStatus: 'recording',
        microphoneDeviceId: 'mic-2',
        microphoneDeviceLabel: 'USB microphone',
      },
    });
    expect(captureHost.finalizeSourceSwitch).toHaveBeenCalledOnce();
    expect(captureHost.rollbackSourceSwitch).not.toHaveBeenCalled();
    expect(captureHost.abortSourceSwitch).not.toHaveBeenCalled();
  });

  it('retries the same rollback intent before the next source preparation', async () => {
    const archiveStore = new MeetingArchiveStore({
      rootPath,
      finalizeMediaFile: async (inputPath, outputPath) => {
        await fs.copyFile(inputPath, outputPath);
      },
    });
    manager = new MeetingRecordingManager({
      archiveStore,
      captureHost,
      createAsrRuntime,
    });
    await manager.prepare({
      ...scope,
      title: 'Rollback response loss',
      consentConfirmed: true,
    });
    await manager.start(scope);
    vi.spyOn(archiveStore, 'updateCaptureSource').mockRejectedValueOnce(
      new Error('manifest write failed'),
    );
    captureHost.rollbackSourceSwitch.mockRejectedValueOnce(
      new Error('rollback response was lost'),
    );

    await expect(
      manager.switchMicrophone({ ...scope, deviceId: 'mic-2' }),
    ).rejects.toThrow('manifest write failed');
    captureHost.prepareMicrophoneSwitch.mockRejectedValueOnce(
      new Error('next preparation stopped'),
    );
    await expect(
      manager.switchMicrophone({ ...scope, deviceId: 'mic-3' }),
    ).rejects.toThrow('next preparation stopped');

    expect(captureHost.rollbackSourceSwitch).toHaveBeenCalledTimes(2);
    expect(captureHost.finalizeSourceSwitch).not.toHaveBeenCalled();
    expect(
      captureHost.rollbackSourceSwitch.mock.invocationCallOrder[1],
    ).toBeLessThan(
      captureHost.prepareMicrophoneSwitch.mock.invocationCallOrder[1]!,
    );
    expect(manager.getStatus().manifest).toMatchObject({
      lifecycleStatus: 'recording',
      microphoneDeviceId: 'built-in-mic',
      microphoneDeviceLabel: 'Built-in microphone',
    });
  });

  it('retries a lost rollback response before recorder stop', async () => {
    const archiveStore = new MeetingArchiveStore({
      rootPath,
      finalizeMediaFile: async (inputPath, outputPath) => {
        await fs.copyFile(inputPath, outputPath);
      },
    });
    manager = new MeetingRecordingManager({
      archiveStore,
      captureHost,
      createAsrRuntime,
    });
    await manager.prepare({
      ...scope,
      title: 'Rollback retry before stop',
      consentConfirmed: true,
    });
    await manager.start(scope);
    vi.spyOn(archiveStore, 'updateCaptureSource').mockRejectedValueOnce(
      new Error('manifest write failed'),
    );
    captureHost.rollbackSourceSwitch.mockRejectedValueOnce(
      new Error('rollback response was lost'),
    );

    await expect(
      manager.switchMicrophone({ ...scope, deviceId: 'mic-2' }),
    ).rejects.toThrow('manifest write failed');
    await expect(manager.stop(scope)).resolves.toMatchObject({
      manifest: {
        lifecycleStatus: 'stopped',
        microphoneDeviceId: 'built-in-mic',
      },
    });

    expect(captureHost.rollbackSourceSwitch).toHaveBeenCalledTimes(2);
    expect(captureHost.finalizeSourceSwitch).not.toHaveBeenCalled();
    expect(
      captureHost.rollbackSourceSwitch.mock.invocationCallOrder[1],
    ).toBeLessThan(captureHost.stop.mock.invocationCallOrder[0]!);
  });

  it('retries the same finalize intent before the next source preparation', async () => {
    captureHost.finalizeSourceSwitch.mockRejectedValueOnce(
      new Error('finalize response was lost'),
    );
    await manager.prepare({
      ...scope,
      title: 'Finalize response loss',
      consentConfirmed: true,
    });
    await manager.start(scope);

    await expect(
      manager.switchMicrophone({ ...scope, deviceId: 'mic-2' }),
    ).resolves.toMatchObject({
      manifest: { microphoneDeviceId: 'mic-2' },
    });
    captureHost.prepareMicrophoneSwitch.mockRejectedValueOnce(
      new Error('next preparation stopped'),
    );
    await expect(
      manager.switchMicrophone({ ...scope, deviceId: 'mic-3' }),
    ).rejects.toThrow('next preparation stopped');

    expect(captureHost.finalizeSourceSwitch).toHaveBeenCalledTimes(2);
    expect(captureHost.rollbackSourceSwitch).not.toHaveBeenCalled();
    expect(
      captureHost.finalizeSourceSwitch.mock.invocationCallOrder[1],
    ).toBeLessThan(
      captureHost.prepareMicrophoneSwitch.mock.invocationCallOrder[1]!,
    );
    expect(manager.getStatus().manifest).toMatchObject({
      lifecycleStatus: 'recording',
      microphoneDeviceId: 'mic-2',
    });
  });

  it('waits for source persistence and finalize before stopping capture', async () => {
    const archiveStore = new MeetingArchiveStore({
      rootPath,
      finalizeMediaFile: async (inputPath, outputPath) => {
        await fs.copyFile(inputPath, outputPath);
      },
    });
    manager = new MeetingRecordingManager({
      archiveStore,
      captureHost,
      createAsrRuntime,
    });
    await manager.prepare({
      ...scope,
      title: 'Commit barrier success',
      consentConfirmed: true,
    });
    await manager.start(scope);
    const persistSource = archiveStore.updateCaptureSource.bind(archiveStore);
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const updateCaptureSource = vi
      .spyOn(archiveStore, 'updateCaptureSource')
      .mockImplementationOnce(async (...args) => {
        await persistenceGate;
        return persistSource(...args);
      });

    const switchPromise = manager.switchMicrophone({
      ...scope,
      deviceId: 'mic-2',
    });
    await vi.waitFor(() => {
      expect(updateCaptureSource).toHaveBeenCalledOnce();
    });
    const stopPromise = manager.stop(scope);
    await Promise.resolve();
    expect(captureHost.stop).not.toHaveBeenCalled();

    releasePersistence();
    await expect(switchPromise).resolves.toMatchObject({
      manifest: { microphoneDeviceId: 'mic-2' },
    });
    await expect(stopPromise).resolves.toMatchObject({
      manifest: {
        lifecycleStatus: 'stopped',
        microphoneDeviceId: 'mic-2',
      },
    });
    expect(captureHost.finalizeSourceSwitch).toHaveBeenCalledOnce();
    expect(captureHost.rollbackSourceSwitch).not.toHaveBeenCalled();
    expect(
      captureHost.finalizeSourceSwitch.mock.invocationCallOrder[0],
    ).toBeLessThan(captureHost.stop.mock.invocationCallOrder[0]!);
  });

  it('waits for rollback after source persistence failure before stopping capture', async () => {
    const archiveStore = new MeetingArchiveStore({
      rootPath,
      finalizeMediaFile: async (inputPath, outputPath) => {
        await fs.copyFile(inputPath, outputPath);
      },
    });
    manager = new MeetingRecordingManager({
      archiveStore,
      captureHost,
      createAsrRuntime,
    });
    await manager.prepare({
      ...scope,
      title: 'Commit barrier rollback',
      consentConfirmed: true,
    });
    await manager.start(scope);
    let releasePersistence!: () => void;
    const persistenceGate = new Promise<void>((resolve) => {
      releasePersistence = resolve;
    });
    const updateCaptureSource = vi
      .spyOn(archiveStore, 'updateCaptureSource')
      .mockImplementationOnce(async () => {
        await persistenceGate;
        throw new Error('manifest write failed after commit');
      });

    const switchPromise = manager.switchMicrophone({
      ...scope,
      deviceId: 'mic-2',
    });
    const switchFailure = expect(switchPromise).rejects.toThrow(
      'manifest write failed after commit',
    );
    await vi.waitFor(() => {
      expect(updateCaptureSource).toHaveBeenCalledOnce();
    });
    const stopPromise = manager.stop(scope);
    await Promise.resolve();
    expect(captureHost.stop).not.toHaveBeenCalled();

    releasePersistence();
    await switchFailure;
    await expect(stopPromise).resolves.toMatchObject({
      manifest: {
        lifecycleStatus: 'stopped',
        microphoneDeviceId: 'built-in-mic',
      },
    });
    expect(captureHost.rollbackSourceSwitch).toHaveBeenCalledOnce();
    expect(captureHost.finalizeSourceSwitch).not.toHaveBeenCalled();
    expect(
      captureHost.rollbackSourceSwitch.mock.invocationCallOrder[0],
    ).toBeLessThan(captureHost.stop.mock.invocationCallOrder[0]!);
  });

  it('lets stop and the final audio append finish while source preparation hangs', async () => {
    let resolvePreparation!: (value: {
      operationId: string;
      source: 'local';
      sourceId: string;
      label: string;
    }) => void;
    captureHost.prepareMicrophoneSwitch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolvePreparation = resolve;
        }),
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
    });
    await manager.prepare({
      ...scope,
      title: 'Hung device switch',
      consentConfirmed: true,
    });
    await manager.start(scope);

    const switchPromise = manager.switchMicrophone({
      ...scope,
      deviceId: 'mic-hung',
    });
    await vi.waitFor(() => {
      expect(captureHost.prepareMicrophoneSwitch).toHaveBeenCalledOnce();
    });
    captureHost.stop.mockImplementationOnce(async () => {
      await manager.appendAudioChunk({
        ...scope,
        source: 'local',
        bytes: new Uint8Array([1, 2, 3]),
        durationMs: 200,
        sampleRate: 48_000,
        channelCount: 1,
        codec: 'opus',
        container: 'webm',
      });
    });

    await expect(manager.stop(scope)).resolves.toMatchObject({
      manifest: { lifecycleStatus: 'stopped' },
    });
    expect(captureHost.commitSourceSwitch).not.toHaveBeenCalled();
    expect(captureHost.abortSourceSwitch).not.toHaveBeenCalled();
    resolvePreparation({
      operationId: 'late-local-op',
      source: 'local',
      sourceId: 'mic-hung',
      label: 'Late microphone',
    });
    await expect(switchPromise).rejects.toThrow(
      'meeting local source switch was cancelled',
    );
    expect(captureHost.abortSourceSwitch).toHaveBeenCalledWith({
      operationId: 'late-local-op',
      source: 'local',
    });
    expect(manager.getStatus().manifest).toMatchObject({
      lifecycleStatus: 'stopped',
      microphoneDeviceId: 'built-in-mic',
    });
  });

  it('waits for a failed commit before stopping the prior source', async () => {
    let rejectCommit!: (reason: Error) => void;
    captureHost.commitSourceSwitch.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectCommit = reject;
        }),
    );
    await manager.prepare({
      ...scope,
      title: 'Stop wins commit race',
      consentConfirmed: true,
    });
    await manager.start(scope);

    const switchPromise = manager.switchMicrophone({
      ...scope,
      deviceId: 'mic-2',
    });
    await vi.waitFor(() => {
      expect(captureHost.commitSourceSwitch).toHaveBeenCalledOnce();
    });
    const stopPromise = manager.stop(scope);
    await Promise.resolve();
    expect(captureHost.stop).not.toHaveBeenCalled();
    rejectCommit(new Error('source switch commit failed'));

    await expect(switchPromise).rejects.toThrow('source switch commit failed');
    await expect(stopPromise).resolves.toMatchObject({
      manifest: {
        lifecycleStatus: 'stopped',
        microphoneDeviceId: 'built-in-mic',
      },
    });
  });

  it('persists a successful commit before stop finalization', async () => {
    let resolveCommit!: (value: {
      source: 'local';
      sourceId: string;
      label: string;
    }) => void;
    captureHost.commitSourceSwitch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCommit = resolve;
        }),
    );
    await manager.prepare({
      ...scope,
      title: 'Commit wins stop race',
      consentConfirmed: true,
    });
    await manager.start(scope);

    const switchPromise = manager.switchMicrophone({
      ...scope,
      deviceId: 'mic-2',
    });
    await vi.waitFor(() => {
      expect(captureHost.commitSourceSwitch).toHaveBeenCalledOnce();
    });
    resolveCommit({
      source: 'local',
      sourceId: 'mic-2',
      label: 'USB microphone',
    });
    const stopPromise = manager.stop(scope);

    await expect(switchPromise).resolves.toMatchObject({
      manifest: {
        lifecycleStatus: 'recording',
        microphoneDeviceId: 'mic-2',
      },
    });
    await expect(stopPromise).resolves.toMatchObject({
      manifest: {
        lifecycleStatus: 'stopped',
        microphoneDeviceId: 'mic-2',
      },
    });
  });

  it('commits only the latest rapid microphone switch', async () => {
    let resolveLatest!: (value: {
      operationId: string;
      source: 'local';
      sourceId: string;
      label: string;
    }) => void;
    captureHost.prepareMicrophoneSwitch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveLatest = resolve;
        }),
    );
    captureHost.commitSourceSwitch.mockImplementationOnce(async () => ({
      source: 'local' as const,
      sourceId: 'mic-3',
      label: 'Latest microphone',
    }));
    await manager.prepare({
      ...scope,
      title: 'Rapid switching',
      consentConfirmed: true,
    });
    await manager.start(scope);

    const first = manager.switchMicrophone({ ...scope, deviceId: 'mic-2' });
    const firstFailure = expect(first).rejects.toThrow(
      'meeting local source switch was cancelled',
    );
    const second = manager.switchMicrophone({ ...scope, deviceId: 'mic-3' });
    await vi.waitFor(() => {
      expect(captureHost.prepareMicrophoneSwitch).toHaveBeenCalledOnce();
    });
    resolveLatest({
      operationId: 'local-op-latest',
      source: 'local',
      sourceId: 'mic-3',
      label: 'Latest microphone',
    });

    await firstFailure;
    await expect(second).resolves.toMatchObject({
      manifest: {
        microphoneDeviceId: 'mic-3',
        microphoneDeviceLabel: 'Latest microphone',
      },
    });
    expect(captureHost.abortSourceSwitch).not.toHaveBeenCalled();
    expect(captureHost.commitSourceSwitch).toHaveBeenCalledOnce();
    expect(captureHost.commitSourceSwitch).toHaveBeenCalledWith({
      operationId: 'local-op-latest',
      source: 'local',
    });
  });

  it('falls back to the default microphone after the active source ends', async () => {
    captureHost.prepareMicrophoneSwitch.mockResolvedValueOnce({
      operationId: 'fallback-op',
      source: 'local',
      sourceId: 'default',
      label: 'MacBook Pro Microphone',
    });
    captureHost.commitSourceSwitch.mockResolvedValueOnce({
      source: 'local',
      sourceId: 'default',
      label: 'MacBook Pro Microphone',
    });
    await manager.prepare({
      ...scope,
      title: 'Microphone fallback',
      consentConfirmed: true,
    });
    await manager.start(scope);

    await manager.handleCaptureSourceEnded({
      ...scope,
      source: 'local',
      sourceId: 'built-in-mic',
      label: 'Built-in microphone',
    });

    expect(captureHost.prepareMicrophoneSwitch).toHaveBeenCalledWith('default');
    expect(manager.getStatus().manifest).toMatchObject({
      lifecycleStatus: 'recording',
      microphoneDeviceId: 'default',
      microphoneDeviceLabel: 'MacBook Pro Microphone',
      tracks: { local: { status: 'active' } },
    });
    expect(onCaptureSourceNotice).toHaveBeenCalledWith({
      ...scope,
      source: 'local',
      kind: 'fallback_succeeded',
      previousLabel: 'Built-in microphone',
      currentLabel: 'MacBook Pro Microphone',
    });
  });

  it('marks only the local track unavailable when default fallback fails', async () => {
    captureHost.prepareMicrophoneSwitch.mockRejectedValueOnce(
      new Error('default microphone is unavailable'),
    );
    await manager.prepare({
      ...scope,
      title: 'Microphone fallback failure',
      consentConfirmed: true,
    });
    await manager.start(scope);

    await manager.handleCaptureSourceEnded({
      ...scope,
      source: 'local',
      sourceId: 'built-in-mic',
      label: 'Built-in microphone',
    });

    expect(manager.getStatus().manifest).toMatchObject({
      lifecycleStatus: 'recording',
      tracks: {
        local: {
          status: 'failed',
          errorCode: 'source_unavailable',
          errorMessage: 'default microphone is unavailable',
        },
        remote: { status: 'active' },
      },
    });
    expect(onCaptureSourceNotice).toHaveBeenCalledWith({
      ...scope,
      source: 'local',
      kind: 'fallback_failed',
      previousLabel: 'Built-in microphone',
    });
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

    const checkpoint = {
      externalId: 'segment-1',
      source: 'remote' as const,
      startMs: 0,
      endMs: 800,
      text: 'Question',
      isFinal: true,
      recordedAt: new Date().toISOString(),
    };

    await expect(
      manager.appendTranscriptCheckpoint(scope, checkpoint),
    ).resolves.toBeUndefined();
    await expect(
      manager.appendTranscriptCheckpoint(scope, checkpoint),
    ).resolves.toBeUndefined();

    expect(onTranscriptChanged).toHaveBeenCalledTimes(1);
    expect(onTranscriptChanged).toHaveBeenCalledWith({ ...scope, checkpoint });
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

  it('does not wait for remote server retry after the local archive is stopped', async () => {
    const flushResult = {
      sessionId: scope.sessionId,
      status: 'pending' as const,
      syncedCount: 0,
      pendingCount: 1,
    };
    const retrySession = vi.fn(() => new Promise<never>(() => undefined));
    const serverSync = {
      createSession: vi.fn(),
      updateLifecycle: vi.fn(),
      createTranscriptRun: vi.fn(),
      checkpointTrack: vi.fn(),
      upsertTranscriptSegments: vi.fn(),
      updateTranscriptRun: vi.fn(),
      updateCopilotState: vi.fn(),
      flushSession: vi.fn().mockResolvedValue(flushResult),
      retrySession,
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
      title: 'Offline finalization',
      consentConfirmed: true,
    });
    await syncManager.start(scope);

    await expect(syncManager.stop(scope)).resolves.toMatchObject({
      manifest: { lifecycleStatus: 'stopped' },
    });
    expect(retrySession).toHaveBeenCalledWith(scope.sessionId);
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

  it('only sends remote turns to Copilot and persists answered history', async () => {
    const flushResult = {
      sessionId: scope.sessionId,
      status: 'synced' as const,
      syncedCount: 1,
      pendingCount: 0,
    };
    const answered = {
      status: 'answered' as const,
      question: 'Explain a hash map.',
      question_segment_id: 'remote-question-1',
      answer: 'A hash map places keys into buckets using a hash function.',
      key_points: ['hash', 'bucket'],
      sources: [],
      reliability: 'high' as const,
      warning: '',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      latency_ms: 250,
    };
    const serverSync = {
      createSession: vi.fn(),
      updateLifecycle: vi.fn(),
      createTranscriptRun: vi.fn(),
      checkpointTrack: vi.fn(),
      upsertTranscriptSegments: vi.fn(),
      updateTranscriptRun: vi.fn(),
      updateCopilotState: vi.fn(),
      answerCopilot: vi.fn().mockResolvedValue(answered),
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
      title: 'Role boundary',
      consentConfirmed: true,
      copilotEnabled: true,
    });
    await syncManager.start(scope);
    await syncManager.appendTranscriptCheckpoint(scope, {
      externalId: 'local-answer-1',
      source: 'local',
      startMs: 1_000,
      endMs: 2_000,
      text: 'A hash map uses buckets.',
      isFinal: true,
      recordedAt: '2026-08-27T00:00:00.000Z',
    });

    await expect(
      syncManager.answerCopilotQuestion(scope, 'local-answer-1'),
    ).resolves.toMatchObject({
      status: 'no_action',
      candidate_segment_id: 'local-answer-1',
    });
    expect(serverSync.answerCopilot).not.toHaveBeenCalled();

    await syncManager.appendTranscriptCheckpoint(scope, {
      externalId: 'remote-question-1',
      source: 'remote',
      startMs: 2_100,
      endMs: 3_000,
      text: 'Explain a hash map.',
      isFinal: true,
      recordedAt: '2026-08-27T00:00:01.000Z',
    });
    await expect(
      syncManager.answerCopilotQuestion(scope, 'remote-question-1'),
    ).resolves.toEqual(answered);

    const archive = await syncManager.getArchive(scope);
    expect(archive.copilotRecords).toHaveLength(1);
    expect(archive.copilotRecords[0]?.result).toEqual(answered);
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
      expect.any(String),
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
