import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  bump: vi.fn(),
  unbindLocalOpened: vi.fn(),
  forgetExternalOpenedSession: vi.fn(),
  resolveExternalOpenedSession: vi.fn(() => null),
}))

vi.mock('../useExternalArchiveIndexStore', () => ({
  useExternalArchiveIndexStore: {
    getState: () => ({
      bump: mocks.bump,
      unbindLocalOpened: mocks.unbindLocalOpened,
    }),
  },
}))

vi.mock('../externalOpenedSessionRegistry', () => ({
  forgetExternalOpenedSession: mocks.forgetExternalOpenedSession,
  resolveExternalOpenedSession: mocks.resolveExternalOpenedSession,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    log: vi.fn(),
  }),
}))

import { deleteExternalArchive, deleteImportRecordAfterArchive } from '../deleteExternalArchive'

describe('deleteExternalArchive', () => {
  beforeEach(() => {
    mocks.bump.mockReset()
    mocks.unbindLocalOpened.mockReset()
    mocks.forgetExternalOpenedSession.mockReset()
    mocks.resolveExternalOpenedSession.mockReset()
    mocks.resolveExternalOpenedSession.mockReturnValue(null)
    ;(window as unknown as { tabtin: unknown }).tabtin = {
      import: {
        deleteArchive: vi.fn(async () => ({ deleted: 1 })),
      },
    }
  })

  it('calls IPC, forgets opened session, bumps index', async () => {
    const result = await deleteExternalArchive({
      organizationId: 'org-1',
      source: 'cursor',
      sourceSessionId: 'src-1',
      openedSessionId: 'chat-1',
    })

    expect(result).toEqual({ deleted: 1 })
    expect(window.muse.import.deleteArchive).toHaveBeenCalledWith({
      organizationId: 'org-1',
      source: 'cursor',
      sourceSessionId: 'src-1',
    })
    expect(mocks.forgetExternalOpenedSession).toHaveBeenCalledWith('chat-1')
    expect(mocks.unbindLocalOpened).toHaveBeenCalledWith('cursor', 'src-1')
    expect(mocks.bump).toHaveBeenCalledTimes(1)
  })

  it('does not forget or bump when deleted is 0', async () => {
    ;(window as unknown as { tabtin: { import: { deleteArchive: ReturnType<typeof vi.fn> } } }).tabtin = {
      import: {
        deleteArchive: vi.fn(async () => ({ deleted: 0 })),
      },
    }
    const result = await deleteExternalArchive({
      organizationId: 'org-1',
      source: 'cursor',
      sourceSessionId: 'missing',
      openedSessionId: 'chat-1',
    })
    expect(result).toEqual({ deleted: 0 })
    expect(mocks.forgetExternalOpenedSession).not.toHaveBeenCalled()
    expect(mocks.bump).not.toHaveBeenCalled()
  })

  it('deleteImportRecordAfterArchive uses registry when no target is passed', async () => {
    mocks.resolveExternalOpenedSession.mockReturnValue({
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来',
      openedSessionId: 'chat-1',
    })
    const dropped = await deleteImportRecordAfterArchive({
      sessionId: 'chat-1',
      organizationId: 'org-1',
    })
    expect(dropped).toBe(true)
    expect(window.muse.import.deleteArchive).toHaveBeenCalledWith({
      organizationId: 'org-1',
      source: 'cursor',
      sourceSessionId: 'src-1',
    })
  })

  it('deleteImportRecordAfterArchive returns false when deleted is 0', async () => {
    mocks.resolveExternalOpenedSession.mockReturnValue({
      source: 'cursor',
      sourceSessionId: 'src-1',
      title: '外来',
      openedSessionId: 'chat-1',
    })
    ;(window as unknown as { tabtin: { import: { deleteArchive: ReturnType<typeof vi.fn> } } }).tabtin = {
      import: {
        deleteArchive: vi.fn(async () => ({ deleted: 0 })),
      },
    }
    await expect(deleteImportRecordAfterArchive({
      sessionId: 'chat-1',
      organizationId: 'org-1',
    })).resolves.toBe(false)
  })

  it('throws when deleteArchive API missing', async () => {
    ;(window as unknown as { tabtin: unknown }).tabtin = { import: {} }
    await expect(
      deleteExternalArchive({
        organizationId: 'org-1',
        source: 'cursor',
        sourceSessionId: 'src-1',
      }),
    ).rejects.toThrow(/未暴露删除外部档案接口/)
  })
})
