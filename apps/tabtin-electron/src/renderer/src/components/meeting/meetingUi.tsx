import React from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, FlaskConical, Mic2, Play } from 'lucide-react';
import { Button, UserAvatar } from '@components/ui';
import { cn } from '@utils/cn';

export const MeetingPreviewBanner: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div
    role="status"
    className="flex items-center gap-2 rounded-[12px] border border-warning/20 bg-warning/5 px-4 py-2.5 text-body text-warning"
  >
    <FlaskConical className="h-4 w-4 shrink-0" aria-hidden />
    <span>{children}</span>
  </div>
);

/** Shared page-header icon: ContextPageHeader owns the standard 56px surface. */
export const MeetingPageIcon: React.FC = () => (
  <Mic2 className="h-7 w-7" data-testid="meeting-page-icon" aria-hidden />
);

export const MeetingSection: React.FC<{
  title: string;
  description?: string;
  children: React.ReactNode;
  actions?: React.ReactNode;
  className?: string;
  contentClassName?: string;
}> = ({
  title,
  description,
  children,
  actions,
  className,
  contentClassName,
}) => (
  <section
    className={cn(
      'rounded-[12px] bg-foreground/[0.03] p-5 dark:bg-foreground/[0.04]',
      className,
    )}
  >
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-title font-semibold text-foreground">{title}</h2>
        {description ? (
          <p className="mt-1 max-w-3xl text-body leading-relaxed text-muted-foreground">
            {description}
          </p>
        ) : null}
      </div>
      {actions ? <div className="shrink-0">{actions}</div> : null}
    </div>
    <div className={cn('mt-4', contentClassName)}>{children}</div>
  </section>
);

export type MeetingHealthTone =
  | 'healthy'
  | 'pending'
  | 'warning'
  | 'failed'
  | 'off';

const HEALTH_TONE_CLASS: Record<MeetingHealthTone, string> = {
  healthy: 'bg-success/10 text-success',
  pending: 'bg-foreground/[0.06] text-muted-foreground',
  warning: 'bg-warning/10 text-warning',
  failed: 'bg-destructive/10 text-destructive',
  off: 'bg-foreground/[0.04] text-muted-foreground/60',
};

export const MeetingHealthCard: React.FC<{
  label: string;
  value: string;
  detail: string;
  tone: MeetingHealthTone;
}> = ({ label, value, detail, tone }) => (
  <div className="min-w-0 rounded-[12px] border border-foreground/[0.06] bg-background p-3.5 dark:border-foreground/[0.08]">
    <div className="flex items-center justify-between gap-2">
      <span className="text-caption font-medium text-muted-foreground">
        {label}
      </span>
      <span
        className={cn(
          'rounded-full px-2 py-0.5 text-caption font-medium',
          HEALTH_TONE_CLASS[tone],
        )}
      >
        {value}
      </span>
    </div>
    <p className="mt-2 text-body text-foreground/80">{detail}</p>
  </div>
);

export const MeetingTranscriptTurn: React.FC<{
  speaker: string;
  time: string;
  children: React.ReactNode;
  pending?: boolean;
  active?: boolean;
  onTimeClick?: () => void;
  timeActionLabel?: string;
  speakerId?: string | null;
  avatarUrl?: string | null;
}> = ({
  speaker,
  time,
  children,
  pending = false,
  active = false,
  onTimeClick,
  timeActionLabel,
  speakerId,
  avatarUrl,
}) => {
  const { t } = useTranslation('meeting');
  return (
    <article
      className={cn(
        'rounded-[10px] border-l-2 border-l-transparent px-2 py-2 transition-colors',
        active &&
          'border-l-accent bg-accent/10 ring-1 ring-inset ring-accent/30',
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <UserAvatar
            name={speaker}
            seed={speakerId || speaker}
            avatarUrl={avatarUrl}
            size={24}
          />
          <span className="truncate text-caption font-medium text-foreground">
            {speaker}
          </span>
        </div>
        {onTimeClick ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-0.5 h-5 gap-1 px-1 text-caption tabular-nums text-muted-foreground hover:text-foreground"
            onClick={onTimeClick}
            aria-label={timeActionLabel || time}
          >
            <Play className="h-2.5 w-2.5" aria-hidden />
            {time}
          </Button>
        ) : (
          <time className="ml-1 shrink-0 text-caption tabular-nums text-muted-foreground">
            {time}
          </time>
        )}
      </div>
      <div
        className={cn(
          'mt-0.5 pl-8 text-caption leading-5',
          pending ? 'text-muted-foreground' : 'text-foreground/90',
        )}
      >
        {children}
        {pending ? (
          <span
            className="ml-1 inline-block h-3.5 w-0.5 animate-pulse bg-accent align-middle motion-reduce:animate-none"
            aria-label={t('common.temporaryTranscript')}
          />
        ) : null}
      </div>
    </article>
  );
};

export const MeetingPartialNotice: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => (
  <div className="flex items-start gap-2 rounded-[12px] border border-warning/20 bg-warning/5 px-4 py-3 text-body text-warning">
    <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
    <span>{children}</span>
  </div>
);
