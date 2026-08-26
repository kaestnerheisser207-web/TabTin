import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bot,
  ChevronLeft,
  FileText,
  HardDrive,
  Mic2,
  ShieldCheck,
  Volume2,
} from 'lucide-react';

import {
  Button,
  Checkbox,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Switch,
  Textarea,
} from '@components/ui';
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage';
import { useAuthStore } from '@stores/useAuthStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import { ProjectApiService } from '@/services/projectApi';
import { OrganizationLlmApiService } from '@/services/organizationLlmApi';
import type { Project } from '@/types/project';
import type { OrganizationLlmModel } from '@/types/llm-organization';
import { MeetingPageIcon, MeetingSection } from './meetingUi';
import {
  type MeetingReadinessState,
  useMeetingReadiness,
} from './useMeetingReadiness';
import {
  MeetingMicrophoneTestDialog,
  type MeetingMicrophoneTestPhase,
} from './MeetingMicrophoneTestDialog';

const NO_PROJECT_VALUE = '__none__';

function meetingSetupErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === 'object') {
    const value = error as {
      message?: unknown;
      error?: { message?: unknown };
    };
    if (typeof value.message === 'string' && value.message) {
      return value.message;
    }
    if (typeof value.error?.message === 'string' && value.error.message) {
      return value.error.message;
    }
    try {
      const serialized = JSON.stringify(error);
      if (serialized && serialized !== '{}') return serialized;
    } catch {
      // Fall through to the stable fallback below.
    }
  }
  const fallback = String(error);
  return fallback && fallback !== '[object Object]'
    ? fallback
    : 'Meeting recording could not start';
}

