import type { Event } from '@taut/contract/events'
import { Effect, Stream } from 'effect'
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
export declare const runNotifier: (
  events: Stream.Stream<Event>,
  hooks: ShellHooks
) => Effect.Effect<void>
/** macOS shows a dot for an empty string; every other platform wants the number. */
export declare const setBadgeCount: (count: number) => void
export declare const show: (options: {
  readonly title: string
  readonly body: string
  readonly path: string
  readonly hooks: ShellHooks
}) => void
