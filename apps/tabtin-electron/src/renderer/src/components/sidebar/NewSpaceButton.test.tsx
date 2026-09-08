import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  createSpace: vi.fn(),
  dshStatus: vi.fn(),
  installDsh: vi.fn(),
  createCloudSpace: vi.fn(),
  updateAgent: vi.fn(),
  loadAgent: vi.fn(),
  refreshSpace: vi.fn(),
  listMcpConnections: vi.fn(),
  openCreatedWorkspaceAsNewTask: vi.fn(),
  dialogState: {
    isOpen: true,
    mode: 'create',
    openCreate: vi.fn(),
    close: vi.fn(),
    createOptions: null as { onCreated?: (spaceId: string) => void } | null,
  },
}))

const spaceState = {
  spaces: [],
  agentCache: {},
  selectedAgent: {
    id: 'agent-1',
    name: 'Cloud Agent',
    organization_id: 'organization-1',
    agent_config: { harness: { type: 'builtin' } },
  },
  error: null as string | null,
  createSpace: mocks.createSpace,
  createCloudSpace: mocks.createCloudSpace,
  updateSpace: vi.fn(),
  updateAgent: mocks.updateAgent,
  loadAgent: mocks.loadAgent,
  refreshSpace: mocks.refreshSpace,
}

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      options?.defaultValue ?? key,
  }),
}))

vi.mock('@components/ui', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? <div>{children}</div> : null,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogScrollBody: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => (
    <textarea {...props} />
  ),
  Button: ({ children, onClick, disabled, type }: React.PropsWithChildren<{
    onClick?: React.MouseEventHandler<HTMLButtonElement>
    disabled?: boolean
    type?: 'button' | 'submit'
  }>) => (
    <button type={type ?? 'button'} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
  toast: vi.fn(),
  Tooltip: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipContent: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipProvider: ({ children }: React.PropsWithChildren) => <>{children}</>,
  TooltipTrigger: ({ children }: React.PropsWithChildren) => <>{children}</>,
}))

vi.mock('@stores/useSpaceStore', () => {
  const useSpaceStore = (selector: (state: typeof spaceState) => unknown) =>
    selector(spaceState)
  useSpaceStore.getState = () => spaceState
  return { useSpaceStore }
})

const organizationState = {
  selectedOrganization: {
    id: 'organization-1', name: 'My Organization',
    settings: { cloud_agent_enabled: true } as { cloud_agent_enabled?: boolean },
  },
  organizations: [],
}

vi.mock('@stores/useOrganizationStore', () => {
  const useOrganizationStore = (selector: (state: typeof organizationState) => unknown) => selector(organizationState)
  useOrganizationStore.getState = () => organizationState
  return { useOrganizationStore }
})

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: {
    getState: () => ({ currentDevice: { id: 'local-device-id' } }),
  },
}))

vi.mock('@stores/useSpaceAgentDialogStore', () => {
  const useSpaceAgentDialogStore = (selector: (value: typeof mocks.dialogState) => unknown) =>
    selector(mocks.dialogState)
  useSpaceAgentDialogStore.getState = () => mocks.dialogState
  return { useSpaceAgentDialogStore }
})

vi.mock('@components/workspace/notifyWorkspacePaths', () => ({
  notifyWorkspacePathsForSpace: vi.fn(),
}))

vi.mock('@components/context-space/ContextDialogHeader', () => ({
  ContextDialogHeader: ({ title }: { title: React.ReactNode }) => <h1>{title}</h1>,
}))

vi.mock('@utils/canonicalPath', () => ({ resolveRealPath: vi.fn() }))
vi.mock('@/services/newTaskDraftNavigation', () => ({
  openCreatedWorkspaceAsNewTask: mocks.openCreatedWorkspaceAsNewTask,
}))
vi.mock('@components/space-settings/profile/workingDirConflict', () => ({
  findLocalWorkingDirConflict: vi.fn(),
  getSelectedWorkingDirCreateBlocker: vi.fn(() => ({ blocked: false })),
  handleWorkingDirConflictResponse: vi.fn(),
  isWorkingDirConflictError: vi.fn(() => false),
}))
vi.mock('./generateRandomWorkspaceName', () => ({
  generateRandomWorkspaceName: () => 'Generated Workspace',
}))
vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), error: vi.fn() }),
}))

import { CreateSpaceDialog } from './NewSpaceButton'

