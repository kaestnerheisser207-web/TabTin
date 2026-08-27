import React from 'react';
import { ChevronDown, ChevronUp, Copy } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@components/ui';
import type { MeetingCopilotRecord } from '@shared/meeting-recording-contract';

export const MeetingCopilotHistory: React.FC<{
  records: MeetingCopilotRecord[];
}> = ({ records }) => {
  const { t } = useTranslation('meeting');
  const answeredRecords = React.useMemo(
    () => records.filter((record) => record.result.status === 'answered'),
    [records],
  );
  const latestId = answeredRecords.at(-1)?.questionSegmentId ?? null;
  const [expandedIds, setExpandedIds] = React.useState<Set<string>>(
    () => new Set(latestId ? [latestId] : []),
  );

  React.useEffect(() => {
    setExpandedIds(new Set(latestId ? [latestId] : []));
  }, [latestId]);

  if (answeredRecords.length === 0) {
    return (
      <p className="rounded-[12px] border border-foreground/[0.06] bg-foreground/[0.025] px-4 py-5 text-body leading-6 text-muted-foreground dark:border-foreground/[0.08] dark:bg-foreground/[0.035]">
        {t('live.copilotNoHistory')}
      </p>
    );
  }

  return (
    <div className="space-y-2" aria-label={t('live.copilotHistory')}>
      {answeredRecords.map((record) => {
        if (record.result.status !== 'answered') return null;
        const answer = record.result;
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
                  ? t('live.collapseAnswer', { question: answer.question })
                  : t('live.expandAnswer', { question: answer.question })
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
                  {t('live.answeredQuestion')}
                </span>
                <span className="mt-1 block text-body font-medium leading-6 text-foreground">
                  {answer.question}
                </span>
              </span>
              {expanded ? (
                <ChevronUp className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              ) : (
                <ChevronDown className="mt-1 h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              )}
            </button>

            {expanded ? (
              <div className="border-t border-accent/10 px-4 py-4">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-caption font-medium text-accent-text">
                    {t('live.suggestedAnswer')}
                  </span>
                  <span className="text-caption text-muted-foreground">
                    {t(`live.reliability.${answer.reliability}`)}
                  </span>
                </div>
                <p className="mt-2 text-body font-medium leading-6 text-foreground">
                  {answer.answer}
                </p>
                {answer.key_points.length > 0 ? (
                  <ul className="mt-3 space-y-2 text-body leading-6 text-foreground/85">
                    {answer.key_points.map((point) => (
                      <li key={point}>• {point}</li>
                    ))}
                  </ul>
                ) : null}
                {answer.warning ? (
                  <p className="mt-3 rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5 text-warning-foreground">
                    {answer.warning}
                  </p>
                ) : null}
                <div className="mt-4 border-t border-foreground/[0.06] pt-3">
                  <div className="flex flex-wrap items-center justify-between gap-2 text-caption text-muted-foreground">
                    <span>{t('live.answerModel', { model: answer.model })}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="h-7 gap-1.5"
                      onClick={() => void navigator.clipboard.writeText(answer.answer)}
                    >
                      <Copy className="h-3.5 w-3.5" aria-hidden />
                      {t('live.copy')}
                    </Button>
                  </div>
                  {answer.sources.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {answer.sources.map((source) => (
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
