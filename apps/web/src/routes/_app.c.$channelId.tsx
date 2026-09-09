import { createFileRoute } from '@tanstack/react-router'
import { HashIcon } from 'lucide-react'
import { ChannelView } from '@/components/channel-view'
import { useChannel } from '@/hooks/use-directory'
import { parseMessageId } from '@/lib/ids'

export interface ChannelSearch {
  readonly thread?: string
  /** A message to scroll to and flash — where a ⌘K search hit lands. */
  readonly at?: string
}

function ChannelRoute() {
  const { channelId } = Route.useParams()
  const { thread, at } = Route.useSearch()
  const channel = useChannel(channelId)
  const name = channel?.name ?? channelId

  return (
    <ChannelView
      channel={channel}
      title={`#${name}`}
      subtitle={channel === undefined ? 'Loading…' : 'Channel'}
      icon={<HashIcon className="size-4" />}
      intro={`This is the very beginning of #${name}.`}
      threadId={parseMessageId(thread)}
      focusMessageId={parseMessageId(at)}
    />
  )
}

export const Route = createFileRoute('/_app/c/$channelId')({
  validateSearch: (search: Record<string, unknown>): ChannelSearch => ({
    thread: typeof search.thread === 'string' ? search.thread : undefined,
    at: typeof search.at === 'string' ? search.at : undefined
  }),
  component: ChannelRoute
})