export const MeetingSetupView: React.FC<{
  onBack: () => void;
  onStarted: (sessionId: string) => void;
}> = ({ onBack, onStarted }) => {
  const { t } = useTranslation('meeting');
  const [title, setTitle] = React.useState('');
  const [brief, setBrief] = React.useState('');
  const [copilotEnabled, setCopilotEnabled] = React.useState(false);
  const copilotChoiceTouchedRef = React.useRef(false);
  const [copilotModelState, setCopilotModelState] = React.useState<
    'checking' | 'ready' | 'missing' | 'failed'
  >('checking');
  const [copilotModels, setCopilotModels] = React.useState<
    OrganizationLlmModel[]
  >([]);
  const [copilotModelId, setCopilotModelId] = React.useState('');
  const [consentConfirmed, setConsentConfirmed] = React.useState(false);
  const [projectId, setProjectId] = React.useState(NO_PROJECT_VALUE);
  const [microphoneDeviceId, setMicrophoneDeviceId] = React.useState('default');
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [projectsLoading, setProjectsLoading] = React.useState(false);
  const [isStarting, setIsStarting] = React.useState(false);
  const [startError, setStartError] = React.useState<string | null>(null);
  const pendingSessionIdRef = React.useRef<string | null>(null);
  const [microphoneTestState, setMicrophoneTestState] =
    React.useState<MeetingMicrophoneTestPhase>('idle');
  const [microphoneTestOpen, setMicrophoneTestOpen] = React.useState(false);
  const [microphoneLevels, setMicrophoneLevels] = React.useState<number[]>([]);
  const [microphoneTestRms, setMicrophoneTestRms] = React.useState(0);
  const organizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  );
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const {
    snapshot: readiness,
    checkSystemAudio,
    applyMicrophoneTestResult,
    resetMicrophone,
  } = useMeetingReadiness(
    microphoneDeviceId,
    organizationId ? String(organizationId) : undefined,
  );
  const selectedMicrophone = readiness.microphones.find(
    (device) => device.deviceId === microphoneDeviceId,
  );
  const selectedCopilotModel = copilotModels.find(
    (model) => model.id === copilotModelId,
  );

  React.useEffect(() => {
    if (!organizationId) {
      setProjects([]);
      return;
    }
    let cancelled = false;
    setProjectsLoading(true);
    void ProjectApiService.listProjects(String(organizationId))
      .then((result) => {
        if (!cancelled) setProjects(result.projects);
      })
      .catch(() => {
        if (!cancelled) setProjects([]);
      })
      .finally(() => {
        if (!cancelled) setProjectsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  React.useEffect(() => {
    if (!organizationId) {
      setCopilotModelState('missing');
      setCopilotModels([]);
      setCopilotModelId('');
      setCopilotEnabled(false);
      return;
    }
    let cancelled = false;
    setCopilotModelState('checking');
    void OrganizationLlmApiService.listModels(String(organizationId))
      .then((result) => {
        if (cancelled) return;
        const readyModels = result.models.filter(
          (model) =>
            model.capability_domain === 'chat' &&
            model.wave_status === 'ready' &&
            model.provider_routing_enabled !== false,
        );
        setCopilotModels(readyModels);
        setCopilotModelState(readyModels.length > 0 ? 'ready' : 'missing');
        if (readyModels.length === 0) setCopilotEnabled(false);
        else if (!copilotChoiceTouchedRef.current) setCopilotEnabled(true);
        const preferredId =
          result.default_model_id ||
          result.organization_default_model_id ||
          readyModels[0]?.id ||
          '';
        setCopilotModelId((current) =>
          readyModels.some((model) => model.id === current)
            ? current
            : preferredId,
        );
      })
      .catch(() => {
        if (!cancelled) {
          setCopilotModelState('failed');
          setCopilotModels([]);
          setCopilotModelId('');
          setCopilotEnabled(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId]);

  React.useEffect(() => {
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge?.onMicrophoneTestLevel) return;
    return bridge.onMicrophoneTestLevel((event) => {
      if (!event.active && event.elapsedMs === 0) return;
      setMicrophoneLevels((current) => [...current.slice(-39), event.rms]);
      setMicrophoneTestRms(event.maxRms);
    });
  }, []);

  const readinessValue = (state: MeetingReadinessState): string => {
    if (state === 'ready') return t('common.normal');
    if (state === 'failed') return t('common.unavailable');
    if (state === 'checking') return t('common.checking');
    return t('common.pendingCheck');
  };
  const transcriptionReadinessValue = (
    state: MeetingReadinessState,
  ): string =>
    state === 'ready'
      ? t('setup.transcriptionConfigReady')
      : readinessValue(state);
  const readinessBadgeClass = (state: MeetingReadinessState): string => {
    if (state === 'ready') return 'bg-success/10 text-success';
    if (state === 'failed') return 'bg-destructive/10 text-destructive';
    return 'bg-foreground/[0.05] text-muted-foreground';
  };
  const canStart = Boolean(
    title.trim() && consentConfirmed && organizationId && userId && !isStarting,
  );

  const handleStart = async () => {
    if (!canStart || !organizationId || !userId) return;
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge) return;
    setIsStarting(true);
    setStartError(null);
    try {
      const currentStatus = await bridge.getStatus();
      const reusableSessionId =
        currentStatus.manifest?.lifecycleStatus === 'preparing' &&
        currentStatus.manifest.organizationId === String(organizationId) &&
        currentStatus.manifest.userId === String(userId)
          ? currentStatus.manifest.sessionId
          : null;
      const sessionId =
        pendingSessionIdRef.current ?? reusableSessionId ?? crypto.randomUUID();
      pendingSessionIdRef.current = sessionId;
      await bridge.prepare({
        sessionId,
        organizationId: String(organizationId),
        userId: String(userId),
        projectId: projectId === NO_PROJECT_VALUE ? null : projectId,
        title: title.trim(),
        brief: brief.trim(),
        consentConfirmed,
        copilotEnabled,
        copilotModelId,
        copilotModelLabel: selectedCopilotModel?.display_name ?? '',
        microphoneDeviceId,
        microphoneDeviceLabel: selectedMicrophone?.label ?? '',
      });
      await bridge.start({
        sessionId,
        organizationId: String(organizationId),
        userId: String(userId),
      });
      pendingSessionIdRef.current = null;
      onStarted(sessionId);
    } catch (error) {
      setStartError(meetingSetupErrorMessage(error));
    } finally {
      setIsStarting(false);
    }
  };

  const handleMicrophoneTest = async () => {
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge || microphoneTestState === 'listening') return;
    setMicrophoneTestOpen(true);
    setMicrophoneTestState('listening');
    setMicrophoneLevels([]);
    setMicrophoneTestRms(0);
    try {
      const result = await bridge.testMicrophone({
        microphoneDeviceId,
        durationMs: 4_000,
      });
      setMicrophoneTestRms(result.maxRms);
      applyMicrophoneTestResult(result);
      if (!result.available) {
        setMicrophoneTestState('failed');
      } else if (result.nonSilentFrames > 0 && result.maxRms >= 0.002) {
        setMicrophoneTestState('heard');
      } else {
        setMicrophoneTestState('silent');
      }
    } catch {
      setMicrophoneTestState('failed');
    }
  };

  return (
    <>
      <StandaloneModulePage
        icon={<MeetingPageIcon />}
        title={t('setup.title')}
        titleAs="h1"
        description={t('setup.description')}
        actions={
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5"
              onClick={onBack}
            >
              <ChevronLeft className="h-4 w-4" aria-hidden />
              {t('setup.cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!canStart}
              onClick={() => void handleStart()}
            >
              {isStarting ? t('setup.starting') : t('setup.start')}
            </Button>
          </div>
        }
        testId="meeting-records-setup"
      >
        <div className="min-h-0 flex-1 overflow-y-auto pr-1 scrollbar-hover">
          <div className="grid gap-3 pb-3 xl:grid-cols-2 xl:items-start">
            <MeetingSection
              title={t('setup.basicInfo')}
              description={t('setup.recordOnlyDescription')}
              className="p-4 xl:col-start-1 xl:row-start-1"
            >
              <div className="grid gap-3 lg:grid-cols-2">
                <label className="space-y-1.5 text-body text-foreground">
                  <span className="font-medium">{t('setup.recordTitle')}</span>
                  <Input
                    value={title}
                    onChange={(event) => setTitle(event.target.value)}
                    placeholder={t('setup.titlePlaceholder')}
                  />
                </label>
                <label className="space-y-1.5 text-body text-foreground">
                  <span className="font-medium">
                    {t('setup.relatedProject')}
                  </span>
                  <Select value={projectId} onValueChange={setProjectId}>
                    <SelectTrigger aria-label={t('setup.relatedProject')}>
                      <SelectValue
                        placeholder={
                          projectsLoading
                            ? t('setup.projectLoading')
                            : t('setup.projectPlaceholder')
                        }
                      />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_PROJECT_VALUE}>
                        {t('setup.noProject')}
                      </SelectItem>
                      {projects.map((project) => (
                        <SelectItem key={project.id} value={project.id}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </label>
                <label className="space-y-1.5 text-body text-foreground lg:col-span-2">
                  <span className="font-medium">{t('setup.brief')}</span>
                  <Textarea
                    value={brief}
                    onChange={(event) => setBrief(event.target.value)}
                    placeholder={t('setup.briefPlaceholder')}
                    className="min-h-16 resize-y"
                  />
                </label>
              </div>
            </MeetingSection>

            <MeetingSection
              title={t('setup.readiness')}
              description={t('setup.readinessDescription')}
              className="p-4 xl:col-start-2 xl:row-start-1"
            >
              <div className="overflow-hidden rounded-[12px] border border-foreground/[0.07] bg-background divide-y divide-foreground/[0.06] dark:border-foreground/[0.09] dark:divide-foreground/[0.08]">
                <div className="grid gap-4 px-4 py-3 sm:grid-cols-[minmax(130px,1fr)_auto] sm:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-foreground/[0.04] text-muted-foreground dark:bg-foreground/[0.06]">
                      <Mic2 className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-body font-medium text-foreground">
                          {t('common.microphone')}
                        </p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-caption ${readinessBadgeClass(readiness.microphone)}`}
                        >
                          {readinessValue(readiness.microphone)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-caption text-muted-foreground">
                        {readiness.microphoneDetail ||
                          selectedMicrophone?.label ||
                          t('setup.defaultInput')}
                      </p>
                    </div>
                  </div>
                  <div className="flex min-w-0 items-center gap-2 sm:justify-self-end">
                    <Select
                      value={microphoneDeviceId}
                      onValueChange={(value) => {
                        const nextDevice = readiness.microphones.find(
                          (device) => device.deviceId === value,
                        );
                        setMicrophoneDeviceId(value);
                        setMicrophoneTestState('idle');
                        setMicrophoneLevels([]);
                        setMicrophoneTestRms(0);
                        resetMicrophone(nextDevice?.label ?? '');
                      }}
                    >
                      <SelectTrigger
                        className="h-9 w-[190px] max-w-[38vw] text-body [&>span]:truncate [&>span]:text-left"
                        aria-label={t('setup.microphoneDevice')}
                      >
                        <SelectValue placeholder={t('setup.systemDefault')} />
                      </SelectTrigger>
                      <SelectContent>
                        {readiness.microphones.length === 0 ? (
                          <SelectItem value="default">
                            {t('setup.systemDefault')}
                          </SelectItem>
                        ) : (
                          readiness.microphones.map((device) => (
                            <SelectItem
                              key={device.deviceId}
                              value={device.deviceId}
                            >
                              {device.label}
                            </SelectItem>
                          ))
                        )}
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="h-9 shrink-0 px-3"
                      onClick={() => void handleMicrophoneTest()}
                      disabled={microphoneTestState === 'listening'}
                    >
                      {t('setup.micTest')}
                    </Button>
                  </div>
                </div>

                <div className="grid gap-4 px-4 py-3 sm:grid-cols-[minmax(130px,1fr)_auto] sm:items-center">
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[10px] bg-foreground/[0.04] text-muted-foreground dark:bg-foreground/[0.06]">
                      <Volume2 className="h-4 w-4" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className="text-body font-medium text-foreground">
                          {t('common.systemAudio')}
                        </p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-caption ${readinessBadgeClass(readiness.systemAudio)}`}
                        >
                          {readinessValue(readiness.systemAudio)}
                        </span>
                      </div>
                      <p className="mt-0.5 truncate text-caption text-muted-foreground">
                        {readiness.systemAudioDetail ||
                          t('setup.waitingAuthorization')}
                      </p>
                    </div>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-9 shrink-0 px-3 sm:justify-self-end"
                    onClick={() => void checkSystemAudio()}
                    disabled={readiness.systemAudio === 'checking'}
                  >
                    {t('setup.checkSystemAudio')}
                  </Button>
                </div>

                <div className="grid gap-3 px-4 py-3 sm:grid-cols-2">
                  <div className="flex items-center gap-3">
                    <HardDrive
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <div className="min-w-0">
                      <p className="text-caption text-muted-foreground">
                        {t('common.localStorage')}
                      </p>
                      <p className="truncate text-body font-medium text-foreground">
                        {readiness.storageDetail || t('setup.localPrivate')}
                      </p>
                    </div>
                  </div>
                  <div className="flex min-w-0 items-center gap-3 sm:justify-end">
                    <FileText
                      className="h-4 w-4 shrink-0 text-muted-foreground"
                      aria-hidden
                    />
                    <div className="min-w-0 sm:text-right">
                      <div className="flex items-center gap-2 sm:justify-end">
                        <p className="text-caption text-muted-foreground">
                          {t('common.realtimeTranscript')}
                        </p>
                        <span
                          className={`rounded-full px-2 py-0.5 text-caption ${readinessBadgeClass(readiness.realtimeTranscript)}`}
                        >
                          {transcriptionReadinessValue(
                            readiness.realtimeTranscript,
                          )}
                        </span>
                      </div>
                      <p className="truncate text-caption text-muted-foreground">
                        {readiness.realtimeTranscript === 'checking'
                          ? t('setup.transcriptionReconnecting')
                          : readiness.realtimeTranscriptDetail ||
                            t('setup.transcriptionStartsAfterRecording')}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </MeetingSection>

            <MeetingSection
              title={t('common.meetingCopilot')}
              description={t('setup.copilotDescription')}
              className="p-4 xl:col-start-2 xl:row-start-2"
            >
              <div className="flex items-center justify-between gap-4 rounded-[12px] border border-foreground/[0.06] bg-background px-4 py-2.5 dark:border-foreground/[0.08]">
                <div className="flex min-w-0 items-center gap-3">
                  <Bot
                    className="h-5 w-5 shrink-0 text-accent-text"
                    aria-hidden
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <p className="text-body font-medium text-foreground">
                        {t('setup.enableCopilot')}
                      </p>
                      <span
                        className={`rounded-full px-2 py-0.5 text-caption ${
                          copilotModelState === 'ready'
                            ? 'bg-success/10 text-success'
                            : copilotModelState === 'checking'
                              ? 'bg-foreground/[0.05] text-muted-foreground'
                              : 'bg-warning/10 text-warning-foreground'
                        }`}
                      >
                        {t(`setup.copilotModel.${copilotModelState}`)}
                      </span>
                    </div>
                    <p className="mt-0.5 text-caption text-muted-foreground">
                      {t('setup.enableCopilotDescription')}
                    </p>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  {copilotModels.length > 0 ? (
                    <Select
                      value={copilotModelId}
                      onValueChange={setCopilotModelId}
                    >
                      <SelectTrigger
                        className="h-8 w-[170px] text-caption [&>span]:truncate"
                        aria-label={t('setup.copilotModelLabel')}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {copilotModels.map((model) => (
                          <SelectItem key={model.id} value={model.id}>
                            {model.display_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : null}
                  <Switch
                    checked={copilotEnabled}
                    disabled={copilotModelState !== 'ready'}
                    onCheckedChange={(enabled) => {
                      copilotChoiceTouchedRef.current = true;
                      setCopilotEnabled(enabled);
                    }}
                    aria-label={t('setup.enableCopilot')}
                  />
                </div>
              </div>
              {copilotEnabled && copilotModelState !== 'ready' ? (
                <p className="mt-2 rounded-lg bg-warning/10 px-3 py-2 text-caption leading-5 text-warning-foreground">
                  {copilotModelState === 'checking'
                    ? t('setup.copilotModelCheckingDetail')
                    : t('setup.copilotModelMissingDetail')}
                </p>
              ) : null}
            </MeetingSection>

            <div className="rounded-[12px] border border-foreground/[0.08] bg-background p-3 xl:col-start-1 xl:row-start-2 dark:border-foreground/[0.1]">
              <label className="flex items-start gap-3 text-body text-foreground">
                <Checkbox
                  checked={consentConfirmed}
                  onCheckedChange={(checked) =>
                    setConsentConfirmed(checked === true)
                  }
                  aria-label={t('setup.consentAria')}
                />
                <span>
                  <span className="flex items-center gap-1.5 font-medium">
                    <ShieldCheck className="h-4 w-4" aria-hidden />
                    {t('setup.consentLabel')}
                  </span>
                  <span className="mt-1 block text-caption leading-5 text-muted-foreground">
                    {t('setup.consentDescription')}
                  </span>
                </span>
              </label>
            </div>

            {startError ? (
              <p
                role="alert"
                className="text-body text-destructive xl:col-span-2"
              >
                {t('setup.startFailed')}: {startError}
              </p>
            ) : null}
          </div>
        </div>
      </StandaloneModulePage>
      <MeetingMicrophoneTestDialog
        open={microphoneTestOpen}
        deviceLabel={selectedMicrophone?.label ?? t('setup.systemDefault')}
        phase={microphoneTestState}
        levels={microphoneLevels}
        maxRms={microphoneTestRms}
        onStart={() => void handleMicrophoneTest()}
        onClose={() => setMicrophoneTestOpen(false)}
        copy={{
          title: t('setup.micTestDialog.title'),
          description: t('setup.micTestDialog.description'),
          dismissLabel: t('setup.micTestDialog.done'),
          deviceLabel: t('setup.micTestDialog.device'),
          idleTitle: t('setup.micTestDialog.title'),
          idleDescription: t('setup.micTestDialog.description'),
          listeningTitle: t('setup.micTestDialog.listening'),
          speaking: t('setup.micTestDialog.speaking'),
          speakPrompt: t('setup.micTestDialog.listening'),
          heardTitle: t('setup.micTestDialog.success'),
          heardDescription: t('setup.micTestDialog.success'),
          silentTitle: t('setup.micTestDialog.silent'),
          silentDescription: t('setup.micTestDialog.quiet'),
          failedTitle: t('setup.micTestDialog.failed'),
          failedDescription: t('setup.micTestDialog.failed'),
          meterLabel: t('setup.micTestDialog.levelAria'),
          rmsLabel: t('setup.micTestDialog.rms', { rms: '' }).trim(),
          start: t('setup.micTestDialog.title'),
          retry: t('setup.micTestDialog.retry'),
          close: t('setup.micTestDialog.done'),
        }}
      />
    </>
  );
};

export default MeetingSetupView;
