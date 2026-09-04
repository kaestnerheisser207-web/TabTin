import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatSession } from '@muse/chat-client'
import {
  ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS,
  ARCHIVE_INLINE_CONFIRM_TIMEOUT_MS,
} from '../useInlineArchiveConfirm'
import { useSessionSwitcherActions } from '../useSessionSwitcherActions'
import {
  rememberExternalOpenedSession,
  syncExternalOpenedSessions,
} from '@components/onboarding/external-import/externalOpenedSessionRegistry'

vi.mock('@/hooks/useResolvedOrganizationId', () => ({
  useResolvedOrganizationId: () => 'org-1',
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: { getState: () => ({ spaces: [] }) },
}))

vi.mock('@/stores/useOrganizationStore', () => ({
  useOrganizationStore: { getState: () => ({ organizations: [], selectedOrganization: null }) },
}))

vi.mock('@components/shared/file-ops/clipboard', () => ({
  copyToClipboard: vi.fn(),
}))

vi.mock('@/utils/buildSessionReferenceClipboardText', () => ({
  buildSessionReferenceClipboardText: () => 'ref',
  warmSpacePathCache: vi.fn(),
}))

vi.mock('@components/onboarding/external-import/deleteExternalArchive', () => ({
  deleteImportRecordAfterArchive: (...args: unknown[]) => mocks.deleteImportRecordAfterArchive(...args),
}))

const mocks = vi.hoisted(() => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  listSessionSharesBySession: vi.fn(),
  beginOptimisticArchive: vi.fn(),
  rollbackOptimisticArchive: vi.fn(),
  restoreSession: vi.fn().mockResolvedValue(undefined),
  deleteImportRecordAfterArchive: vi.fn().mockResolvedValue(undefined),
  messagesBySessionId: {} as Record<string, Array<{
    id: string
    role: string
    content: string
    metadata?: Record<string, unknown>
  }>>,
}))

vi.mock('@components/ui', () => ({
  toast: mocks.toast,
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      restoreSession: mocks.restoreSession,
      beginOptimisticArchive: mocks.beginOptimisticArchive,
      rollbackOptimisticArchive: mocks.rollbackOptimisticArchive,
      messagesBySessionId: mocks.messagesBySessionId,
    }),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  listSessionSharesBySession: mocks.listSessionSharesBySession,
}))

const session = {
  id: 'chat-ext-1',
  title: '外来历史',
  status: 'active',
  space_id: 'space-1',
} as ChatSession

