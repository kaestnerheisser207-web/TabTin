import { describe, expect, it } from 'vitest';

import {
  formatMeetingTranscriptTime,
  groupMeetingTranscriptTurns,
  resolveMeetingTranscript,
} from './meetingTranscript';

describe('meeting transcript projection', () => {
  it('replaces interim checkpoints and never regresses a final segment', () => {
    const base = {
      source: 'local' as const,
      speakerKey: 'local',
      startMs: 100,
      endMs: 400,
      confidence: null,
      recordedAt: '2026-08-26T00:00:00.000Z',
    };
    const projected = resolveMeetingTranscript([
      { ...base, externalId: 'one', text: 'hel', isFinal: false },
      { ...base, externalId: 'one', text: 'hello', isFinal: true },
      { ...base, externalId: 'one', text: 'stale', isFinal: false },
    ]);

    expect(projected).toHaveLength(1);
    expect(projected[0]).toMatchObject({ text: 'hello', isFinal: true });
  });

  it('orders both sources by capture time and formats an absolute timestamp', () => {
    const checkpoint = (source: 'local' | 'remote', startMs: number) => ({
      externalId: `${source}-${startMs}`,
      source,
      startMs,
      endMs: startMs + 200,
      text: source,
      isFinal: true,
      recordedAt: '2026-08-26T00:00:00.000Z',
    });
    expect(
      resolveMeetingTranscript([
        checkpoint('local', 2_000),
        checkpoint('remote', 1_000),
      ]).map((item) => item.source),
    ).toEqual(['remote', 'local']);
    expect(formatMeetingTranscriptTime(3_723_999)).toBe('01:02:03');
  });

  it('joins provider VAD fragments into a speaker turn without changing raw storage', () => {
    const checkpoint = (
      externalId: string,
      startMs: number,
      endMs: number,
      text: string,
    ) => ({
      externalId,
      source: 'local' as const,
      startMs,
      endMs,
      text,
      isFinal: true,
      recordedAt: '2026-08-26T00:00:00.000Z',
    });
    const raw = [
      checkpoint('one', 0, 1_000, 'provider segment'),
      checkpoint('two', 1_050, 1_500, 'situation!'),
      checkpoint('three', 1_600, 2_000, 'Next sentence.'),
    ];

    const turns = groupMeetingTranscriptTurns(raw);

    expect(turns.map((turn) => turn.text)).toEqual([
      'provider segment situation!',
      'Next sentence.',
    ]);
    expect(raw[0]).toMatchObject({ externalId: 'one', text: 'provider segment' });
  });

  it('does not merge different speakers or long silence gaps', () => {
    const base = {
      isFinal: true,
      recordedAt: '2026-08-26T00:00:00.000Z',
    };
    const turns = groupMeetingTranscriptTurns([
      {
        ...base,
        externalId: 'local-1',
        source: 'local',
        startMs: 0,
        endMs: 500,
        text: 'Local fragment',
      },
      {
        ...base,
        externalId: 'remote-1',
        source: 'remote',
        startMs: 600,
        endMs: 900,
        text: 'Remote fragment',
      },
      {
        ...base,
        externalId: 'remote-2',
        source: 'remote',
        startMs: 2_500,
        endMs: 2_900,
        text: 'Fragment after silence',
      },
    ]);

    expect(turns).toHaveLength(3);
  });

});
