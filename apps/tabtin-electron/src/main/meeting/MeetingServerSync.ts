import { randomUUID } from 'node:crypto';

import { joinApiPath } from '@tabtin/config';

import { TokenManager } from '../auth.js';
import { API_BASE_URL } from '../config/api.js';
import type {
  MeetingCopilotAnswerResult,
  MeetingTranscriptCheckpoint,
} from '../../shared/meeting-recording-contract';
import {
  buildMeetingCopilotTurns,
  type MeetingCopilotTurn,
} from '../../shared/meeting-copilot-turns';

const DEFAULT_RETRY_BASE_DELAY_MS = 1_000;
const DEFAULT_RETRY_MAX_DELAY_MS = 60_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
export const MEETING_COPILOT_REQUEST_TIMEOUT_MS = 30_000;
export const MAX_MEETING_TRANSCRIPT_SEGMENTS_PER_BATCH = 500;
export const MAX_MEETING_COPILOT_CONTEXT_SEGMENTS = 12;

export function selectMeetingCopilotContext(
  transcript: MeetingTranscriptCheckpoint[],
  questionSegmentId: string,
): MeetingCopilotTurn[] {
  const turns = buildMeetingCopilotTurns(transcript);
  const candidateIndex = turns.findIndex(
    (turn) =>
      turn.requestSegmentId === questionSegmentId ||
      turn.candidateId === questionSegmentId ||
      turn.segmentIds.includes(questionSegmentId),
  );
  if (candidateIndex < 0) return [];
  return turns.slice(
    Math.max(0, candidateIndex - MAX_MEETING_COPILOT_CONTEXT_SEGMENTS + 1),
    candidateIndex + 1,
  );
}

export type MeetingLifecycleStatus =
  | 'draft'
  | 'preparing'
  | 'recording'
  | 'stopped'
  | 'cancelled'
  | 'interrupted';

export type MeetingTrackSource = 'local' | 'remote';

export interface CreateMeetingSessionInput {
  id: string;
  organizationId: string;
  projectId?: string | null;
  title: string;
  brief?: string;
  consentConfirmed?: boolean;
  copilotEnabled?: boolean;
}

export interface MeetingLifecycleInput {
  status: MeetingLifecycleStatus;
  durationMs?: number;
  expectedVersion?: number;
}

export interface MeetingCopilotStateInput {
  enabled: boolean;
  expectedVersion?: number;
}

export interface MeetingTrackCheckpointInput {
  source: MeetingTrackSource;
  captureStatus:
    | 'pending'
    | 'active'
    | 'completed'
    | 'interrupted'
    | 'failed'
    | 'missing';
  storageStatus?: 'local_only' | 'uploading' | 'synced' | 'missing' | 'deleted';
  localAvailable?: boolean;
  deviceId?: string;
  deviceLabel?: string;
  sampleRate?: number;
  channelCount?: number;
  codec?: string;
  container?: string;
  durationMs?: number;
  fileSize?: number;
  contentHash?: string;
  fileRecordId?: string | null;
  errorCode?: string;
  errorMessage?: string;
}

export interface CreateMeetingTranscriptRunInput {
  id: string;
  trackId?: string | null;
  mode: 'realtime' | 'post_process';
  provider?: string;
  model?: string;
  language?: string;
  metadata?: Record<string, unknown>;
}

export interface MeetingTranscriptSegmentInput {
  externalId: string;
  trackId?: string | null;
  source: MeetingTrackSource;
  speakerKey?: string;
  startMs: number;
  endMs: number;
  rawText: string;
  isFinal: boolean;
  confidence?: number | null;
  metadata?: Record<string, unknown>;
}

export interface MeetingTranscriptRunStateInput {
  status: 'pending' | 'running' | 'completed' | 'partial' | 'failed';
  errorCode?: string;
  errorMessage?: string;
}

export type MeetingSyncOperationKind =
  | 'create_session'
  | 'update_lifecycle'
  | 'update_copilot'
  | 'checkpoint_track'
  | 'create_transcript_run'
  | 'upsert_transcript_segments'
  | 'update_transcript_run';

