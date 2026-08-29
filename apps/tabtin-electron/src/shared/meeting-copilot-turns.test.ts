import { describe, expect, it } from 'vitest';

import type { MeetingTranscriptCheckpoint } from './meeting-recording-contract';
import { buildMeetingCopilotTurns } from './meeting-copilot-turns';

function checkpoint(
  externalId: string,
  text: string,
  startMs: number,
  endMs: number,
  options: Partial<MeetingTranscriptCheckpoint> = {},
): MeetingTranscriptCheckpoint {
  return {
    externalId,
    source: 'local',
    startMs,
    endMs,
    text,
    isFinal: true,
    recordedAt: new Date(Date.UTC(2026, 7, 28, 0, 0, 0, endMs)).toISOString(),
    ...options,
  };
}

describe('buildMeetingCopilotTurns', () => {
  it.each([
    ['请帮我判断究竟是', '终端上传慢，还是识别服务回传慢？'],
    ['我在想请求是不是先经过', '检索处理，还是直接调用模型？'],
    ['前面的内容没有解决问题。', '而且只给了话术，这是什么原因？'],
  ])('merges a synthetic continuation: %s', (first, second) => {
    const turns = buildMeetingCopilotTurns([
      checkpoint('first', first, 1_000, 2_000),
      checkpoint('second', second, 2_500, 4_000),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      candidateId: 'first',
      requestSegmentId: 'second',
      segmentIds: ['first', 'second'],
      revision: 2,
    });
    expect(turns[0]?.text).toContain(second);
  });

  it('keeps an opening phrase and two adjacent questions in one turn', () => {
    const turns = buildMeetingCopilotTurns([
      checkpoint('opening', '先问你第一个问题，就是', 1_000, 2_000),
      checkpoint('question-1', '它是怎么构造的？', 2_000, 3_000),
      checkpoint('question-2', '它内部结构是什么样子的？', 3_000, 4_000),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toMatchObject({
      candidateId: 'opening',
      requestSegmentId: 'question-2',
      revision: 3,
      segmentIds: ['opening', 'question-1', 'question-2'],
    });
  });

  it('removes an overlapping local/remote echo before turn building', () => {
    const turns = buildMeetingCopilotTurns([
      checkpoint('echo-local', '向量数据库。', 194_522, 196_072),
      checkpoint('echo-remote', '向量数据库。', 194_882, 196_612, {
        source: 'remote',
      }),
    ]);

    expect(turns).toHaveLength(1);
    expect(turns[0]?.segmentIds).toEqual(['echo-local', 'echo-remote']);
  });

  it('collapses thirteen overlapping replay finals', () => {
    const turns = buildMeetingCopilotTurns(
      Array.from({ length: 13 }, (_, index) =>
        checkpoint(
          `replay-${index}`,
          '散列表为什么能快速查询？',
          10_000 + index * 20,
          13_000 + index * 20,
        ),
      ),
    );

    expect(turns).toHaveLength(1);
    expect(turns[0]?.candidateId).toBe('replay-0');
    expect(turns[0]?.segmentIds).toHaveLength(13);
    expect(turns[0]?.revision).toBe(1);
    expect(new Set(Object.values(turns[0]!.segmentRevisions))).toEqual(
      new Set([1]),
    );
  });

  it('keeps a stable candidate while selecting a richer duplicate', () => {
    const turns = buildMeetingCopilotTurns([
      checkpoint('short', '散列表', 10_000, 12_000),
      checkpoint('complete', '散列表为什么能快速查询？', 10_200, 13_000),
    ]);

    expect(turns).toEqual([
      expect.objectContaining({
        candidateId: 'short',
        requestSegmentId: 'complete',
        segmentIds: ['short', 'complete'],
        segmentRevisions: { short: 1, complete: 2 },
        revision: 2,
        text: '散列表为什么能快速查询？',
      }),
    ]);
  });

  it('uses a later equivalent duplicate when it restores sentence closure', () => {
    const turns = buildMeetingCopilotTurns([
      checkpoint('plain', '散列表为什么能快速查询', 10_000, 12_000),
      checkpoint('punctuated', '散列表为什么能快速查询？', 10_100, 12_500),
    ]);

    expect(turns[0]).toMatchObject({
      candidateId: 'plain',
      requestSegmentId: 'punctuated',
      revision: 2,
      text: '散列表为什么能快速查询？',
      stability: { semanticOpen: false, recommendedDelayMs: 250 },
    });
  });

  it('preserves final dominance and exposes stable scheduling hints', () => {
    const turns = buildMeetingCopilotTurns([
      checkpoint('one', '请帮我判断究竟是', 1_000, 2_000, {
        isFinal: false,
      }),
      checkpoint('one', '请帮我判断究竟是', 1_000, 2_300),
      checkpoint('one', '迟到的 partial', 1_000, 2_500, {
        isFinal: false,
      }),
    ]);

    expect(turns).toEqual([
      expect.objectContaining({
        candidateId: 'one',
        requestSegmentId: 'one',
        revision: 1,
        text: '请帮我判断究竟是',
        stability: expect.objectContaining({
          semanticOpen: true,
          recommendedDelayMs: 800,
          hardDeadlineMs: 1_500,
        }),
      }),
    ]);
  });

  it('does not merge across a source change', () => {
    const turns = buildMeetingCopilotTurns([
      checkpoint('local', '请帮我判断究竟是', 1_000, 2_000),
      checkpoint('remote', '另一位说话人插话。', 2_000, 2_500, {
        source: 'remote',
      }),
      checkpoint('local-2', '后续内容。', 2_500, 3_000),
    ]);

    expect(turns.map((turn) => turn.candidateId)).toEqual([
      'local',
      'remote',
      'local-2',
    ]);
  });
});
