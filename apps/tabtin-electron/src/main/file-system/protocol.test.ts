import { describe, expect, it, vi } from 'vitest'

const { defaultRegister } = vi.hoisted(() => ({
  defaultRegister: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  session: {
    defaultSession: {
      protocol: { registerStreamProtocol: defaultRegister },
    },
  },
}))

import { registerTabtinFileProtocol } from './protocol'

describe('registerTabtinFileProtocol', () => {
  it('registers muse-file independently for each Electron session', () => {
    const firstRegister = vi.fn()
    const secondRegister = vi.fn()
    const firstSession = {
      protocol: { registerStreamProtocol: firstRegister },
    }
    const secondSession = {
      protocol: { registerStreamProtocol: secondRegister },
    }

    registerTabtinFileProtocol(firstSession as never)
    registerTabtinFileProtocol(firstSession as never)
    registerTabtinFileProtocol(secondSession as never)

    expect(firstRegister).toHaveBeenCalledOnce()
    expect(secondRegister).toHaveBeenCalledOnce()
    expect(firstRegister).toHaveBeenCalledWith(
      'muse-file',
      expect.any(Function),
    )
  })
})
