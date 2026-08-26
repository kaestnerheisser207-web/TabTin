import { describe, expect, it, vi } from 'vitest';

import type { MeetingTranscriptCheckpoint } from '../../shared/meeting-recording-contract';
import {
  MeetingAsrCoordinator,
  probeMeetingAsrReadiness,
  type MeetingAsrGateway,
} from './MeetingAsrCoordinator';

interface SentMessage {
  type: string;
  payload: Record<string, unknown>;
}

class FakeGateway implements MeetingAsrGateway {
  readonly sent: SentMessage[] = [];
  readonly startPayloads: Record<string, unknown>[] = [];
  readonly unsubscribed: string[] = [];
  readonly startStreamIds: string[] = [];
  sendResult = true;

  private startCount = 0;
  private readonly eventHandlers = new Map<
    string,
    Set<(payload: Record<string, unknown>) => void>
  >();
  private readonly reconnectHandlers = new Set<() => void>();

  async requestWithLastAuth(
    type: string,
    payload: Record<string, unknown>,
  ): Promise<{
    ok: boolean;
    type: string;
    payload: Record<string, unknown>;
  }> {
    expect(type).toBe('asr.stream.start');
    this.startPayloads.push(payload);
    const streamId = `stream-${++this.startCount}`;
    this.startStreamIds.push(streamId);
    return {
      ok: true,
      type: 'asr.stream.started',
      payload: { stream_id: streamId },
    };
  }

  send(type: string, payload: Record<string, unknown>): boolean {
    this.sent.push({ type, payload });
    return this.sendResult;
  }

  on(
    type: string,
    handler: (payload: Record<string, unknown>) => void,
  ): () => void {
    const handlers = this.eventHandlers.get(type) ?? new Set();
    handlers.add(handler);
    this.eventHandlers.set(type, handlers);
    return () => {
      handlers.delete(handler);
      this.unsubscribed.push(type);
    };
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => {
      this.reconnectHandlers.delete(handler);
      this.unsubscribed.push('reconnect');
    };
  }

  emit(type: string, payload: Record<string, unknown>): void {
    for (const handler of this.eventHandlers.get(type) ?? []) handler(payload);
  }

  reconnect(): void {
    for (const handler of this.reconnectHandlers) handler();
  }
}

function audioMessages(gateway: FakeGateway): SentMessage[] {
  return gateway.sent.filter((message) => message.type === 'asr.stream.audio');
}

