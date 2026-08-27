import React from 'react';
import { AlertCircle, CheckCircle2, Mic2, MicOff, Radio } from 'lucide-react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@components/ui';

export type MeetingMicrophoneTestPhase =
  | 'idle'
  | 'listening'
  | 'heard'
  | 'silent'
  | 'failed';

export interface MeetingMicrophoneTestDialogCopy {
  title: string;
  description: string;
  dismissLabel: string;
  deviceLabel: string;
  idleTitle: string;
  idleDescription: string;
  listeningTitle: string;
  speaking: string;
  speakPrompt: string;
  heardTitle: string;
  heardDescription: string;
  silentTitle: string;
  silentDescription: string;
  failedTitle: string;
  failedDescription: string;
  meterLabel: string;
  rmsLabel: string;
  start: string;
  retry: string;
  close: string;
}

export interface MeetingMicrophoneTestDialogProps {
  open: boolean;
  deviceLabel: string;
  phase: MeetingMicrophoneTestPhase;
  levels: number[];
  maxRms: number;
  onStart: () => void;
  onClose: () => void;
  copy?: Partial<MeetingMicrophoneTestDialogCopy>;
}

const DEFAULT_COPY: MeetingMicrophoneTestDialogCopy = {
  title: 'Test microphone',
  description: 'Speak normally to confirm that this microphone can hear you.',
  dismissLabel: 'Dismiss microphone test',
  deviceLabel: 'Selected microphone',
  idleTitle: 'Ready to listen',
  idleDescription: 'Start the test, then speak for a few seconds.',
  listeningTitle: 'Listening to your microphone',
  speaking: 'Speaking detected',
  speakPrompt: 'Please start speaking',
  heardTitle: 'Microphone detected',
  heardDescription: 'Audio was captured at a usable level.',
  silentTitle: 'No voice detected',
  silentDescription:
    'Check the selected device and try speaking a little louder.',
  failedTitle: 'Microphone test failed',
  failedDescription:
    'The microphone could not be tested. Check access and try again.',
  meterLabel: 'Live microphone level',
  rmsLabel: 'Peak RMS',
  start: 'Start test',
  retry: 'Test again',
  close: 'Close',
};

const SPEAKING_RMS_THRESHOLD = 0.006;
const WAVEFORM_BAR_COUNT = 40;
const WAVEFORM_VISUAL_CEILING = 0.03;

