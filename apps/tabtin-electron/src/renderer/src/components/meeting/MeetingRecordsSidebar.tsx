import React from 'react';
import {
  CircleDot,
  LibraryBig,
  Plus,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { SidebarMenuItem } from '@components/layout/SidebarMenuItem';
import { cn } from '@utils/cn';
import {
  SIDEBAR_ICON_ACTIVE,
  SIDEBAR_ICON_INACTIVE,
  SIDEBAR_LIST_ICON,
  SIDEBAR_LIST_ICON_SIZE,
  SIDEBAR_LIST_ICON_SLOT,
  SIDEBAR_MENU_ICON_STROKE,
  SIDEBAR_ROW_LIST,
} from '@components/layout/sidebarUi';
import {
  resolveContinuableMeetingSessionId,
  useMeetingViewNavigation,
} from './meetingViewNavigation';
import { useAuthStore } from '@stores/useAuthStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';

const MeetingSidebarItem: React.FC<{
  active: boolean;
  Icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
}> = ({ active, Icon, label, onClick, disabled = false }) => (
  <SidebarMenuItem
    active={active}
    fullWidth
    aria-current={active ? 'page' : undefined}
    leading={
      <span
        className={cn(
          SIDEBAR_LIST_ICON_SLOT,
          'transition-colors',
          active ? SIDEBAR_ICON_ACTIVE : SIDEBAR_ICON_INACTIVE,
        )}
      >
        <Icon
          className={SIDEBAR_LIST_ICON}
          size={SIDEBAR_LIST_ICON_SIZE}
          strokeWidth={SIDEBAR_MENU_ICON_STROKE}
          aria-hidden
        />
      </span>
    }
    label={label}
    onClick={onClick}
    disabled={disabled}
    aria-disabled={disabled}
  />
);

export const MeetingRecordsSidebar: React.FC = () => {
  const { t } = useTranslation('meeting');
  const view = useMeetingViewNavigation((state) => state.view);
  const openLibrary = useMeetingViewNavigation((state) => state.openLibrary);
  const openSetup = useMeetingViewNavigation((state) => state.openSetup);
  const openSession = useMeetingViewNavigation((state) => state.openSession);
  const organizationId = useOrganizationStore(
    (state) => state.selectedOrganization?.id ?? null,
  );
  const userId = useAuthStore((state) => state.user?.id ?? null);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(
    null,
  );

  React.useEffect(() => {
    const bridge = window.tabtin?.meetingRecording;
    if (!bridge || !organizationId || !userId) return;
    let cancelled = false;
    void bridge
      .getStatus()
      .then((status) => {
        if (!cancelled) {
          setActiveSessionId(resolveContinuableMeetingSessionId(status));
        }
      })
      .catch(() => undefined);
    const unsubscribe = bridge.onStatusChanged((status) => {
      if (cancelled) return;
      setActiveSessionId(resolveContinuableMeetingSessionId(status));
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [organizationId, userId]);

  const libraryActive = view.kind === 'library';
  const setupActive = view.kind === 'setup' && !activeSessionId;
  const liveActive =
    view.kind === 'session' && view.sessionId === activeSessionId;

  return (
    <div className="flex h-full min-h-0 flex-col bg-transparent">
      <nav
        className={cn(SIDEBAR_ROW_LIST, 'pb-1')}
        aria-label={t('common.title')}
      >
        <MeetingSidebarItem
          active={libraryActive}
          Icon={LibraryBig}
          label={t('sidebar.all')}
          onClick={openLibrary}
        />
        <MeetingSidebarItem
          active={setupActive}
          Icon={Plus}
          label={t('sidebar.setup')}
          onClick={openSetup}
          disabled={Boolean(activeSessionId)}
        />
        {activeSessionId ? (
          <MeetingSidebarItem
            active={liveActive}
            Icon={CircleDot}
            label={t('sidebar.live')}
            onClick={() => openSession(activeSessionId)}
          />
        ) : null}
      </nav>
    </div>
  );
};

export default MeetingRecordsSidebar;
