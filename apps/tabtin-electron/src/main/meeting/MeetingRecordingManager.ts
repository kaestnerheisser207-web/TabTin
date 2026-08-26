import type {
  AppendMeetingAudioChunkInput,
  AppendMeetingPcmChunkInput,
  MeetingArchiveManifestV1,
  MeetingArchiveScope,
  MeetingMediaProbeResult,
  MeetingMediaProbeInput,
  MeetingArchiveListScope,
  MeetingCopilotAnswerResult,
  MeetingLocalArchive,
  MeetingMicrophoneTestInput,
  MeetingMicrophoneTestResult,
  MeetingMicrophoneDevice,
  MeetingSystemAudioSource,
  MeetingRecordingStatus,
  MeetingStorageProbeResult,
  MeetingTranscriptCheckpoint,
  PrepareMeetingArchiveInput,
  SwitchMeetingMicrophoneInput,
  SwitchMeetingSystemAudioInput,
} from '../../shared/meeting-recording-contract';
import { MeetingArchiveStore } from './MeetingArchiveStore';
import type { MeetingCaptureHost } from './MeetingCaptureWindow';
import type {
  MeetingServerSync,
  MeetingSyncFlushResult,
  MeetingTranscriptSegmentInput,
} from './MeetingServerSync';

const ACTIVE_STATES = new Set(['preparing', 'recording', 'paused'] as const);
const DEFAULT_SOURCE_SWITCH_TIMEOUT_MS = 10_000;

export interface MeetingRecordingManagerOptions {
  archiveStore?: MeetingArchiveStore;
  onStatusChanged?: (status: MeetingRecordingStatus) => void;
  captureHost?: MeetingCaptureHost;
  createAsrRuntime?: (input: {
    scope: MeetingArchiveScope;
    onTranscript: (checkpoint: MeetingTranscriptCheckpoint) => Promise<void>;
    onStatus: (
      status: MeetingArchiveManifestV1['transcriptionStatus'],
      errorMessage?: string,
    ) => Promise<MeetingRecordingStatus>;
  }) => MeetingAsrRuntime;
  serverSync?: MeetingServerSync;
  sourceSwitchTimeoutMs?: number;
}

export interface MeetingAsrRuntime {
  start(): Promise<void>;
  appendPcm(
    source: AppendMeetingPcmChunkInput['source'],
    bytes: Uint8Array,
  ): void;
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
}

