import {
  useViewContainerState as useViewContainerStateBase,
  type UseViewContainerStateInput as UseViewContainerStateInputBase,
  type ViewContainerState,
} from '@muse/table-ui'
import type { ViewMeta, ViewRecordsResponse } from '@muse/table-core'

export interface UseViewContainerStateInput
  extends Omit<UseViewContainerStateInputBase, 'views' | 'currentViewRecords'> {
  views: ViewMeta[]
  currentViewRecords: ViewRecordsResponse | null
}

export const useViewContainerState = (input: UseViewContainerStateInput): ViewContainerState =>
  useViewContainerStateBase(input as unknown as UseViewContainerStateInputBase)