function decodeAudio(message: SentMessage): number[] {
  return [...Buffer.from(String(message.payload.data), 'base64')];
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('probeMeetingAsrReadiness', () => {
  function probeGateway(response: {
    ok: boolean;
    type: string;
    payload?: Record<string, unknown>;
    error?: { code?: string; message?: string };
  }): MeetingAsrGateway {
    return {
      requestWithLastAuth: vi.fn().mockResolvedValue(response),
      send: vi.fn().mockReturnValue(true),
      on: vi.fn().mockReturnValue(() => undefined),
      onReconnect: vi.fn().mockReturnValue(() => undefined),
    };
  }

  it('returns configured BytePlus metadata without exposing credentials', async () => {
    const gateway = probeGateway({
      ok: true,
      type: 'asr.config.status',
      payload: {
        ready: true,
        provider: 'byteplus',
        resource_id: 'volc.seedasr.sauc.duration',
        ws_endpoint: 'bigmodel_async',
      },
    });

    await expect(
      probeMeetingAsrReadiness(gateway, 'organization-1'),
    ).resolves.toEqual({
      ready: true,
      provider: 'byteplus',
      resourceId: 'volc.seedasr.sauc.duration',
      wsEndpoint: 'bigmodel_async',
    });
    expect(gateway.requestWithLastAuth).toHaveBeenCalledWith(
      'asr.config.check',
      { provider: 'byteplus' },
      { organizationId: 'organization-1', timeoutMs: 10_000 },
    );
  });

  it('keeps configuration failure separate from local recording readiness', async () => {
    const gateway = probeGateway({
      ok: true,
      type: 'asr.config.status',
      payload: {
        ready: false,
        provider: 'byteplus',
        reason: 'not_configured',
        message: '语音识别服务未配置，请联系管理员',
      },
    });

    await expect(probeMeetingAsrReadiness(gateway)).resolves.toEqual({
      ready: false,
      provider: 'byteplus',
      reason: 'not_configured',
      message: '语音识别服务未配置，请联系管理员',
    });
  });

  it('preserves a provider credential error from the gateway', async () => {
    const gateway = probeGateway({
      ok: true,
      type: 'asr.config.status',
      payload: {
        ready: false,
        provider: 'byteplus',
        reason: 'credential_error',
        message: 'byteplus API Key cannot be decrypted',
      },
    });

    await expect(probeMeetingAsrReadiness(gateway)).resolves.toEqual({
      ready: false,
      provider: 'byteplus',
      reason: 'credential_error',
      message: 'byteplus API Key cannot be decrypted',
    });
  });

  it('returns a retryable gateway state instead of throwing on request timeout', async () => {
    const gateway = probeGateway({ ok: true, type: 'unused' });
    vi.mocked(gateway.requestWithLastAuth).mockRejectedValueOnce(
      new Error('request timeout'),
    );

    await expect(probeMeetingAsrReadiness(gateway)).resolves.toMatchObject({
      ready: false,
      provider: 'byteplus',
      reason: 'gateway_error',
      message: 'request timeout',
    });
  });
});

describe('MeetingAsrCoordinator', () => {
  it('keeps local and remote audio and transcripts on independent streams', async () => {
    const gateway = new FakeGateway();
    const transcriptSink =
      vi.fn<(checkpoint: MeetingTranscriptCheckpoint) => void>();
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink,
      sessionId: 'meeting-1',
      now: () => new Date('2026-08-26T00:00:00.000Z'),
    });

    await coordinator.start();
    expect(gateway.startPayloads).toHaveLength(2);
    expect(gateway.startPayloads[0]).toMatchObject({
      provider: 'byteplus',
      ws_endpoint: 'bigmodel_async',
      audio_format: 'pcm',
      sample_rate: 16_000,
    });
    coordinator.appendPcm('local', new Uint8Array([1, 2]));
    coordinator.appendPcm('remote', new Uint8Array([8, 9]));

    expect(audioMessages(gateway)).toEqual([
      {
        type: 'asr.stream.audio',
        payload: { stream_id: 'stream-1', data: 'AQI=' },
      },
      {
        type: 'asr.stream.audio',
        payload: { stream_id: 'stream-2', data: 'CAk=' },
      },
    ]);

    gateway.emit('asr.stream.event', {
      stream_id: 'stream-1',
      utterances: [
        { startTime: 10, endTime: 40, text: 'local text', definite: false },
      ],
    });
    gateway.emit('asr.stream.event', {
      stream_id: 'stream-2',
      utterances: [
        { startTime: 20, endTime: 50, text: 'remote text', definite: true },
      ],
    });
    await flushAsyncWork();

    expect(
      transcriptSink.mock.calls.map(([checkpoint]) => checkpoint.source),
    ).toEqual(['local', 'remote']);
    expect(transcriptSink.mock.calls[1]?.[0]).toMatchObject({
      source: 'remote',
      text: 'remote text',
      isFinal: true,
    });
  });

  it('upgrades an interim utterance to final with a stable external id', async () => {
    const gateway = new FakeGateway();
    const checkpoints: MeetingTranscriptCheckpoint[] = [];
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink: (checkpoint) => checkpoints.push(checkpoint),
      sessionId: 'meeting-2',
    });
    await coordinator.start();

    gateway.emit('asr.stream.event', {
      stream_id: 'stream-1',
      utterances: [
        { startTime: 100, endTime: 400, text: 'partial', definite: false },
      ],
    });
    gateway.emit('asr.stream.event', {
      stream_id: 'stream-1',
      utterances: [
        { startTime: 120, endTime: 650, text: 'final text', definite: true },
      ],
    });
    await flushAsyncWork();

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({ text: 'partial', isFinal: false });
    expect(checkpoints[1]).toMatchObject({ text: 'final text', isFinal: true });
    expect(checkpoints[1]?.externalId).toBe(checkpoints[0]?.externalId);
  });

  it('keeps final replay ids stable when the provider adjusts utterance timing', async () => {
    const gateway = new FakeGateway();
    const checkpoints: MeetingTranscriptCheckpoint[] = [];
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink: (checkpoint) => checkpoints.push(checkpoint),
      sessionId: 'meeting-final-replay',
    });
    await coordinator.start();

    gateway.emit('asr.stream.event', {
      stream_id: 'stream-1',
      utterances: [
        { startTime: 100, endTime: 400, text: 'stable final', definite: true },
      ],
    });
    gateway.emit('asr.stream.done', {
      stream_id: 'stream-1',
      utterances: [
        { startTime: 140, endTime: 440, text: 'stable final', definite: true },
      ],
    });
    await flushAsyncWork();

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[1]?.externalId).toBe(checkpoints[0]?.externalId);
  });

  it('falls back to payload text and audio duration when utterances are absent', async () => {
    const gateway = new FakeGateway();
    const checkpoints: MeetingTranscriptCheckpoint[] = [];
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink: (checkpoint) => checkpoints.push(checkpoint),
      sessionId: 'meeting-fallback',
    });
    await coordinator.start();

    gateway.emit('asr.stream.event', {
      stream_id: 'stream-2',
      text: 'fallback interim',
      audioInfo: { duration: 1_250 },
    });
    gateway.emit('asr.stream.done', {
      stream_id: 'stream-2',
      text: 'fallback final',
      audioInfo: { duration: 1_500 },
    });
    await flushAsyncWork();

    expect(checkpoints).toHaveLength(2);
    expect(checkpoints[0]).toMatchObject({
      source: 'remote',
      startMs: 0,
      endMs: 1_250,
      text: 'fallback interim',
      isFinal: false,
    });
    expect(checkpoints[1]).toMatchObject({
      source: 'remote',
      startMs: 0,
      endMs: 1_500,
      text: 'fallback final',
      isFinal: true,
    });
    expect(checkpoints[1]?.externalId).toBe(checkpoints[0]?.externalId);
  });

  it('bounds and flushes audio queued before streams are ready', async () => {
    const gateway = new FakeGateway();
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink: vi.fn(),
      sessionId: 'meeting-not-ready',
      maxQueuedChunksPerSource: 2,
    });

    coordinator.appendPcm('local', new Uint8Array([1]));
    coordinator.appendPcm('local', new Uint8Array([2]));
    coordinator.appendPcm('local', new Uint8Array([3]));
    await coordinator.start();

    expect(audioMessages(gateway).map(decodeAudio)).toEqual([[2], [3]]);
  });

  it('queues per source while disconnected and replays in order on new streams', async () => {
    const gateway = new FakeGateway();
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink: vi.fn(),
      sessionId: 'meeting-3',
      maxQueuedChunksPerSource: 2,
    });
    await coordinator.start();

    gateway.sendResult = false;
    coordinator.appendPcm('local', new Uint8Array([1]));
    coordinator.appendPcm('local', new Uint8Array([2]));
    coordinator.appendPcm('local', new Uint8Array([3]));
    coordinator.appendPcm('remote', new Uint8Array([9]));

    gateway.sendResult = true;
    gateway.reconnect();
    await flushAsyncWork();

    const replayed = audioMessages(gateway).filter(
      (message) =>
        message.payload.stream_id === 'stream-3' ||
        message.payload.stream_id === 'stream-4',
    );
    expect(replayed.map((message) => message.payload.stream_id)).toEqual([
      'stream-3',
      'stream-3',
      'stream-4',
    ]);
    expect(replayed.map(decodeAudio)).toEqual([[2], [3], [9]]);
  });

  it('does not send while paused, flushes on resume, and stops both streams', async () => {
    const gateway = new FakeGateway();
    const transcriptSink = vi.fn();
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink,
      sessionId: 'meeting-4',
      stopGracePeriodMs: 0,
    });
    await coordinator.start();

    coordinator.pause();
    coordinator.appendPcm('local', new Uint8Array([4]));
    coordinator.appendPcm('remote', new Uint8Array([5]));
    expect(audioMessages(gateway)).toHaveLength(0);

    coordinator.resume();
    expect(audioMessages(gateway).map(decodeAudio)).toEqual([[4], [5]]);

    await coordinator.stop();
    expect(
      gateway.sent.filter((message) => message.type === 'asr.stream.stop'),
    ).toEqual([
      { type: 'asr.stream.stop', payload: { stream_id: 'stream-1' } },
      { type: 'asr.stream.stop', payload: { stream_id: 'stream-2' } },
    ]);
    expect(gateway.unsubscribed.sort()).toEqual([
      'asr.stream.done',
      'asr.stream.error',
      'asr.stream.event',
      'reconnect',
    ]);

    gateway.emit('asr.stream.event', {
      stream_id: 'stream-1',
      text: 'must be ignored',
      audioInfo: { duration: 100 },
    });
    gateway.reconnect();
    coordinator.appendPcm('local', new Uint8Array([6]));
    await flushAsyncWork();

    expect(transcriptSink).not.toHaveBeenCalled();
    expect(gateway.startStreamIds).toEqual(['stream-1', 'stream-2']);
    expect(audioMessages(gateway).map(decodeAudio)).toEqual([[4], [5]]);
  });

  it('keeps listeners alive long enough to persist final done events on stop', async () => {
    const gateway = new FakeGateway();
    const checkpoints: MeetingTranscriptCheckpoint[] = [];
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink: (checkpoint) => checkpoints.push(checkpoint),
      sessionId: 'meeting-final-stop',
      stopGracePeriodMs: 1_000,
    });
    await coordinator.start();

    const stopping = coordinator.stop();
    gateway.emit('asr.stream.done', {
      stream_id: 'stream-1',
      text: 'local final',
      audioInfo: { duration: 800 },
    });
    gateway.emit('asr.stream.done', {
      stream_id: 'stream-2',
      text: 'remote final',
      audioInfo: { duration: 900 },
    });
    await stopping;

    expect(checkpoints).toEqual([
      expect.objectContaining({
        source: 'local',
        text: 'local final',
        isFinal: true,
      }),
      expect.objectContaining({
        source: 'remote',
        text: 'remote final',
        isFinal: true,
      }),
    ]);
  });

  it('keeps transcript time absolute across reconnect and pause gaps', async () => {
    const gateway = new FakeGateway();
    const checkpoints: MeetingTranscriptCheckpoint[] = [];
    let nowMs = 1_000;
    const coordinator = new MeetingAsrCoordinator({
      gateway,
      transcriptSink: (checkpoint) => checkpoints.push(checkpoint),
      sessionId: 'meeting-timeline',
      now: () => new Date(nowMs),
    });
    await coordinator.start();

    coordinator.appendPcm('local', new Uint8Array(6_400));
    gateway.sendResult = false;
    coordinator.appendPcm('local', new Uint8Array(6_400));
    gateway.sendResult = true;
    gateway.reconnect();
    await flushAsyncWork();

    gateway.emit('asr.stream.event', {
      stream_id: 'stream-3',
      utterances: [
        { startTime: 0, endTime: 200, text: 'after reconnect', definite: true },
      ],
    });
    coordinator.pause();
    nowMs += 1_000;
    coordinator.resume();
    gateway.emit('asr.stream.event', {
      stream_id: 'stream-3',
      utterances: [
        { startTime: 200, endTime: 400, text: 'after pause', definite: true },
      ],
    });
    await flushAsyncWork();

    expect(checkpoints).toEqual([
      expect.objectContaining({ startMs: 200, endMs: 400 }),
      expect.objectContaining({ startMs: 1_400, endMs: 1_600 }),
    ]);
  });
});
