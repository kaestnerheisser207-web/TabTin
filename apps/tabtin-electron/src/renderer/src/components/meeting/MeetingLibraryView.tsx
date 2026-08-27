import React from 'react';
import { Clock3, Mic2, Search, SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button, EmptyState, Input } from '@components/ui';
import { StandaloneModulePage } from '@components/context-space/StandaloneModulePage';
import {
  CONTEXT_PAGE_SEARCH_WIDTH,
  CONTEXT_PAGE_TOOLBAR_BTN,
  CONTEXT_PAGE_TOOLBAR_SEARCH_INPUT,
} from '@components/context-space/constants';
import { MeetingPageIcon } from './meetingUi';
import { useAuthStore } from '@stores/useAuthStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';
import type { MeetingLocalArchive } from '@shared/meeting-recording-contract';

function formatDuration(durationMs: number): string {
  const totalSeconds = Math.floor(durationMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export const MeetingLibraryView: React.FC<{
  activeSessionId?: string | null;
  onStart: () => void;
  onOpen: (sessionId: string) => void;
}> = ({ activeSessionId = null, onStart, onOpen }) => {
  const { t } = useTranslation('meeting');
  const [search, setSearch] = React.useState('');
  const [archives, setArchives] = React.useState<MeetingLocalArchive[]>([]);
  const [loading, setLoading] = React.useState(true);
  const organizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  );
  const userId = useAuthStore((state) => state.user?.id ?? null);

  React.useEffect(() => {
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge || !organizationId || !userId) {
      setArchives([]);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void bridge
      .listArchives({
        organizationId: String(organizationId),
        userId: String(userId),
      })
      .then((items) => {
        if (!cancelled) setArchives(items);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [organizationId, userId]);

  const normalizedSearch = search.trim().toLowerCase();
  const visibleArchives = archives.filter((archive) =>
    normalizedSearch
      ? archive.manifest.title.toLowerCase().includes(normalizedSearch)
      : true,
  );

  return (
    <StandaloneModulePage
      icon={<MeetingPageIcon />}
      title={t('common.title')}
      titleAs="h1"
      description={t('library.description')}
      actions={
        <Button type="button" size="sm" className="gap-2" onClick={onStart}>
          <Mic2 className="h-4 w-4" aria-hidden />
          {activeSessionId ? t('library.continue') : t('library.start')}
        </Button>
      }
      testId="meeting-records-library"
    >
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 pb-4">
          <div className={`relative ${CONTEXT_PAGE_SEARCH_WIDTH}`}>
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground/60"
              aria-hidden
            />
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className={CONTEXT_PAGE_TOOLBAR_SEARCH_INPUT}
              placeholder={t('library.searchPlaceholder')}
              aria-label={t('library.searchLabel')}
            />
          </div>
          <Button
            type="button"
            variant="outline"
            className={CONTEXT_PAGE_TOOLBAR_BTN}
            disabled
          >
            <SlidersHorizontal className="h-3.5 w-3.5" aria-hidden />
            {t('library.filter')}
          </Button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto rounded-[12px] bg-foreground/[0.025] dark:bg-foreground/[0.035]">
          {loading || visibleArchives.length === 0 ? (
            <EmptyState
              icon="list"
              title={
                loading
                  ? t('library.loading')
                  : search.trim()
                    ? t('library.noMatch')
                    : t('library.emptyTitle')
              }
              description={
                search.trim()
                  ? t('library.tryDifferent')
                  : t('library.emptyDescription')
              }
              action={
                !loading && !search.trim() ? (
                  <Button type="button" size="sm" onClick={onStart}>
                    {activeSessionId
                      ? t('library.continue')
                      : t('library.start')}
                  </Button>
                ) : undefined
              }
              size="lg"
            />
          ) : (
            <div className="space-y-1 p-2">
              {visibleArchives.map(({ manifest }) => (
                <Button
                  key={manifest.sessionId}
                  type="button"
                  variant="ghost"
                  className="h-auto w-full justify-start rounded-interactive px-3 py-3 text-left"
                  onClick={() => onOpen(manifest.sessionId)}
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate text-body font-medium text-foreground">
                        {manifest.title}
                      </span>
                      <span className="shrink-0 text-caption text-muted-foreground">
                        {t(`live.trackStatus.${manifest.lifecycleStatus}`)}
                      </span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-3 text-caption text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <Clock3 className="h-3.5 w-3.5" aria-hidden />
                        {formatDuration(manifest.durationMs)}
                      </span>
                      <span>
                        {new Date(manifest.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>
                </Button>
              ))}
            </div>
          )}
        </div>
      </div>
    </StandaloneModulePage>
  );
};

export default MeetingLibraryView;
