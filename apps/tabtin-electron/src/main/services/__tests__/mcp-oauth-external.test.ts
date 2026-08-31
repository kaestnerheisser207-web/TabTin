import { beforeEach, describe, expect, it, vi } from 'vitest'

const { openExternal } = vi.hoisted(() => ({
  openExternal: vi.fn<() => Promise<void>>(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/tabtin-oauth-test') },
  shell: { openExternal },
}))

import {
  openConnectorOAuthWindow,
} from '../mcp-oauth-window'

describe('connector oauth external browser', () => {
  beforeEach(() => {
    openExternal.mockReset()
    openExternal.mockResolvedValue(undefined)
  })

  it('opens standard MCP OAuth in the system browser', async () => {
    openConnectorOAuthWindow('https://api.supabase.com/v1/oauth/authorize?state=secret')
    await vi.waitFor(() => expect(openExternal).toHaveBeenCalledTimes(1))
    expect(openExternal).toHaveBeenCalledWith(
      'https://api.supabase.com/v1/oauth/authorize?state=secret',
    )
  })
})
