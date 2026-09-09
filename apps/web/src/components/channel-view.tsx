import * as React from 'react'
import { Link, useNavigate } from '@tanstack/react-router'
import { HashIcon, MessagesSquareIcon, SettingsIcon, UsersIcon } from 'lucide-react'
import type { Channel, MessageId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { ChannelMembersSheet } from '@/components/channel-members-sheet'
import { Composer } from '@/components/composer'
import { HuddleButton } from '@/components/huddle-bar'
import { MessageList, MessageListSkeleton } from '@/components/message-list'
import { EmptyState, PageHeader } from '@/components/page'
import { ThreadPanel } from '@/components/thread-panel'
import { useMarkReadOnView } from '@/hooks/use-realtime'
import { useMessages, useThreadContextSeed } from '@/lib/api'
import { flattenChannel } from '@/lib/message-cache'

function ChannelIntro({ title, blurb }: { title: string; blurb: string }) {
  return (
    <div className="px-6 pt-8 pb-4">
      <h2 className="text-xl font-bold">{title}</h2>
      <p className="mt-1 max-w-prose text-sm text-muted-foreground">{blurb}</p>
    </div>
  )
}

export function ChannelView({
  channel,
  title,
  subtitle,
  icon,
  intro,
  headerAvatar,
  headerActions,
  threadId,
  focusMessageId
}: {
  channel: Channel | undefined
  title: string
  subtitle: string
  icon?: React.ReactNode
  intro: string
  headerAvatar?: React.ReactNode
  /** Rendered before the Members button — e.g. "Agent profile" on an agent DM. */
  headerActions?: React.ReactNode
  /** From `?thread=<messageId>`; `undefined` closes the panel. */
  threadId?: MessageId
  /** From `?at=<messageId>` (a search hit): scroll to it, flash it, then drop the param. */
  focusMessageId?: MessageId
}) {
  const navigate = useNavigate()
  const channelId = channel?.id
  const messages = useMessages(channelId)
  // Fills the context rings for this channel's threads, so a refresh mid-run does not blank
  // every meter on screen (docs/build-plan-context-meter.md).
  useThreadContextSeed(channelId)
  const [membersOpen, setMembersOpen] = React.useState(false)

  useMarkReadOnView(channelId)

  const list = React.useMemo(() => flattenChannel(messages.data), [messages.data])

  /*
   * A search hit on a reply arrives as `?thread=<root>&at=<reply>`: the reply is
   * only rendered inside the thread panel, so the main list must not try to find
   * it (it would burn its older-page budget and never flash).
   */
  const focusInThread =
    threadId !== undefined && focusMessageId !== undefined && focusMessageId !== threadId

  const closeThread = React.useCallback(() => {
    void navigate({ to: '.', search: {}, replace: true })
  }, [navigate])

  // The hit is on screen: drop `?at=` so a refresh or a back-navigation does not re-scroll.
  const clearFocus = React.useCallback(() => {
    void navigate({
      to: '.',
      search: threadId === undefined ? {} : { thread: threadId },
      replace: true
    })
  }, [navigate, threadId])

  const openThread = React.useCallback(
    (messageId: MessageId) => {
      void navigate({ to: '.', search: { thread: messageId } })
    },
    [navigate]
  )

  // Escape closes the thread panel from anywhere in the channel.
  React.useEffect(() => {
    if (threadId === undefined) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') closeThread()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [threadId, closeThread])

  return (
    <div className="flex min-h-0 flex-1">
      <div className="flex min-w-0 flex-1 flex-col">
        <PageHeader
          title={title}
          description={subtitle}
          icon={headerAvatar ?? icon ?? <HashIcon className="size-4" />}
          actions={
            <>
              {headerActions}
              {/* Channels and DMs alike — both header rows come through here (D1). */}
              {channel === undefined ? null : <HuddleButton channelId={channel.id} />}
              {channel === undefined ? null : (
                <Button variant="ghost" size="sm" onClick={() => setMembersOpen(true)}>
                  <UsersIcon />
                  Members
                </Button>
              )}
              {channel === undefined || channel.kind === 'dm' ? null : (
                <Button asChild variant="ghost" size="icon-sm" aria-label="Channel settings">
                  <Link to="/channels/$channelId/settings" params={{ channelId: channel.id }}>
                    <SettingsIcon />
                  </Link>
                </Button>
              )}
            </>
          }
        />

        {messages.isPending ? (
          <MessageListSkeleton />
        ) : (
          <MessageList
            messages={list}
            channelId={channelId}
            hasOlder={messages.hasNextPage}
            isLoadingOlder={messages.isFetchingNextPage}
            onLoadOlder={() => void messages.fetchNextPage()}
            onOpenThread={openThread}
            activeThreadId={threadId}
            focusId={focusInThread ? undefined : focusMessageId}
            onFocused={clearFocus}
            header={<ChannelIntro title={title} blurb={intro} />}
            empty={
              <div className="px-6 py-10">
                <EmptyState
                  icon={<MessagesSquareIcon className="size-5" />}
                  title="No messages yet"
                  description="Say something, or @mention an agent to put it to work."
                />
              </div>
            }
          />
        )}

        <Composer channelId={channelId} placeholder={`Message ${title}`} />
      </div>

      {channel !== undefined && threadId !== undefined ? (
        <ThreadPanel
          channelId={channel.id}
          threadId={threadId}
          focusId={focusInThread ? focusMessageId : undefined}
          onFocused={clearFocus}
          onClose={closeThread}
        />
      ) : null}

      {channel === undefined ? null : (
        <ChannelMembersSheet channel={channel} open={membersOpen} onOpenChange={setMembersOpen} />
      )}
    </div>
  )
}
