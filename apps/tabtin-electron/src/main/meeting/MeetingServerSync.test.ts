import { describe, expect, it, vi } from 'vitest';

import {
  MAX_MEETING_COPILOT_CONTEXT_SEGMENTS,
  MAX_MEETING_TRANSCRIPT_SEGMENTS_PER_BATCH,
  MEETING_COPILOT_REQUEST_TIMEOUT_MS,
  MeetingServerSync,
  selectMeetingCopilotContext,
  type MeetingTranscriptSegmentInput,
} from './MeetingServerSync';

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function requestBody(call: unknown[]): Record<string, unknown> {
  const init = call[1] as RequestInit;
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

function createSync(input: {
  fetch: typeof fetch;
  now?: () => number;
  operationIds?: string[];
  retryBaseDelayMs?: number;
  retryMaxDelayMs?: number;
}): MeetingServerSync {
  const ids = [...(input.operationIds ?? [])];
  return new MeetingServerSync({
    fetch: input.fetch,
    getAccessToken: async () => 'test-token',
    apiBaseUrl: 'https://api.example.test/api',
    autoFlush: false,
    now: input.now ?? (() => 1_000),
    createOperationId: () => ids.shift() ?? `op-${Math.random()}`,
    retryBaseDelayMs: input.retryBaseDelayMs,
    retryMaxDelayMs: input.retryMaxDelayMs,
    requestTimeoutMs: 1_000,
  });
}

describe('MeetingServerSync', () => {
  it('reads cloud archives and uses explicit delete endpoints', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({ sessions: [{ id: 'session-1', version: 2 }] }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          runs: [],
          segments: [{ external_id: 'segment-1', display_text: 'Hello' }],
          total: 1,
          offset: 0,
          limit: 1000,
          next_offset: null,
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ deleted_audio_tracks: 2 }))
      .mockResolvedValueOnce(jsonResponse({ deleted: true }));
    const sync = createSync({ fetch: fetchImpl });

    await expect(
      sync.listSessions({ organizationId: 'org-1' }),
    ).resolves.toEqual([{ id: 'session-1', version: 2 }]);
    await expect(sync.getTranscript('session-1')).resolves.toMatchObject({
      total: 1,
      segments: [{ external_id: 'segment-1' }],
    });
    await sync.deleteAudio('session-1');
    await sync.deleteSession('session-1');

    expect(String(fetchImpl.mock.calls[0][0])).toContain(
      '/meetings/sessions?organization_id=org-1',
    );
    expect((fetchImpl.mock.calls[2][1] as RequestInit).method).toBe('DELETE');
    expect(String(fetchImpl.mock.calls[2][0])).toContain(
      '/meetings/sessions/session-1/audio',
    );
    expect((fetchImpl.mock.calls[3][1] as RequestInit).method).toBe('DELETE');
  });
  it('keeps the selected question when later transcript turns fill the context window', () => {
    const transcript = Array.from(
      { length: MAX_MEETING_COPILOT_CONTEXT_SEGMENTS + 2 },
      (_, index) => ({
        externalId: `segment-${index}`,
        source: 'remote' as const,
        startMs: index * 1_000,
        endMs: index * 1_000 + 500,
        text: `Question ${index}?`,
        isFinal: true,
        recordedAt: '2026-08-26T00:00:00.000Z',
      }),
    );

    const context = selectMeetingCopilotContext(transcript, 'segment-0');

    expect(context).toHaveLength(MAX_MEETING_COPILOT_CONTEXT_SEGMENTS);
    expect(context.some((item) => item.externalId === 'segment-0')).toBe(true);
    expect(context.some((item) => item.externalId === 'segment-2')).toBe(false);
  });

  it('creates a meeting session with the existing main-process auth and URL shape', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        id: 'session-1',
        version: 0,
        lifecycle_status: 'draft',
      }),
    );
    const sync = createSync({ fetch: fetchImpl, operationIds: ['create-1'] });

    expect(
      sync.createSession({
        id: 'session-1',
        organizationId: 'org-1',
        projectId: 'project-1',
        title: 'Product review',
        brief: 'Confirm the recording boundary',
        consentConfirmed: true,
        copilotEnabled: false,
      }),
    ).toMatchObject({
      id: 'create-1',
      sessionId: 'session-1',
      kind: 'create_session',
    });

    const result = await sync.flushSession('session-1');

    expect(result).toMatchObject({
      status: 'synced',
      syncedCount: 1,
      pendingCount: 0,
      serverVersion: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://api.example.test/api/meetings/sessions',
    );
    expect(fetchImpl.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: {
        Authorization: 'Bearer test-token',
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
    });
    expect(requestBody(fetchImpl.mock.calls[0])).toEqual({
      id: 'session-1',
      organization_id: 'org-1',
      project_id: 'project-1',
      title: 'Product review',
      brief: 'Confirm the recording boundary',
      consent_confirmed: true,
      copilot_enabled: false,
    });
  });

  it('requests a Copilot answer with the latest local transcript snapshot', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        success: true,
        data: {
          status: 'answered',
          question: 'Can we deliver Friday?',
          question_segment_id: 'remote-1',
          answer: 'Confirm the plan before committing.',
          key_points: [],
          sources: [],
          reliability: 'low',
          warning: '',
          model: 'deepseek-v4-flash',
          provider: 'deepseek',
          latency_ms: 100,
        },
      }),
    );
    const sync = createSync({ fetch: fetchImpl });
    const retrySession = vi.spyOn(sync, 'retrySession');

    await expect(
      sync.answerCopilot(
        'session-1',
        [
          {
            externalId: 'remote-1',
            source: 'remote',
            startMs: 1_000,
            endMs: 1_500,
            text: 'Can we deliver',
            isFinal: false,
            recordedAt: '2026-08-26T00:00:00.000Z',
          },
          {
            externalId: 'remote-1',
            source: 'remote',
            startMs: 1_000,
            endMs: 2_000,
            text: 'Can we deliver Friday?',
            isFinal: true,
            recordedAt: '2026-08-26T00:00:00.000Z',
          },
        ],
        'remote-1',
        'model-1',
        '00000000-0000-4000-8000-000000000099',
      ),
    ).resolves.toMatchObject({
      status: 'answered',
      question_segment_id: 'remote-1',
    });
    expect(String(fetchImpl.mock.calls[0][0])).toBe(
      'https://api.example.test/api/meetings/sessions/session-1/copilot/answer',
    );
    expect(requestBody(fetchImpl.mock.calls[0])).toEqual({
      model_id: 'model-1',
      request_id: '00000000-0000-4000-8000-000000000099',
      question_segment_id: 'remote-1',
      recent_segments: [
        {
          external_id: 'remote-1',
          source: 'remote',
          start_ms: 1_000,
          text: 'Can we deliver Friday?',
          is_final: true,
        },
      ],
    });
    expect(retrySession).not.toHaveBeenCalled();
    expect(timeout).toHaveBeenCalledWith(MEETING_COPILOT_REQUEST_TIMEOUT_MS);
    timeout.mockRestore();
  });

  it('serializes lifecycle and Copilot mutations and advances optimistic versions', async () => {
    const responses = [
      { id: 'session-1', version: 0, lifecycle_status: 'draft' },
      { id: 'session-1', version: 1, lifecycle_status: 'preparing' },
      {
        id: 'session-1',
        version: 2,
        lifecycle_status: 'preparing',
        copilot_enabled: true,
      },
    ];
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse(responses.shift()),
    );
    const sync = createSync({ fetch: fetchImpl });

    sync.createSession({
      id: 'session-1',
      organizationId: 'org-1',
      title: 'Review',
      consentConfirmed: true,
    });
    sync.updateLifecycle('session-1', {
      status: 'preparing',
      durationMs: 25,
    });
    sync.updateCopilotState('session-1', { enabled: true });

    const result = await sync.flushSession('session-1');

    expect(result).toMatchObject({
      status: 'synced',
      syncedCount: 3,
      pendingCount: 0,
      serverVersion: 2,
    });
    expect(
      fetchImpl.mock.calls.map((call) => (call[1] as RequestInit).method),
    ).toEqual(['POST', 'PATCH', 'PATCH']);
    expect(requestBody(fetchImpl.mock.calls[1])).toEqual({
      status: 'preparing',
      duration_ms: 25,
      expected_version: 0,
    });
    expect(requestBody(fetchImpl.mock.calls[2])).toEqual({
      enabled: true,
      expected_version: 1,
    });
  });

  it('loads the authoritative version before a standalone lifecycle mutation', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'session-1',
          version: 7,
          lifecycle_status: 'recording',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'session-1',
          version: 8,
          lifecycle_status: 'stopped',
        }),
      );
    const sync = createSync({ fetch: fetchImpl });
    sync.updateLifecycle('session-1', {
      status: 'stopped',
      durationMs: 8_000,
    });

    expect(await sync.flushSession('session-1')).toMatchObject({
      status: 'synced',
      pendingCount: 0,
      serverVersion: 8,
    });
    expect((fetchImpl.mock.calls[0][1] as RequestInit).method).toBe('GET');
    expect(requestBody(fetchImpl.mock.calls[1])).toEqual({
      status: 'stopped',
      duration_ms: 8_000,
      expected_version: 7,
    });
  });

  it('keeps failed network work queued with exponential backoff and supports explicit retry', async () => {
    let now = 1_000;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('offline-1'))
      .mockRejectedValueOnce(new Error('offline-2'))
      .mockResolvedValueOnce(jsonResponse({ id: 'session-1', version: 0 }));
    const sync = createSync({
      fetch: fetchImpl,
      now: () => now,
      retryBaseDelayMs: 100,
      retryMaxDelayMs: 400,
    });

    expect(() =>
      sync.createSession({
        id: 'session-1',
        organizationId: 'org-1',
        title: 'Offline-safe review',
      }),
    ).not.toThrow();

    const first = await sync.flushSession('session-1');
    expect(first).toMatchObject({
      status: 'deferred',
      pendingCount: 1,
      retryAt: 1_100,
      failure: { reason: 'network', message: 'offline-1' },
    });

    expect(await sync.flushSession('session-1')).toMatchObject({
      status: 'deferred',
      retryAt: 1_100,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    now = 1_100;
    expect(await sync.flushSession('session-1')).toMatchObject({
      status: 'deferred',
      retryAt: 1_300,
      failure: { message: 'offline-2' },
    });

    now = 1_101;
    expect(await sync.retrySession('session-1')).toMatchObject({
      status: 'synced',
      pendingCount: 0,
      serverVersion: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('reconciles a 409 with session detail and never silently rewrites the queued mutation', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse(
          {
            detail: 'meeting session version conflict',
          },
          409,
        ),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          id: 'session-1',
          version: 3,
          lifecycle_status: 'recording',
        }),
      );
    const sync = createSync({
      fetch: fetchImpl,
      operationIds: ['lifecycle-1'],
    });
    sync.updateLifecycle('session-1', {
      status: 'stopped',
      durationMs: 5_000,
      expectedVersion: 2,
    });

    const result = await sync.flushSession('session-1');

    expect(result).toMatchObject({
      status: 'conflict',
      syncedCount: 0,
      pendingCount: 1,
      conflict: {
        status: 409,
        message: 'meeting session version conflict',
        operation: { id: 'lifecycle-1', kind: 'update_lifecycle' },
        remoteSession: {
          id: 'session-1',
          version: 3,
          lifecycle_status: 'recording',
        },
      },
    });
    expect(requestBody(fetchImpl.mock.calls[0])).toEqual({
      status: 'stopped',
      duration_ms: 5_000,
      expected_version: 2,
    });
    expect(String(fetchImpl.mock.calls[1][0])).toBe(
      'https://api.example.test/api/meetings/sessions/session-1',
    );
    expect((fetchImpl.mock.calls[1][1] as RequestInit).method).toBe('GET');
    expect(sync.getPendingOperations('session-1')).toHaveLength(1);
    expect(sync.getConflict('session-1')?.remoteSession?.version).toBe(3);

    expect(await sync.retrySession('session-1')).toMatchObject({
      status: 'conflict',
      pendingCount: 1,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('queues track checkpoints, transcript runs, bounded segment batches, and run state in order', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: true }),
    );
    const sync = createSync({ fetch: fetchImpl });
    const segments: MeetingTranscriptSegmentInput[] = Array.from(
      { length: MAX_MEETING_TRANSCRIPT_SEGMENTS_PER_BATCH + 1 },
      (_, index) => ({
        externalId: `segment-${index}`,
        source: index % 2 === 0 ? 'local' : 'remote',
        speakerKey: `speaker-${index % 2}`,
        startMs: index * 1_000,
        endMs: index * 1_000 + 900,
        rawText: `Text ${index}`,
        isFinal: true,
        confidence: 0.9,
      }),
    );

    sync.checkpointTrack('session-1', {
      source: 'local',
      captureStatus: 'active',
      localAvailable: true,
      sampleRate: 48_000,
      channelCount: 1,
      codec: 'opus',
      container: 'webm',
      durationMs: 10_000,
      fileSize: 2_048,
      contentHash: 'abc123',
    });
    sync.createTranscriptRun('session-1', {
      id: 'run-1',
      mode: 'realtime',
      provider: 'provider-1',
      model: 'model-1',
      language: 'zh-CN',
    });
    expect(
      sync.upsertTranscriptSegments('session-1', 'run-1', segments),
    ).toHaveLength(2);
    sync.updateTranscriptRun('session-1', 'run-1', { status: 'completed' });

    expect(
      sync.getPendingOperations('session-1').map((item) => item.kind),
    ).toEqual([
      'checkpoint_track',
      'create_transcript_run',
      'upsert_transcript_segments',
      'upsert_transcript_segments',
      'update_transcript_run',
    ]);
    expect(await sync.flushSession('session-1')).toMatchObject({
      status: 'synced',
      syncedCount: 5,
      pendingCount: 0,
    });

    expect(
      String(fetchImpl.mock.calls[0][0]).endsWith(
        '/meetings/sessions/session-1/tracks/local',
      ),
    ).toBe(true);
    expect(requestBody(fetchImpl.mock.calls[0])).toMatchObject({
      source: 'local',
      capture_status: 'active',
      storage_status: 'local_only',
      local_available: true,
      sample_rate: 48_000,
      duration_ms: 10_000,
      file_size: 2_048,
      content_hash: 'abc123',
    });
    expect(
      String(fetchImpl.mock.calls[1][0]).endsWith(
        '/meetings/sessions/session-1/transcript-runs',
      ),
    ).toBe(true);
    expect(requestBody(fetchImpl.mock.calls[1])).toMatchObject({
      id: 'run-1',
      track_id: null,
      mode: 'realtime',
      provider: 'provider-1',
      model: 'model-1',
      language: 'zh-CN',
    });

    const firstBatch = requestBody(fetchImpl.mock.calls[2])
      .segments as unknown[];
    const secondBatch = requestBody(fetchImpl.mock.calls[3])
      .segments as unknown[];
    expect(firstBatch).toHaveLength(500);
    expect(secondBatch).toHaveLength(1);
    expect(firstBatch[0]).toEqual({
      external_id: 'segment-0',
      track_id: null,
      source: 'local',
      speaker_key: 'speaker-0',
      start_ms: 0,
      end_ms: 900,
      raw_text: 'Text 0',
      is_final: true,
      confidence: 0.9,
      metadata: {},
    });
    expect(requestBody(fetchImpl.mock.calls[4])).toEqual({
      status: 'completed',
      error_code: '',
      error_message: '',
    });
  });

  it('coalesces unsent track checkpoints and transcript revisions under backpressure', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      jsonResponse({ ok: true }),
    );
    const sync = createSync({ fetch: fetchImpl });

    sync.checkpointTrack('session-1', {
      source: 'local',
      captureStatus: 'active',
      durationMs: 1_000,
      fileSize: 100,
    });
    sync.checkpointTrack('session-1', {
      source: 'local',
      captureStatus: 'completed',
      durationMs: 2_000,
      fileSize: 200,
    });
    sync.upsertTranscriptSegments('session-1', 'run-1', [
      {
        externalId: 'segment-1',
        source: 'local',
        startMs: 0,
        endMs: 500,
        rawText: '临时',
        isFinal: false,
      },
    ]);
    sync.upsertTranscriptSegments('session-1', 'run-1', [
      {
        externalId: 'segment-1',
        source: 'local',
        startMs: 0,
        endMs: 900,
        rawText: '最终文本',
        isFinal: true,
      },
      {
        externalId: 'segment-2',
        source: 'local',
        startMs: 1_000,
        endMs: 1_500,
        rawText: '下一段',
        isFinal: true,
      },
    ]);

    expect(
      sync.getPendingOperations('session-1').map((operation) => operation.kind),
    ).toEqual(['checkpoint_track', 'upsert_transcript_segments']);
    expect(await sync.flushSession('session-1')).toMatchObject({
      status: 'synced',
      syncedCount: 2,
      pendingCount: 0,
    });
    expect(requestBody(fetchImpl.mock.calls[0])).toMatchObject({
      capture_status: 'completed',
      duration_ms: 2_000,
      file_size: 200,
    });
    expect(requestBody(fetchImpl.mock.calls[1]).segments).toEqual([
      expect.objectContaining({
        external_id: 'segment-1',
        raw_text: '最终文本',
        is_final: true,
      }),
      expect.objectContaining({
        external_id: 'segment-2',
        raw_text: '下一段',
        is_final: true,
      }),
    ]);
  });

  it('keeps queues isolated by session while preserving order inside each session', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const sessionId = String(
        (JSON.parse(String(init?.body)) as { id?: string }).id,
      );
      return jsonResponse({ id: sessionId, version: 0 });
    });
    const sync = createSync({ fetch: fetchImpl });
    sync.createSession({
      id: 'session-a',
      organizationId: 'org-1',
      title: 'A',
    });
    sync.createSession({
      id: 'session-b',
      organizationId: 'org-1',
      title: 'B',
    });

    expect(await sync.flushSession('session-a')).toMatchObject({
      status: 'synced',
      pendingCount: 0,
    });
    expect(sync.getPendingOperations('session-b')).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    expect(await sync.flushSession('session-b')).toMatchObject({
      status: 'synced',
      pendingCount: 0,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
