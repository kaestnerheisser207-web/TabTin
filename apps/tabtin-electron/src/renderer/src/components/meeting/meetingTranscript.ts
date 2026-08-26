import type { MeetingTranscriptCheckpoint } from '@shared/meeting-recording-contract';

const TURN_MERGE_MAX_GAP_MS = 1_200;
const TURN_MERGE_MAX_TEXT_LENGTH = 180;
const STRONG_SENTENCE_END = /[。！？!?；;]$/u;

function joinTranscriptText(left: string, right: string): string {
  const normalizedLeft = left.trimEnd();
  const normalizedRight = right.trimStart();
  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;
  const needsSpace =
    /[A-Za-z0-9]$/u.test(normalizedLeft) && /^[A-Za-z0-9]/u.test(normalizedRight);
  return `${normalizedLeft}${needsSpace ? ' ' : ''}${normalizedRight}`;
}

export function resolveMeetingTranscript(
  checkpoints: MeetingTranscriptCheckpoint[],
): MeetingTranscriptCheckpoint[] {
  const latest = new Map<string, MeetingTranscriptCheckpoint>();
  for (const checkpoint of checkpoints) {
    const current = latest.get(checkpoint.externalId);
    if (current?.isFinal && !checkpoint.isFinal) continue;
    latest.set(checkpoint.externalId, checkpoint);
  }
  return [...latest.values()].sort(
    (left, right) =>
      left.startMs - right.startMs ||
      left.source.localeCompare(right.source) ||
      left.externalId.localeCompare(right.externalId),
  );
}

/**
 * Project provider utterances into human-readable speaker turns.
 *
 * BytePlus finalizes utterances from VAD/acoustic endpointing, not topic-level
 * semantics. Keep every raw checkpoint in storage, but visually join adjacent
 * fragments from the same source until a strong sentence boundary appears.
 */
export function groupMeetingTranscriptTurns(
  checkpoints: MeetingTranscriptCheckpoint[],
): MeetingTranscriptCheckpoint[] {
  const turns: MeetingTranscriptCheckpoint[] = [];
  for (const checkpoint of checkpoints) {
    const current = { ...checkpoint };
    const previous = turns.at(-1);
    const gapMs = previous
      ? Math.max(0, current.startMs - previous.endMs)
      : Number.POSITIVE_INFINITY;
    const combinedText = previous
      ? joinTranscriptText(previous.text, current.text)
      : current.text;
    const shouldMerge = Boolean(
      previous &&
        previous.source === current.source &&
        gapMs <= TURN_MERGE_MAX_GAP_MS &&
        !STRONG_SENTENCE_END.test(previous.text.trim()) &&
        combinedText.length <= TURN_MERGE_MAX_TEXT_LENGTH,
    );
    if (!previous || !shouldMerge) {
      turns.push(current);
      continue;
    }
    previous.externalId = `${previous.externalId}|${current.externalId}`;
    previous.endMs = Math.max(previous.endMs, current.endMs);
    previous.text = combinedText;
    previous.isFinal = previous.isFinal && current.isFinal;
    previous.recordedAt = current.recordedAt;
  }
  return turns;
}

export function formatMeetingTranscriptTime(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds]
    .map((value) => String(value).padStart(2, '0'))
    .join(':');
}
