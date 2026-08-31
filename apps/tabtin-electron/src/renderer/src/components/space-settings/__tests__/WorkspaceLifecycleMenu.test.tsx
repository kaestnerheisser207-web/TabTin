import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const canManageSpaceLifecycleMock = vi.hoisted(() => vi.fn(() => true))
const useSpaceDeleteGuardMock = vi.hoisted(() =>
  vi.fn(() => ({
    canDelete: true,
    isResolving: false,
    isRemoteViewer: false,
    blockReason: null,
    controlDeviceName: null,
  })),
)

vi.mock('@/hooks/useCanManageSpaceLifecycle', () => ({
  canManageSpaceLifecycle: canManageSpaceLifecycleMock,
}))

vi.mock('../hooks/useSpaceDeleteGuard', () => ({
  useSpaceDeleteGuard: useSpaceDeleteGuardMock,
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        selectedAgent: null,
        deleteSpace: vi.fn(),
        archiveSpace: vi.fn(),
        loadSpaces: vi.fn(),
        watchCloudSpace: vi.fn(),
        isLoading: false,
        error: null,
      }),
    {
      getState: () => ({ error: null }),
    },
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({
      currentUserRole: 'editor',
      selectedOrganization: { id: 'org-1', owner_id: 'user-1' },
    }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (s: Record<string, unknown>) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@components/settings/SettingsNameConfirmDialog', () => ({
  SettingsNameConfirmDialog: () => null,
}))

vi.mock('@components/context-space/dirtyExitConfirm/spaceDeleteGuard', () => ({
  confirmDirtyBeforeSpaceDelete: vi.fn(async () => true),
}))

vi.mock('@/utils/featureFlags', () => ({
  SPACE_TRASH_UI_ENABLED: false,
  SPACE_ARCHIVE_UI_ENABLED: false,
}))

import { WorkspaceLifecycleMenu } from '../WorkspaceLifecycleMenu'
import type { Space } from '@tabtin/app-shell'

const space = {
  id: 'ws-1',
  name: 'workspace-abc123',
  organization_id: 'org-1',
  type: 'workspace',
  workspace_record: true,
  status: 'active',
  table_count: 0,
  order: 0,
  is_archived: false,
  is_default: false,
  created_at: '',
  updated_at: '',
} as Space

describe('WorkspaceLifecycleMenu', () => {
  beforeEach(() => {
    canManageSpaceLifecycleMock.mockReturnValue(true)
    useSpaceDeleteGuardMock.mockReturnValue({
      canDelete: true,
      isResolving: false,
      isRemoteViewer: false,
      blockReason: null,
      controlDeviceName: null,
    })
  })

  it('有权限时渲染页底危险操作区与删除按钮', () => {
    render(<WorkspaceLifecycleMenu space={space} />)
    expect(screen.getByTestId('workspace-lifecycle-danger')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'actions.delete' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'actions.workspaceMenuLabel' })).toBeNull()
  })

  it('无权限时不渲染菜单', () => {
    canManageSpaceLifecycleMock.mockReturnValue(false)
    const { container } = render(<WorkspaceLifecycleMenu space={space} />)
    expect(container.childElementCount).toBe(0)
  })

  it('云端 Workspace 显示重启、停用和云端唯一权威提示', () => {
    render(
      <WorkspaceLifecycleMenu
        space={{
          ...space,
          runtime_plane: 'cloud',
          cloud: {
            allocation_id: 'allocation-1',
            state: 'ready',
            generation: 1,
            source_type: 'empty',
            runtime_version: 'test',
            protocol_version: '1',
          },
        }}
      />,
    )

    expect(screen.getByTestId('cloud-workspace-lifecycle')).toBeTruthy()
    expect(screen.getByRole('button', { name: '重启' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '停用' })).toBeTruthy()
    expect(screen.getByText(/不同步到本机/)).toBeTruthy()
  })

  it('私有 Git 初始化失败时提供个人 GitHub 连接重试入口', () => {
    render(
      <WorkspaceLifecycleMenu
        space={{
          ...space,
          runtime_plane: 'cloud',
          cloud: {
            allocation_id: 'allocation-1',
            state: 'error',
            generation: 1,
            source_type: 'git',
            runtime_version: 'test',
            protocol_version: '1',
            last_error: 'git_source_unavailable',
          },
        }}
      />,
    )

    expect(screen.getByRole('button', {
      name: '使用我的 GitHub 连接重试',
    })).toBeTruthy()
  })
})
