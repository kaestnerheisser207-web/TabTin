import { MEETING_ARCHIVE_SCHEMA_VERSION } from '../../shared/meeting-recording-contract';
import { randomUUID } from 'node:crypto';

import type {
  AppendMeetingAudioChunkInput,
  AppendMeetingPcmChunkInput,
  MeetingArchiveManifestV2,
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
import type { MeetingAudioUploader } from './MeetingAudioUploader';
import type { MeetingCaptureHost } from './MeetingCaptureWindow';
import {
  MeetingServerRequestError,
  type MeetingServerSync,
  type MeetingSyncFlushResult,
  type MeetingServerSession,
  type MeetingTranscriptSegmentInput,
} from './MeetingServerSync';

const ACTIVE_STATES = new Set(['preparing', 'recording'] as const);
const DEFAULT_SOURCE_SWITCH_TIMEOUT_MS = 10_000;

function readString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function serverSessionManifest(
  session: MeetingServerSession,
  userId: string,
): MeetingArchiveManifestV2 {
  const tracks = Array.isArray(session.tracks) ? session.tracks : [];
  const buildTrack = (source: 'local' | 'remote') => {
    const remote = tracks.find(
      (value) =>
        value !== null &&
        typeof value === 'object' &&
        (value as Record<string, unknown>).source === source,
    ) as Record<string, unknown> | undefined;
    return {
      source,
      status: (readString(remote?.capture_status, 'pending') || 'pending') as
        MeetingArchiveManifestV2['tracks']['local']['status'],
      nextSequence: 0,
      durationMs: readNumber(remote?.duration_ms),
      bytes: readNumber(remote?.file_size),
      sampleRate: readNumber(remote?.sample_rate),
      channelCount: readNumber(remote?.channel_count),
      codec: readString(remote?.codec),
      container: readString(remote?.container),
      lastCheckpointAt: remote?.last_checkpoint_at
        ? String(remote.last_checkpoint_at)
        : null,
      finalizedRelativePath: null,
      contentHash: readString(remote?.content_hash),
      storageStatus: (readString(remote?.storage_status, 'local_only') ||
        'local_only') as MeetingArchiveManifestV2['tracks']['local']['storageStatus'],
      fileRecordId: remote?.file_record_id
        ? String(remote.file_record_id)
        : null,
      objectKey: '',
      uploadError: '',
      uploadAttempts: 0,
      lastUploadAttemptAt: null,
      errorCode: readString(remote?.error_code),
      errorMessage: readString(remote?.error_message),
    };
  };
  const createdAt = readString(session.created_at, new Date(0).toISOString());
  return {
    schemaVersion: MEETING_ARCHIVE_SCHEMA_VERSION,
    sessionId: session.id,
    organizationId: readString(session.organization_id),
    userId,
    projectId: session.project_id ? String(session.project_id) : null,
    projectName: readString(session.project_name),
    title: readString(session.title, '未命名会议'),
    brief: readString(session.brief),
    consentConfirmedAt: readString(session.consent_confirmed_at),
    microphoneDeviceId: '',
    microphoneDeviceLabel: '',
    systemAudioSourceId: '',
    systemAudioSourceLabel: '',
    copilotInitiallyEnabled: session.copilot_initially_enabled === true,
    copilotEnabled: session.copilot_enabled === true,
    transcriptionStatus: 'idle',
    transcriptRevision: 0,
    transcriptFinalCount: 0,
    transcriptRunId: '',
    transcriptionError: '',
    lifecycleStatus: (readString(session.lifecycle_status, 'stopped') ||
      'stopped') as MeetingArchiveManifestV2['lifecycleStatus'],
    createdAt,
    startedAt: session.started_at ? String(session.started_at) : null,
    endedAt: session.ended_at ? String(session.ended_at) : null,
    durationMs: readNumber(session.duration_ms),
    serverSyncStatus: 'synced',
    serverSyncError: '',
    tracks: {
      local: buildTrack('local'),
      remote: buildTrack('remote'),
    },
  };
}

export interface MeetingRecordingManagerOptions {
  archiveStore?: MeetingArchiveStore;
  onStatusChanged?: (status: MeetingRecordingStatus) => void;
  captureHost?: MeetingCaptureHost;
  createAsrRuntime?: (input: {
    scope: MeetingArchiveScope;
    onTranscript: (checkpoint: MeetingTranscriptCheckpoint) => Promise<void>;
    onStatus: (
      status: MeetingArchiveManifestV2['transcriptionStatus'],
      errorMessage?: string,
    ) => Promise<MeetingRecordingStatus>;
  }) => MeetingAsrRuntime;
  serverSync?: MeetingServerSync;
  audioUploader?: MeetingAudioUploader;
  sourceSwitchTimeoutMs?: number;
}

export interface MeetingAsrRuntime {
  start(): Promise<void>;
  appendPcm(
    source: AppendMeetingPcmChunkInput['source'],
    bytes: Uint8Array,
  ): void;
  stop(): Promise<void>;
}

export class MeetingRecordingManager {
  private readonly archiveStore: MeetingArchiveStore;
  private readonly onStatusChanged?: (status: MeetingRecordingStatus) => void;
  private readonly captureHost?: MeetingCaptureHost;
  private readonly createAsrRuntime?: MeetingRecordingManagerOptions['createAsrRuntime'];
  private readonly serverSync?: MeetingServerSync;
  private readonly audioUploader?: MeetingAudioUploader;
  private readonly sourceSwitchTimeoutMs: number;
  private activeScope: MeetingArchiveScope | null = null;
  private activeManifest: MeetingArchiveManifestV2 | null = null;
  private operationChain: Promise<unknown> = Promise.resolve();
  private stopPromise: Promise<MeetingRecordingStatus> | null = null;
  private activeAsrRuntime: MeetingAsrRuntime | null = null;
  private readonly pendingTranscriptSync = new Map<
    string,
    MeetingTranscriptSegmentInput
  >();
  private readonly uploadTasks = new Map<string, Promise<void>>();
  private transcriptSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MeetingRecordingManagerOptions = {}) {
    this.archiveStore = options.archiveStore ?? new MeetingArchiveStore();
    this.onStatusChanged = options.onStatusChanged;
    this.captureHost = options.captureHost;
    this.createAsrRuntime = options.createAsrRuntime;
    this.serverSync = options.serverSync;
    this.audioUploader = options.audioUploader;
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
    void this.serverSync
      .flushSession(scope.sessionId)
      .then((result) => this.applyServerFlushResult(scope, result))
      .catch(() => undefined);
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
    manifest: MeetingArchiveManifestV2,
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
      storageStatus:
        track.fileRecordId || track.storageStatus === 'synced'
          ? 'synced'
          : track.storageStatus === 'deleted'
            ? 'deleted'
            : track.storageStatus === 'uploading' ||
                track.storageStatus === 'confirming'
              ? 'uploading'
              : 'local_only',
      fileRecordId: track.fileRecordId,
    });
  }

  private updateActiveManifest(manifest: MeetingArchiveManifestV2): void {
    if (this.activeManifest?.sessionId !== manifest.sessionId) return;
    this.activeManifest = manifest;
    this.emitStatus();
  }

  private async uploadFinalizedTracks(scope: MeetingArchiveScope): Promise<void> {
    const existing = this.uploadTasks.get(scope.sessionId);
    if (existing) return existing;
    const task = this.performFinalizedTrackUploads(scope);
    this.uploadTasks.set(scope.sessionId, task);
    try {
      await task;
    } finally {
      if (this.uploadTasks.get(scope.sessionId) === task) {
        this.uploadTasks.delete(scope.sessionId);
      }
    }
  }

  private async performFinalizedTrackUploads(
    scope: MeetingArchiveScope,
  ): Promise<void> {
    if (!this.audioUploader) return;
    let manifest = await this.archiveStore.readManifest(scope);
    for (const source of ['local', 'remote'] as const) {
      let track = manifest.tracks[source];
      if (
        !track.finalizedRelativePath ||
        track.bytes <= 0 ||
        track.storageStatus === 'synced' ||
        track.storageStatus === 'deleted'
      ) {
        continue;
      }
      const filePath = this.archiveStore.resolveSessionFile(
        scope,
        track.finalizedRelativePath,
      );
      const common = {
        sessionId: scope.sessionId,
        organizationId: scope.organizationId,
        source,
        fileName: track.finalizedRelativePath,
        fileSize: track.bytes,
        contentType: 'audio/webm',
        fileHash: track.contentHash || undefined,
      };
      let failureStatus: MeetingArchiveManifestV2['tracks']['local']['storageStatus'] =
        'failed';
      try {
        let result = null;
        if (track.objectKey && track.storageStatus === 'confirming') {
          failureStatus = 'confirming';
          try {
            manifest = await this.archiveStore.updateTrackUploadState(
              scope,
              source,
              {
                storageStatus: 'confirming',
                uploadError: '',
                uploadAttempts: track.uploadAttempts + 1,
                lastUploadAttemptAt: new Date().toISOString(),
              },
            );
            this.updateActiveManifest(manifest);
            result = await this.audioUploader.confirmTrack({
              ...common,
              objectKey: track.objectKey,
            });
          } catch (error) {
            throw error;
          }
        }
        if (!result) {
          failureStatus = 'failed';
          manifest = await this.archiveStore.updateTrackUploadState(
            scope,
            source,
            {
              storageStatus: 'pending',
              uploadError: '',
              uploadAttempts: track.uploadAttempts + 1,
              lastUploadAttemptAt: new Date().toISOString(),
            },
          );
          this.updateActiveManifest(manifest);
          result = await this.audioUploader.uploadTrack({
            ...common,
            filePath,
            onPresigned: async (objectKey) => {
              const updated = await this.archiveStore.updateTrackUploadState(
                scope,
                source,
                { storageStatus: 'uploading', objectKey, uploadError: '' },
              );
              this.updateActiveManifest(updated);
            },
            onPutCompleted: async (objectKey) => {
              failureStatus = 'confirming';
              const updated = await this.archiveStore.updateTrackUploadState(
                scope,
                source,
                { storageStatus: 'confirming', objectKey },
              );
              this.updateActiveManifest(updated);
            },
          });
        }
        manifest = await this.archiveStore.updateTrackUploadState(scope, source, {
          storageStatus: 'confirming',
          fileRecordId: result.fileId,
          objectKey: result.fileKey,
          uploadError: '',
        });
        this.updateActiveManifest(manifest);
        this.checkpointServerTrack(manifest, source);
        if (!this.serverSync) {
          throw new Error('meeting server sync is unavailable');
        }
        const syncResult = await this.serverSync.retrySession(scope.sessionId);
        if (syncResult.status !== 'synced' || syncResult.pendingCount !== 0) {
          throw new Error(
            syncResult.failure?.message ||
              syncResult.conflict?.message ||
              'meeting track binding is pending',
          );
        }
        manifest = await this.archiveStore.updateTrackUploadState(scope, source, {
          storageStatus: 'synced',
          uploadError: '',
        });
        this.updateActiveManifest(manifest);
      } catch (error) {
        manifest = await this.archiveStore.updateTrackUploadState(scope, source, {
          storageStatus: failureStatus,
          uploadError: error instanceof Error ? error.message : String(error),
        });
        this.updateActiveManifest(manifest);
      }
      track = manifest.tracks[source];
    }
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
        this.activeManifest!.lifecycleStatus !== 'recording'
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
        this.activeManifest!.lifecycleStatus !== 'recording'
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
    const localManifests = await this.archiveStore.listManifests(scope);
    const manifestsById = new Map(
      localManifests.map((manifest) => [manifest.sessionId, manifest]),
    );
    if (this.serverSync?.listSessions) {
      let remoteSessions: MeetingServerSession[] | null = null;
      try {
        remoteSessions = await this.serverSync.listSessions({
          organizationId: scope.organizationId,
        });
      } catch {
        remoteSessions = null;
      }
      if (remoteSessions) {
        const remoteIds = new Set(remoteSessions.map((session) => session.id));
        for (const [sessionId, local] of manifestsById) {
          const safelyServerBacked =
            !['preparing', 'recording', 'interrupted'].includes(
              local.lifecycleStatus,
            ) &&
            Object.values(local.tracks).every((track) =>
              ['synced', 'deleted'].includes(track.storageStatus),
            );
          if (safelyServerBacked && !remoteIds.has(sessionId)) {
            manifestsById.delete(sessionId);
            void this.archiveStore
              .deleteArchive({ ...scope, sessionId })
              .catch(() => undefined);
          }
        }
      }
      for (const session of remoteSessions ?? []) {
        const local = manifestsById.get(session.id);
        if (!local) {
          manifestsById.set(
            session.id,
            serverSessionManifest(session, scope.userId),
          );
          continue;
        }
        const hasUnsyncedLocalState =
          ['preparing', 'recording', 'interrupted'].includes(
            local.lifecycleStatus,
          ) ||
          Object.values(local.tracks).some(
            (track) => !['synced', 'deleted'].includes(track.storageStatus),
          );
        if (!hasUnsyncedLocalState) {
          const remote = serverSessionManifest(session, scope.userId);
          manifestsById.set(session.id, {
            ...local,
            title: remote.title,
            brief: remote.brief,
            projectId: remote.projectId,
            projectName: remote.projectName,
            lifecycleStatus: remote.lifecycleStatus,
            startedAt: remote.startedAt,
            endedAt: remote.endedAt,
            durationMs: remote.durationMs,
            copilotEnabled: remote.copilotEnabled,
            serverSyncStatus: 'synced',
            serverSyncError: '',
          });
        }
      }
    }
    return [...manifestsById.values()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .map((manifest) => {
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
      return { manifest, audioUrls, transcript: [], copilotRecords: [] };
      });
  }

  async getArchive(scope: MeetingArchiveScope): Promise<MeetingLocalArchive> {
    const localManifest = await this.archiveStore.readManifest(scope).catch(() => null);
    let remoteSession: MeetingServerSession | null = null;
    if (this.serverSync?.getSession) {
      try {
        remoteSession = await this.serverSync.getSession(scope.sessionId);
      } catch (error) {
        if (
          error instanceof MeetingServerRequestError &&
          (error.status === 403 || error.status === 404)
        ) {
          const serverBacked = Boolean(
            localManifest &&
              Object.values(localManifest.tracks).every((track) =>
                ['synced', 'deleted'].includes(track.storageStatus),
              ),
          );
          if (serverBacked) {
            await this.archiveStore.deleteArchive(scope).catch(() => undefined);
            throw new Error('meeting archive not found');
          }
        }
      }
    }
    if (!localManifest && !remoteSession) {
      throw new Error('meeting archive not found');
    }
    const manifest =
      localManifest ?? serverSessionManifest(remoteSession!, scope.userId);
    const remoteManifest = remoteSession
      ? serverSessionManifest(remoteSession, scope.userId)
      : null;
    if (localManifest && remoteManifest) {
      for (const source of ['local', 'remote'] as const) {
        const remoteTrack = remoteManifest.tracks[source];
        if (remoteTrack.fileRecordId || remoteTrack.storageStatus === 'deleted') {
          manifest.tracks[source].storageStatus = remoteTrack.storageStatus;
          manifest.tracks[source].fileRecordId = remoteTrack.fileRecordId;
        }
      }
    }
    const [localTranscript, localCopilotRecords, remoteTranscript, remoteCopilot] = await Promise.all([
      localManifest ? this.archiveStore.readTranscript(scope) : Promise.resolve([]),
      localManifest
        ? this.archiveStore.readCopilotRecords(scope)
        : Promise.resolve([]),
      this.serverSync?.getTranscript && remoteSession
        ? this.serverSync.getTranscript(scope.sessionId).catch(() => null)
        : Promise.resolve(null),
      this.serverSync?.getCopilotAnswers && remoteSession
        ? this.serverSync.getCopilotAnswers(scope.sessionId).catch(() => [])
        : Promise.resolve([]),
    ]);
    const copilotRecords =
      localCopilotRecords.length > 0
        ? localCopilotRecords
        : remoteCopilot
            .map((answer) => {
              const result = answer.result_snapshot;
              const questionSegmentId = readString(answer.question_segment_id);
              if (
                !questionSegmentId ||
                result === null ||
                typeof result !== 'object'
              ) {
                return null;
              }
              return {
                questionSegmentId,
                evaluatedAt: readString(answer.created_at, manifest.createdAt),
                result: result as MeetingCopilotAnswerResult,
              };
            })
            .filter((record): record is NonNullable<typeof record> => Boolean(record));
    const transcript =
      localTranscript.length > 0
        ? localTranscript
        : (remoteTranscript?.segments ?? []).map((segment) => ({
            externalId: readString(segment.external_id, readString(segment.id)),
            source: readString(segment.source, 'remote') as 'local' | 'remote',
            speakerKey: readString(segment.speaker_key) || undefined,
            startMs: readNumber(segment.start_ms),
            endMs: readNumber(segment.end_ms),
            text: readString(segment.display_text, readString(segment.raw_text)),
            isFinal: segment.is_final !== false,
            confidence:
              typeof segment.confidence === 'number'
                ? segment.confidence
                : null,
            recordedAt: readString(
              segment.created_at,
              manifest.createdAt,
            ),
          }));
    const audioUrls: MeetingLocalArchive['audioUrls'] = {};
    for (const source of ['local', 'remote'] as const) {
      if (manifest.tracks[source].storageStatus === 'deleted') continue;
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
    if (
      localManifest &&
      remoteManifest &&
      (['local', 'remote'] as const).every(
        (source) => remoteManifest.tracks[source].storageStatus === 'deleted',
      )
    ) {
      void this.archiveStore.deleteAudioFiles(scope).catch(() => undefined);
    }
    if (this.serverSync?.getTrackAudio && remoteSession) {
      for (const source of ['local', 'remote'] as const) {
        if (audioUrls[source]) continue;
        const audio = await this.serverSync
          .getTrackAudio(scope.sessionId, source)
          .catch(() => null);
        if (audio?.url) audioUrls[source] = audio.url;
      }
    }
    return { manifest, audioUrls, transcript, copilotRecords };
  }

  async deleteArchiveAudio(scope: MeetingArchiveScope): Promise<void> {
    if (!this.serverSync?.deleteAudio) {
      throw new Error('meeting server is unavailable');
    }
    await this.serverSync.deleteAudio(scope.sessionId);
    await this.archiveStore.deleteAudioFiles(scope).catch(() => undefined);
  }

  async deleteArchive(scope: MeetingArchiveScope): Promise<void> {
    if (!this.serverSync?.deleteSession) {
      throw new Error('meeting server is unavailable');
    }
    await this.serverSync.deleteSession(scope.sessionId);
    await this.archiveStore.deleteArchive(scope).catch(() => undefined);
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

  async stop(scope?: MeetingArchiveScope): Promise<MeetingRecordingStatus> {
    if (this.stopPromise) return this.stopPromise;
    const activeScope = this.requireActiveScope(scope);
    if (
      !['recording', 'interrupted'].includes(
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
      const status = await this.stopPromise;
      void this.uploadFinalizedTracks(activeScope).catch(() => undefined);
      if (this.serverSync) {
        void this.serverSync
          .retrySession(activeScope.sessionId)
          .then((syncResult) =>
            this.applyServerFlushResult(activeScope, syncResult),
          )
          .catch(() => undefined);
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
        this.activeManifest!.lifecycleStatus !== 'recording'
      ) {
        throw new Error(
          'audio chunks are accepted only while recording',
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
      !['preparing', 'recording'].includes(
        this.activeManifest!.lifecycleStatus,
      )
    ) {
      throw new Error(
        'PCM chunks are accepted only while preparing or recording',
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
    status: MeetingArchiveManifestV2['transcriptionStatus'],
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
        !['preparing', 'recording'].includes(
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
    const question = archive.transcript.find(
      (checkpoint) =>
        checkpoint.externalId === questionSegmentId && checkpoint.isFinal,
    );
    if (!question) {
      return {
        status: 'no_question',
        message: '这个问题尚未转写完成，请稍后再试',
      };
    }
    if (question.source !== 'remote') {
      return {
        status: 'no_action',
        message: '本地麦克风内容属于你的回答，不需要 Copilot 再次解答',
        candidate_segment_id: question.externalId,
      };
    }
    const result = await this.serverSync.answerCopilot(
      scope.sessionId,
      archive.transcript,
      questionSegmentId,
      this.activeManifest.copilotModelId,
      randomUUID(),
    );
    if (result.status === 'answered' || result.status === 'no_action') {
      await this.archiveStore.appendCopilotRecord(scope, result);
    }
    return result;
  }

  async interruptForShutdown(): Promise<void> {
    return this.interruptActiveRecording(true);
  }

  async interruptForCaptureTermination(): Promise<void> {
    return this.interruptActiveRecording(false);
  }

  private async interruptActiveRecording(
    stopCaptureHost: boolean,
  ): Promise<void> {
    if (!this.activeScope || !this.activeManifest) return;
    if (!ACTIVE_STATES.has(
      this.activeManifest.lifecycleStatus as 'preparing' | 'recording',
    )) return;
    const scope = this.activeScope;
    if (this.activeManifest.lifecycleStatus === 'recording') {
      if (stopCaptureHost) {
        await this.captureHost?.stop().catch(() => undefined);
      }
      await this.activeAsrRuntime?.stop().catch(() => undefined);
      this.activeAsrRuntime = null;
    }
    await this.enqueue(async () => {
      if (!this.activeManifest || this.activeScope?.sessionId !== scope.sessionId)
        return;
      this.activeManifest = await this.archiveStore.updateLifecycle(
        scope,
        'interrupted',
      );
      this.serverSync?.updateLifecycle(scope.sessionId, {
        status: 'interrupted',
        durationMs: this.activeManifest.durationMs,
      });
      this.scheduleServerFlush(scope);
      this.emitStatus();
    });
  }

  async recoverInterrupted(): Promise<MeetingArchiveManifestV2[]> {
    return this.enqueue(async () => {
      const recovered = await this.archiveStore.recoverInterrupted();
      const finalized: MeetingArchiveManifestV2[] = [];
      for (const manifest of recovered) {
        const scope = {
          organizationId: manifest.organizationId,
          userId: manifest.userId,
          sessionId: manifest.sessionId,
        };
        await this.archiveStore.finalizeAudioTracks(scope, {
          reconcileParts: true,
          bestEffort: true,
        });
        finalized.push(await this.archiveStore.readManifest(scope));
      }
      const uploadCandidates = await this.archiveStore.listAllManifests();
      for (const manifest of uploadCandidates) {
        if (!['stopped', 'interrupted'].includes(manifest.lifecycleStatus)) continue;
        const scope = {
          organizationId: manifest.organizationId,
          userId: manifest.userId,
          sessionId: manifest.sessionId,
        };
        if (
          Object.values(manifest.tracks).some(
            (track) =>
              Boolean(track.finalizedRelativePath) &&
              !['synced', 'deleted'].includes(track.storageStatus),
          )
        ) {
          void this.uploadFinalizedTracks(scope).catch(() => undefined);
        }
      }
      return finalized;
    });
  }

  async retryActiveServerSync(): Promise<void> {
    await this.retryPendingUploads();
    if (!this.serverSync || !this.activeScope) return;
    const scope = this.activeScope;
    const result = await this.serverSync.retrySession(scope.sessionId);
    await this.applyServerFlushResult(scope, result);
  }

  async retryPendingUploads(): Promise<void> {
    if (!this.audioUploader) return;
    const manifests = await this.archiveStore.listAllManifests();
    for (const manifest of manifests) {
      if (!['stopped', 'interrupted'].includes(manifest.lifecycleStatus)) continue;
      if (
        !Object.values(manifest.tracks).some(
          (track) =>
            Boolean(track.finalizedRelativePath) &&
            !['synced', 'deleted'].includes(track.storageStatus),
        )
      ) {
        continue;
      }
      await this.uploadFinalizedTracks({
        organizationId: manifest.organizationId,
        userId: manifest.userId,
        sessionId: manifest.sessionId,
      });
    }
  }
}
