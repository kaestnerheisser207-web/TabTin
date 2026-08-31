import type { TFunction } from 'i18next'
import type { ExecutionDeviceStatus } from './terminalOverviewModel'
import { isCurrentDeviceControl, isDeviceReachable } from '@/services/deviceControlMatch'
import type { DeviceControlView } from '@/services/deviceControlMatch'
import {
  resolveCurrentMemberProjectCompanionWorkspace,
  type ProjectExecutionTargetLike,
} from '@/utils/projectExecutionTarget'

export type DeviceLike = DeviceControlView

export type SpaceWithDeviceBinding = {
  control_device_id?: string | null
  bound_device_id?: string | null
  execution_agent_id?: string | null
  agent_id?: string | null
  owner_execution_device_status?: string | null
  runtime_plane?: string | null
  cloud?: {
    state?: string | null
    last_error?: string | null
  } | null
}

/** Cloud Allocation 生命周期比逻辑 Device 在线态更权威。 */
export function resolveCloudRuntimeStatus(
  space: SpaceWithDeviceBinding | null | undefined,
  t: TFunction,
): ExecutionDeviceStatus | null {
  if (space?.runtime_plane !== 'cloud') return null
  const state = space.cloud?.state
  if (state === 'pending' || state === 'provisioning') {
    return {
      label: t('desktop.cloudRuntime.initializing', { defaultValue: '初始化中' }),
      title: t('desktop.cloudRuntime.initializingTitle', { defaultValue: '云端工作空间正在准备，请稍候' }),
      tone: 'remote',
    }
  }
  if (state === 'error') {
    const errorCode = space.cloud?.last_error?.split(':', 1)[0]?.trim()
    return {
      label: t('desktop.cloudRuntime.initializationFailed', { defaultValue: '初始化失败' }),
      title: errorCode === 'git_source_unavailable'
        ? t('desktop.cloudRuntime.gitCredentialRequired', { defaultValue: '私有仓库缺少访问凭证，无法初始化云端工作空间' })
        : errorCode === 'git_credential_rejected'
          ? t('desktop.cloudRuntime.gitCredentialRejected', { defaultValue: '当前 GitHub 连接无权访问该仓库，请检查仓库权限后重试' })
          : t('desktop.cloudRuntime.initializationFailedTitle', { defaultValue: '云端工作空间初始化失败，请在设置中检查后重试' }),
      tone: 'offline',
    }
  }
  if (state === 'disabled') {
    return {
      label: t('desktop.cloudRuntime.disabled', { defaultValue: '已停用' }),
      title: t('desktop.cloudRuntime.disabledTitle', { defaultValue: '云端运行环境已停用，可在工作空间设置中恢复' }),
      tone: 'offline',
    }
  }
  if (state === 'deleting' || state === 'deleted') {
    return {
      label: t('desktop.cloudRuntime.deleting', { defaultValue: '删除中' }),
      title: t('desktop.cloudRuntime.deletingTitle', { defaultValue: '云端工作空间正在删除' }),
      tone: 'offline',
    }
  }
  return null
}

export type AgentWithDeviceBinding = {
  control_device_id?: string | null
  bound_device_id?: string | null
}

export function resolveSpaceControlDeviceId(
  space: SpaceWithDeviceBinding | null | undefined,
  agent: AgentWithDeviceBinding | null | undefined,
): string | null {
  return space?.control_device_id
    ?? space?.bound_device_id
    ?? agent?.control_device_id
    ?? agent?.bound_device_id
    ?? null
}

/**
 * 计算执行设备徽标（未绑定 / 离线 / 远程；本机执行返回 null = 无徽标）。
 *
 * 桌面侧栏、对话侧栏 Space 分组、跨 Agent 终端总览复用同一口径。
 */
export function computeExecutionDeviceStatus(
  controlDeviceId: string | null,
  currentDevice: DeviceControlView | null,
  devices: DeviceLike[],
  t: TFunction,
  authoritativeStatus?: string | null,
): ExecutionDeviceStatus | null {
  if (!controlDeviceId) {
    return {
      label: t('desktop.deviceStatus.unbound', { defaultValue: '未绑定' }),
      title: t('desktop.deviceStatus.unboundTitle', { defaultValue: 'Agent 还没有绑定执行设备' }),
      tone: 'unbound',
    }
  }
  const currentDeviceId = currentDevice?.id ?? null
  if (!currentDeviceId) return null
  if (isCurrentDeviceControl(controlDeviceId, currentDevice, devices)) return null
  const controlDevice = devices.find(d => d.id === controlDeviceId)
  const deviceName = controlDevice?.name || t('desktop.deviceStatus.remoteDevice', { defaultValue: '执行设备' })
  const effectiveStatus = controlDevice?.status ?? authoritativeStatus
  // WS 丢事件时设备列表可能暂缺：优先使用 Workspace 轮询的权威状态；两边都缺才按离线。
  if ((!controlDevice && !effectiveStatus) || (effectiveStatus && !isDeviceReachable(effectiveStatus))) {
    return {
      label: t('desktop.deviceStatus.remote', { defaultValue: '远程' }),
      secondaryLabel: t('desktop.deviceStatus.offline', { defaultValue: '离线' }),
      title: t('desktop.deviceStatus.offlineTitle', {
        device: deviceName,
        defaultValue: 'Agent 的执行设备「{{device}}」当前不在线',
      }),
      tone: 'remote',
      secondaryTone: 'offline',
    }
  }
  return {
    label: t('desktop.deviceStatus.remote', { defaultValue: '远程' }),
    title: t('desktop.deviceStatus.remoteTitle', {
      device: deviceName,
      defaultValue: 'Agent 在「{{device}}」上工作，需切换到该设备才能操作这个应用',
    }),
    tone: 'remote',
  }
}

export function resolveSpaceExecutionDeviceStatus(
  space: SpaceWithDeviceBinding | null | undefined,
  agent: AgentWithDeviceBinding | null | undefined,
  currentDevice: DeviceControlView | null,
  devices: DeviceLike[],
  t: TFunction,
): ExecutionDeviceStatus | null {
  const cloudRuntimeStatus = resolveCloudRuntimeStatus(space, t)
  if (cloudRuntimeStatus) return cloudRuntimeStatus
  return computeExecutionDeviceStatus(
    resolveSpaceControlDeviceId(space, agent),
    currentDevice,
    devices,
    t,
    space?.owner_execution_device_status,
  )
}

/**
 * Project 的设备状态只读取 Project API 明确标注为当前成员的伴生工作空间。
 * 缺少该工作空间时不展示徽标，绝不回退到容器历史 execution_space_id。
 */
export function resolveCurrentMemberProjectCompanionDeviceStatus<
  TSpace extends SpaceWithDeviceBinding & ProjectExecutionTargetLike,
>(
  project: (TSpace & { my_workspace?: { id?: string | null } | null }) | null | undefined,
  spaces: TSpace[],
  currentDevice: DeviceControlView | null,
  devices: DeviceLike[],
  t: TFunction,
): ExecutionDeviceStatus | null {
  if (project?.type !== 'team_space') {
    return resolveSpaceExecutionDeviceStatus(project, null, currentDevice, devices, t)
  }

  const workspace = resolveCurrentMemberProjectCompanionWorkspace(project, spaces)
  return workspace
    ? resolveSpaceExecutionDeviceStatus(workspace, null, currentDevice, devices, t)
    : null
}
