import * as React from 'react'
import { MessagesSquareIcon, XIcon } from '@taut/ui/components/icons'
import type { ChannelId, MessageId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { ChannelCanvases } from '@/components/canvas-dialog'
import { Composer } from '@/components/composer'
import { ContextMeter } from '@/components/context-meter'
import { EntityAvatar } from '@/components/entity-avatar'
import { MessageList, MessageListSkeleton } from '@/components/message-list'
import { EmptyState } from '@/components/page'
import { PaneHandle } from '@/components/pane-layout'
import { ThreadSignals } from '@/components/thread-signals'
import { useLookupMember } from '@/hooks/use-directory'
import { useMessages, useThread } from '@/lib/api'
import { useThreadContexts } from '@/lib/live'
import { flattenChannel, flattenThread } from '@/lib/message-cache'

/** The right-hand thread column, opened by `?thread=<messageId>`. */
export function ThreadPanel({
  channelId,
  threadId,
  focusId,
  browserAction,
  onFocused,
  onClose
}: {
  channelId: ChannelId
  threadId: MessageId
  /** From `?at=<messageId>` when the hit is a reply: scroll to it, focus it, flash it. */
  focusId?: MessageId
  browserAction?: React.ReactNode
  onFocused?: () => void
  onClose: () => void
}) {
  const channelMessages = useMessages(channelId)
  const contexts = useThreadContexts(threadId)
  const lookup = useLookupMember()
  const thread = useThread(threadId)

  const root = React.useMemo(
    () => flattenChannel(channelMessages.data).find((message) => message.id === threadId),
    [channelMessages.data, threadId]
  )
  const replies = React.useMemo(() => flattenThread(thread.data), [thread.data])
  const messages = React.useMemo(
    () => (root === undefined ? replies : [root, ...replies]),
    [root, replies]
  )
  // The root carries the server's total, so the header is right before every
  // older page has been pulled in.
  const count = root?.thread?.replyCount ?? replies.length

  return (
    <aside
      aria-label="Thread"
      className="taut-thread-panel flex min-h-0 w-full min-w-0 shrink-0 flex-col bg-background @3xl/conversation:w-[var(--thread-width)] @3xl/conversation:border-l"
    >
      <PaneHandle pane="thread" label="Resize thread" />
      <header className="taut-topbar flex h-14 shrink-0 items-center gap-3 border-b bg-background px-4">
        <MessagesSquareIcon className="size-4 text-muted-foreground" />
        <div className="min-w-0">
          <h2 className="truncate text-[15px] leading-tight font-semibold">Thread</h2>
          <p className="truncate text-xs text-muted-foreground">
            {count === 0 ? 'No replies yet' : `${count} ${count === 1 ? 'reply' : 'replies'}`}
          </p>
        </div>
        {browserAction}
        {/*
          Who is holding a context window in this conversation, and how full it is
          (docs/build-plan-context-meter.md D11). A thread is a session, so this row is the
          honest place to show it: two agents in one thread are two copies with two windows,
          and the header is where that stops being an abstraction.
        */}
        {contexts.length === 0 ? null : (
          // Leave breathing room around the context avatars inside the scrollport.
          <div className="taut-rail ml-auto flex min-w-0 items-center gap-1.5 overflow-x-auto overflow-y-hidden p-1">
            {contexts.map((context) => {
              const member = lookup(context.agentId)
              return (
                <ContextMeter key={context.agentId} context={context}>
                  <EntityAvatar
                    memberId={context.agentId}
                    kind="agent"
                    face={member?.face}
                    name={member?.name ?? ''}
                    size="md"
                  />
                </ContextMeter>
              )
            })}
          </div>
        )}
        <ChannelCanvases threadId={threadId} />
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Close thread"
          className={contexts.length === 0 ? 'ml-auto shrink-0' : 'shrink-0'}
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </header>

      {thread.isPending ? (
        <MessageListSkeleton />
      ) : (
        <MessageList
          messages={messages}
          channelId={channelId}
          hasOlder={thread.hasNextPage}
          isLoadingOlder={thread.isFetchingNextPage}
          onLoadOlder={() => void thread.fetchNextPage()}
          focusId={focusId}
          onFocused={onFocused}
          empty={
            <div className="px-4 py-8">
              <EmptyState
                icon={<MessagesSquareIcon className="size-5" />}
                title="No replies yet"
                description="Reply here to keep the main channel readable."
              />
            </div>
          }
        />
      )}

      <Composer channelId={channelId} threadId={threadId} placeholder="Reply…" autoFocus />

      {/* Anything an agent armed in this thread and has not delivered yet (D26). */}
      <ThreadSignals threadId={threadId} />
    </aside>
  )
}
