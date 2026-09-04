/** @store-category prefs */

export { useTableViewUiStore } from '@muse/table-ui'
export type { PersonalViewDraftState } from '@muse/table-ui'

import { useTableViewUiStore } from '@muse/table-ui'
import { registerResetAction } from './sessionResetRegistry'

registerResetAction('table-view-ui', 'reset', () => useTableViewUiStore.getState().reset())