export interface MeetingQueuedOperation {
  id: string;
  sessionId: string;
  kind: MeetingSyncOperationKind;
  queuedAt: number;
}

export interface MeetingServerSession {
  id: string;
  version: number;
  lifecycle_status?: string;
  copilot_enabled?: boolean;
  tracks?: unknown[];
  [key: string]: unknown;
}

export interface MeetingServerTranscript {
  runs: Array<Record<string, unknown>>;
  segments: Array<Record<string, unknown>>;
  total: number;
  offset: number;
  limit: number;
  next_offset: number | null;
}

export interface MeetingServerTrackAudio {
  track: Record<string, unknown>;
  url: string;
  access_mode: string;
  expires_at: string | null;
  expires_in: number | null;
}

export interface MeetingServerPermission {
  id: string;
  subject_type: string;
  subject_id: string;
  permission: 'viewer' | 'editor' | 'admin';
  is_active: boolean;
  granted_by: string;
}

export interface MeetingSyncConflict {
  sessionId: string;
  operation: MeetingQueuedOperation;
  status: 409;
  message: string;
  remoteSession: MeetingServerSession | null;
  reconciliationError?: string;
}

export interface MeetingSyncFailure {
  sessionId: string;
  operation: MeetingQueuedOperation;
  reason: 'auth' | 'network' | 'http' | 'invalid_response';
  message: string;
  status?: number;
}

export interface MeetingSyncFlushResult {
  sessionId: string;
  status: 'synced' | 'deferred' | 'conflict' | 'failed';
  syncedCount: number;
  pendingCount: number;
  serverVersion?: number;
  retryAt?: number;
  failure?: MeetingSyncFailure;
  conflict?: MeetingSyncConflict;
}

export interface MeetingServerSyncOptions {
  fetch?: typeof fetch;
  getAccessToken?: () => Promise<string | null>;
  apiBaseUrl?: string;
  now?: () => number;
  createOperationId?: () => string;
  autoFlush?: boolean;
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
  requestTimeoutMs?: number;
}

type JsonRecord = Record<string, unknown>;

interface PendingOperation extends MeetingQueuedOperation {
  method: 'POST' | 'PUT' | 'PATCH';
  path: string;
  body: JsonRecord;
  expectedVersion?: number;
}

interface SessionQueueState {
  pending: PendingOperation[];
  serverVersion?: number;
  retryAttempt: number;
  retryAt?: number;
  lastFailure?: MeetingSyncFailure;
  conflict?: MeetingSyncConflict;
  inFlight?: Promise<MeetingSyncFlushResult>;
}

type HttpResult =
  | { ok: true; payload: unknown }
  | {
      ok: false;
      reason: MeetingSyncFailure['reason'];
      message: string;
      retryable: boolean;
      status?: number;
    };

export class MeetingServerRequestError extends Error {
  readonly status?: number;
  readonly reason: MeetingSyncFailure['reason'];

