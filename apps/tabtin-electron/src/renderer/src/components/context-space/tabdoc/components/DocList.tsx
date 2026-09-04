import React from 'react'
import { DocList as SharedDocList } from '@muse/tabdoc-ui/editor'
import { DetailedRowListSkeleton } from '@components/common/ListSkeletons'

type SharedDocListProps = React.ComponentProps<typeof SharedDocList>

export function DocList(props: SharedDocListProps) {
  return (
    <SharedDocList
      {...props}
      loadingSkeleton={<DetailedRowListSkeleton count={6} showPreview={false} compact />}
    />
  )
}
