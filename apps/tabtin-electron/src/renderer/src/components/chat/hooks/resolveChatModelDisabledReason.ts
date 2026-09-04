import type { Model } from '@muse/chat-client'
import { filterSendableChatModels } from '@/utils/chatModelGuards'

export interface ResolveChatModelDisabledReasonInput {
  organizationId: string | null
  loadedOrganizationId: string | null
  isLoadingModels: boolean
  modelLoadError: string | null
  models: Model[]
  noModelReason: string
}

/**
 * Only report an empty model catalog after the current organization's load
 * completed successfully. Loading, failed, and organization-switch states keep
 * their existing presentation instead of being mistaken for missing config.
 */
export function resolveChatModelDisabledReason({
  organizationId,
  loadedOrganizationId,
  isLoadingModels,
  modelLoadError,
  models,
  noModelReason,
}: ResolveChatModelDisabledReasonInput): string | null {
  if (filterSendableChatModels(models).length > 0) return null
  if (!organizationId || loadedOrganizationId !== organizationId) return null
  if (isLoadingModels || modelLoadError) return null
  return noModelReason
}
