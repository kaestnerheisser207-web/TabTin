import { MEETING_ARCHIVE_SCHEMA_VERSION } from '../../shared/meeting-recording-contract';
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import fs from 'node:fs/promises';

import type {
  AppendMeetingAudioChunkInput,
  AppendMeetingPcmChunkInput,
  MeetingArchiveManifestV2,
  MeetingArchiveScope,
  MeetingMediaProbeResult,
  MeetingMediaProbeInput,
  MeetingArchiveListScope,
  MeetingCopilotAnswerResult,
  MeetingCaptureSourceEndedEvent,
  MeetingCaptureSourceNoticeEvent,
  MeetingLocalArchive,
  MeetingMicrophoneTestInput,
  MeetingMicrophoneTestResult,
  MeetingMicrophoneDevice,
  MeetingSystemAudioSource,
  MeetingRecordingStatus,
  MeetingStorageProbeResult,
  MeetingTranscriptCheckpoint,
  MeetingTranscriptChangedEvent,
  PrepareMeetingArchiveInput,
  SwitchMeetingMicrophoneInput,
  SwitchMeetingSystemAudioInput,
} from '../../shared/meeting-recording-contract';
import { MeetingArchiveStore } from './MeetingArchiveStore';
import type { MeetingAudioUploader } from './MeetingAudioUploader';
import type {
  MeetingCaptureHost,
  MeetingCaptureSourceSwitchReference,
  PreparedMeetingCaptureSource,
} from './MeetingCaptureWindow';
import {
  MeetingServerRequestError,
  type MeetingServerSync,
  type MeetingSyncFlushResult,
  type MeetingServerSession,
  type MeetingTranscriptSegmentInput,
} from './MeetingServerSync';
import { createLogger } from '../logger';

const ACTIVE_STATES = new Set(['preparing', 'recording'] as const);
const log = createLogger('MeetingRecording');

class MeetingSourceSwitchSupersededError extends Error {}

interface PendingSourceResolution {
  reference: MeetingCaptureSourceSwitchReference;
  resolution: 'finalize' | 'rollback';
}

type MeetingLocalAudioFileState =
  | 'available'
  | 'deleted'
  | 'not_declared'
  | 'missing'
  | 'empty'
  | 'not_file'
  | 'unreadable'
  | 'cleanup_pending';

