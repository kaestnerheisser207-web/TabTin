import type {
  MeetingAudioSource,
  MeetingTranscriptCheckpoint,
} from './meeting-recording-contract';

const MAX_TURN_GAP_MS = 1_800;
const ADJACENT_QUESTION_GAP_MS = 800;
const MAX_TURN_DURATION_MS = 45_000;
const MAX_TURN_TEXT_LENGTH = 512;
const SHORT_OPEN_TEXT_LENGTH = 12;
const STRONG_SENTENCE_END = /[。！？!?；;.]$/u;
const QUESTION_END = /[？?]$/u;
const OPEN_ENDING =
  /(就是|因为|所以|但是|然后|以及|或者|还是|到底是|直接|比如说|包括|关于|至于|的话|的|了一个|有一个)$/u;
const CONTINUATION_START =
  /^(然后|以及|而且|并且|但是|不过|还是|或者|所以|因为|就是|也|而|内容|情况|比如|包括|的话|其实|同时|另外|再说|接着)/u;

export interface MeetingCopilotTurnStability {
  semanticOpen: boolean;
  hasTerminalPunctuation: boolean;
  recommendedDelayMs: 250 | 800;
  hardDeadlineMs: 1_500;
  closeReason:
    | 'open_semantics'
    | 'terminal_punctuation'
    | 'short_fragment'
    | 'end_of_input';
}

export interface MeetingCopilotTurn {
  candidateId: string;
  requestSegmentId: string;
  segmentIds: string[];
  segmentRevisions: Record<string, number>;
  revision: number;
  source: MeetingAudioSource;
  text: string;
  startMs: number;
  endMs: number;
  recordedAt: string;
  stability: MeetingCopilotTurnStability;
}

interface ResolvedFinal {
  candidateId: string;
  requestSegmentId: string;
  segmentIds: string[];
  segmentRevisions: Record<string, number>;
  revision: number;
  checkpoint: MeetingTranscriptCheckpoint;
}

function normalizeComparisonText(text: string): string {
  return text.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

function textSimilarity(left: string, right: string): number {
  if (left === right) return 1;
  if (!left || !right) return 0;
  const previous = Array.from(
    { length: right.length + 1 },
    (_, index) => index,
  );
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]!;
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex]!;
      previous[rightIndex] = Math.min(
        previous[rightIndex]! + 1,
        previous[rightIndex - 1]! + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return 1 - previous[right.length]! / Math.max(left.length, right.length);
}

function overlapRatio(
  left: MeetingTranscriptCheckpoint,
  right: MeetingTranscriptCheckpoint,
): number {
  const overlap = Math.max(
    0,
    Math.min(left.endMs, right.endMs) - Math.max(left.startMs, right.startMs),
  );
  const shortestDuration = Math.max(
    1,
    Math.min(left.endMs - left.startMs, right.endMs - right.startMs),
  );
  return overlap / shortestDuration;
}

function isOverlappingDuplicate(
  left: MeetingTranscriptCheckpoint,
  right: MeetingTranscriptCheckpoint,
): boolean {
  if (overlapRatio(left, right) < 0.5) return false;
  const normalizedLeft = normalizeComparisonText(left.text);
  const normalizedRight = normalizeComparisonText(right.text);
  if (!normalizedLeft || !normalizedRight) return false;
  return (
    normalizedLeft.includes(normalizedRight) ||
    normalizedRight.includes(normalizedLeft) ||
    textSimilarity(normalizedLeft, normalizedRight) >= 0.9
  );
}

function compareFinals(
  left: MeetingTranscriptCheckpoint,
  right: MeetingTranscriptCheckpoint,
): number {
  const leftRecordedAt = Date.parse(left.recordedAt);
  const rightRecordedAt = Date.parse(right.recordedAt);
  const recordedAtOrder =
    Number.isFinite(leftRecordedAt) && Number.isFinite(rightRecordedAt)
      ? leftRecordedAt - rightRecordedAt
      : 0;
  return (
    recordedAtOrder ||
    left.startMs - right.startMs ||
    left.externalId.localeCompare(right.externalId)
  );
}

function resolveFinals(
  checkpoints: MeetingTranscriptCheckpoint[],
): ResolvedFinal[] {
  const latest = new Map<string, MeetingTranscriptCheckpoint>();
  for (const checkpoint of checkpoints) {
    const current = latest.get(checkpoint.externalId);
    if (current?.isFinal) {
      if (!checkpoint.isFinal || checkpoint.recordedAt < current.recordedAt) {
        continue;
      }
    }
    if (
      !current ||
      checkpoint.isFinal ||
      checkpoint.recordedAt >= current.recordedAt
    ) {
      latest.set(checkpoint.externalId, checkpoint);
    }
  }
  const finals = [...latest.values()].filter(
    (checkpoint) => checkpoint.isFinal,
  );
  finals.sort(compareFinals);
  const deduplicated: ResolvedFinal[] = [];
  for (const checkpoint of finals) {
    const duplicateIndex = deduplicated.findIndex((candidate) =>
      isOverlappingDuplicate(candidate.checkpoint, checkpoint),
    );
    if (duplicateIndex >= 0) {
      const duplicate = deduplicated[duplicateIndex]!;
      duplicate.segmentIds.push(checkpoint.externalId);
      const currentText = normalizeComparisonText(duplicate.checkpoint.text);
      const incomingText = normalizeComparisonText(checkpoint.text);
      const laterEquivalentCorrection =
        incomingText.length === currentText.length &&
        checkpoint.text.trim() !== duplicate.checkpoint.text.trim() &&
        checkpoint.recordedAt > duplicate.checkpoint.recordedAt;
      const richer =
        incomingText.length > currentText.length || laterEquivalentCorrection;
      if (richer) {
        duplicate.requestSegmentId = checkpoint.externalId;
        duplicate.revision += 1;
        duplicate.checkpoint = {
          ...checkpoint,
          source: duplicate.checkpoint.source,
          startMs: Math.min(duplicate.checkpoint.startMs, checkpoint.startMs),
          endMs: Math.max(duplicate.checkpoint.endMs, checkpoint.endMs),
        };
      }
      duplicate.segmentRevisions[checkpoint.externalId] = duplicate.revision;
      continue;
    }
    deduplicated.push({
      candidateId: checkpoint.externalId,
      requestSegmentId: checkpoint.externalId,
      segmentIds: [checkpoint.externalId],
      segmentRevisions: { [checkpoint.externalId]: 1 },
      revision: 1,
      checkpoint,
    });
  }
  return deduplicated;
}