  constructor(input: {
    message: string;
    reason: MeetingSyncFailure['reason'];
    status?: number;
  }) {
    super(input.message);
    this.name = 'MeetingServerRequestError';
    this.reason = input.reason;
    this.status = input.status;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unwrapApiPayload(value: unknown): unknown {
  if (isRecord(value) && value.success === true && 'data' in value) {
    return value.data;
  }
  return value;
}

function readServerSession(value: unknown): MeetingServerSession | null {
  const payload = unwrapApiPayload(value);
  if (
    !isRecord(payload) ||
    typeof payload.id !== 'string' ||
    typeof payload.version !== 'number' ||
    !Number.isSafeInteger(payload.version) ||
    payload.version < 0
  ) {
    return null;
  }
  return payload as MeetingServerSession;
}

function responseMessage(value: unknown, fallback: string): string {
  const payload = unwrapApiPayload(value);
  if (isRecord(payload)) {
    for (const key of ['detail', 'message', 'error']) {
      if (typeof payload[key] === 'string' && payload[key].trim()) {
        return payload[key].trim();
      }
    }
  }
  return fallback;
}

async function readResponsePayload(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function isRetryableHttpStatus(status: number): boolean {
  return (
    status === 401 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function operationSnapshot(
  operation: PendingOperation,
): MeetingQueuedOperation {
  return {
    id: operation.id,
    sessionId: operation.sessionId,
    kind: operation.kind,
    queuedAt: operation.queuedAt,
  };
}

export class MeetingServerSync {
  private readonly fetchImpl: typeof fetch;
  private readonly getAccessToken: () => Promise<string | null>;
  private readonly apiBaseUrl: string;
  private readonly now: () => number;
  private readonly createOperationId: () => string;
  private readonly autoFlush: boolean;
  private readonly retryBaseDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly queues = new Map<string, SessionQueueState>();

  constructor(options: MeetingServerSyncOptions = {}) {
    this.fetchImpl = options.fetch ?? globalThis.fetch;
    this.getAccessToken =
      options.getAccessToken ?? (() => TokenManager.getAccessToken());
    this.apiBaseUrl = options.apiBaseUrl ?? API_BASE_URL;
    this.now = options.now ?? (() => Date.now());
    this.createOperationId = options.createOperationId ?? (() => randomUUID());
    this.autoFlush = options.autoFlush ?? true;
    this.retryBaseDelayMs = Math.max(
      1,
      options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS,
    );
    this.retryMaxDelayMs = Math.max(
      this.retryBaseDelayMs,
      options.retryMaxDelayMs ?? DEFAULT_RETRY_MAX_DELAY_MS,
    );
    this.requestTimeoutMs = Math.max(
      1,
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    );
  }

  createSession(input: CreateMeetingSessionInput): MeetingQueuedOperation {
    return this.enqueue({
      sessionId: input.id,
      kind: 'create_session',
      method: 'POST',
      path: '/meetings/sessions',
      body: {
        id: input.id,
        organization_id: input.organizationId,
        project_id: input.projectId ?? null,
        title: input.title,
        brief: input.brief ?? '',
        consent_confirmed: input.consentConfirmed ?? false,
        copilot_enabled: input.copilotEnabled ?? false,
      },
    });
  }

  updateLifecycle(
    sessionId: string,
    input: MeetingLifecycleInput,
  ): MeetingQueuedOperation {
    return this.enqueue({
      sessionId,
      kind: 'update_lifecycle',
      method: 'PATCH',
      path: `/meetings/sessions/${encodeURIComponent(sessionId)}/lifecycle`,
      body: {
        status: input.status,
        duration_ms: input.durationMs ?? 0,
      },
      expectedVersion: input.expectedVersion,
    });
  }

  updateCopilotState(
    sessionId: string,
    input: MeetingCopilotStateInput,
  ): MeetingQueuedOperation {
    return this.enqueue({
      sessionId,
      kind: 'update_copilot',
      method: 'PATCH',
      path: `/meetings/sessions/${encodeURIComponent(sessionId)}/copilot`,
      body: { enabled: input.enabled },
      expectedVersion: input.expectedVersion,
    });
  }

  async answerCopilot(
    sessionId: string,
    transcript: MeetingTranscriptCheckpoint[],
    questionSegmentId: string,
    modelId?: string,
    requestId?: string,
  ): Promise<MeetingCopilotAnswerResult> {
    const context = selectMeetingCopilotContext(transcript, questionSegmentId);
    const candidate = context.at(-1);
    const requestQuestionSegmentId =
      candidate?.requestSegmentId ?? questionSegmentId;
    const requestAnswer = () =>
      this.request(
        'POST',
        `/meetings/sessions/${encodeURIComponent(sessionId)}/copilot/answer`,
        {
          model_id: modelId || null,
          ...(requestId ? { request_id: requestId } : {}),
          question_segment_id: requestQuestionSegmentId,
          recent_segments: context.map((turn) => ({
            external_id: turn.requestSegmentId,
            source: turn.source,
            start_ms: turn.startMs,
            end_ms: turn.endMs,
            text: turn.text,
            is_final: true,
            recorded_at: turn.recordedAt,
            candidate_id: turn.candidateId,
            segment_ids: turn.segmentIds,
            revision: turn.revision,
            stability: turn.stability.semanticOpen ? 'open' : 'stable',
            close_reason: turn.stability.closeReason,
          })),
        },
        MEETING_COPILOT_REQUEST_TIMEOUT_MS,
      );
    let response = await requestAnswer();
    const initialPayload = response.ok
      ? unwrapApiPayload(response.payload)
      : null;
    const needsReadinessRetry =
      (!response.ok && (response.status === 404 || response.status === 409)) ||
      (isRecord(initialPayload) && initialPayload.status === 'disabled');
    if (needsReadinessRetry) {
      await this.retrySession(sessionId);
      response = await requestAnswer();
    }
    if (!response.ok) throw new Error(response.message);
    const payload = unwrapApiPayload(response.payload);
    if (!isRecord(payload) || typeof payload.status !== 'string') {
      throw new Error('meeting server returned an invalid Copilot response');
    }
    return payload as unknown as MeetingCopilotAnswerResult;
  }

  async getCopilotAnswers(
    sessionId: string,
  ): Promise<Array<Record<string, unknown>>> {
    const response = await this.request(
      'GET',
      `/meetings/sessions/${encodeURIComponent(sessionId)}/copilot-answers`,
    );
    if (!response.ok) throw new Error(response.message);
    const payload = unwrapApiPayload(response.payload);
    if (!isRecord(payload) || !Array.isArray(payload.answers)) {
      throw new Error('meeting server returned invalid Copilot history');
    }
    return payload.answers.filter(isRecord);
  }

  checkpointTrack(
    sessionId: string,
    input: MeetingTrackCheckpointInput,
  ): MeetingQueuedOperation {
    return this.enqueue({
      sessionId,
      kind: 'checkpoint_track',
      method: 'PUT',
      path: `/meetings/sessions/${encodeURIComponent(sessionId)}/tracks/${encodeURIComponent(input.source)}`,
      body: {
        source: input.source,
        capture_status: input.captureStatus,
        storage_status: input.storageStatus ?? 'local_only',
        local_available: input.localAvailable ?? false,
        device_id: input.deviceId ?? '',
        device_label: input.deviceLabel ?? '',
        sample_rate: input.sampleRate ?? 0,
        channel_count: input.channelCount ?? 0,
        codec: input.codec ?? '',
        container: input.container ?? '',
        duration_ms: input.durationMs ?? 0,
        file_size: input.fileSize ?? 0,
        content_hash: input.contentHash ?? '',
        file_record_id: input.fileRecordId ?? null,
        error_code: input.errorCode ?? '',
        error_message: input.errorMessage ?? '',
      },
    });
  }

  createTranscriptRun(
    sessionId: string,
    input: CreateMeetingTranscriptRunInput,
  ): MeetingQueuedOperation {
    return this.enqueue({
      sessionId,
      kind: 'create_transcript_run',
      method: 'POST',
      path: `/meetings/sessions/${encodeURIComponent(sessionId)}/transcript-runs`,
      body: {
        id: input.id,
        track_id: input.trackId ?? null,
        mode: input.mode,
        provider: input.provider ?? '',
        model: input.model ?? '',
        language: input.language ?? '',
        metadata: input.metadata ?? {},
      },
    });
  }

  upsertTranscriptSegments(
    sessionId: string,
    runId: string,
    segments: MeetingTranscriptSegmentInput[],
  ): MeetingQueuedOperation[] {
    const queued: MeetingQueuedOperation[] = [];
    for (
      let offset = 0;
      offset < segments.length;
      offset += MAX_MEETING_TRANSCRIPT_SEGMENTS_PER_BATCH
    ) {
      const batch = segments.slice(
        offset,
        offset + MAX_MEETING_TRANSCRIPT_SEGMENTS_PER_BATCH,
      );
      queued.push(
        this.enqueue({
          sessionId,
          kind: 'upsert_transcript_segments',
          method: 'PUT',
          path: `/meetings/sessions/${encodeURIComponent(sessionId)}/transcript-runs/${encodeURIComponent(runId)}/segments`,
          body: {
            segments: batch.map((segment) => ({
              external_id: segment.externalId,
              track_id: segment.trackId ?? null,
              source: segment.source,
              speaker_key: segment.speakerKey ?? '',
              start_ms: segment.startMs,
              end_ms: segment.endMs,
              raw_text: segment.rawText,
              is_final: segment.isFinal,
              confidence: segment.confidence ?? null,
              metadata: segment.metadata ?? {},
            })),
          },
        }),
      );
    }
    return queued;
  }

  updateTranscriptRun(
    sessionId: string,
    runId: string,
    input: MeetingTranscriptRunStateInput,
  ): MeetingQueuedOperation {
    return this.enqueue({
      sessionId,
      kind: 'update_transcript_run',
      method: 'PATCH',
      path: `/meetings/sessions/${encodeURIComponent(sessionId)}/transcript-runs/${encodeURIComponent(runId)}`,
      body: {
        status: input.status,
        error_code: input.errorCode ?? '',
        error_message: input.errorMessage ?? '',
      },
    });
  }

  async listSessions(input: {
    organizationId: string;
    projectId?: string | null;
    lifecycleStatus?: string;
  }): Promise<MeetingServerSession[]> {
    const query = new URLSearchParams({
      organization_id: input.organizationId,
    });
    if (input.projectId) query.set('project_id', input.projectId);
    if (input.lifecycleStatus) {
      query.set('lifecycle_status', input.lifecycleStatus);
    }
    const response = await this.request('GET', `/meetings/sessions?${query}`);
    if (!response.ok) throw new Error(response.message);
    const payload = unwrapApiPayload(response.payload);
    if (!isRecord(payload) || !Array.isArray(payload.sessions)) {
      throw new Error('meeting server returned an invalid session list');
    }
    return payload.sessions.filter(isRecord) as MeetingServerSession[];
  }

  async getSession(sessionId: string): Promise<MeetingServerSession> {
    const response = await this.request(
      'GET',
      `/meetings/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok) {
      throw new MeetingServerRequestError({
        message: response.message,
        reason: response.reason,
        status: response.status,
      });
    }
    const session = readServerSession(response.payload);
    if (!session) throw new Error('meeting server returned an invalid session');
    return session;
  }

  async getTranscript(
    sessionId: string,
    offset = 0,
    limit = 1_000,
  ): Promise<MeetingServerTranscript> {
    const query = new URLSearchParams({
      offset: String(Math.max(0, offset)),
      limit: String(Math.max(1, Math.min(limit, 1_000))),
    });
    const response = await this.request(
      'GET',
      `/meetings/sessions/${encodeURIComponent(sessionId)}/transcript?${query}`,
    );
    if (!response.ok) throw new Error(response.message);
    const payload = unwrapApiPayload(response.payload);
    if (
      !isRecord(payload) ||
      !Array.isArray(payload.runs) ||
      !Array.isArray(payload.segments)
    ) {
      throw new Error('meeting server returned an invalid transcript');
    }
    return payload as unknown as MeetingServerTranscript;
  }

  async getTrackAudio(
    sessionId: string,
    source: MeetingTrackSource,
  ): Promise<MeetingServerTrackAudio> {
    const response = await this.request(
      'GET',
      `/meetings/sessions/${encodeURIComponent(sessionId)}/tracks/${source}/audio`,
    );
    if (!response.ok) throw new Error(response.message);
    const payload = unwrapApiPayload(response.payload);
    if (!isRecord(payload) || typeof payload.url !== 'string') {
      throw new Error('meeting server returned an invalid audio response');
    }
    return payload as unknown as MeetingServerTrackAudio;
  }

  async listPermissions(sessionId: string): Promise<MeetingServerPermission[]> {
    const response = await this.request(
      'GET',
      `/meetings/sessions/${encodeURIComponent(sessionId)}/permissions`,
    );
    if (!response.ok) throw new Error(response.message);
    const payload = unwrapApiPayload(response.payload);
    if (!isRecord(payload) || !Array.isArray(payload.permissions)) {
      throw new Error('meeting server returned invalid permissions');
    }
    return payload.permissions.filter(
      isRecord,
    ) as unknown as MeetingServerPermission[];
  }

  async grantPermission(
    sessionId: string,
    input: {
      subjectType: 'user' | 'role';
      subjectId: string;
      permission: 'viewer' | 'editor' | 'admin';
    },
  ): Promise<MeetingServerPermission> {
    const response = await this.request(
      'POST',
      `/meetings/sessions/${encodeURIComponent(sessionId)}/permissions`,
      {
        subject_type: input.subjectType,
        subject_id: input.subjectId,
        permission: input.permission,
      },
    );
    if (!response.ok) throw new Error(response.message);
    const payload = unwrapApiPayload(response.payload);
    if (!isRecord(payload) || typeof payload.id !== 'string') {
      throw new Error('meeting server returned an invalid permission');
    }
    return payload as unknown as MeetingServerPermission;
  }

  async revokePermission(
    sessionId: string,
    permissionId: string,
  ): Promise<void> {
    const response = await this.request(
      'DELETE',
      `/meetings/sessions/${encodeURIComponent(sessionId)}/permissions/${encodeURIComponent(permissionId)}`,
    );
    if (!response.ok) throw new Error(response.message);
  }

  async deleteAudio(sessionId: string): Promise<void> {
    const response = await this.request(
      'DELETE',
      `/meetings/sessions/${encodeURIComponent(sessionId)}/audio`,
    );
    if (!response.ok) throw new Error(response.message);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const response = await this.request(
      'DELETE',
      `/meetings/sessions/${encodeURIComponent(sessionId)}`,
    );
    if (!response.ok) throw new Error(response.message);
  }

  getPendingOperations(sessionId: string): MeetingQueuedOperation[] {
    return (this.queues.get(sessionId)?.pending ?? []).map(operationSnapshot);
  }

  getServerVersion(sessionId: string): number | undefined {
    return this.queues.get(sessionId)?.serverVersion;
  }

  getConflict(sessionId: string): MeetingSyncConflict | undefined {
    return this.queues.get(sessionId)?.conflict;
  }

  async flushSession(sessionId: string): Promise<MeetingSyncFlushResult> {
    return this.startFlush(sessionId, false);
  }

  async retrySession(sessionId: string): Promise<MeetingSyncFlushResult> {
    const state = this.getOrCreateState(sessionId);
    if (!state.conflict) state.retryAt = undefined;
    return this.startFlush(sessionId, true);
  }

  async flushAll(): Promise<MeetingSyncFlushResult[]> {
    return Promise.all(
      [...this.queues.keys()].map((sessionId) => this.flushSession(sessionId)),
    );
  }

  async retryAll(): Promise<MeetingSyncFlushResult[]> {
    return Promise.all(
      [...this.queues.keys()].map((sessionId) => this.retrySession(sessionId)),
    );
  }

  private enqueue(
    input: Omit<PendingOperation, 'id' | 'queuedAt'>,
  ): MeetingQueuedOperation {
    const state = this.getOrCreateState(input.sessionId);
    const coalesced = this.coalescePendingOperation(state, input);
    if (coalesced) return operationSnapshot(coalesced);
    const operation: PendingOperation = {
      ...input,
      id: this.createOperationId(),
      queuedAt: this.now(),
    };
    state.pending.push(operation);
    if (this.autoFlush) {
      queueMicrotask(() => {
        void this.flushSession(input.sessionId).catch(() => undefined);
      });
    }
    return operationSnapshot(operation);
  }

  private coalescePendingOperation(
    state: SessionQueueState,
    input: Omit<PendingOperation, 'id' | 'queuedAt'>,
  ): PendingOperation | null {
    if (
      input.kind !== 'checkpoint_track' &&
      input.kind !== 'upsert_transcript_segments'
    ) {
      return null;
    }
    const firstMutableIndex = state.inFlight ? 1 : 0;
    for (
      let index = state.pending.length - 1;
      index >= firstMutableIndex;
      index -= 1
    ) {
      const pending = state.pending[index];
      if (pending.kind !== input.kind || pending.path !== input.path) continue;
      if (input.kind === 'checkpoint_track') {
        pending.body = input.body;
        return pending;
      }
      const existingSegments = Array.isArray(pending.body.segments)
        ? (pending.body.segments as JsonRecord[])
        : [];
      const incomingSegments = Array.isArray(input.body.segments)
        ? (input.body.segments as JsonRecord[])
        : [];
      const merged = new Map<string, JsonRecord>();
      for (const segment of [...existingSegments, ...incomingSegments]) {
        const externalId = String(segment.external_id ?? '');
        if (externalId) merged.set(externalId, segment);
      }
      if (merged.size > MAX_MEETING_TRANSCRIPT_SEGMENTS_PER_BATCH) return null;
      pending.body = { segments: [...merged.values()] };
      return pending;
    }
    return null;
  }

  private getOrCreateState(sessionId: string): SessionQueueState {
    let state = this.queues.get(sessionId);
    if (!state) {
      state = { pending: [], retryAttempt: 0 };
      this.queues.set(sessionId, state);
    }
    return state;
  }

  private startFlush(
    sessionId: string,
    force: boolean,
  ): Promise<MeetingSyncFlushResult> {
    const state = this.getOrCreateState(sessionId);
    if (state.inFlight) return state.inFlight;
    const current = this.drainSession(sessionId, state, force)
      .catch((error) => this.deferUnexpectedFailure(sessionId, state, error))
      .finally(() => {
        if (state.inFlight === current) state.inFlight = undefined;
      });
    state.inFlight = current;
    return current;
  }

  private async drainSession(
    sessionId: string,
    state: SessionQueueState,
    force: boolean,
  ): Promise<MeetingSyncFlushResult> {
    if (state.conflict) {
      return this.result(sessionId, state, 'conflict', 0, {
        conflict: state.conflict,
      });
    }
    if (!force && state.retryAt !== undefined && this.now() < state.retryAt) {
      return this.result(sessionId, state, 'deferred', 0, {
        retryAt: state.retryAt,
        failure: state.lastFailure,
      });
    }

    let syncedCount = 0;
    while (state.pending.length > 0) {
      const operation = state.pending[0];
      const versionResult = await this.prepareOptimisticVersion(
        sessionId,
        state,
        operation,
      );
      if (versionResult) {
        return this.handleHttpFailure(
          sessionId,
          state,
          operation,
          versionResult,
          syncedCount,
        );
      }

      const body =
        operation.expectedVersion === undefined
          ? operation.body
          : { ...operation.body, expected_version: operation.expectedVersion };
      const response = await this.request(
        operation.method,
        operation.path,
        body,
      );
      if (!response.ok) {
        if (response.status === 409) {
          return this.handleConflict(
            sessionId,
            state,
            operation,
            response.message,
            syncedCount,
          );
        }
        return this.handleHttpFailure(
          sessionId,
          state,
          operation,
          response,
          syncedCount,
        );
      }

      if (
        operation.kind === 'create_session' ||
        operation.kind === 'update_lifecycle' ||
        operation.kind === 'update_copilot'
      ) {
        const session = readServerSession(response.payload);
        if (!session || session.id !== sessionId) {
          return this.handleHttpFailure(
            sessionId,
            state,
            operation,
            {
              ok: false,
              reason: 'invalid_response',
              message: 'meeting server returned an invalid session response',
              retryable: true,
            },
            syncedCount,
          );
        }
        state.serverVersion = session.version;
      }

      state.pending.shift();
      state.retryAttempt = 0;
      state.retryAt = undefined;
      state.lastFailure = undefined;
      syncedCount += 1;
    }
    return this.result(sessionId, state, 'synced', syncedCount);
  }

  private async prepareOptimisticVersion(
    sessionId: string,
    state: SessionQueueState,
    operation: PendingOperation,
  ): Promise<Exclude<HttpResult, { ok: true }> | null> {
    if (
      operation.kind !== 'update_lifecycle' &&
      operation.kind !== 'update_copilot'
    ) {
      return null;
    }
    if (operation.expectedVersion !== undefined) return null;
    if (state.serverVersion === undefined) {
      const detail = await this.request(
        'GET',
        `/meetings/sessions/${encodeURIComponent(sessionId)}`,
      );
      if (!detail.ok) return detail;
      const remoteSession = readServerSession(detail.payload);
      if (!remoteSession || remoteSession.id !== sessionId) {
        return {
          ok: false,
          reason: 'invalid_response',
          message: 'meeting server returned an invalid session detail',
          retryable: true,
        };
      }
      state.serverVersion = remoteSession.version;
    }
    // Freeze the version on the queued operation. A later 409 reconciliation
    // must not silently rewrite and replay this mutation against newer data.
    operation.expectedVersion = state.serverVersion;
    return null;
  }

  private async handleConflict(
    sessionId: string,
    state: SessionQueueState,
    operation: PendingOperation,
    message: string,
    syncedCount: number,
  ): Promise<MeetingSyncFlushResult> {
    const detail = await this.request(
      'GET',
      `/meetings/sessions/${encodeURIComponent(sessionId)}`,
    );
    const remoteSession = detail.ok ? readServerSession(detail.payload) : null;
    const conflict: MeetingSyncConflict = {
      sessionId,
      operation: operationSnapshot(operation),
      status: 409,
      message,
      remoteSession,
      ...(!detail.ok ? { reconciliationError: detail.message } : {}),
    };
    state.conflict = conflict;
    state.retryAt = undefined;
    state.lastFailure = undefined;
    return this.result(sessionId, state, 'conflict', syncedCount, { conflict });
  }

  private handleHttpFailure(
    sessionId: string,
    state: SessionQueueState,
    operation: PendingOperation,
    response: Exclude<HttpResult, { ok: true }>,
    syncedCount: number,
  ): MeetingSyncFlushResult {
    const failure: MeetingSyncFailure = {
      sessionId,
      operation: operationSnapshot(operation),
      reason: response.reason,
      message: response.message,
      ...(response.status !== undefined ? { status: response.status } : {}),
    };
    state.lastFailure = failure;
    if (!response.retryable) {
      state.retryAt = undefined;
      return this.result(sessionId, state, 'failed', syncedCount, { failure });
    }
    state.retryAttempt += 1;
    const exponent = Math.min(state.retryAttempt - 1, 30);
    const delay = Math.min(
      this.retryMaxDelayMs,
      this.retryBaseDelayMs * 2 ** exponent,
    );
    state.retryAt = this.now() + delay;
    return this.result(sessionId, state, 'deferred', syncedCount, {
      retryAt: state.retryAt,
      failure,
    });
  }

  private deferUnexpectedFailure(
    sessionId: string,
    state: SessionQueueState,
    error: unknown,
  ): MeetingSyncFlushResult {
    const operation = state.pending[0];
    if (!operation) return this.result(sessionId, state, 'synced', 0);
    return this.handleHttpFailure(
      sessionId,
      state,
      operation,
      {
        ok: false,
        reason: 'network',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      },
      0,
    );
  }

  private result(
    sessionId: string,
    state: SessionQueueState,
    status: MeetingSyncFlushResult['status'],
    syncedCount: number,
    extra: Partial<MeetingSyncFlushResult> = {},
  ): MeetingSyncFlushResult {
    return {
      sessionId,
      status,
      syncedCount,
      pendingCount: state.pending.length,
      ...(state.serverVersion !== undefined
        ? { serverVersion: state.serverVersion }
        : {}),
      ...extra,
    };
  }

  private async request(
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
    path: string,
    body?: JsonRecord,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<HttpResult> {
    let token: string | null;
    try {
      token = await this.getAccessToken();
    } catch (error) {
      return {
        ok: false,
        reason: 'auth',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
    if (!token) {
      return {
        ok: false,
        reason: 'auth',
        message: 'meeting sync is waiting for an access token',
        retryable: true,
      };
    }

    try {
      const response = await this.fetchImpl(
        joinApiPath(this.apiBaseUrl, path),
        {
          method,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(body ? { 'Content-Type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
          signal: AbortSignal.timeout(timeoutMs),
          redirect: 'error',
        },
      );
      const payload = await readResponsePayload(response);
      if (response.ok) return { ok: true, payload };
      return {
        ok: false,
        reason: 'http',
        message: responseMessage(
          payload,
          `meeting server request failed with HTTP ${response.status}`,
        ),
        retryable: isRetryableHttpStatus(response.status),
        status: response.status,
      };
    } catch (error) {
      return {
        ok: false,
        reason: 'network',
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
  }
}
