import { Notification, app } from 'electron'
import type { NotificationKind } from '@taut/contract/domain'
import type { Event } from '@taut/contract/events'
import { Effect, Stream } from 'effect'

/** Same wording as the in-app toast in `apps/web/src/lib/realtime-cache.ts`. */
const TITLE: Record<NotificationKind, string> = {
  mention: 'You were mentioned',
  dm: 'New direct message',
  thread_reply: 'New reply in a thread you are in',
  agent_done: 'An agent finished',
  agent_failed: 'An agent run failed',
  huddle: 'A huddle started'
}

const BODY_LIMIT = 220
/** Enough to cover the gap between a message and the notification it caused. */
const SEQ_MEMORY = 300

interface Origin {
  readonly channelId: string
  readonly threadId?: string
  readonly body: string
}

interface Counts {
  readonly unread: number
  readonly mentions: number
}

const truncate = (body: string): string =>
  body.length <= BODY_LIMIT ? body : `${body.slice(0, BODY_LIMIT - 1)}…`

export interface ShellHooks {
  /** Bring the app forward and route the web client. */
  readonly open: (path: string) => void
}

/**
 * Turns the shell's event stream into the two things only the OS can do:
 * a notification centre entry and a dock/taskbar badge.
 *
 * `notification` events carry only the seq of the event that caused them, so
 * the last few hundred messages are kept by seq to recover the channel and the
 * text — the same trick `apps/web/src/lib/live.ts` uses for its toasts.
 */
export const runNotifier = (
  events: Stream.Stream<Event>,
  hooks: ShellHooks
): Effect.Effect<void> => {
  const origins = new Map<number, Origin>()
  const counts = new Map<string, Counts>()
  /** Channels whose plain unread should badge, learned from `dm` notifications. */
  const dmChannels = new Set<string>()
  let badge = -1

  const remember = (seq: number, origin: Origin): void => {
    origins.set(seq, origin)
    if (origins.size > SEQ_MEMORY) {
      const oldest = origins.keys().next()
      if (!oldest.done) origins.delete(oldest.value)
    }
  }

  const pathFor = (channelId: string | undefined, threadId: string | undefined): string => {
    if (channelId === undefined) return '/'
    // The renderer rewrites `/c/` to `/dm/` when the channel is a DM; the main
    // process has no channel directory of its own.
    return threadId === undefined
      ? `/c/${channelId}`
      : `/c/${channelId}?thread=${encodeURIComponent(threadId)}`
  }

  const applyBadge = (): void => {
    let total = 0
    for (const [channelId, count] of counts) {
      total += dmChannels.has(channelId) ? Math.max(count.unread, count.mentions) : count.mentions
    }
    if (total === badge) return
    badge = total
    setBadgeCount(total)
  }

  /** Returns a one-line trace of what the event did, for the debug log. */
  const handle = (event: Event): string | undefined => {
    switch (event.type) {
      case 'message.created': {
        const { message } = event.payload
        remember(event.seq, {
          channelId: message.channelId,
          ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
          body: message.body
        })
        return undefined
      }

      case 'agent.task.done':
      case 'agent.task.failed': {
        const { message } = event.payload
        remember(event.seq, {
          channelId: message.channelId,
          ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
          body: message.body
        })
        return undefined
      }

      case 'notification': {
        const { notification } = event.payload
        const origin = origins.get(notification.eventSeq)
        const channelId = event.payload.channelId ?? origin?.channelId
        if (notification.kind === 'dm' && channelId !== undefined) {
          dmChannels.add(channelId)
          applyBadge()
        }
        const path = pathFor(channelId, origin?.threadId)
        show({ title: TITLE[notification.kind], body: truncate(origin?.body ?? ''), path, hooks })
        return `notifier: ${notification.kind} → ${path}`
      }

      case 'unread.changed': {
        const { channelId, unread, mentions } = event.payload
        if (unread === 0 && mentions === 0) {
          counts.delete(channelId)
          dmChannels.delete(channelId)
        } else {
          counts.set(channelId, { unread, mentions })
        }
        applyBadge()
        return `notifier: badge ${badge} (${channelId} unread=${unread} mentions=${mentions})`
      }

      default:
        return undefined
    }
  }

  return events.pipe(
    Stream.runForEach((event) =>
      Effect.sync(() => handle(event)).pipe(
        Effect.flatMap((trace) => (trace === undefined ? Effect.void : Effect.logInfo(trace)))
      )
    ),
    Effect.catchAllCause((cause) => Effect.logError('notifier: stream ended', cause))
  )
}

/** macOS shows a dot for an empty string; every other platform wants the number. */
export const setBadgeCount = (count: number): void => {
  const safe = Number.isFinite(count) && count > 0 ? Math.floor(count) : 0
  if (process.platform === 'darwin' && app.dock !== undefined) {
    app.dock.setBadge(safe === 0 ? '' : String(safe))
    return
  }
  app.setBadgeCount(safe)
}

export const show = (options: {
  readonly title: string
  readonly body: string
  readonly path: string
  readonly hooks: ShellHooks
}): void => {
  if (!Notification.isSupported()) return
  // `silent`: the page plays the owner's own pop for the same notification
  // (docs/build-plan-huddle-window.md D10), and two sounds for one event is one too many.
  const notification = new Notification({
    title: options.title,
    body: options.body,
    silent: true
  })
  notification.on('click', () => options.hooks.open(options.path))
  // Silently refused when the OS has not authorised the app (an unsigned dev
  // build on macOS, notifications turned off): say so rather than vanish.
  notification.on('failed', (_event, error) =>
    console.warn(`[taut] the OS refused a notification: ${error}`)
  )
  notification.show()
}