function joinTurnText(left: string, right: string): string {
  const normalizedLeft = left.trimEnd();
  const normalizedRight = right.trimStart();
  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;
  const needsSpace =
    /[A-Za-z0-9]$/u.test(normalizedLeft) &&
    /^[A-Za-z0-9]/u.test(normalizedRight);
  return `${normalizedLeft}${needsSpace ? ' ' : ''}${normalizedRight}`;
}

function semanticOpen(text: string): boolean {
  const normalized = text.trim();
  return !STRONG_SENTENCE_END.test(normalized) || OPEN_ENDING.test(normalized);
}

function shouldMerge(
  turn: MeetingCopilotTurn,
  previousSegment: MeetingTranscriptCheckpoint,
  checkpoint: MeetingTranscriptCheckpoint,
): boolean {
  if (turn.source !== checkpoint.source) return false;
  const gapMs = checkpoint.startMs - previousSegment.endMs;
  if (gapMs > MAX_TURN_GAP_MS) return false;
  const combinedText = joinTurnText(turn.text, checkpoint.text);
  if (
    combinedText.length > MAX_TURN_TEXT_LENGTH ||
    checkpoint.endMs - turn.startMs > MAX_TURN_DURATION_MS
  ) {
    return false;
  }
  return (
    semanticOpen(turn.text) ||
    CONTINUATION_START.test(checkpoint.text.trimStart()) ||
    (gapMs <= ADJACENT_QUESTION_GAP_MS &&
      QUESTION_END.test(previousSegment.text.trim()) &&
      QUESTION_END.test(checkpoint.text.trim()))
  );
}

function stabilityFor(text: string): MeetingCopilotTurnStability {
  const normalized = text.trim();
  const isShort =
    normalized.length <= SHORT_OPEN_TEXT_LENGTH &&
    !STRONG_SENTENCE_END.test(normalized);
  const isOpen = semanticOpen(normalized);
  return {
    semanticOpen: isOpen,
    hasTerminalPunctuation: STRONG_SENTENCE_END.test(normalized),
    recommendedDelayMs: isOpen ? 800 : 250,
    hardDeadlineMs: 1_500,
    closeReason: isShort
      ? 'short_fragment'
      : isOpen
        ? 'open_semantics'
        : STRONG_SENTENCE_END.test(normalized)
          ? 'terminal_punctuation'
          : 'end_of_input',
  };
}

export function buildMeetingCopilotTurns(
  checkpoints: MeetingTranscriptCheckpoint[],
): MeetingCopilotTurn[] {
  const finals = resolveFinals(checkpoints);
  const turns: MeetingCopilotTurn[] = [];
  const lastSegmentByCandidate = new Map<string, MeetingTranscriptCheckpoint>();
  for (const resolved of finals) {
    const checkpoint = resolved.checkpoint;
    const previousTurn = turns.at(-1);
    const previousSegment = previousTurn
      ? lastSegmentByCandidate.get(previousTurn.candidateId)
      : undefined;
    if (
      previousTurn &&
      previousSegment &&
      shouldMerge(previousTurn, previousSegment, checkpoint)
    ) {
      previousTurn.requestSegmentId = resolved.requestSegmentId;
      previousTurn.segmentIds.push(...resolved.segmentIds);
      const previousRevision = previousTurn.revision;
      for (const [segmentId, revision] of Object.entries(
        resolved.segmentRevisions,
      )) {
        previousTurn.segmentRevisions[segmentId] = previousRevision + revision;
      }
      previousTurn.revision += resolved.revision;
      previousTurn.text = joinTurnText(previousTurn.text, checkpoint.text);
      previousTurn.endMs = Math.max(previousTurn.endMs, checkpoint.endMs);
      previousTurn.recordedAt = checkpoint.recordedAt;
      previousTurn.stability = stabilityFor(previousTurn.text);
      lastSegmentByCandidate.set(previousTurn.candidateId, checkpoint);
      continue;
    }
    const turn: MeetingCopilotTurn = {
      candidateId: resolved.candidateId,
      requestSegmentId: resolved.requestSegmentId,
      segmentIds: [...resolved.segmentIds],
      segmentRevisions: { ...resolved.segmentRevisions },
      revision: resolved.revision,
      source: checkpoint.source,
      text: checkpoint.text.trim(),
      startMs: checkpoint.startMs,
      endMs: checkpoint.endMs,
      recordedAt: checkpoint.recordedAt,
      stability: stabilityFor(checkpoint.text),
    };
    turns.push(turn);
    lastSegmentByCandidate.set(turn.candidateId, checkpoint);
  }
  return turns;
}
