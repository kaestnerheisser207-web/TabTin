import {
  useViewFilterGroupController as useViewFilterGroupControllerBase,
  type UseViewFilterGroupControllerInput as UseViewFilterGroupControllerInputBase,
  type ViewFilterGroupControllerState,
} from '@muse/table-ui'
import type { ViewMeta } from '@muse/table-core'

export interface UseViewFilterGroupControllerInput
  extends Omit<UseViewFilterGroupControllerInputBase, 'views'> {
  views: ViewMeta[]
}

export const useViewFilterGroupController = (
  input: UseViewFilterGroupControllerInput
): ViewFilterGroupControllerState =>
  useViewFilterGroupControllerBase(input as unknown as UseViewFilterGroupControllerInputBase)
