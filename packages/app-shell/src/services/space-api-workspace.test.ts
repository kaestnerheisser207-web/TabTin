import { beforeEach, describe, expect, it, vi } from 'vitest'

const authenticatedRequest = vi.fn()

vi.mock('./base.js', () => ({
  authenticatedRequest: (...args: unknown[]) => authenticatedRequest(...args),
  apiBaseUrl: () => 'https://api.tabtin.test/api',
  formatApiErrorMessage: vi.fn(),
}))

import { WorkspaceApiService } from './space-api.js'

describe('WorkspaceApiService.create', () => {
  beforeEach(() => {
    authenticatedRequest.mockReset()
  })

  it('uses the Daemon installation id without inventing a Django device id', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 201,
      data: {
        success: true,
        data: { id: 'workspace-1' },
      },
    })

    await WorkspaceApiService.create({
      organization_id: 'organization-1',
      device_installation_id: 'daemon-installation-1',
      working_dir: '/srv/tabtin/project',
      name: 'Remote project',
    })

    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/context/workspaces',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        organization_id: 'organization-1',
        device_installation_id: 'daemon-installation-1',
        working_dir: '/srv/tabtin/project',
        name: 'Remote project',
      }),
    })
  })

  it('creates a Cloud Workspace without sending a local directory or device id', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 202,
      data: {
        success: true,
        data: {
          id: 'cloud-workspace-1',
          runtime_plane: 'cloud',
          cloud: { state: 'pending' },
        },
      },
    })

    await WorkspaceApiService.createCloud({
      request_key: 'request-1',
      organization_id: 'organization-1',
      name: 'Cloud Dev',
      source_type: 'git',
      git_url: 'https://github.com/org/repo.git',
    })

    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/context/workspaces/cloud',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        request_key: 'request-1',
        organization_id: 'organization-1',
        name: 'Cloud Dev',
        source_type: 'git',
        git_url: 'https://github.com/org/repo.git',
      }),
    })
  })
})

describe('WorkspaceApiService Cloud lifecycle', () => {
  beforeEach(() => authenticatedRequest.mockReset())

  it('uses explicit cloud lifecycle endpoints', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: { success: true, data: { id: 'workspace-1' } },
    })

    await WorkspaceApiService.cloudAction('workspace-1', 'disable')

    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/context/workspaces/workspace-1/cloud/disable',
      method: 'POST',
    })
  })

  it('requires the typed confirmation body for permanent delete', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: { success: true },
    })

    await WorkspaceApiService.permanentlyDeleteCloud('workspace-1', 'Cloud Dev')

    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/context/workspaces/workspace-1/cloud/permanent',
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmation: 'Cloud Dev' }),
    })
  })
})

describe('WorkspaceApiService.update', () => {
  beforeEach(() => {
    authenticatedRequest.mockReset()
  })

  it('#7248：PATCH body 携带 custom_rules / execution_limits', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          id: 'workspace-1',
          custom_rules: '用早上好开头回复',
          execution_limits: { max_iterations_per_run: 40 },
        },
      },
    })

    await expect(
      WorkspaceApiService.update('workspace-1', {
        custom_rules: '用早上好开头回复',
        execution_limits: { max_iterations_per_run: 40 },
      }),
    ).resolves.toMatchObject({
      id: 'workspace-1',
      custom_rules: '用早上好开头回复',
    })
    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/context/workspaces/workspace-1',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        custom_rules: '用早上好开头回复',
        execution_limits: { max_iterations_per_run: 40 },
      }),
    })
  })
})

describe('WorkspaceApiService.updateApprovalGrant', () => {
  beforeEach(() => {
    authenticatedRequest.mockReset()
  })

  it('writes approval_grant to the Workspace endpoint', async () => {
    authenticatedRequest.mockResolvedValue({
      status: 200,
      data: {
        success: true,
        data: {
          id: 'workspace-1',
          approval_grant: 'auto',
          approval_memo_generation: 2,
        },
      },
    })

    await expect(
      WorkspaceApiService.updateApprovalGrant('workspace-1', 'auto'),
    ).resolves.toMatchObject({
      id: 'workspace-1',
      approval_grant: 'auto',
    })
    expect(authenticatedRequest).toHaveBeenCalledWith({
      url: 'https://api.tabtin.test/api/context/workspaces/workspace-1/approval-grant',
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ approval_grant: 'auto' }),
    })
  })
})
