import * as React from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ChannelId, CompanyId, Event, MessageId } from '@taut/contract'

import { useMarkRead, useMe } from '@/lib/api'
import { useCurrentUser } from '@/hooks/use-directory'
import { live } from '@/lib/live'
import { applyRealtimeEvent } from '@/lib/realtime-cache'
import { realtime, type ConnectionStatus } from '@/lib/ws'

/** Tracks whether the tab is in front, so we only auto-read what is really read. */
function useWindowFocus(): boolean {
  const [focused, setFocused] = React.useState(() => document.hasFocus())

  React.useEffect(() => {
    const onFocus = (): void => setFocused(true)
    const onBlur = (): void => setFocused(false)
    window.addEventListener('focus', onFocus)
    window.addEventListener('blur', onBlur)
    return () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('blur', onBlur)
    }
  }, [])

  return focused
}

export interface RealtimeState {
  readonly status: ConnectionStatus
  readonly lastSeq: number
}

/**
 * Opens the single app socket for the active company and turns every event
 * into a cache edit. Mounted once, by the authenticated shell.
 */
export function useRealtime(currentChannelId: string | undefined): RealtimeState {
  const queryClient = useQueryClient()
  const me = useMe().data
  const currentUser = useCurrentUser()
  const focused = useWindowFocus()
  const markRead = useMarkRead()
  const mutateMarkRead = markRead.mutate

  const status = React.useSyncExternalStore(realtime.subscribeSnapshot, realtime.getStatus)
  const lastSeq = React.useSyncExternalStore(realtime.subscribeSnapshot, realtime.getLastSeq)

  const companyId: CompanyId | undefined = me?.activeCompanyId
  const currentUserId = me?.user.id
  const currentUserHandle = currentUser?.handle

  // The subscription is opened once; the handler behind it is refreshed after
  // every render so it always sees the current route and session.
  const handlerRef = React.useRef<(event: Event) => void>(() => undefined)

  React.useEffect(() => {
    handlerRef.current = (event) => {
      applyRealtimeEvent(event, {
        queryClient,
        currentUserId,
        currentUserHandle,
        currentChannelId,
        focused,
        onRead: (channelId) => {
          live.clearUnread(channelId)
          if (realtime.lastSeq > 0) {
            mutateMarkRead({ channelId, lastReadSeq: realtime.lastSeq })
          }
        }
      })
    }
  }, [queryClient, currentUserId, currentUserHandle, currentChannelId, focused, mutateMarkRead])

  React.useEffect(() => {
    const unsubscribeEvents = realtime.subscribe((event) => handlerRef.current(event))
    const unsubscribeResync = realtime.onResync(() => {
      void queryClient.invalidateQueries()
    })
    return () => {
      unsubscribeEvents()
      unsubscribeResync()
    }
  }, [queryClient])

  React.useEffect(() => {
    if (companyId === undefined) return
    realtime.connect(companyId)
    return () => {
      realtime.close()
    }
  }, [companyId])

  return { status, lastSeq }
}

const TYPING_INTERVAL_MS = 2000

/** `typing` frames from the composer, at most one every two seconds. */
export function useTypingSender(
  channelId: ChannelId | undefined,
  threadId?: MessageId
): () => void {
  const lastSentRef = React.useRef(0)

  return React.useCallback(() => {
    if (channelId === undefined) return
    const now = Date.now()
    if (now - lastSentRef.current < TYPING_INTERVAL_MS) return
    lastSentRef.current = now
    realtime.send({ type: 'typing', channelId, threadId })
  }, [channelId, threadId])
}

/** Marks a channel read when it is opened, and whenever it regains focus. */
export function useMarkReadOnView(channelId: ChannelId | undefined): void {
  const markRead = useMarkRead()
  const mutate = markRead.mutate
  const focused = useWindowFocus()

  // `lastSeq` is 0 until the socket has replayed; marking read there would
  // rewind `channel_members.last_read_seq`. Depend on the boolean, not the
  // number, so opening a channel is one request rather than one per event —
  // new messages while the channel is focused are read by `applyRealtimeEvent`.
  const ready = React.useSyncExternalStore(realtime.subscribeSnapshot, realtime.getLastSeq) > 0

  React.useEffect(() => {
    if (channelId === undefined || !focused || !ready) return
    live.clearUnread(channelId)
    mutate({ channelId, lastReadSeq: realtime.lastSeq })
  }, [channelId, focused, ready, mutate])
}
