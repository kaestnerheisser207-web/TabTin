import { useTranslation } from 'react-i18next';

import { useAuthStore } from '@stores/useAuthStore';
import { useOrganizationStore } from '@stores/useOrganizationStore';

/** 当前用户展示名与组织标签的统一推导，供所有身份展示复用。 */
export function useIdentityLabels(): {
  user: ReturnType<typeof useAuthStore.getState>['user'];
  displayName: string;
  organizationLabel: string;
} {
  const { t } = useTranslation(['sidebar', 'settings']);
  const user = useAuthStore((state) => state.user);
  const selectedOrganization = useOrganizationStore(
    (state) => state.selectedOrganization,
  );
  const displayName = user?.nickname || user?.username || '';
  const organizationLabel = selectedOrganization
    ? selectedOrganization.type === 'personal'
      ? t('teamSwitcher.personalLabel', {
          ns: 'settings',
          defaultValue: '个人账号',
        })
      : selectedOrganization.name
    : t('teamSwitcher.empty', {
        ns: 'settings',
        defaultValue: '暂无组织',
      });
  return { user, displayName, organizationLabel };
}
