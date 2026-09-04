/**
 * 删除单条本机外部档案，并刷新侧栏索引。
 */

import { createLogger } from '@/utils/logger'
import {
  forgetExternalOpenedSession,
  resolveExternalOpenedSession,
} from './externalOpenedSessionRegistry'
import { useExternalArchiveIndexStore } from './useExternalArchiveIndexStore'

const log = createLogger('ExternalArchiveDelete')

export async function deleteExternalArchive(payload: {
  organizationId: string
  source: string
  sourceSessionId: string
  openedSessionId?: string | null
}): Promise<{ deleted: number }> {
  const api = window.muse?.import
  if (!api?.deleteArchive) {
    throw new Error('当前客户端未暴露删除外部档案接口')
  }

  const result = await api.deleteArchive({
    organizationId: payload.organizationId,
    source: payload.source,
    sourceSessionId: payload.sourceSessionId,
  }) as { deleted: number }

  const deleted = result?.deleted ?? 0
  if (deleted > 0) {
    const openedId = payload.openedSessionId?.trim()
    if (openedId) {
      forgetExternalOpenedSession(openedId)
    }
    useExternalArchiveIndexStore.getState().unbindLocalOpened(
      payload.source,
      payload.sourceSessionId,
    )
    useExternalArchiveIndexStore.getState().bump()
    log.info('已删除外部档案', {
      source: payload.source,
      sourceSessionId: payload.sourceSessionId,
      deleted,
    })
  } else {
    log.warn('删除外部档案未命中任何条目', {
      source: payload.source,
      sourceSessionId: payload.sourceSessionId,
    })
  }
  return { deleted }
}

/** 续聊后归档：会话留下归档态，本机导入行必须删掉，否则会重新露出来。 */
export async function deleteImportRecordAfterArchive(input: {
  sessionId: string
  organizationId: string | null
  target?: {
    source: string
    sourceSessionId: string
    openedSessionId?: string | null
  } | null
}): Promise<boolean> {
  if (!input.organizationId) return false
  const target = input.target ?? resolveExternalOpenedSession(input.sessionId)
  if (!target) return false
  try {
    const { deleted } = await deleteExternalArchive({
      organizationId: input.organizationId,
      source: target.source,
      sourceSessionId: target.sourceSessionId,
      openedSessionId: target.openedSessionId ?? input.sessionId,
    })
    if (deleted <= 0) {
      log.warn('归档后删除导入记录未命中', {
        sessionId: input.sessionId,
        source: target.source,
        sourceSessionId: target.sourceSessionId,
      })
      return false
    }
    return true
  } catch (error) {
    log.warn('归档后删除导入记录失败', {
      sessionId: input.sessionId,
      source: target.source,
      sourceSessionId: target.sourceSessionId,
    }, error)
    return false
  }
}
