import React from 'react';
import { ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@components/ui';
import type { MeetingCopilotRecord } from '@shared/meeting-recording-contract';

export const MeetingCopilotHistory: React.FC<{
  records: MeetingCopilotRecord[];
}> = ({ records }) => {
  const { t } = useTranslation('meeting');
  const terminalRecords = React.useMemo(() => {
    const latestByCandidate = new Map<string, MeetingCopilotRecord>();
    for (const record of records) {
      if (
        record.result.status !== 'answered' &&
        record.result.status !== 'needs_clarification'
      ) {
        continue;
      }
      const candidateId =
        record.candidateId ||
        record.result.candidate_id ||
        record.questionSegmentId;
      const current = latestByCandidate.get(candidateId);
      const revision = record.revision ?? record.result.candidate_revision ?? 1;
      const currentRevision =
        current?.revision ?? current?.result.candidate_revision ?? 1;
      if (!current || revision >= currentRevision) {
        latestByCandidate.set(candidateId, record);
      }
    }
    return [...latestByCandidate.values()];
  }, [records]);
  const latestId = terminalRecords.at(-1)?.questionSegmentId ?? null;
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(
    () => new Set(latestId ? [latestId] : []),
  );

  React.useEffect(() => {
    setExpandedIds(new Set(latestId ? [latestId] : []));
  }, [latestId]);

  if (terminalRecords.length === 0) {
    return (
      <p className="rounded-[12px] border border-foreground/[0.06] bg-foreground/[0.025] px-4 py-5 text-body leading-6 text-muted-foreground dark:border-foreground/[0.08] dark:bg-foreground/[0.035]">
        {t('live.copilotNoHistory')}
      </p>
    );
  }

  return (
    <div className="space-y-2" aria-label={t('live.copilotHistory')}>
      {terminalRecords.map((record) => {
        if (
          record.result.status !== 'answered' &&
          record.result.status !== 'needs_clarification'
        )
          return null;
        const result = record.result;
        const expanded = expandedIds.has(record.questionSegmentId);
        return (
          <div
            key={record.questionSegmentId}
            className="overflow-hidden rounded-[12px] border border-accent/15 bg-accent/5"
            data-testid={`meeting-copilot-record-${record.questionSegmentId}`}
          >
            <button
              type="button"
              className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left"
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? t('live.collapseAnswer', { question: result.question })
                  : t('live.expandAnswer', { question: result.question })
              }
              onClick={() =>
                setExpandedIds((current) => {
                  const next = new Set(current);
                  if (expanded) next.delete(record.questionSegmentId);
                  else next.add(record.questionSegmentId);
                  return next;
                })
              }
            >
              <span className="min-w-0">
                <span className="block text-caption font-medium text-muted-foreground">
                  {result.status === 'answered'
                    ? t('live.answeredQuestion')
                    : t('live.clarificationNeeded')}
                </span>
                <span className="mt-1 block text-body font-medium leading-6 text-foreground">
                  {result.question}
                </span>
              </span>
              {expanded ? (
                <ChevronUp
                  className="mt-1 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              ) : (
                <ChevronDown
                  className="mt-1 h-4 w-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
              )}
            </button>

            {expanded && result.status === 'needs_clarification' ? (
              <div className="border-t border-accent/10 px-4 py-4">
                <span className="text-caption font-medium text-accent-text">
                  {t('live.clarifyingQuestion')}
                </span>
                <p className="mt-2 text-body font-medium leading-6 text-foreground">
                  {result.clarifying_question}
                </p>
                {result.uncertainty ? (
                  <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5 text-warning-foreground">
                    {t('live.clarificationUncertainty', {
                      uncertainty: result.uncertainty,
                    })}
                  </p>
                ) : null}
                <p className="mt-4 border-t border-foreground/[0.06] pt-3 text-caption text-muted-foreground">
                  {t('live.answerModel', { model: result.model })}
                </p>
              </div>
            ) : expanded && result.status === 'answered' ? (
              <div className="border-t border-accent/10 px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption font-medium text-accent-text">
                    {t('live.suggestedAnswer')}
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {t(`live.reliability.${result.reliability}`)}
                  </span>
                </div>
                <p className="mt-2 text-body font-medium leading-6 text-foreground">
                  {result.answer}
                </p>
                {result.key_points.length > 0 ? (
                  <ul className="mt-3 space-y-2 text-body leading-6 text-foreground/85">
                    {result.key_points.map((point) => (
                      <li key={point}>• {point}</li>
                    ))}
                  </ul>
                ) : null}
                {result.warning ? (
                  <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5 text-warning-foreground">
                    {result.warning}
                  </p>
                ) : null}
                <div className="mt-4 border-t border-foreground/[0.06] pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground">
                    <span>
                      {t('live.answerModel', { model: result.model })}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5"
                      onClick={() =>
                        void navigator.clipboard.writeText(result.answer)
                      }
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                      {t('live.copy')}
                    </Button>
                  </div>
                  {result.sources.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {result.sources.map((source) => (
                        <span
                          key={source.id}
                          className="rounded-full border border-foreground/[0.08] bg-background px-2 py-1 text-caption text-muted-foreground"
                          title={source.excerpt}
                        >
                          {source.title}
                        </span>
                      ))}
                    </div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
};
