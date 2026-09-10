import * as React from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { HashIcon } from '@taut/ui/components/icons'
import { Button } from '@taut/ui/components/button'
import { CreateChannelDialog } from '@/components/create-channel-dialog'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { MessageListSkeleton } from '@/components/message-list'
import { useChannelGroups } from '@/hooks/use-directory'

/** Land on the first channel of the session's active company. */
function IndexRoute() {
  const { all, dms, isPending } = useChannelGroups()
  const navigate = useNavigate()
  const [creating, setCreating] = React.useState(false)

  const first = all.find((channel) => channel.kind === 'channel')
  const firstDm = dms[0]

  React.useEffect(() => {
    if (first !== undefined) {
      void navigate({ to: '/c/$channelId', params: { channelId: first.id }, replace: true })
    } else if (firstDm !== undefined) {
      void navigate({ to: '/dm/$channelId', params: { channelId: firstDm.id }, replace: true })
    }
  }, [first, firstDm, navigate])

  if (isPending) return <MessageListSkeleton />
  if (first !== undefined || firstDm !== undefined) return null

  return (
    <>
      <PageHeader title="Welcome to Taut" description="Nothing to read yet." />
      <PageBody>
        <EmptyState
          icon={<HashIcon className="size-5" />}
          title="No channels yet"
          description="Create the first channel so this company has somewhere to talk."
          action={<Button onClick={() => setCreating(true)}>Create a channel</Button>}
        />
      </PageBody>
      <CreateChannelDialog open={creating} onOpenChange={setCreating} />
    </>
  )
}

export const Route = createFileRoute('/_app/')({
  component: IndexRoute
})
