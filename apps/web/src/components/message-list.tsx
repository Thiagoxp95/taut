import * as React from 'react'
import { Loader2Icon } from '@taut/ui/components/icons'
import type { ChannelId, Message, MessageId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import { MessageBubble } from '@/components/message-bubble'
import { useMessageAuthor } from '@/hooks/use-directory'
import { useDeleteMessage, useEditMessage, useMe, useTasks } from '@/lib/api'
import { dayKey, formatDay, toMillis } from '@/lib/format'

/** Consecutive messages by the same author inside this window are grouped. */
const GROUP_WINDOW_MS = 5 * 60_000
/** How many older pages a `focusId` may pull in before giving up on finding it. */
const MAX_FOCUS_PAGES = 12
/** Two 1s pulses of `.taut-flash` (see `styles/globals.css`), plus a beat to settle. */
const FLASH_MS = 2100
const FLASH_CLASS = 'taut-flash'

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

function DayDivider({ value }: { value: Message['createdAt'] }) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-3 bg-background/85 px-6 py-2 backdrop-blur">
      <span className="h-px flex-1 bg-border" />
      <span className="rounded-full border bg-background px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        {formatDay(value)}
      </span>
      <span className="h-px flex-1 bg-border" />
    </div>
  )
}

export function MessageListSkeleton() {
  return (
    <div className="space-y-4 px-6 py-6">
      {[0, 1, 2].map((row) => (
        <div key={row} className="flex gap-3">
          <Skeleton className="size-10 rounded-lg" />
          <div className="flex-1 space-y-2 py-1">
            <Skeleton className="h-3 w-32" />
            <Skeleton className="h-3 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  )
}

/**
 * The messages in this channel that a signal posted (docs/build-plan-triggers.md D21).
 *
 * `tasks.signal_id` is where a wake records that it came from the clock rather than from a
 * keyboard, and `triggerMessageId` points back at the message the wake posted — so one task
 * query per channel is enough to badge every one of them. The channel view and its thread panel
 * share the key, so the two lists on screen are one request.
 */
function useScheduledMessages(channelId: ChannelId | undefined): ReadonlySet<string> {
  const tasks = useTasks(channelId === undefined ? {} : { channelId }, channelId !== undefined)
  const items = tasks.data?.items
  return React.useMemo(() => {
    const ids = new Set<string>()
    for (const task of items ?? []) {
      if (task.signalId !== undefined && task.triggerMessageId !== undefined) {
        ids.add(task.triggerMessageId)
      }
    }
    return ids
  }, [items])
}

export interface MessageListProps {
  /** Oldest first — reading order. */
  messages: readonly Message[]
  /** The channel these messages live in, so a signal-woken message can be badged (D21). */
  channelId?: ChannelId
  hasOlder: boolean
  isLoadingOlder: boolean
  onLoadOlder: () => void
  onOpenThread?: (messageId: MessageId) => void
  activeThreadId?: MessageId
  /** Scroll this message into view (loading older pages until it appears) and flash it. */
  focusId?: MessageId
  /** Fired once `focusId` is on screen, so the owner can drop it from the URL. */
  onFocused?: () => void
  header?: React.ReactNode
  empty?: React.ReactNode
}

/**
 * Reverse infinite scroll: the newest message sits at the bottom, "load older"
 * (and hitting the top) pulls the previous page in without moving the view.
 */
export function MessageList({
  messages,
  channelId,
  hasOlder,
  isLoadingOlder,
  onLoadOlder,
  onOpenThread,
  activeThreadId,
  focusId,
  onFocused,
  header,
  empty
}: MessageListProps) {
  const me = useMe().data
  const authorOf = useMessageAuthor()
  const editMessage = useEditMessage()
  const deleteMessage = useDeleteMessage()
  const scheduledIds = useScheduledMessages(channelId)

  const scrollRef = React.useRef<HTMLDivElement>(null)
  const pinnedRef = React.useRef(true)
  const previousHeightRef = React.useRef(0)
  const newest = messages[messages.length - 1]?.id
  const oldest = messages[0]?.id

  // Keep the viewport pinned to the newest message unless the reader scrolled up.
  React.useLayoutEffect(() => {
    const node = scrollRef.current
    if (node === null) return
    if (pinnedRef.current) {
      node.scrollTop = node.scrollHeight
    } else if (previousHeightRef.current !== 0) {
      // An older page was prepended: hold the reader's place.
      node.scrollTop += node.scrollHeight - previousHeightRef.current
    }
    previousHeightRef.current = node.scrollHeight
  }, [newest, oldest])

  // A search hit: find it in the loaded pages, else pull older pages (bounded) until it shows up.
  const focusPagesRef = React.useRef(0)

  /*
   * The flash is applied to the DOM node rather than through state: `onFocused`
   * drops `?at=` from the URL the moment the row is found, so a state-driven
   * highlight would be torn down by that very re-render. Owning the class here
   * also lets the same row be re-flashed (remove, reflow, re-add restarts the
   * animation) when the reader picks the same hit twice.
   */
  const flashRef = React.useRef<{ node: HTMLElement; timer: number } | null>(null)
  const clearFlash = React.useCallback(() => {
    if (flashRef.current === null) return
    clearTimeout(flashRef.current.timer)
    flashRef.current.node.classList.remove(FLASH_CLASS)
    flashRef.current = null
  }, [])
  React.useEffect(() => clearFlash, [clearFlash])

  React.useEffect(() => {
    const node = scrollRef.current
    if (focusId === undefined || node === null) {
      focusPagesRef.current = 0
      return
    }
    const target = node.querySelector<HTMLElement>(`[data-message-id="${focusId}"]`)
    if (target !== null) {
      pinnedRef.current = false
      target.scrollIntoView({
        block: 'center',
        behavior: prefersReducedMotion() ? 'auto' : 'smooth'
      })
      // Keyboard and screen-reader focus land on the hit, not on the list.
      target.focus({ preventScroll: true })
      clearFlash()
      target.classList.remove(FLASH_CLASS)
      void target.offsetWidth // restart the animation if it is already running
      target.classList.add(FLASH_CLASS)
      flashRef.current = {
        node: target,
        timer: window.setTimeout(() => {
          target.classList.remove(FLASH_CLASS)
          flashRef.current = null
        }, FLASH_MS)
      }
      onFocused?.()
      return
    }
    if (hasOlder && !isLoadingOlder && focusPagesRef.current < MAX_FOCUS_PAGES) {
      focusPagesRef.current += 1
      previousHeightRef.current = node.scrollHeight
      onLoadOlder()
    }
  }, [focusId, messages, hasOlder, isLoadingOlder, onLoadOlder, onFocused, clearFlash])

  const onScroll = (): void => {
    const node = scrollRef.current
    if (node === null) return
    pinnedRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80
    if (node.scrollTop < 120 && hasOlder && !isLoadingOlder) {
      previousHeightRef.current = node.scrollHeight
      onLoadOlder()
    }
  }

  const rows = React.useMemo(
    () =>
      messages.map((message, index) => {
        const previous = index === 0 ? undefined : messages[index - 1]
        const newDay =
          previous === undefined || dayKey(previous.createdAt) !== dayKey(message.createdAt)
        const grouped =
          !newDay &&
          previous !== undefined &&
          previous.authorId === message.authorId &&
          previous.authorKind === message.authorKind &&
          toMillis(message.createdAt) - toMillis(previous.createdAt) < GROUP_WINDOW_MS
        return { message, newDay, grouped }
      }),
    [messages]
  )

  return (
    <div ref={scrollRef} onScroll={onScroll} className="taut-scroll min-h-0 flex-1 overflow-y-auto">
      {header}

      {hasOlder ? (
        <div className="flex justify-center py-3">
          <Button variant="outline" size="sm" disabled={isLoadingOlder} onClick={onLoadOlder}>
            {isLoadingOlder ? <Loader2Icon className="animate-spin" /> : null}
            Load older messages
          </Button>
        </div>
      ) : null}

      {messages.length === 0 ? (
        empty
      ) : (
        <div className="pb-4">
          {rows.map(({ message, newDay, grouped }) => {
            const author = authorOf(message)
            const own = message.authorKind === 'user' && message.authorId === me?.user.id

            return (
              <React.Fragment key={message.id}>
                {newDay ? <DayDivider value={message.createdAt} /> : null}
                <div
                  data-message-id={message.id}
                  tabIndex={-1}
                  className="scroll-my-4 outline-none"
                >
                  <MessageBubble
                    message={message}
                    author={author}
                    compact={grouped && message.status === 'sent'}
                    own={own}
                    active={activeThreadId === message.id}
                    scheduled={scheduledIds.has(message.id)}
                    onEdit={
                      own
                        ? (body) => editMessage.mutate({ messageId: message.id, body })
                        : undefined
                    }
                    onDelete={own ? () => deleteMessage.mutate(message.id) : undefined}
                    onOpenThread={
                      onOpenThread === undefined || message.threadId !== undefined
                        ? undefined
                        : () => onOpenThread(message.id)
                    }
                  />
                </div>
              </React.Fragment>
            )
          })}
        </div>
      )}
    </div>
  )
}