describe('CreateSpaceDialog 远程执行设备 Workspace', () => {
  beforeEach(() => {
    organizationState.selectedOrganization.settings = { cloud_agent_enabled: true }
    spaceState.error = null
    mocks.dshStatus.mockReset().mockResolvedValue({ installed: true, installing: false, version: "0.1.1-rc.2", canInstall: true, error: null, detail: null })
    mocks.installDsh.mockReset()
    mocks.createSpace.mockReset().mockResolvedValue({ id: 'workspace-1' })
    mocks.createCloudSpace.mockReset().mockResolvedValue({
      id: 'cloud-workspace-1',
      runtime_plane: 'cloud',
      cloud: { state: 'pending' },
    })
    mocks.refreshSpace.mockReset().mockResolvedValue(undefined)
    mocks.updateAgent.mockReset().mockResolvedValue(true)
    mocks.loadAgent.mockReset().mockResolvedValue(spaceState.selectedAgent)
    mocks.openCreatedWorkspaceAsNewTask.mockReset().mockResolvedValue(undefined)
    mocks.listMcpConnections.mockReset().mockResolvedValue([])
    Object.defineProperty(window, 'muse', {
      configurable: true,
      value: {
        fileSystem: { ensureDefaultAgentDir: vi.fn().mockResolvedValue({ success: true, path: "/tmp/muse-local-test" }) },
        localDsh: { getStatus: mocks.dshStatus, install: mocks.installDsh },
        localMcp: {
          listConnections: mocks.listMcpConnections,
        },
      },
    })
    mocks.dialogState.createOptions = null
  })

  it('rejects paths that normalize to the remote root', () => {
    render(
      <CreateSpaceDialog
        open
        onOpenChange={vi.fn()}
        daemonTarget={{ installationId: 'electron-installation-1', deviceName: 'Office Mac' }}
      />,
    )

    fireEvent.change(document.querySelector('#daemon-working-dir')!, {
      target: { value: '/tmp/..' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))

    expect(screen.getByRole('alert').textContent).toBe('请输入执行设备上的非根绝对路径')
    expect(mocks.createSpace).not.toHaveBeenCalled()
  })

  it('用选中执行设备的 installation id 创建，不混入当前本机 device id', async () => {
    render(
      <CreateSpaceDialog
        open
        onOpenChange={vi.fn()}
        daemonTarget={{ installationId: 'electron-installation-1', deviceName: 'Office Mac' }}
      />,
    )

    fireEvent.change(document.querySelector('#daemon-working-dir')!, {
      target: { value: '/srv/tabtin/project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))

    await waitFor(() => {
      expect(mocks.createSpace).toHaveBeenCalledWith(expect.objectContaining({
        organization_id: 'organization-1',
        device_id: undefined,
        device_installation_id: 'electron-installation-1',
        working_dir: '/srv/tabtin/project',
      }))
    })
    expect(mocks.createSpace.mock.calls[0][0].device_id).toBeUndefined()
  })

  it('调用方接管创建结果时不自动打开新任务', async () => {
    const onCreated = vi.fn()
    mocks.dialogState.createOptions = { onCreated }

    render(
      <CreateSpaceDialog
        open
        onOpenChange={vi.fn()}
        daemonTarget={{ installationId: 'electron-installation-1', deviceName: 'Office Mac' }}
      />,
    )

    fireEvent.change(document.querySelector('#daemon-working-dir')!, {
      target: { value: '/srv/tabtin/project' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))

    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith('workspace-1')
    })
    expect(mocks.openCreatedWorkspaceAsNewTask).not.toHaveBeenCalled()
  })

  it('云端托管创建不要求本机目录或 device id', async () => {
    render(<CreateSpaceDialog open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /云端托管/ }))
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))

    await waitFor(() => {
      expect(mocks.createCloudSpace).toHaveBeenCalledWith(expect.objectContaining({
        organization_id: 'organization-1',
        name: 'Generated Workspace',
        source_type: 'empty',
        working_dir_type: 'code',
      }))
    })
    const payload = mocks.createCloudSpace.mock.calls[0][0]
    expect(payload).not.toHaveProperty('device_id')
    expect(payload).not.toHaveProperty('working_dir')
    expect(mocks.createSpace).not.toHaveBeenCalled()
    expect(screen.getByTestId('cloud-harness-selector')).toBeTruthy()
    expect(mocks.updateAgent).toHaveBeenCalledWith(
      'agent-1',
      expect.objectContaining({
        agent_config: expect.objectContaining({
          harness: { type: 'dsh' },
        }),
      }),
    )
  })

  it('GitHub 来源在创建前显示个人授权入口', async () => {
    render(<CreateSpaceDialog open onOpenChange={vi.fn()} />)

    fireEvent.click(screen.getByRole('button', { name: /云端托管/ }))
    fireEvent.click(screen.getByRole('button', { name: 'Git' }))
    fireEvent.change(screen.getByPlaceholderText('https://github.com/org/repo.git'), {
      target: { value: 'https://github.com/flowdos/flow.git' },
    })

    expect(await screen.findByRole('button', { name: '授权 GitHub' })).toBeTruthy()
    expect(mocks.createCloudSpace).not.toHaveBeenCalled()
  })
  it('未开通时禁用云端选项并显示开通说明', () => {
    organizationState.selectedOrganization.settings = {}
    render(<CreateSpaceDialog open onOpenChange={vi.fn()} />)
    const cloud = screen.getByRole('button', { name: /云端托管/ }) as HTMLButtonElement
    expect(cloud.disabled).toBe(true)
    fireEvent.click(cloud)
    expect(screen.queryByTestId('cloud-harness-selector')).toBeNull()
    expect(screen.getByText(/云端托管尚未开通/)).toBeTruthy()
    expect(mocks.createCloudSpace).not.toHaveBeenCalled()
  })

  it('组织配置刷新后已开通的云端选项可用', () => {
    organizationState.selectedOrganization.settings = { cloud_agent_enabled: false }
    const { rerender } = render(<CreateSpaceDialog open onOpenChange={vi.fn()} />)
    organizationState.selectedOrganization.settings = { cloud_agent_enabled: true }
    rerender(<CreateSpaceDialog open onOpenChange={vi.fn()} />)
    expect((screen.getByRole('button', { name: /云端托管/ }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: /云端托管/ }))
    expect(screen.getByTestId('cloud-harness-selector')).toBeTruthy()
  })

  it('选中云端后权限被撤销时提交也不得修改 Agent 或调用创建接口', () => {
    render(<CreateSpaceDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /云端托管/ }))
    organizationState.selectedOrganization.settings = { cloud_agent_enabled: false }
    fireEvent.submit(document.querySelector('form')!)
    expect(mocks.updateAgent).not.toHaveBeenCalled()
    expect(mocks.createCloudSpace).not.toHaveBeenCalled()
    expect(screen.getAllByText(/云端托管尚未开通/).length).toBeGreaterThan(0)
  })

  it('创建被后端拒绝时展示具体原因', async () => {
    mocks.createCloudSpace.mockImplementation(async () => {
      spaceState.error = '当前组织尚未启用 Cloud Agent'
      return null
    })
    render(<CreateSpaceDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: /云端托管/ }))
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))
    expect(await screen.findByText('当前组织尚未启用 Cloud Agent')).toBeTruthy()
    expect(screen.queryByText('创建失败，请重试')).toBeNull()
  })

  it('本地也可选择已安装的DSH并保留本机执行绑定', async () => {
    render(<CreateSpaceDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek DSH' }))
    await waitFor(() => expect((screen.getByRole('button', { name: 'create.actions.create' }) as HTMLButtonElement).disabled).toBe(false))
    fireEvent.click(screen.getByRole('button', { name: 'create.actions.create' }))
    await waitFor(() => expect(mocks.createSpace).toHaveBeenCalled())
    expect(mocks.updateAgent).toHaveBeenCalledWith('agent-1', expect.objectContaining({ agent_config: { harness: { type: 'dsh' } } }))
    expect(mocks.createSpace.mock.calls[0][0]).toMatchObject({ device_id: 'local-device-id', working_dir: '/tmp/muse-local-test' })
    expect(mocks.createCloudSpace).not.toHaveBeenCalled()
    expect(mocks.installDsh).not.toHaveBeenCalled()
  })

  it('本地DSH缺失时展示安装引导并阻止创建', async () => {
    mocks.dshStatus.mockResolvedValue({ installed: false, installing: false, canInstall: true, error: null, detail: null })
    render(<CreateSpaceDialog open onOpenChange={vi.fn()} />)
    fireEvent.click(screen.getByRole('button', { name: 'DeepSeek DSH' }))
    expect(await screen.findByRole('button', { name: 'harness.local.install' })).toBeTruthy()
    expect((screen.getByRole('button', { name: 'create.actions.create' }) as HTMLButtonElement).disabled).toBe(true)
    expect(mocks.createSpace).not.toHaveBeenCalled()
    expect(mocks.installDsh).not.toHaveBeenCalled()
  })

})