export class MeetingRecordingManager {
  private readonly archiveStore: MeetingArchiveStore;
  private readonly onStatusChanged?: (status: MeetingRecordingStatus) => void;
  private readonly captureHost?: MeetingCaptureHost;
  private readonly createAsrRuntime?: MeetingRecordingManagerOptions['createAsrRuntime'];
  private readonly serverSync?: MeetingServerSync;
  private readonly sourceSwitchTimeoutMs: number;
  private activeScope: MeetingArchiveScope | null = null;
  private activeManifest: MeetingArchiveManifestV1 | null = null;
  private operationChain: Promise<unknown> = Promise.resolve();
  private stopPromise: Promise<MeetingRecordingStatus> | null = null;
  private activeAsrRuntime: MeetingAsrRuntime | null = null;
  private readonly pendingTranscriptSync = new Map<
    string,
    MeetingTranscriptSegmentInput
  >();
  private transcriptSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MeetingRecordingManagerOptions = {}) {
    this.archiveStore = options.archiveStore ?? new MeetingArchiveStore();
    this.onStatusChanged = options.onStatusChanged;
    this.captureHost = options.captureHost;
    this.createAsrRuntime = options.createAsrRuntime;
    this.serverSync = options.serverSync;
    this.sourceSwitchTimeoutMs =
      options.sourceSwitchTimeoutMs ?? DEFAULT_SOURCE_SWITCH_TIMEOUT_MS;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operationChain.catch(() => undefined).then(operation);
    this.operationChain = current;
    return current;
  }

  private async withSourceSwitchTimeout<T>(operation: Promise<T>): Promise<T> {
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    try {
      return await Promise.race([
        operation,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(
            () => reject(new Error('meeting capture source switch timed out')),
            this.sourceSwitchTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  private emitStatus(): MeetingRecordingStatus {
    const status = this.getStatus();
    this.onStatusChanged?.(status);
    return status;
  }

  private scheduleServerFlush(scope: MeetingArchiveScope): void {
    if (!this.serverSync) return;
    void this.serverSync.flushSession(scope.sessionId).then((result) => {
      void this.applyServerFlushResult(scope, result);
    });
  }

  private async applyServerFlushResult(
    scope: MeetingArchiveScope,
    result: MeetingSyncFlushResult,
  ): Promise<void> {
    const status =
      result.status === 'synced' && result.pendingCount === 0
        ? 'synced'
        : result.status === 'conflict' || result.status === 'failed'
          ? 'failed'
          : 'pending';
    const errorMessage =
      result.conflict?.message || result.failure?.message || '';
    await this.enqueue(async () => {
      const manifest = await this.archiveStore.updateServerSyncStatus(
        scope,
        status,
        errorMessage,
      );
      if (this.activeManifest?.sessionId === scope.sessionId) {
        this.activeManifest = manifest;
        this.emitStatus();
      }
    });
  }

  private checkpointServerTrack(
    manifest: MeetingArchiveManifestV1,
    source: 'local' | 'remote',
  ): void {
    if (!this.serverSync) return;
    const track = manifest.tracks[source];
    this.serverSync.checkpointTrack(manifest.sessionId, {
      source,
      captureStatus: track.status,
      localAvailable: track.bytes > 0,
      deviceId:
        source === 'local'
          ? manifest.microphoneDeviceId
          : manifest.systemAudioSourceId || 'main-display',
      deviceLabel:
        source === 'local'
          ? manifest.microphoneDeviceLabel
          : manifest.systemAudioSourceLabel || 'System audio',
      sampleRate: track.sampleRate,
      channelCount: track.channelCount,
      codec: track.codec,
      container: track.container,
      durationMs: track.durationMs,
      fileSize: track.bytes,
      contentHash: track.contentHash,
    });
  }

  private queueTranscriptServerSync(
    scope: MeetingArchiveScope,
    checkpoint: MeetingTranscriptCheckpoint,
  ): void {
    if (!this.serverSync || !this.activeManifest) return;
    this.pendingTranscriptSync.set(checkpoint.externalId, {
      externalId: checkpoint.externalId,
      source: checkpoint.source,
      speakerKey: checkpoint.speakerKey,
      startMs: checkpoint.startMs,
      endMs: checkpoint.endMs,
      rawText: checkpoint.text,
      isFinal: checkpoint.isFinal,
      confidence: checkpoint.confidence,
      metadata: { recorded_at: checkpoint.recordedAt },
    });
    if (this.transcriptSyncTimer) return;
    this.transcriptSyncTimer = setTimeout(() => {
      this.transcriptSyncTimer = null;
      this.flushTranscriptServerSync(scope);
    }, 1_000);
  }

  private flushTranscriptServerSync(scope: MeetingArchiveScope): void {
    if (!this.serverSync || !this.activeManifest) return;
    const segments = [...this.pendingTranscriptSync.values()];
    this.pendingTranscriptSync.clear();
    if (segments.length === 0) return;
    this.serverSync.upsertTranscriptSegments(
      scope.sessionId,
      this.activeManifest.transcriptRunId,
      segments,
    );
    this.scheduleServerFlush(scope);
  }

  private requireActiveScope(scope?: MeetingArchiveScope): MeetingArchiveScope {
    if (!this.activeScope || !this.activeManifest) {
      throw new Error('no active meeting recording');
    }
    if (
      scope &&
      (scope.sessionId !== this.activeScope.sessionId ||
        scope.organizationId !== this.activeScope.organizationId ||
        scope.userId !== this.activeScope.userId)
    ) {
      throw new Error('meeting recording scope does not match active session');
    }
    return this.activeScope;
  }

  getStatus(): MeetingRecordingStatus {
    return {
      active: Boolean(
        this.activeManifest &&
        ACTIVE_STATES.has(
          this.activeManifest.lifecycleStatus as
            | 'preparing'
            | 'recording'
            | 'paused',
        ),
      ),
      manifest: this.activeManifest,
    };
  }

  async probeLocalStorage(): Promise<MeetingStorageProbeResult> {
    return this.archiveStore.probeLocalStorage();
  }

  async probeMedia(
    input: MeetingMediaProbeInput = {},
  ): Promise<MeetingMediaProbeResult> {
    if (!this.captureHost) {
      throw new Error('meeting media capture host is unavailable');
    }
    return this.captureHost.probe(input);
  }

  async listMicrophones(): Promise<MeetingMicrophoneDevice[]> {
    if (!this.captureHost) {
      throw new Error('meeting media capture host is unavailable');
    }
    return this.captureHost.listMicrophones();
  }

  async listSystemAudioSources(): Promise<MeetingSystemAudioSource[]> {
    if (!this.captureHost) {
      throw new Error('meeting media capture host is unavailable');
    }
    return this.captureHost.listSystemAudioSources();
  }

  async switchMicrophone(
    input: SwitchMeetingMicrophoneInput,
  ): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      const scope = this.requireActiveScope(input);
      if (
        !['recording', 'paused'].includes(this.activeManifest!.lifecycleStatus)
      ) {
        throw new Error(
          'microphone can only change during an active recording',
        );
      }
      if (!this.captureHost) {
        throw new Error('meeting media capture host is unavailable');
      }
      const selected = await this.withSourceSwitchTimeout(
        this.captureHost.switchMicrophone(input.deviceId),
      );
      this.activeManifest = await this.archiveStore.updateCaptureSource(
        scope,
        'local',
        selected.sourceId,
        selected.label,
      );
      this.checkpointServerTrack(this.activeManifest, 'local');
      this.scheduleServerFlush(scope);
      return this.emitStatus();
    });
  }

  async switchSystemAudio(
    input: SwitchMeetingSystemAudioInput,
  ): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      const scope = this.requireActiveScope(input);
      if (
        !['recording', 'paused'].includes(this.activeManifest!.lifecycleStatus)
      ) {
        throw new Error(
          'system audio can only change during an active recording',
        );
      }
      if (!this.captureHost) {
        throw new Error('meeting media capture host is unavailable');
      }
      const selected = await this.withSourceSwitchTimeout(
        this.captureHost.switchSystemAudio(input.sourceId),
      );
      this.activeManifest = await this.archiveStore.updateCaptureSource(
        scope,
        'remote',
        selected.sourceId,
        selected.label,
      );
      this.checkpointServerTrack(this.activeManifest, 'remote');
      this.scheduleServerFlush(scope);
      return this.emitStatus();
    });
  }

  async listArchives(
    scope: MeetingArchiveListScope,
  ): Promise<MeetingLocalArchive[]> {
    const manifests = await this.archiveStore.listManifests(scope);
    return manifests.map((manifest) => {
      const archiveScope = {
        ...scope,
        sessionId: manifest.sessionId,
      };
      const audioUrls: MeetingLocalArchive['audioUrls'] = {};
      for (const source of ['local', 'remote'] as const) {
        const relativeName = manifest.tracks[source].finalizedRelativePath;
        if (!relativeName) continue;
        const absolutePath = this.archiveStore.resolveSessionFile(
          archiveScope,
          relativeName,
        );
        const encoded = absolutePath
          .split('/')
          .map((segment) => encodeURIComponent(segment))
          .join('/');
        audioUrls[source] = `tabtin-file://${encoded}`;
      }
      return { manifest, audioUrls, transcript: [] };
    });
  }

  async getArchive(scope: MeetingArchiveScope): Promise<MeetingLocalArchive> {
    const manifest = await this.archiveStore.readManifest(scope);
    const transcript = await this.archiveStore.readTranscript(scope);
    const audioUrls: MeetingLocalArchive['audioUrls'] = {};
    for (const source of ['local', 'remote'] as const) {
      const relativeName = manifest.tracks[source].finalizedRelativePath;
      if (!relativeName) continue;
      const absolutePath = this.archiveStore.resolveSessionFile(
        scope,
        relativeName,
      );
      const encoded = absolutePath
        .split('/')
        .map((segment) => encodeURIComponent(segment))
        .join('/');
      audioUrls[source] = `tabtin-file://${encoded}`;
    }
    return { manifest, audioUrls, transcript };
  }

  async testMicrophone(
    input: MeetingMicrophoneTestInput = {},
  ): Promise<MeetingMicrophoneTestResult> {
    if (!this.captureHost) {
      throw new Error('meeting media capture host is unavailable');
    }
    return this.captureHost.testMicrophone(input);
  }

  async prepare(
    input: PrepareMeetingArchiveInput,
  ): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      if (
        this.activeManifest &&
        ACTIVE_STATES.has(
          this.activeManifest.lifecycleStatus as
            | 'preparing'
            | 'recording'
            | 'paused',
        ) &&
        this.activeManifest.sessionId !== input.sessionId
      ) {
        throw new Error('another meeting recording is already active');
      }
      const manifest = await this.archiveStore.prepare(input);
      this.activeScope = {
        sessionId: input.sessionId,
        organizationId: input.organizationId,
        userId: input.userId,
      };
      this.activeManifest =
        manifest.lifecycleStatus === 'draft'
          ? await this.archiveStore.updateLifecycle(
              this.activeScope,
              'preparing',
            )
          : manifest;
      if (this.serverSync) {
        this.serverSync.createSession({
          id: input.sessionId,
          organizationId: input.organizationId,
          projectId: input.projectId,
          title: input.title,
          brief: input.brief,
          consentConfirmed: input.consentConfirmed,
          copilotEnabled: input.copilotEnabled,
        });
        this.serverSync.updateLifecycle(input.sessionId, {
          status: 'preparing',
        });
        this.scheduleServerFlush(this.activeScope);
      }
      return this.emitStatus();
    });
  }

  async start(scope?: MeetingArchiveScope): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      const activeScope = this.requireActiveScope(scope);
      if (this.activeManifest!.lifecycleStatus !== 'preparing') {
        throw new Error('meeting recording can only start from preparing');
      }
      this.activeAsrRuntime =
        this.createAsrRuntime?.({
          scope: activeScope,
          onTranscript: (checkpoint) =>
            this.appendTranscriptCheckpoint(activeScope, checkpoint),
          onStatus: (status, errorMessage) =>
            this.updateTranscriptionStatus(status, errorMessage),
        }) ?? null;
      const activeSources = await this.captureHost?.start(activeScope, {
        microphoneDeviceId: this.activeManifest!.microphoneDeviceId,
      });
      try {
        for (const source of activeSources ?? []) {
          this.activeManifest = await this.archiveStore.updateCaptureSource(
            activeScope,
            source.source,
            source.sourceId,
            source.label,
          );
        }
        this.activeManifest = await this.archiveStore.updateLifecycle(
          activeScope,
          'recording',
        );
        if (this.activeAsrRuntime) {
          this.activeManifest =
            await this.archiveStore.updateTranscriptionStatus(
              activeScope,
              'connecting',
            );
          try {
            await this.activeAsrRuntime.start();
            this.activeManifest =
              await this.archiveStore.updateTranscriptionStatus(
                activeScope,
                'active',
              );
          } catch (error) {
            this.activeAsrRuntime = null;
            this.activeManifest =
              await this.archiveStore.updateTranscriptionStatus(
                activeScope,
                'failed',
                error instanceof Error ? error.message : String(error),
              );
          }
        }
        if (this.serverSync) {
          this.serverSync.createTranscriptRun(activeScope.sessionId, {
            id: this.activeManifest.transcriptRunId,
            mode: 'realtime',
            provider: 'byteplus',
            model: 'bigmodel',
            language: 'zh-CN',
            metadata: { sources: ['local', 'remote'] },
          });
          this.serverSync.updateLifecycle(activeScope.sessionId, {
            status: 'recording',
            durationMs: this.activeManifest.durationMs,
          });
          this.scheduleServerFlush(activeScope);
        }
      } catch (error) {
        await this.activeAsrRuntime?.stop().catch(() => undefined);
        this.activeAsrRuntime = null;
        await this.captureHost?.stop().catch(() => undefined);
        throw error;
      }
      return this.emitStatus();
    });
  }

  async pause(scope?: MeetingArchiveScope): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      const activeScope = this.requireActiveScope(scope);
      if (this.activeManifest!.lifecycleStatus !== 'recording') {
        throw new Error('meeting recording can only pause while recording');
      }
      await this.captureHost?.pause();
      this.activeAsrRuntime?.pause();
      try {
        this.activeManifest = await this.archiveStore.updateLifecycle(
          activeScope,
          'paused',
        );
        this.serverSync?.updateLifecycle(activeScope.sessionId, {
          status: 'paused',
          durationMs: this.activeManifest.durationMs,
        });
        this.scheduleServerFlush(activeScope);
      } catch (error) {
        await this.captureHost?.resume().catch(() => undefined);
        this.activeAsrRuntime?.resume();
        throw error;
      }
      return this.emitStatus();
    });
  }

  async resume(scope?: MeetingArchiveScope): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      const activeScope = this.requireActiveScope(scope);
      if (this.activeManifest!.lifecycleStatus !== 'paused') {
        throw new Error('meeting recording can only resume while paused');
      }
      await this.captureHost?.resume();
      this.activeAsrRuntime?.resume();
      try {
        this.activeManifest = await this.archiveStore.updateLifecycle(
          activeScope,
          'recording',
        );
        this.serverSync?.updateLifecycle(activeScope.sessionId, {
          status: 'recording',
          durationMs: this.activeManifest.durationMs,
        });
        this.scheduleServerFlush(activeScope);
      } catch (error) {
        await this.captureHost?.pause().catch(() => undefined);
        this.activeAsrRuntime?.pause();
        throw error;
      }
      return this.emitStatus();
    });
  }

  async stop(scope?: MeetingArchiveScope): Promise<MeetingRecordingStatus> {
    if (this.stopPromise) return this.stopPromise;
    const activeScope = this.requireActiveScope(scope);
    if (
      !['recording', 'paused', 'interrupted'].includes(
        this.activeManifest!.lifecycleStatus,
      )
    ) {
      throw new Error('meeting recording cannot stop in the current state');
    }

    this.stopPromise = (async () => {
      // MediaRecorder.stop() emits a final dataavailable event. Do not hold the
      // manager operation queue while waiting, otherwise that final chunk's IPC
      // call cannot enter appendAudioChunk and both sides deadlock.
      await this.captureHost?.stop();
      await this.activeAsrRuntime?.stop();
      this.activeAsrRuntime = null;
      if (this.transcriptSyncTimer) {
        clearTimeout(this.transcriptSyncTimer);
        this.transcriptSyncTimer = null;
      }
      this.flushTranscriptServerSync(activeScope);
      return this.enqueue(async () => {
        this.requireActiveScope(activeScope);
        try {
          await this.archiveStore.finalizeAudioTracks(activeScope);
          this.activeManifest =
            await this.archiveStore.updateTranscriptionStatus(
              activeScope,
              this.activeManifest!.transcriptFinalCount > 0
                ? 'completed'
                : 'partial',
            );
          this.activeManifest = await this.archiveStore.updateLifecycle(
            activeScope,
            'stopped',
          );
          this.checkpointServerTrack(this.activeManifest, 'local');
          this.checkpointServerTrack(this.activeManifest, 'remote');
          this.serverSync?.updateTranscriptRun(
            activeScope.sessionId,
            this.activeManifest.transcriptRunId,
            {
              status:
                this.activeManifest.transcriptFinalCount > 0
                  ? 'completed'
                  : 'partial',
            },
          );
          this.serverSync?.updateLifecycle(activeScope.sessionId, {
            status: 'stopped',
            durationMs: this.activeManifest.durationMs,
          });
          this.scheduleServerFlush(activeScope);
        } catch (error) {
          this.activeManifest = await this.archiveStore.updateLifecycle(
            activeScope,
            'interrupted',
          );
          this.emitStatus();
          throw error;
        }
        return this.emitStatus();
      });
    })();
    try {
      let status = await this.stopPromise;
      if (this.serverSync) {
        const syncResult = await this.serverSync.retrySession(
          activeScope.sessionId,
        );
        await this.applyServerFlushResult(activeScope, syncResult);
        status = this.getStatus();
      }
      return status;
    } finally {
      this.stopPromise = null;
    }
  }

  async cancel(scope?: MeetingArchiveScope): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      const activeScope = this.requireActiveScope(scope);
      if (
        !['draft', 'preparing'].includes(this.activeManifest!.lifecycleStatus)
      ) {
        throw new Error(
          'meeting recording cannot be cancelled after capture starts',
        );
      }
      this.activeManifest = await this.archiveStore.updateLifecycle(
        activeScope,
        'cancelled',
      );
      this.serverSync?.updateLifecycle(activeScope.sessionId, {
        status: 'cancelled',
      });
      this.scheduleServerFlush(activeScope);
      return this.emitStatus();
    });
  }

  async appendAudioChunk(
    input: AppendMeetingAudioChunkInput,
  ): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      this.requireActiveScope(input);
      if (
        !['recording', 'paused'].includes(this.activeManifest!.lifecycleStatus)
      ) {
        throw new Error(
          'audio chunks are accepted only while recording or flushing a pause',
        );
      }
      const result = await this.archiveStore.appendAudioChunk(input);
      this.activeManifest = result.manifest;
      this.checkpointServerTrack(this.activeManifest, input.source);
      this.scheduleServerFlush(input);
      return this.emitStatus();
    });
  }

  appendPcmChunk(input: AppendMeetingPcmChunkInput): void {
    this.requireActiveScope(input);
    if (
      !['preparing', 'recording', 'paused'].includes(
        this.activeManifest!.lifecycleStatus,
      )
    ) {
      throw new Error(
        'PCM chunks are accepted only while preparing, recording, or paused',
      );
    }
    this.activeAsrRuntime?.appendPcm(input.source, input.bytes);
  }

  async appendTranscriptCheckpoint(
    scope: MeetingArchiveScope,
    checkpoint: MeetingTranscriptCheckpoint,
  ): Promise<void> {
    return this.enqueue(async () => {
      this.requireActiveScope(scope);
      this.activeManifest = await this.archiveStore.appendTranscriptCheckpoint(
        scope,
        checkpoint,
      );
      this.queueTranscriptServerSync(scope, checkpoint);
      this.emitStatus();
    });
  }

  async updateTranscriptionStatus(
    status: MeetingArchiveManifestV1['transcriptionStatus'],
    errorMessage = '',
  ): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      const scope = this.requireActiveScope();
      this.activeManifest = await this.archiveStore.updateTranscriptionStatus(
        scope,
        status,
        errorMessage,
      );
      return this.emitStatus();
    });
  }

  async setCopilotEnabled(
    scope: MeetingArchiveScope,
    enabled: boolean,
  ): Promise<MeetingRecordingStatus> {
    return this.enqueue(async () => {
      this.requireActiveScope(scope);
      if (
        !['preparing', 'recording', 'paused'].includes(
          this.activeManifest!.lifecycleStatus,
        )
      ) {
        throw new Error('Meeting Copilot cannot change in the current state');
      }
      this.activeManifest = await this.archiveStore.updateCopilotEnabled(
        scope,
        enabled,
      );
      this.serverSync?.updateCopilotState(scope.sessionId, { enabled });
      this.scheduleServerFlush(scope);
      return this.emitStatus();
    });
  }

  async answerCopilotQuestion(
    scope: MeetingArchiveScope,
    questionSegmentId: string,
  ): Promise<MeetingCopilotAnswerResult> {
    this.requireActiveScope(scope);
    if (!this.activeManifest?.copilotEnabled) {
      return {
        status: 'disabled',
        message: '会议 Copilot 当前已关闭',
      };
    }
    if (!this.serverSync) {
      return {
        status: 'unavailable',
        message: '会议 Copilot 服务暂时不可用，录音与转写会继续运行',
      };
    }
    const archive = await this.getArchive(scope);
    const questionExists = archive.transcript.some(
      (checkpoint) =>
        checkpoint.externalId === questionSegmentId && checkpoint.isFinal,
    );
    if (!questionExists) {
      return {
        status: 'no_question',
        message: '这个问题尚未转写完成，请稍后再试',
      };
    }
    return this.serverSync.answerCopilot(
      scope.sessionId,
      archive.transcript,
      questionSegmentId,
      this.activeManifest.copilotModelId,
    );
  }

  async recoverInterrupted(): Promise<MeetingArchiveManifestV1[]> {
    return this.enqueue(async () => this.archiveStore.recoverInterrupted());
  }

  async retryActiveServerSync(): Promise<void> {
    if (!this.serverSync || !this.activeScope) return;
    const scope = this.activeScope;
    const result = await this.serverSync.retrySession(scope.sessionId);
    await this.applyServerFlushResult(scope, result);
  }
}
