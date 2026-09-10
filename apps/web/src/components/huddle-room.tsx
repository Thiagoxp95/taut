import * as React from 'react'
import { HeadphonesIcon, MessagesSquareIcon } from '@taut/ui/components/icons'
import type { Call } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'

import { Composer } from '@/components/composer'
import { HuddleControls } from '@/components/huddle-bar'
import { HuddleTiles } from '@/components/huddle-tiles'
import { MessageList, MessageListSkeleton } from '@/components/message-list'
import { EmptyState } from '@/components/page'
import { useHuddle } from '@/hooks/use-huddle'
import { useThread } from '@/lib/api'
import { closeHuddleWindow } from '@/lib/desktop'
import { flattenThread } from '@/lib/message-cache'

/**
 * The huddle chat: the thread under the message the server posted when the call opened
 * (docs/build-plan-huddle-window.md D8, D9). No new endpoint and no new message kind — the
 * ordinary `MessageList` and `Composer`, posting with `threadId`, so the channel shows the
 * huddle and everything said in it in normal history.
 */
function HuddleThread({ call }: { call: Call }) {
  const thread = useThread(call.messageId)
  const replies = React.useMemo(() => flattenThread(thread.data), [thread.data])

  if (call.messageId === undefined) {
    // The post failed — an archived channel, a starter who is no longer a member. That costs
    // the chat and never the call (D9).
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 py-8">
        <EmptyState
          icon={<MessagesSquareIcon className="size-5" />}
          title="Chat is unavailable for this huddle"
          description="No message could be posted for it, so there is no thread to write in. The huddle itself is unaffected."
        />
      </div>
    )
  }

  return (
    <>
      {thread.isPending ? (
        <MessageListSkeleton />
      ) : (
        <MessageList
          messages={replies}
          hasOlder={thread.hasNextPage}
          isLoadingOlder={thread.isFetchingNextPage}
          onLoadOlder={() => void thread.fetchNextPage()}
          empty={
            <div className="px-4 py-8">
              <EmptyState
                icon={<MessagesSquareIcon className="size-5" />}
                title="Nothing said yet"
                description="Links, notes and anything worth keeping from this huddle go here."
              />
            </div>
          }
        />
      )}
      <Composer
        channelId={call.channelId}
        threadId={call.messageId}
        placeholder="Message huddle…"
      />
    </>
  )
}

/**
 * Tiles, controls and the huddle thread, in one tree with two mounts (D4).
 *
 * `layout` is the only branch: `inline` is the browser, where the room is a strip above the
 * docked bar that already carries the controls (D5); `window` is the shell's huddle window,
 * where the room *is* the page and therefore owns the controls and the leave that closes it
 * (D6, D13).
 */
export function HuddleRoomPanel({ layout }: { layout: 'inline' | 'window' }) {
  const { enabled, call, leave } = useHuddle()

  const exit = React.useCallback((): void => {
    leave()
    // In the shell there is nothing left in the window once the huddle is over (D13) — it goes
    // a beat later so the pop-out `leave` just started is heard rather than closed on top of.
    if (layout === 'window') closeHuddleWindow()
  }, [leave, layout])

  if (!enabled || call === undefined) return null

  const standalone = layout === 'window'

  return (
    <div
      className={cn(
        '@container/huddle flex min-h-0 min-w-0 shrink-0 flex-col bg-background',
        standalone ? 'flex-1 shrink' : 'h-[min(60dvh,28rem)] border-t lg:h-[min(42dvh,360px)]'
      )}
    >
      <div
        className={cn(
          'flex min-h-0 min-w-0 flex-1 flex-col',
          !standalone && '@3xl/huddle:flex-row'
        )}
      >
        <HuddleTiles
          className={cn(
            'min-h-0 border-t-0',
            standalone
              ? 'h-auto max-h-[45%] shrink'
              : 'h-auto max-h-[30%] shrink @3xl/huddle:max-h-none @3xl/huddle:flex-1'
          )}
        />
        <div
          className={cn(
            'flex min-h-0 min-w-0 flex-1 flex-col',
            standalone
              ? 'border-t'
              : 'w-full border-t @3xl/huddle:w-[24rem] @3xl/huddle:shrink-0 @3xl/huddle:border-t-0 @3xl/huddle:border-l'
          )}
        >
          {standalone ? null : (
            <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs font-medium text-muted-foreground">
              <HeadphonesIcon className="size-3.5" />
              Huddle thread
            </header>
          )}
          <HuddleThread call={call} />
        </div>
      </div>

      {/* The docked bar carries these in a browser; the window has no bar (D4, D5). */}
      {standalone ? (
        <div className="flex shrink-0 items-center justify-center gap-1 border-t bg-sidebar px-4 py-2 text-sidebar-foreground">
          <HuddleControls onLeave={exit} />
        </div>
      ) : null}
    </div>
  )
}
