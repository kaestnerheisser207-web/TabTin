import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MeetingArchiveStore } from './MeetingArchiveStore';

const scope = {
  organizationId: 'org-1',
  userId: 'user-1',
  sessionId: 'session-1',
};

describe('MeetingArchiveStore', () => {
  let rootPath = '';
  let store: MeetingArchiveStore;

  beforeEach(async () => {
    rootPath = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-meeting-archive-'),
    );
    store = new MeetingArchiveStore({
      rootPath,
      now: () => new Date('2026-08-26T00:00:00.000Z'),
      finalizeMediaFile: async (inputPath, outputPath) => {
        await fs.copyFile(inputPath, outputPath);
      },
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(rootPath, { recursive: true, force: true });
  });

  const prepareFinalizedAudio = async (): Promise<void> => {
    await store.prepare({
      ...scope,
      title: 'Audio deletion',
      consentConfirmed: true,
    });
    await store.updateLifecycle(scope, 'recording');
    for (const source of ['local', 'remote'] as const) {
      await store.appendAudioChunk({
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
    await store.finalizeAudioTracks(scope);
    await store.updateLifecycle(scope, 'stopped');
  };

  it('prepares an idempotent manifest with separate local and remote tracks', async () => {
    const first = await store.prepare({
      ...scope,
      projectId: 'project-1',
      projectName: 'Interview prep',
      title: 'Product review',
      consentConfirmed: true,
    });
    const second = await store.prepare({
      ...scope,
      title: 'Ignored retry title',
      consentConfirmed: true,
    });

    expect(first).toEqual(second);
    expect(first.lifecycleStatus).toBe('draft');
    expect(first).toMatchObject({
      consentConfirmedAt: '2026-08-26T00:00:00.000Z',
      copilotInitiallyEnabled: false,
      copilotEnabled: false,
      transcriptionStatus: 'idle',
      transcriptRevision: 0,
      transcriptFinalCount: 0,
      serverSyncStatus: 'pending',
      projectId: 'project-1',
      projectName: 'Interview prep',
    });
    expect(first.transcriptRunId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.tracks.local.source).toBe('local');
    expect(first.tracks.remote.source).toBe('remote');
    await expect(
      fs.stat(path.join(rootPath, 'org-1/user-1/session-1/local')),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(rootPath, 'org-1/user-1/session-1/remote')),
    ).resolves.toBeTruthy();
  });

  it('durably writes independent audio chunks before advancing the manifest', async () => {
    await store.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    await store.updateLifecycle(scope, 'recording');

    const result = await store.appendAudioChunk({
      ...scope,
      source: 'remote',
      bytes: new Uint8Array([1, 2, 3, 4]),
      durationMs: 5_000,
      sampleRate: 48_000,
      channelCount: 1,
      codec: 'aac',
      container: 'm4a',
    });

    expect(result.relativePath).toBe('remote/00000001.m4a.part');
    await expect(
      fs.readFile(
        path.join(rootPath, 'org-1/user-1/session-1', result.relativePath),
      ),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4]));
    const manifest = await store.readManifest(scope);
    expect(manifest.tracks.remote).toMatchObject({
      nextSequence: 2,
      durationMs: 5_000,
      bytes: 4,
      sampleRate: 48_000,
      codec: 'aac',
      container: 'm4a',
    });
    expect(manifest.tracks.local.nextSequence).toBe(1);
  });

  it('serializes concurrent chunk writes so sequence numbers cannot collide', async () => {
    await store.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    await store.updateLifecycle(scope, 'recording');
    const input = {
      ...scope,
      source: 'local' as const,
      bytes: new Uint8Array([9]),
      durationMs: 200,
      sampleRate: 16_000,
      channelCount: 1,
      codec: 'pcm_s16le',
      container: 'pcm',
    };

    const results = await Promise.all([
      store.appendAudioChunk(input),
      store.appendAudioChunk(input),
      store.appendAudioChunk(input),
    ]);

    expect(results.map((result) => result.sequence)).toEqual([1, 2, 3]);
    expect((await store.readManifest(scope)).tracks.local.nextSequence).toBe(4);
  });

  it('appends transcript checkpoints without coupling them to audio lifecycle', async () => {
    await store.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    await store.appendTranscriptCheckpoint(scope, {
      externalId: 'segment-1',
      source: 'remote',
      startMs: 1_000,
      endMs: 1_800,
      text: 'Question',
      isFinal: true,
      confidence: 0.9,
      recordedAt: '2026-08-26T00:00:00.000Z',
    });

    const raw = await fs.readFile(
      path.join(rootPath, 'org-1/user-1/session-1/transcript.jsonl'),
      'utf8',
    );
    expect(JSON.parse(raw.trim())).toMatchObject({
      externalId: 'segment-1',
      source: 'remote',
      isFinal: true,
    });
    await expect(store.readTranscript(scope)).resolves.toEqual([
      expect.objectContaining({ externalId: 'segment-1', text: 'Question' }),
    ]);
    await expect(store.readManifest(scope)).resolves.toMatchObject({
      transcriptRevision: 1,
      transcriptFinalCount: 1,
    });
    await store.appendTranscriptCheckpoint(scope, {
      externalId: 'segment-1',
      source: 'remote',
      startMs: 1_040,
      endMs: 1_840,
      text: 'Question',
      isFinal: true,
      confidence: 0.9,
      recordedAt: '2026-08-26T00:00:00.500Z',
    });
    await expect(store.readTranscript(scope)).resolves.toHaveLength(1);
    await expect(store.readManifest(scope)).resolves.toMatchObject({
      transcriptRevision: 1,
      transcriptFinalCount: 1,
    });
    await expect(
      store.appendTranscriptCheckpoint(scope, {
        externalId: 'segment-1',
        source: 'remote',
        startMs: 1_000,
        endMs: 1_900,
        text: 'Changed question',
        isFinal: true,
        recordedAt: '2026-08-26T00:00:01.000Z',
      }),
    ).rejects.toThrow('final transcript checkpoint cannot be overwritten');
  });

  it('atomically assembles ordered MediaRecorder parts into one final track', async () => {
    await store.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    await store.updateLifecycle(scope, 'recording');
    for (const bytes of [new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])]) {
      await store.appendAudioChunk({
        ...scope,
        source: 'remote',
        bytes,
        durationMs: 5_000,
        sampleRate: 48_000,
        channelCount: 1,
        codec: 'opus',
        container: 'webm',
      });
    }

    const manifest = await store.finalizeAudioTracks(scope);

    await expect(
      fs.readFile(path.join(rootPath, 'org-1/user-1/session-1/remote.webm')),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(manifest.tracks.remote.finalizedRelativePath).toBe('remote.webm');
    expect(manifest.tracks.remote.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(manifest.tracks.local.finalizedRelativePath).toBeNull();

    const listed = await store.listManifests({
      organizationId: scope.organizationId,
      userId: scope.userId,
    });
    expect(listed.map((item) => item.sessionId)).toEqual([scope.sessionId]);
    expect(
      store.resolveSessionFile(
        scope,
        manifest.tracks.remote.finalizedRelativePath!,
      ),
    ).toBe(path.join(rootPath, 'org-1/user-1/session-1/remote.webm'));
  });

  it('preserves manifest audio state when unlink is denied', async () => {
    await prepareFinalizedAudio();
    const denied = Object.assign(new Error('permission denied'), {
      code: 'EACCES',
    });
    vi.spyOn(fs, 'unlink').mockRejectedValueOnce(denied);

    await expect(store.deleteAudioFiles(scope)).rejects.toThrow(
      'permission denied',
    );

    const manifest = await store.readManifest(scope);
    expect(manifest.tracks.local).toMatchObject({
      storageStatus: 'local_only',
      finalizedRelativePath: 'local.webm',
      bytes: 2,
    });
    await expect(
      fs.readFile(path.join(rootPath, 'org-1/user-1/session-1/local.webm')),
    ).resolves.toEqual(Buffer.from([1, 2]));
  });

  it('keeps manifest retryable after a partial directory deletion failure', async () => {
    await prepareFinalizedAudio();
    const remove = fs.rm.bind(fs);
    const denied = Object.assign(new Error('remote directory is busy'), {
      code: 'EACCES',
    });
    const removeSpy = vi
      .spyOn(fs, 'rm')
      .mockImplementation(async (target, options) => {
        if (String(target).endsWith(`${path.sep}remote`)) throw denied;
        return remove(target, options);
      });

    await expect(store.deleteAudioFiles(scope)).rejects.toThrow(
      'remote directory is busy',
    );

    const retained = await store.readManifest(scope);
    expect(retained.tracks.local.finalizedRelativePath).toBe('local.webm');
    expect(retained.tracks.remote.finalizedRelativePath).toBe('remote.webm');
    await expect(
      fs.stat(path.join(rootPath, 'org-1/user-1/session-1/local')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(
      fs.stat(path.join(rootPath, 'org-1/user-1/session-1/remote')),
    ).resolves.toBeTruthy();

    removeSpy.mockRestore();
    const deleted = await store.deleteAudioFiles(scope);
    expect(deleted.tracks.local).toMatchObject({
      storageStatus: 'deleted',
      finalizedRelativePath: null,
      bytes: 0,
    });
    expect(deleted.tracks.remote.storageStatus).toBe('deleted');
  });

  it('does not mark audio deleted when a filesystem call reports false success', async () => {
    await prepareFinalizedAudio();
    vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);

    await expect(store.deleteAudioFiles(scope)).rejects.toThrow(
      'meeting audio cleanup did not remove every target',
    );

    const manifest = await store.readManifest(scope);
    expect(manifest.tracks.local).toMatchObject({
      storageStatus: 'local_only',
      finalizedRelativePath: 'local.webm',
      bytes: 2,
    });
    await expect(
      fs.readFile(path.join(rootPath, 'org-1/user-1/session-1/local.webm')),
    ).resolves.toEqual(Buffer.from([1, 2]));
  });

  it('persists Copilot evaluations and keeps the latest answer per question', async () => {
    await store.prepare({
      ...scope,
      title: 'Interview',
      consentConfirmed: true,
    });
    const answer = {
      status: 'answered' as const,
      question: 'How does a hash map work?',
      question_segment_id: `${scope.sessionId}:remote:asr:1:0`,
      answer: 'It maps a hashed key into a bucket.',
      key_points: ['hash', 'bucket'],
      sources: [],
      reliability: 'high' as const,
      warning: '',
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      latency_ms: 320,
    };
    await store.appendCopilotRecord(scope, answer);
    await store.appendCopilotRecord(scope, {
      ...answer,
      answer: 'It uses a hash function and resolves collisions.',
    });
    await store.appendCopilotRecord(scope, {
      status: 'needs_clarification',
      question: 'Why is it slow?',
      question_segment_id: 'clarify-1',
      clarifying_question: 'Do you mean transcription or answer latency?',
      reason_code: 'ambiguous_reference',
      candidate_id: 'clarify-candidate',
      candidate_revision: 1,
      candidate_segment_ids: ['clarify-1'],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      latency_ms: 180,
    });
    await store.appendCopilotRecord(scope, {
      status: 'needs_clarification',
      question: 'Why is this request slow?',
      question_segment_id: 'clarify-2',
      clarifying_question:
        'Is the delay before ASR or after the model request?',
      reason_code: 'ambiguous_reference',
      candidate_id: 'clarify-candidate',
      candidate_revision: 2,
      candidate_segment_ids: ['clarify-1', 'clarify-2'],
      model: 'deepseek-v4-flash',
      provider: 'deepseek',
      latency_ms: 180,
    });
    await fs.appendFile(
      path.join(rootPath, 'org-1/user-1/session-1/copilot.jsonl'),
      '{"questionSegmentId":"interrupted-tail"',
    );

    const records = await store.readCopilotRecords(scope);

    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      questionSegmentId: answer.question_segment_id,
      evaluatedAt: '2026-08-26T00:00:00.000Z',
      result: {
        status: 'answered',
        answer: 'It uses a hash function and resolves collisions.',
      },
    });
    expect(records[1]).toMatchObject({
      questionSegmentId: 'clarify-2',
      candidateId: 'clarify-candidate',
      revision: 2,
      result: {
        status: 'needs_clarification',
        clarifying_question:
          'Is the delay before ASR or after the model request?',
      },
    });
    await expect(
      store.appendCopilotRecord(scope, {
        status: 'wait_for_more',
        message: 'Need more context.',
        candidate_segment_id: 'wait-1',
      }),
    ).rejects.toThrow('Copilot record requires a question segment');
  });

  it('persists a needs-clarification Copilot terminal result', async () => {
    await store.prepare({
      ...scope,
      title: 'Clarification',
      consentConfirmed: true,
    });
    await store.appendCopilotRecord(scope, {
      status: 'needs_clarification',
      question: 'Which rollout do you mean?',
      question_segment_id: 'question-clarify',
      clarifying_question: 'Do you mean the desktop or server rollout?',
      reason_code: 'ambiguous_reference',
      model: 'test-model',
      provider: 'test-provider',
      latency_ms: 20,
    });

    await expect(store.readCopilotRecords(scope)).resolves.toEqual([
      expect.objectContaining({
        questionSegmentId: 'question-clarify',
        result: expect.objectContaining({ status: 'needs_clarification' }),
      }),
    ]);
  });

  it('reconciles orphaned parts while recovering a playable interrupted track', async () => {
    await store.prepare({
      ...scope,
      title: 'Interrupted interview',
      consentConfirmed: true,
    });
    await store.updateLifecycle(scope, 'recording');
    await fs.writeFile(
      path.join(rootPath, 'org-1/user-1/session-1/local/00000001.webm.part'),
      new Uint8Array([1, 2]),
    );
    await fs.writeFile(
      path.join(rootPath, 'org-1/user-1/session-1/local/00000002.webm.part'),
      new Uint8Array([3, 4, 5]),
    );
    await store.updateLifecycle(scope, 'interrupted');

    const manifest = await store.finalizeAudioTracks(scope, {
      reconcileParts: true,
      bestEffort: true,
    });

    await expect(
      fs.readFile(path.join(rootPath, 'org-1/user-1/session-1/local.webm')),
    ).resolves.toEqual(Buffer.from([1, 2, 3, 4, 5]));
    expect(manifest.tracks.local.finalizedRelativePath).toBe('local.webm');
    expect(manifest.tracks.local.nextSequence).toBe(3);
    expect(manifest.tracks.local.status).toBe('interrupted');
  });

  it('marks unfinished archives interrupted without deleting completed chunks', async () => {
    await store.prepare({
      ...scope,
      title: 'Product review',
      consentConfirmed: true,
    });
    await store.updateLifecycle(scope, 'recording');
    await store.appendAudioChunk({
      ...scope,
      source: 'local',
      bytes: new Uint8Array([7, 8]),
      durationMs: 200,
      sampleRate: 16_000,
      channelCount: 1,
      codec: 'pcm_s16le',
      container: 'pcm',
    });

    const recovered = await store.recoverInterrupted();

    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.lifecycleStatus).toBe('interrupted');
    expect(recovered[0]!.tracks.local.status).toBe('interrupted');
    await expect(
      fs.readFile(
        path.join(rootPath, 'org-1/user-1/session-1/local/00000001.pcm.part'),
      ),
    ).resolves.toEqual(Buffer.from([7, 8]));
  });

  it('persists capture-source failure and clears it after a successful fallback', async () => {
    await store.prepare({
      ...scope,
      title: 'Device recovery',
      consentConfirmed: true,
    });
    await store.updateLifecycle(scope, 'recording');

    const failed = await store.markCaptureSourceUnavailable(
      scope,
      'local',
      'source_unavailable',
      'microphone disconnected',
    );
    expect(failed.tracks.local).toMatchObject({
      status: 'failed',
      errorCode: 'source_unavailable',
      errorMessage: 'microphone disconnected',
    });

    const recovered = await store.updateCaptureSource(
      scope,
      'local',
      'default',
      'MacBook Pro Microphone',
    );
    expect(recovered.microphoneDeviceId).toBe('default');
    expect(recovered.tracks.local.status).toBe('active');
    expect(recovered.tracks.local.errorCode).toBeUndefined();
    expect(recovered.tracks.local.errorMessage).toBeUndefined();
  });

  it('probes durable write, rename, readback, and available capacity', async () => {
    const result = await store.probeLocalStorage();

    expect(result.ok).toBe(true);
    expect(result.rootPath).toBe(rootPath);
    expect(result.availableBytes === null || result.availableBytes > 0).toBe(
      true,
    );
  });
});
