import { describe, expect, it } from 'vitest'
import {
  createRuntimeCacheKey,
  runtimeCacheKeysMatch,
  type CreateRuntimeCacheKeyInput,
} from '../src/runtime/runtime-cache-key.js'

function createKey(overrides: Partial<CreateRuntimeCacheKeyInput> = {}) {
  return createRuntimeCacheKey({
    modelId: 'model-1',
    workspaceRoot: '/workspace',
    owner: {
      userId: 'user-1',
      organizationId: 'organization-1',
      agentId: 'agent-1',
    },
    spaceId: 'space-1',
    ...overrides,
  })
}

describe('RuntimeCacheKey — harness', () => {
  it('normalizes an omitted harness to builtin', () => {
    expect(createKey().harness).toBe('builtin')
  })

  it('forces a hard rebuild when the harness changes', () => {
    expect(runtimeCacheKeysMatch(
      createKey({ harness: 'builtin' }),
      createKey({ harness: 'dsh' }),
    )).toBe(false)
  })
})
