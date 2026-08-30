import { describe, expect, it, vi } from 'vitest'
import {
  RuntimeDriverRegistry,
  type HostedRuntime,
  type RuntimeDriver,
  type RuntimeDriverContext,
} from '../src/runtime/runtime-driver.js'

function runtime(id: string): HostedRuntime {
  return {
    async *query() {},
    abort: vi.fn(),
    getRuntimeId: () => id,
  }
}

function context(): RuntimeDriverContext {
  return {
    threadId: 'thread-1',
    workspaceId: 'workspace-1',
    workspaceRoot: '/workspace',
    owner: {
      userId: 'user-1',
      organizationId: 'organization-1',
    },
  }
}

describe('RuntimeDriverRegistry', () => {
  it('resolves builtin and DSH drivers through the same runtime contract', async () => {
    const builtinRuntime = runtime('builtin-runtime')
    const dshRuntime = runtime('dsh-runtime')
    const builtin: RuntimeDriver = {
      harness: 'builtin',
      create: vi.fn(async () => ({ runtime: builtinRuntime })),
      dispose: vi.fn(async () => undefined),
    }
    const dsh: RuntimeDriver<RuntimeDriverContext, { acpSessionId: string }> = {
      harness: 'dsh',
      create: vi.fn(async () => ({
        runtime: dshRuntime,
        binding: { acpSessionId: 'acp-1' },
      })),
      resume: vi.fn(async (_context, binding) => ({
        runtime: dshRuntime,
        binding,
      })),
      dispose: vi.fn(async () => undefined),
    }
    const registry = new RuntimeDriverRegistry([builtin, dsh])

    const builtinSession = await registry.resolve('builtin').create(context())
    const dshSession = await registry.resolve('dsh').create(context())

    expect(builtinSession.runtime).toBe(builtinRuntime)
    expect(dshSession.runtime).toBe(dshRuntime)
    expect(dshSession.binding).toEqual({ acpSessionId: 'acp-1' })
  })

  it('rejects duplicate harness registrations', () => {
    const first: RuntimeDriver = {
      harness: 'dsh',
      create: async () => ({ runtime: runtime('first') }),
      dispose: async () => undefined,
    }
    const second: RuntimeDriver = {
      harness: 'dsh',
      create: async () => ({ runtime: runtime('second') }),
      dispose: async () => undefined,
    }

    expect(() => new RuntimeDriverRegistry([first, second])).toThrow(
      'Runtime driver already registered: dsh',
    )
  })

  it('fails closed when a requested harness has no driver', () => {
    const registry = new RuntimeDriverRegistry()

    expect(() => registry.resolve('dsh')).toThrow(
      'Runtime driver not registered: dsh',
    )
  })
})