function clampRms(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function waveformLevels(levels: number[]): number[] {
  const recent = levels.slice(-WAVEFORM_BAR_COUNT).map(clampRms);
  return [
    ...Array.from(
      { length: Math.max(0, WAVEFORM_BAR_COUNT - recent.length) },
      () => 0,
    ),
    ...recent,
  ];
}

function barHeight(level: number): string {
  const normalized = Math.min(1, level / WAVEFORM_VISUAL_CEILING);
  return `${Math.round(8 + normalized * 92)}%`;
}

interface ResultPresentation {
  Icon: React.FC<React.SVGProps<SVGSVGElement>>;
  title: string;
  description: string;
  toneClassName: string;
}

function resultPresentation(
  phase: Exclude<MeetingMicrophoneTestPhase, 'listening'>,
  copy: MeetingMicrophoneTestDialogCopy,
): ResultPresentation {
  if (phase === 'heard') {
    return {
      Icon: CheckCircle2,
      title: copy.heardTitle,
      description: copy.heardDescription,
      toneClassName: 'bg-success/10 text-success',
    };
  }
  if (phase === 'silent') {
    return {
      Icon: MicOff,
      title: copy.silentTitle,
      description: copy.silentDescription,
      toneClassName: 'bg-warning/10 text-warning',
    };
  }
  if (phase === 'failed') {
    return {
      Icon: AlertCircle,
      title: copy.failedTitle,
      description: copy.failedDescription,
      toneClassName: 'bg-destructive/10 text-destructive',
    };
  }
  return {
    Icon: Mic2,
    title: copy.idleTitle,
    description: copy.idleDescription,
    toneClassName: 'bg-accent/10 text-accent-text',
  };
}

export const MeetingMicrophoneTestDialog: React.FC<
  MeetingMicrophoneTestDialogProps
> = ({
  open,
  deviceLabel,
  phase,
  levels,
  maxRms,
  onStart,
  onClose,
  copy: copyOverrides,
}) => {
  const copy = { ...DEFAULT_COPY, ...copyOverrides };
  const bars = waveformLevels(levels);
  const latestRms = levels.length > 0 ? clampRms(levels.at(-1) ?? 0) : 0;
  const isSpeaking = latestRms >= SPEAKING_RMS_THRESHOLD;
  const safeMaxRms = clampRms(maxRms);
  const result = phase === 'listening' ? null : resultPresentation(phase, copy);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent
        className="w-[calc(100vw-32px)] max-w-[440px] gap-0 p-0 sm:max-w-[440px]"
        closeLabel={copy.dismissLabel}
      >
        <DialogHeader className="border-b border-foreground/[0.07] px-6 pb-4 pt-5 text-left dark:border-foreground/[0.09]">
          <DialogTitle className="text-subtitle font-semibold text-foreground">
            {copy.title}
          </DialogTitle>
          <DialogDescription className="text-body leading-6 text-muted-foreground">
            {copy.description}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-5">
          <div className="flex min-w-0 items-center gap-3 rounded-[12px] bg-foreground/[0.035] px-4 py-3 dark:bg-foreground/[0.05]">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-background text-muted-foreground">
              <Mic2 className="h-4 w-4" aria-hidden />
            </span>
            <div className="min-w-0">
              <p className="text-caption text-muted-foreground">
                {copy.deviceLabel}
              </p>
              <p className="truncate text-body font-medium text-foreground">
                {deviceLabel}
              </p>
            </div>
          </div>

          {phase === 'listening' ? (
            <div className="space-y-4">
              <div
                role="meter"
                aria-label={copy.meterLabel}
                aria-valuemin={0}
                aria-valuemax={1}
                aria-valuenow={latestRms}
                aria-valuetext={`${copy.rmsLabel}: ${latestRms.toFixed(3)}`}
                className="flex h-24 items-center gap-1 overflow-hidden rounded-[12px] border border-foreground/[0.07] bg-foreground/[0.025] px-4 py-3 dark:border-foreground/[0.09] dark:bg-foreground/[0.035]"
              >
                {bars.map((level, index) => (
                  <span
                    // Fixed positions intentionally represent a rolling time window.
                    key={index}
                    data-testid="microphone-level-bar"
                    aria-hidden
                    className="min-h-[2px] min-w-0 flex-1 rounded-full bg-accent/65 transition-[height,background-color] duration-100 motion-reduce:transition-none"
                    style={{ height: barHeight(level) }}
                  />
                ))}
              </div>

              <div
                className="text-center"
                aria-live="polite"
                aria-atomic="true"
              >
                <p className="text-body font-medium text-foreground">
                  {copy.listeningTitle}
                </p>
                <p
                  data-testid="microphone-speaking-state"
                  className={
                    isSpeaking
                      ? 'mt-1 inline-flex items-center gap-1.5 text-caption text-success'
                      : 'mt-1 inline-flex items-center gap-1.5 text-caption text-muted-foreground'
                  }
                >
                  <Radio
                    className={
                      isSpeaking
                        ? 'h-3.5 w-3.5 animate-pulse motion-reduce:animate-none'
                        : 'h-3.5 w-3.5'
                    }
                    aria-hidden
                  />
                  {isSpeaking ? copy.speaking : copy.speakPrompt}
                </p>
              </div>
            </div>
          ) : result ? (
            <div
              className="rounded-[12px] border border-foreground/[0.07] bg-background p-5 text-center dark:border-foreground/[0.09]"
              aria-live="polite"
              aria-atomic="true"
            >
              <span
                className={`mx-auto flex h-11 w-11 items-center justify-center rounded-full ${result.toneClassName}`}
              >
                <result.Icon className="h-5 w-5" aria-hidden />
              </span>
              <p className="mt-3 text-body font-medium text-foreground">
                {result.title}
              </p>
              {result.description !== result.title ? (
                <p className="mt-1 text-caption leading-5 text-muted-foreground">
                  {result.description}
                </p>
              ) : null}
              <div className="mt-4 inline-flex items-baseline gap-2 rounded-full bg-foreground/[0.04] px-3 py-1.5 tabular-nums dark:bg-foreground/[0.06]">
                <span className="text-caption text-muted-foreground">
                  {copy.rmsLabel}
                </span>
                <span className="text-body font-medium text-foreground">
                  {safeMaxRms.toFixed(3)}
                </span>
              </div>
            </div>
          ) : null}
        </div>

        <DialogFooter className="gap-2 border-t border-foreground/[0.07] px-6 py-4 sm:space-x-0 dark:border-foreground/[0.09]">
          <Button type="button" variant="outline" onClick={onClose}>
            {copy.close}
          </Button>
          {phase !== 'listening' ? (
            <Button type="button" onClick={onStart}>
              {phase === 'idle' ? copy.start : copy.retry}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default MeetingMicrophoneTestDialog;