describe('useSessionSwitcherActions external archive', () => {
  beforeEach(() => {
    mocks.listSessionSharesBySession.mockReset()
    mocks.listSessionSharesBySession.mockResolvedValue([])
    mocks.beginOptimisticArchive.mockReset()
    mocks.rollbackOptimisticArchive.mockReset()
    mocks.restoreSession.mockReset()
    mocks.restoreSession.mockResolvedValue(undefined)
    mocks.deleteImportRecordAfterArchive.mockReset()
    mocks.deleteImportRecordAfterArchive.mockResolvedValue(undefined)
    mocks.messagesBySessionId = {}
  })

  it('uses two-click inline confirm for ordinary agent conversation archive', async () => {
    vi.useFakeTimers()
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    expect(result.current.pendingArchiveSessionId).toBe(session.id)
    expect(result.current.archiveTarget).toBeNull()
    expect(onDeleteSession).not.toHaveBeenCalled()

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    expect(onDeleteSession).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS - 1)
      result.current.handleArchiveRequest(session.id)
    })
    expect(onDeleteSession).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(1)
      result.current.handleArchiveRequest(session.id)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.beginOptimisticArchive).toHaveBeenCalledWith('space-1', session.id)
    expect(onDeleteSession).toHaveBeenCalledWith(session.id)
    expect(result.current.archiveTarget).toBeNull()
    expect(result.current.pendingArchiveSessionId).toBeNull()
    vi.useRealTimers()
  })

  it('removes the session from the sidebar before share lookup resolves', async () => {
    vi.useFakeTimers()
    let resolveShares: (value: unknown[]) => void = () => {}
    mocks.listSessionSharesBySession.mockImplementation(
      () => new Promise((resolve) => { resolveShares = resolve }),
    )
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleArchiveRequest(session.id)
    })
    expect(mocks.beginOptimisticArchive).toHaveBeenCalledWith('space-1', session.id)
    expect(onDeleteSession).not.toHaveBeenCalled()

    await act(async () => {
      resolveShares([])
      await Promise.resolve()
    })
    expect(onDeleteSession).toHaveBeenCalledWith(session.id)
    vi.useRealTimers()
  })

  it('clears inline confirm after the timeout without archiving', () => {
    vi.useFakeTimers()
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_TIMEOUT_MS)
    })
    expect(result.current.pendingArchiveSessionId).toBeNull()
    expect(onDeleteSession).not.toHaveBeenCalled()
    vi.useRealTimers()
  })

  it('opens the shared-archive dialog instead of deleting when the session is shared', async () => {
    vi.useFakeTimers()
    mocks.listSessionSharesBySession.mockResolvedValue([
      { id: 'share-1', status: 'active' },
    ])
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest(session.id)
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleArchiveRequest(session.id)
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(mocks.beginOptimisticArchive).toHaveBeenCalledWith('space-1', session.id)
    expect(mocks.rollbackOptimisticArchive).toHaveBeenCalledWith('space-1', session.id)
    expect(onDeleteSession).not.toHaveBeenCalled()
    expect(result.current.archiveTarget).toBe(session.id)
    vi.useRealTimers()
  })

  it('uses two-click inline confirm to delete an opened external archive', () => {
    vi.useFakeTimers()
    const resolve = vi.fn(() => ({
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来历史',
      openedSessionId: 'chat-ext-1',
    }))
    mocks.messagesBySessionId = {
      'chat-ext-1': [{
        id: 'ext-a1',
        role: 'assistant',
        content: '外来',
        metadata: { external_archive: true },
      }],
    }
    const onDeleteExternalArchive = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      externalOpenedSessionIds: new Set(['chat-ext-1']),
      resolveExternalArchiveByOpenedSessionId: resolve,
      onDeleteExternalArchive,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest('chat-ext-1')
    })
    expect(resolve).toHaveBeenCalledWith('chat-ext-1')
    expect(result.current.pendingArchiveSessionId).toBe('chat-ext-1')
    expect(onDeleteExternalArchive).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleArchiveRequest('chat-ext-1')
    })
    expect(onDeleteExternalArchive).toHaveBeenCalledWith({
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来历史',
      openedSessionId: 'chat-ext-1',
    })
    expect(result.current.pendingArchiveSessionId).toBeNull()
    expect(result.current.archiveTarget).toBeNull()
    expect(result.current.isExternalOpenedSession('chat-ext-1')).toBe(true)
    vi.useRealTimers()
  })

  it('deletes via remembered target when the disk index is not bound yet', () => {
    vi.useFakeTimers()
    mocks.messagesBySessionId = {
      'chat-ext-1': [{
        id: 'ext-a1',
        role: 'assistant',
        content: '外来',
        metadata: { external_archive: true },
      }],
    }
    rememberExternalOpenedSession('chat-ext-1', {
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来历史',
    })
    const onDeleteExternalArchive = vi.fn().mockResolvedValue(undefined)
    const onDeleteSession = vi.fn()
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      externalOpenedSessionIds: new Set(['chat-ext-1']),
      resolveExternalArchiveByOpenedSessionId: () => null,
      onDeleteExternalArchive,
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest('chat-ext-1')
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleArchiveRequest('chat-ext-1')
    })
    expect(onDeleteExternalArchive).toHaveBeenCalledWith({
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来历史',
      openedSessionId: 'chat-ext-1',
    })
    expect(onDeleteSession).not.toHaveBeenCalled()
    syncExternalOpenedSessions([])
    vi.useRealTimers()
  })

  it('does not delete an opened import when messages are not loaded yet', async () => {
    vi.useFakeTimers()
    const onDeleteExternalArchive = vi.fn().mockResolvedValue(undefined)
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      externalOpenedSessionIds: new Set(['chat-ext-1']),
      resolveExternalArchiveByOpenedSessionId: () => ({
        source: 'cursor',
        sourceSessionId: 'src-1',
        title: '外来历史',
        openedSessionId: 'chat-ext-1',
      }),
      onDeleteExternalArchive,
      onDeleteSession,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest('chat-ext-1')
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleArchiveRequest('chat-ext-1')
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(onDeleteExternalArchive).not.toHaveBeenCalled()
    expect(onDeleteSession).toHaveBeenCalledWith('chat-ext-1')
    vi.useRealTimers()
  })

  it('archives an opened external session after a live TabTin turn', async () => {
    vi.useFakeTimers()
    mocks.messagesBySessionId = {
      'chat-ext-1': [
        {
          id: 'ext-a1',
          role: 'assistant',
          content: '外来',
          metadata: { external_archive: true },
        },
        { id: 'live-1', role: 'user', content: '接着做' },
      ],
    }
    const onDeleteSession = vi.fn().mockResolvedValue(undefined)
    const onDeleteExternalArchive = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteSession,
      externalOpenedSessionIds: new Set(['chat-ext-1']),
      resolveExternalArchiveByOpenedSessionId: () => ({
        source: 'cursor',
        sourceSessionId: 'src-1',
        title: '外来历史',
        openedSessionId: 'chat-ext-1',
      }),
      onDeleteExternalArchive,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))

    act(() => {
      result.current.handleArchiveRequest('chat-ext-1')
    })
    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleArchiveRequest('chat-ext-1')
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(onDeleteExternalArchive).not.toHaveBeenCalled()
    expect(onDeleteSession).toHaveBeenCalledWith('chat-ext-1')
    expect(mocks.deleteImportRecordAfterArchive).toHaveBeenCalledWith({
      sessionId: 'chat-ext-1',
      organizationId: 'org-1',
      target: {
        source: 'cursor',
        sourceSessionId: 'src-1',
        title: '外来历史',
        openedSessionId: 'chat-ext-1',
      },
    })
    vi.useRealTimers()
  })

  it('uses two-click inline confirm for unread imported archive rows', () => {
    vi.useFakeTimers()
    const onDeleteExternalArchive = vi.fn().mockResolvedValue(undefined)
    const { result } = renderHook(() => useSessionSwitcherActions({
      sessions: [session],
      onDeleteExternalArchive,
      t: (_key, opts) => (typeof opts?.defaultValue === 'string' ? opts.defaultValue : _key),
    }))
    const target = {
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来历史',
    }

    act(() => {
      result.current.handleDeleteExternalArchiveRequest(target)
    })
    expect(result.current.pendingArchiveSessionId).toBe('cursor:src-1')
    expect(onDeleteExternalArchive).not.toHaveBeenCalled()

    act(() => {
      vi.advanceTimersByTime(ARCHIVE_INLINE_CONFIRM_COOLDOWN_MS)
      result.current.handleDeleteExternalArchiveRequest(target)
    })
    expect(onDeleteExternalArchive).toHaveBeenCalledWith(target)
    vi.useRealTimers()
  })
})