function timestampValue(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function mergeTranscriptCheckpoints(
  local: MeetingTranscriptCheckpoint[],
  remote: MeetingTranscriptCheckpoint[],
): MeetingTranscriptCheckpoint[] {
  const merged = new Map<string, MeetingTranscriptCheckpoint>();
  for (const checkpoint of [...local, ...remote]) {
    const current = merged.get(checkpoint.externalId);
    if (!current) {
      merged.set(checkpoint.externalId, checkpoint);
      continue;
    }
    if (current.isFinal !== checkpoint.isFinal) {
      if (checkpoint.isFinal) merged.set(checkpoint.externalId, checkpoint);
      continue;
    }
    if (
      timestampValue(checkpoint.recordedAt) > timestampValue(current.recordedAt)
    ) {
      merged.set(checkpoint.externalId, checkpoint);
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.source.localeCompare(right.source) ||
      left.externalId.localeCompare(right.externalId),
  );
}

function mergeCopilotRecords(
  local: MeetingLocalArchive['copilotRecords'],
  remote: MeetingLocalArchive['copilotRecords'],
): MeetingLocalArchive['copilotRecords'] {
  const merged = new Map<
    string,
    MeetingLocalArchive['copilotRecords'][number]
  >();
  for (const record of [...local, ...remote]) {
    const candidateId =
      record.candidateId?.trim() ||
      record.result.candidate_id?.trim() ||
      record.questionSegmentId;
    const current = merged.get(candidateId);
    if (!current) {
      merged.set(candidateId, record);
      continue;
    }
    const currentRevision = Math.max(
      current.revision ?? current.result.candidate_revision ?? 1,
      1,
    );
    const candidateRevision = Math.max(
      record.revision ?? record.result.candidate_revision ?? 1,
      1,
    );
    if (candidateRevision !== currentRevision) {
      if (candidateRevision > currentRevision) {
        merged.set(candidateId, record);
      }
      continue;
    }
    const currentTimestamp = timestampValue(current.evaluatedAt);
    const candidateTimestamp = timestampValue(record.evaluatedAt);
    if (candidateTimestamp !== currentTimestamp) {
      if (candidateTimestamp > currentTimestamp) {
        merged.set(candidateId, record);
      }
      continue;
    }
    const currentTieBreaker = `${current.result.status}\u0000${JSON.stringify(current.result)}`;
    const candidateTieBreaker = `${record.result.status}\u0000${JSON.stringify(record.result)}`;
    if (candidateTieBreaker > currentTieBreaker) {
      merged.set(candidateId, record);
    }
  }
  return [...merged.values()].sort(
    (left, right) =>
      timestampValue(left.evaluatedAt) - timestampValue(right.evaluatedAt) ||
      left.questionSegmentId.localeCompare(right.questionSegmentId),
  );
}

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
      status: (readString(remote?.capture_status, 'pending') ||
        'pending') as MeetingArchiveManifestV2['tracks']['local']['status'],
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
  onTranscriptChanged?: (event: MeetingTranscriptChangedEvent) => void;
  onCaptureSourceNotice?: (event: MeetingCaptureSourceNoticeEvent) => void;
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
  private readonly onTranscriptChanged?: (
    event: MeetingTranscriptChangedEvent,
  ) => void;
  private readonly onCaptureSourceNotice?: (
    event: MeetingCaptureSourceNoticeEvent,
  ) => void;
  private readonly captureHost?: MeetingCaptureHost;
  private readonly createAsrRuntime?: MeetingRecordingManagerOptions['createAsrRuntime'];
  private readonly serverSync?: MeetingServerSync;
  private readonly audioUploader?: MeetingAudioUploader;
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
  private readonly sourceSwitchGeneration: Record<'local' | 'remote', number> =
    {
      local: 0,
      remote: 0,
    };
  private readonly activeSourceCommitPhases = new Set<Promise<unknown>>();
  private readonly activeSourceCommitPhaseBySource = new Map<
    'local' | 'remote',
    Promise<unknown>
  >();
  private readonly pendingSourceResolutions = new Map<
    'local' | 'remote',
    PendingSourceResolution
  >();
  private readonly activeSourceResolutionAttempts = new Map<
    'local' | 'remote',
    Promise<void>
  >();
  private transcriptSyncTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: MeetingRecordingManagerOptions = {}) {
    this.archiveStore = options.archiveStore ?? new MeetingArchiveStore();
    this.onStatusChanged = options.onStatusChanged;
    this.onTranscriptChanged = options.onTranscriptChanged;
    this.onCaptureSourceNotice = options.onCaptureSourceNotice;
    this.captureHost = options.captureHost;
    this.createAsrRuntime = options.createAsrRuntime;
    this.serverSync = options.serverSync;
    this.audioUploader = options.audioUploader;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const current = this.operationChain.catch(() => undefined).then(operation);
    this.operationChain = current;
    return current;
  }

  private invalidateSourceSwitches(): void {
    this.sourceSwitchGeneration.local += 1;
    this.sourceSwitchGeneration.remote += 1;
  }

  private trackSourceCommitPhase<T>(
    source: 'local' | 'remote',
    operation: Promise<T>,
  ): Promise<T> {
    const tracked = operation.finally(() => {
      this.activeSourceCommitPhases.delete(tracked);
      if (this.activeSourceCommitPhaseBySource.get(source) === tracked) {
        this.activeSourceCommitPhaseBySource.delete(source);
      }
    });
    this.activeSourceCommitPhases.add(tracked);
    this.activeSourceCommitPhaseBySource.set(source, tracked);
    return tracked;
  }

  private reconcilePendingSourceResolution(
    source: 'local' | 'remote',
  ): Promise<void> {
    const active = this.activeSourceResolutionAttempts.get(source);
    if (active) return active;
    const pending = this.pendingSourceResolutions.get(source);
    if (!pending) return Promise.resolve();
    if (!this.captureHost) {
      return Promise.reject(
        new Error('meeting media capture host is unavailable'),
      );
    }
    const attempt = (async () => {
      if (pending.resolution === 'finalize') {
        await this.captureHost!.finalizeSourceSwitch(pending.reference);
      } else {
        await this.captureHost!.rollbackSourceSwitch(pending.reference);
      }
      if (this.pendingSourceResolutions.get(source) === pending) {
        this.pendingSourceResolutions.delete(source);
      }
    })().finally(() => {
      if (this.activeSourceResolutionAttempts.get(source) === attempt) {
        this.activeSourceResolutionAttempts.delete(source);
      }
    });
    this.activeSourceResolutionAttempts.set(source, attempt);
    return attempt;
  }

  private async reconcileAllPendingSourceResolutions(): Promise<void> {
    for (const source of ['local', 'remote'] as const) {
      await this.reconcilePendingSourceResolution(source);
    }
  }

  private isSourceSwitchCurrent(
    source: 'local' | 'remote',
    generation: number,
    scope: MeetingArchiveScope,
  ): boolean {
    return (
      this.sourceSwitchGeneration[source] === generation &&
      this.stopPromise === null &&
      this.activeScope?.sessionId === scope.sessionId &&
      this.activeScope.organizationId === scope.organizationId &&
      this.activeScope.userId === scope.userId &&
      this.activeManifest?.lifecycleStatus === 'recording'
    );
  }

  private async abortPreparedSourceSwitch(
    prepared: PreparedMeetingCaptureSource,
  ): Promise<void> {
    await this.captureHost
      ?.abortSourceSwitch({
        operationId: prepared.operationId,
        source: prepared.source,
      })
      .catch(() => undefined);
  }

  private async switchCaptureSource(
    source: 'local' | 'remote',
    scope: MeetingArchiveScope,
    requestedSourceId: string,
    prepare: () => Promise<PreparedMeetingCaptureSource>,
  ): Promise<MeetingRecordingStatus> {
    if (!this.captureHost) {
      throw new Error('meeting media capture host is unavailable');
    }
    const generation = ++this.sourceSwitchGeneration[source];
    const startedAt = Date.now();
    log.info('source_switch', {
      phase: 'prepare_start',
      source,
      generation,
      requestedSourceId,
      sessionId: scope.sessionId,
    });
    let prepared: PreparedMeetingCaptureSource | null = null;
    let committed = false;
    try {
      const activeCommit = this.activeSourceCommitPhaseBySource.get(source);
      if (activeCommit) await Promise.allSettled([activeCommit]);
      await this.reconcilePendingSourceResolution(source);
      if (!this.isSourceSwitchCurrent(source, generation, scope)) {
        throw new MeetingSourceSwitchSupersededError();
      }
      prepared = await prepare();
      log.info('source_switch', {
        phase: 'prepare_complete',
        source,
        generation,
        operationId: prepared.operationId,
        elapsedMs: Date.now() - startedAt,
      });
      if (prepared.source !== source) {
        throw new Error('meeting capture returned the wrong audio source');
      }
      return await this.trackSourceCommitPhase(
        source,
        this.enqueue(async () => {
          if (!this.isSourceSwitchCurrent(source, generation, scope)) {
            throw new MeetingSourceSwitchSupersededError();
          }
          const selected = await this.captureHost!.commitSourceSwitch({
            operationId: prepared!.operationId,
            source,
          });
          committed = true;
          log.info('source_switch', {
            phase: 'commit_complete',
            source,
            generation,
            operationId: prepared!.operationId,
            selectedSourceId: selected.sourceId,
            elapsedMs: Date.now() - startedAt,
          });
          const reference = {
            operationId: prepared!.operationId,
            source,
          };
          try {
            if (selected.source !== source) {
              throw new Error(
                'meeting capture committed the wrong audio source',
              );
            }
            this.activeManifest = await this.archiveStore.updateCaptureSource(
              scope,
              source,
              selected.sourceId,
              selected.label,
            );
          } catch (error) {
            this.pendingSourceResolutions.set(source, {
              reference,
              resolution: 'rollback',
            });
            try {
              await this.reconcilePendingSourceResolution(source);
              log.warn('source_switch', {
                phase: 'rollback_complete',
                source,
                generation,
                operationId: prepared!.operationId,
                elapsedMs: Date.now() - startedAt,
              });
            } catch (resolutionError) {
              log.warn('source_switch', {
                phase: 'rollback_pending',
                source,
                generation,
                operationId: prepared!.operationId,
                errorName:
                  resolutionError instanceof Error
                    ? resolutionError.name
                    : 'UnknownError',
                elapsedMs: Date.now() - startedAt,
              });
            }
            throw error;
          }
          this.pendingSourceResolutions.set(source, {
            reference,
            resolution: 'finalize',
          });
          try {
            await this.reconcilePendingSourceResolution(source);
            log.info('source_switch', {
              phase: 'finalize_complete',
              source,
              generation,
              operationId: prepared!.operationId,
              elapsedMs: Date.now() - startedAt,
            });
          } catch (error) {
            // The new source and manifest already agree. Finalization only
            // releases the old input, so do not report the switch as failed or
            // roll the actual source back behind the persisted selection.
            log.warn('source_switch', {
              phase: 'finalize_failed',
              source,
              generation,
              operationId: prepared!.operationId,
              errorName: error instanceof Error ? error.name : 'UnknownError',
              elapsedMs: Date.now() - startedAt,
            });
          }
          this.checkpointServerTrack(this.activeManifest, source);
          this.scheduleServerFlush(scope);
          return this.emitStatus();
        }),
      );
    } catch (error) {
      if (prepared && !committed)
        await this.abortPreparedSourceSwitch(prepared);
      const logFailure =
        error instanceof MeetingSourceSwitchSupersededError
          ? log.info.bind(log)
          : log.warn.bind(log);
      logFailure('source_switch', {
        phase: 'failed',
        source,
        generation,
        operationId: prepared?.operationId,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        elapsedMs: Date.now() - startedAt,
      });
      if (error instanceof MeetingSourceSwitchSupersededError) {
        throw new Error(`meeting ${source} source switch was cancelled`);
      }
      throw error;
    }
  }

  private isCurrentCaptureSource(
    event: MeetingCaptureSourceEndedEvent,
  ): boolean {
    if (
      event.source !== 'local' ||
      this.activeManifest?.lifecycleStatus !== 'recording'
    ) {
      return false;
    }
    return (
      this.activeScope?.sessionId === event.sessionId &&
      this.activeScope.organizationId === event.organizationId &&
      this.activeScope.userId === event.userId &&
      this.activeManifest.microphoneDeviceId === event.sourceId
    );
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

  private async uploadFinalizedTracks(
    scope: MeetingArchiveScope,
  ): Promise<void> {
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
        manifest = await this.archiveStore.updateTrackUploadState(
          scope,
          source,
          {
            storageStatus: 'confirming',
            fileRecordId: result.fileId,
            objectKey: result.fileKey,
            uploadError: '',
          },
        );
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
        manifest = await this.archiveStore.updateTrackUploadState(
          scope,
          source,
          {
            storageStatus: 'synced',
            uploadError: '',
          },
        );
        this.updateActiveManifest(manifest);
      } catch (error) {
        manifest = await this.archiveStore.updateTrackUploadState(
          scope,
          source,
          {
            storageStatus: failureStatus,
            uploadError: error instanceof Error ? error.message : String(error),
          },
        );
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
          this.activeManifest.lifecycleStatus as 'preparing' | 'recording',
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
    const scope = { ...this.requireActiveScope(input) };
    if (
      this.activeManifest!.lifecycleStatus !== 'recording' ||
      this.stopPromise
    ) {
      throw new Error('microphone can only change during an active recording');
    }
    return this.switchCaptureSource('local', scope, input.deviceId, () =>
      this.captureHost!.prepareMicrophoneSwitch(input.deviceId),
    );
  }

  async switchSystemAudio(
    input: SwitchMeetingSystemAudioInput,
  ): Promise<MeetingRecordingStatus> {
    const scope = { ...this.requireActiveScope(input) };
    if (
      this.activeManifest!.lifecycleStatus !== 'recording' ||
      this.stopPromise
    ) {
      throw new Error(
        'system audio can only change during an active recording',
      );
    }
    return this.switchCaptureSource('remote', scope, input.sourceId, () =>
      this.captureHost!.prepareSystemAudioSwitch(input.sourceId),
    );
  }

  async handleCaptureSourceEnded(
    event: MeetingCaptureSourceEndedEvent,
  ): Promise<void> {
    if (!this.isCurrentCaptureSource(event)) return;
    const fallback = this.switchMicrophone({
      sessionId: event.sessionId,
      organizationId: event.organizationId,
      userId: event.userId,
      deviceId: 'default',
    });
    const fallbackGeneration = this.sourceSwitchGeneration.local;
    try {
      const status = await fallback;
      const currentLabel = status.manifest?.microphoneDeviceLabel;
      this.onCaptureSourceNotice?.({
        sessionId: event.sessionId,
        organizationId: event.organizationId,
        userId: event.userId,
        source: 'local',
        kind: 'fallback_succeeded',
        previousLabel: event.label,
        ...(currentLabel ? { currentLabel } : {}),
      });
    } catch (error) {
      await this.enqueue(async () => {
        if (
          this.sourceSwitchGeneration.local !== fallbackGeneration ||
          !this.isCurrentCaptureSource(event)
        ) {
          return;
        }
        this.activeManifest =
          await this.archiveStore.markCaptureSourceUnavailable(
            event,
            'local',
            'source_unavailable',
            error instanceof Error ? error.message : String(error),
          );
        this.checkpointServerTrack(this.activeManifest, 'local');
        this.scheduleServerFlush(event);
        this.emitStatus();
        this.onCaptureSourceNotice?.({
          sessionId: event.sessionId,
          organizationId: event.organizationId,
          userId: event.userId,
          source: 'local',
          kind: 'fallback_failed',
          previousLabel: event.label,
        });
      });
    }
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

  private async resolveLocalArchiveAudio(
    scope: MeetingArchiveScope,
    manifest: MeetingArchiveManifestV2,
    source: 'local' | 'remote',
  ): Promise<{ state: MeetingLocalAudioFileState; url?: string }> {
    const track = manifest.tracks[source];
    if (track.errorCode === 'audio_cleanup_pending') {
      return { state: 'cleanup_pending' };
    }
    if (track.storageStatus === 'deleted') return { state: 'deleted' };
    if (!track.finalizedRelativePath) return { state: 'not_declared' };
    const absolutePath = this.archiveStore.resolveSessionFile(
      scope,
      track.finalizedRelativePath,
    );
    let fileStat: Stats;
    try {
      fileStat = await fs.stat(absolutePath);
    } catch (error) {
      return {
        state:
          (error as NodeJS.ErrnoException).code === 'ENOENT'
            ? 'missing'
            : 'unreadable',
      };
    }
    if (!fileStat.isFile()) return { state: 'not_file' };
    if (fileStat.size <= 0) return { state: 'empty' };
    try {
      await fs.access(absolutePath, fsConstants.R_OK);
    } catch {
      return { state: 'unreadable' };
    }
    const encoded = absolutePath
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/');
    return { state: 'available', url: `tabtin-file://${encoded}` };
  }

  async getArchive(scope: MeetingArchiveScope): Promise<MeetingLocalArchive> {
    const localManifest = await this.archiveStore
      .readManifest(scope)
      .catch(() => null);
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
    let manifest =
      localManifest ?? serverSessionManifest(remoteSession!, scope.userId);
    const remoteManifest = remoteSession
      ? serverSessionManifest(remoteSession, scope.userId)
      : null;
    const remoteAudioDeleted = Boolean(
      remoteManifest &&
      (['local', 'remote'] as const).every(
        (source) => remoteManifest.tracks[source].storageStatus === 'deleted',
      ),
    );
    const persistedCleanupPending = Boolean(
      localManifest &&
      Object.values(localManifest.tracks).some(
        (track) => track.errorCode === 'audio_cleanup_pending',
      ),
    );
    const localAudioDeleted = Boolean(
      localManifest &&
      Object.values(localManifest.tracks).every(
        (track) => track.storageStatus === 'deleted',
      ),
    );
    const cleanupRequired = Boolean(
      localManifest &&
      (persistedCleanupPending || (remoteAudioDeleted && !localAudioDeleted)),
    );
    let localAudioCleanupPending = false;
    if (localManifest && cleanupRequired) {
      let pendingManifest = localManifest;
      if (!persistedCleanupPending) {
        try {
          pendingManifest =
            await this.archiveStore.markAudioCleanupPending(scope);
        } catch (error) {
          throw new Error(
            'meeting local audio cleanup state could not be saved',
            { cause: error },
          );
        }
      }
      try {
        manifest = await this.archiveStore.deleteAudioFiles(scope);
      } catch (error) {
        manifest = pendingManifest;
        localAudioCleanupPending = true;
        log.warn('archive_audio_cleanup', {
          phase: 'pending',
          sessionId: scope.sessionId,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
    if (localManifest && remoteManifest && !cleanupRequired) {
      for (const source of ['local', 'remote'] as const) {
        const remoteTrack = remoteManifest.tracks[source];
        if (
          remoteTrack.fileRecordId ||
          remoteTrack.storageStatus === 'deleted'
        ) {
          manifest.tracks[source].storageStatus = remoteTrack.storageStatus;
          manifest.tracks[source].fileRecordId = remoteTrack.fileRecordId;
        }
      }
    }
    const [
      localTranscript,
      localCopilotRecords,
      remoteTranscript,
      remoteCopilot,
    ] = await Promise.all([
      localManifest
        ? this.archiveStore.readTranscript(scope)
        : Promise.resolve([]),
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
    const remoteCopilotRecords = remoteCopilot
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
        const resultRecord = result as Record<string, unknown>;
        return {
          questionSegmentId,
          candidateId: readString(resultRecord.candidate_id, questionSegmentId),
          revision: Math.max(readNumber(resultRecord.candidate_revision, 1), 1),
          evaluatedAt: readString(answer.created_at, manifest.createdAt),
          result: result as MeetingCopilotAnswerResult,
        };
      })
      .filter((record): record is NonNullable<typeof record> =>
        Boolean(record),
      );
    const copilotRecords = mergeCopilotRecords(
      localCopilotRecords,
      remoteCopilotRecords,
    );
    const remoteTranscriptCheckpoints = (remoteTranscript?.segments ?? []).map(
      (segment) => ({
        externalId: readString(segment.external_id, readString(segment.id)),
        source: readString(segment.source, 'remote') as 'local' | 'remote',
        speakerKey: readString(segment.speaker_key) || undefined,
        startMs: readNumber(segment.start_ms),
        endMs: readNumber(segment.end_ms),
        text: readString(segment.display_text, readString(segment.raw_text)),
        isFinal: segment.is_final !== false,
        confidence:
          typeof segment.confidence === 'number' ? segment.confidence : null,
        recordedAt: readString(segment.created_at, manifest.createdAt),
      }),
    );
    const transcript = mergeTranscriptCheckpoints(
      localTranscript,
      remoteTranscriptCheckpoints,
    );
    const audioUrls: MeetingLocalArchive['audioUrls'] = {};
    const localFileState: Record<
      'local' | 'remote',
      MeetingLocalAudioFileState
    > = {
      local: 'not_declared',
      remote: 'not_declared',
    };
    const audioUrlKind: Record<'local' | 'remote', 'local' | 'cloud' | 'none'> =
      {
        local: 'none',
        remote: 'none',
      };
    for (const source of ['local', 'remote'] as const) {
      const localAudio = await this.resolveLocalArchiveAudio(
        scope,
        manifest,
        source,
      );
      localFileState[source] = localAudio.state;
      if (localAudio.url) {
        audioUrls[source] = localAudio.url;
        audioUrlKind[source] = 'local';
      }
    }
    if (this.serverSync?.getTrackAudio && remoteSession) {
      for (const source of ['local', 'remote'] as const) {
        if (
          audioUrls[source] ||
          manifest.tracks[source].storageStatus === 'deleted'
        ) {
          continue;
        }
        const audio = await this.serverSync
          .getTrackAudio(scope.sessionId, source)
          .catch(() => null);
        if (audio?.url) {
          audioUrls[source] = audio.url;
          audioUrlKind[source] = 'cloud';
        }
      }
    }
    log.info('archive_read', {
      sessionId: scope.sessionId,
      hasLocalManifest: Boolean(localManifest),
      localFileState,
      audioUrlKind,
      localTranscriptCount: localTranscript.length,
      remoteTranscriptCount: remoteTranscriptCheckpoints.length,
      mergedTranscriptCount: transcript.length,
      localCopilotCount: localCopilotRecords.length,
      remoteCopilotCount: remoteCopilotRecords.length,
      mergedCopilotCount: copilotRecords.length,
    });
    return {
      manifest,
      audioUrls,
      transcript,
      copilotRecords,
      ...(localAudioCleanupPending ? { localAudioCleanupPending: true } : {}),
    };
  }

  async deleteArchiveAudio(scope: MeetingArchiveScope): Promise<void> {
    if (!this.serverSync?.deleteAudio) {
      throw new Error('meeting server is unavailable');
    }
    await this.serverSync.deleteAudio(scope.sessionId);
    try {
      const localManifest = await this.archiveStore
        .readManifest(scope)
        .catch((error) => {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
          throw error;
        });
      if (!localManifest) return;
      if (
        Object.values(localManifest.tracks).every(
          (track) => track.storageStatus === 'deleted',
        )
      ) {
        return;
      }
      await this.archiveStore.markAudioCleanupPending(scope);
      await this.archiveStore.deleteAudioFiles(scope);
    } catch (error) {
      throw new Error(
        'meeting audio was deleted from the server, but local cleanup failed',
        { cause: error },
      );
    }
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
          this.activeManifest.lifecycleStatus as 'preparing' | 'recording',
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

    this.invalidateSourceSwitches();
    const stopStartedAt = Date.now();
    log.info('recording_stop', {
      phase: 'requested',
      sessionId: activeScope.sessionId,
    });
    this.stopPromise = (async () => {
      // A committed source keeps its previous input alive until manifest
      // persistence finishes. Let that short transaction finalize or roll back
      // before renderer stop discards the rollback state. Device preparation is
      // deliberately outside this set, so a hung permission prompt never blocks
      // stop.
      await Promise.allSettled([...this.activeSourceCommitPhases]);
      await this.reconcileAllPendingSourceResolutions();
      // MediaRecorder.stop() emits a final dataavailable event. Do not hold the
      // manager operation queue while waiting, otherwise that final chunk's IPC
      // call cannot enter appendAudioChunk and both sides deadlock.
      await this.captureHost?.stop();
      log.info('recording_stop', {
        phase: 'capture_flushed',
        sessionId: activeScope.sessionId,
        elapsedMs: Date.now() - stopStartedAt,
      });
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
        const status = this.emitStatus();
        log.info('recording_stop', {
          phase: 'archive_finalized',
          sessionId: activeScope.sessionId,
          elapsedMs: Date.now() - stopStartedAt,
        });
        return status;
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
      if (this.activeManifest!.lifecycleStatus !== 'recording') {
        throw new Error('audio chunks are accepted only while recording');
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
      !['preparing', 'recording'].includes(this.activeManifest!.lifecycleStatus)
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
      const previousRevision = this.activeManifest!.transcriptRevision;
      this.activeManifest = await this.archiveStore.appendTranscriptCheckpoint(
        scope,
        checkpoint,
      );
      this.queueTranscriptServerSync(scope, checkpoint);
      this.emitStatus();
      if (this.activeManifest.transcriptRevision > previousRevision) {
        this.onTranscriptChanged?.({ ...scope, checkpoint });
      }
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
    const requestId = randomUUID();
    const startedAt = Date.now();
    log.info('copilot_answer', {
      phase: 'request_received',
      requestId,
      sessionId: scope.sessionId,
      questionSegmentId,
    });
    if (!this.activeManifest?.copilotEnabled) {
      const result: MeetingCopilotAnswerResult = {
        status: 'disabled',
        message: '会议 Copilot 当前已关闭',
      };
      log.info('copilot_answer', {
        phase: 'completed',
        requestId,
        sessionId: scope.sessionId,
        resultStatus: result.status,
        totalMs: Date.now() - startedAt,
      });
      return result;
    }
    if (!this.serverSync) {
      const result: MeetingCopilotAnswerResult = {
        status: 'unavailable',
        message: '会议 Copilot 服务暂时不可用，录音与转写会继续运行',
      };
      log.info('copilot_answer', {
        phase: 'completed',
        requestId,
        sessionId: scope.sessionId,
        resultStatus: result.status,
        totalMs: Date.now() - startedAt,
      });
      return result;
    }
    const contextReadStartedAt = Date.now();
    const transcript = await this.archiveStore.readTranscript(scope);
    const question = transcript.find(
      (checkpoint) =>
        checkpoint.externalId === questionSegmentId && checkpoint.isFinal,
    );
    log.info('copilot_answer', {
      phase: 'local_context_read',
      requestId,
      sessionId: scope.sessionId,
      candidateSource: question?.source,
      segmentCount: transcript.length,
      elapsedMs: Date.now() - contextReadStartedAt,
    });
    if (!question) {
      const result: MeetingCopilotAnswerResult = {
        status: 'no_question',
        message: '这个问题尚未转写完成，请稍后再试',
      };
      log.info('copilot_answer', {
        phase: 'completed',
        requestId,
        sessionId: scope.sessionId,
        resultStatus: result.status,
        totalMs: Date.now() - startedAt,
      });
      return result;
    }
    const modelId = this.activeManifest.copilotModelId;
    const serverStartedAt = Date.now();
    let result: MeetingCopilotAnswerResult;
    try {
      result = await this.serverSync.answerCopilot(
        scope.sessionId,
        transcript,
        questionSegmentId,
        modelId,
        requestId,
      );
    } catch (error) {
      log.warn('copilot_answer', {
        phase: 'server_model_failed',
        requestId,
        sessionId: scope.sessionId,
        candidateSource: question.source,
        modelId: modelId || 'default',
        errorName: error instanceof Error ? error.name : 'UnknownError',
        elapsedMs: Date.now() - serverStartedAt,
        totalMs: Date.now() - startedAt,
      });
      throw error;
    }
    log.info('copilot_answer', {
      phase: 'server_model_roundtrip',
      requestId,
      sessionId: scope.sessionId,
      candidateSource: question.source,
      modelId: modelId || 'default',
      resultStatus: result.status,
      elapsedMs: Date.now() - serverStartedAt,
    });
    if (
      result.status === 'answered' ||
      result.status === 'no_action' ||
      result.status === 'needs_clarification'
    ) {
      await this.archiveStore.appendCopilotRecord(scope, result);
    }
    log.info('copilot_answer', {
      phase: 'completed',
      requestId,
      sessionId: scope.sessionId,
      candidateSource: question.source,
      resultStatus: result.status,
      totalMs: Date.now() - startedAt,
    });
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
    if (
      !ACTIVE_STATES.has(
        this.activeManifest.lifecycleStatus as 'preparing' | 'recording',
      )
    )
      return;
    const scope = this.activeScope;
    this.invalidateSourceSwitches();
    if (this.activeManifest.lifecycleStatus === 'recording') {
      if (stopCaptureHost) {
        await this.captureHost?.stop().catch(() => undefined);
      }
      await this.activeAsrRuntime?.stop().catch(() => undefined);
      this.activeAsrRuntime = null;
    }
    await this.enqueue(async () => {
      if (
        !this.activeManifest ||
        this.activeScope?.sessionId !== scope.sessionId
      )
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
        if (!['stopped', 'interrupted'].includes(manifest.lifecycleStatus))
          continue;
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
      if (!['stopped', 'interrupted'].includes(manifest.lifecycleStatus))
        continue;
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
