import { describe, expect, it } from 'vitest'
import type { Model } from '@muse/chat-client'
import { resolveChatModelDisabledReason } from '../resolveChatModelDisabledReason'

const base = {
  organizationId: 'org-current',
  loadedOrganizationId: 'org-current',
  isLoadingModels: false,
  modelLoadError: null,
  models: [] as Model[],
  noModelReason: 'community_no_chat_model',
}

describe('resolveChatModelDisabledReason', () => {
  it('keeps the initializing presentation while the catalog is loading', () => {
    expect(resolveChatModelDisabledReason({
      ...base,
      isLoadingModels: true,
    })).toBeNull()
  })

  it('reports no model when the current organization catalog loaded empty', () => {
    expect(resolveChatModelDisabledReason(base)).toBe('community_no_chat_model')
  })

  it('reports no model when the loaded catalog has no sendable model', () => {
    expect(resolveChatModelDisabledReason({
      ...base,
      models: [{ id: 'declared:provider:model', name: 'Declared only' } as Model],
    })).toBe('community_no_chat_model')
  })

  it('does not mistake a load failure for missing model configuration', () => {
    expect(resolveChatModelDisabledReason({
      ...base,
      modelLoadError: 'request failed',
    })).toBeNull()
  })

  it('does not report no model while switching organizations', () => {
    expect(resolveChatModelDisabledReason({
      ...base,
      loadedOrganizationId: 'org-previous',
    })).toBeNull()
  })

  it('does not report no model when a sendable model exists', () => {
    expect(resolveChatModelDisabledReason({
      ...base,
      models: [{
        id: '00000000-0000-0000-0000-000000000001',
        name: 'Sendable',
      } as Model],
    })).toBeNull()
  })
})
