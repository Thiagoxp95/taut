/**
 * Client-only state that the REST contract does not model: presence, unread
 * counters, "X is typing…", and the error text of a failed agent run.
 *
 * All of it is fed by the `/ws` event stream (`realtime-cache.ts`) and read
 * through `useSyncExternalStore`, so it never round-trips through the router.
 */
import * as React from 'react'
import type { AgentPresence, ThreadContext, UserPresence } from '@taut/contract'
import {
  emptyCanvasState,
  reduceCanvasScopes,
  type CanvasAction,
  type CanvasState
} from './canvas-state'

export type Presence = UserPresence | AgentPresence

/** The line under a streaming reply: a brief public progress summary, or the tool it just called. */
export interface Activity {
  readonly kind: 'thinking' | 'tool'
  readonly text: string
}

class Store<T> {
  #value: T
  #listeners = new Set<() => void>()

  constructor(initial: T) {
    this.#value = initial
    this.subscribe = this.subscribe.bind(this)
    this.get = this.get.bind(this)
  }

  get(): T {
    return this.#value
  }

  set(next: T): void {
    if (Object.is(next, this.#value)) return
    this.#value = next
    for (const listener of this.#listeners) listener()
  }

  update(f: (current: T) => T): void {
    this.set(f(this.#value))
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }
}

export interface UnreadCounts {
  readonly unread: number
  readonly mentions: number
}

const NO_UNREAD: UnreadCounts = { unread: 0, mentions: 0 }
const NO_TYPING: readonly string[] = []
const NO_CONTEXTS: readonly ThreadContext[] = []

const presenceStore = new Store<ReadonlyMap<string, Presence>>(new Map())
const unreadStore = new Store<ReadonlyMap<string, UnreadCounts>>(new Map())
const typingStore = new Store<ReadonlyMap<string, ReadonlyMap<string, number>>>(new Map())
const messageErrorStore = new Store<ReadonlyMap<string, string>>(new Map())
/**
 * Trigger message id → how many of its agent runs are still going
 * (docs/build-plan-shimmer.md D2/D5). A message shimmers while its count is above zero, so
 * mentioning two agents in one line is still one shimmer, ending with the slower of them.
 */
const liveTriggerStore = new Store<ReadonlyMap<string, number>>(new Map())

/**
 * Streaming message id → what its agent is doing this second
 * (docs/build-plan-activity.md). One line, replaced in place, gone the moment the run ends:
 * it is the narration under a reply that has not written its first word, not a history.
 */
const activityStore = new Store<ReadonlyMap<string, Activity>>(new Map())

/**
 * `agentId:threadId` → how full that copy's window is
 * (docs/build-plan-context-meter.md). The key is the pair because the pair is what owns a
 * context: the same agent in two threads is two windows, and two agents in one thread are
 * two more. Fed by `agent.context.updated`, seeded from `GET /channels/:id/context` so a
 * refresh mid-run does not blank every ring on screen.
 */
const contextStore = new Store<ReadonlyMap<string, ThreadContext>>(new Map())
const canvasStore = new Store<ReadonlyMap<string, CanvasState>>(new Map())

const contextKey = (agentId: string, threadId: string): string => `${agentId}:${threadId}`

export interface ThreadRun {
  readonly threadId: string
  readonly messageId: string
  readonly agentId: string
}

const threadRunStore = new Store<readonly ThreadRun[]>([])

export interface BrowserRun extends ThreadRun {
  readonly taskId: string
  readonly channelId: string
}
const browserRunStore = new Store<readonly BrowserRun[]>([])

/**
 * Task id → the message that triggered it, so an end event can find what to decrement, plus the
 * epoch the start was seen at. The epoch is what keeps the seed (D9) from undoing the socket
 * (D2): `GET /tasks?live=true` is refetched on every task event, and its snapshot is taken before
 * it lands, so a run that starts inside that window is missing from an answer that is already
 * stale. Mentioning two agents in one line does exactly that — the second task starts while the
 * first task's refetch is in flight — and reseeding blindly dropped it, leaving the message flat
 * while the second agent was still writing.
 */
interface CountedTask {
  readonly reply?: ThreadRun
  readonly triggerMessageId: string
  readonly epoch: number
}

const countedTasks = new Map<string, CountedTask>()

function publishThreadRuns(): void {
  threadRunStore.set(
    [...countedTasks.values()].flatMap((entry) => (entry.reply === undefined ? [] : [entry.reply]))
  )
}

/** Bumped by every run start the socket reports, so a seed can date its own snapshot. */
let runEpoch = 0

/**
 * Task ids whose end event already arrived. A snapshot older than that end still lists them as
 * live, and re-adding one would shimmer a message that nothing will ever switch off.
 */
const endedTasks = new Set<string>()
const ENDED_MEMORY = 200

/** `notification` events only carry an `eventSeq`; this maps it back to a channel. */
const seqToChannel = new Map<number, string>()
const SEQ_MEMORY = 500

const TYPING_TTL_MS = 3000

function withEntry<K, V>(map: ReadonlyMap<K, V>, key: K, value: V): ReadonlyMap<K, V> {
  const next = new Map(map)
  next.set(key, value)
  return next
}

export const live = {
  setBrowserRun(run: BrowserRun): void {
    if (endedTasks.has(run.taskId)) return
    browserRunStore.update((runs) =>
      runs.some((current) => current.taskId === run.taskId) ? runs : [...runs, run]
    )
  },

  canvas(channelId: string, action: CanvasAction, threadId?: string): void {
    canvasStore.update((current) => reduceCanvasScopes(current, channelId, action, threadId))
  },

  setPresence(memberId: string, presence: Presence): void {
    presenceStore.update((current) =>
      current.get(memberId) === presence ? current : withEntry(current, memberId, presence)
    )
  },

  setUnread(channelId: string, counts: UnreadCounts): void {
    unreadStore.update((current) => withEntry(current, channelId, counts))
  },

  bumpUnread(channelId: string, mention: boolean): void {
    unreadStore.update((current) => {
      const existing = current.get(channelId) ?? NO_UNREAD
      return withEntry(current, channelId, {
        unread: existing.unread + 1,
        mentions: existing.mentions + (mention ? 1 : 0)
      })
    })
  },

  clearUnread(channelId: string): void {
    unreadStore.update((current) => {
      if (!current.has(channelId)) return current
      const next = new Map(current)
      next.delete(channelId)
      return next
    })
  },

  markTyping(channelId: string, userId: string): void {
    const expiresAt = Date.now() + TYPING_TTL_MS
    typingStore.update((current) =>
      withEntry(
        current,
        channelId,
        withEntry(current.get(channelId) ?? new Map(), userId, expiresAt)
      )
    )
    setTimeout(() => {
      typingStore.update((current) => {
        const channel = current.get(channelId)
        if (channel === undefined) return current
        const still = new Map(channel)
        for (const [id, at] of still) if (at <= Date.now()) still.delete(id)
        return withEntry(current, channelId, still)
      })
    }, TYPING_TTL_MS + 50)
  },

  /** The newest line wins; there is only ever one per message. */
  setActivity(messageId: string, activity: Activity): void {
    activityStore.update((current) => withEntry(current, messageId, activity))
  },

  /** The run ended: the narration goes with it, whether the reply landed or failed. */
  clearActivity(messageId: string): void {
    activityStore.update((current) => {
      if (!current.has(messageId)) return current
      const next = new Map(current)
      next.delete(messageId)
      return next
    })
  },

  setMessageError(messageId: string, error: string): void {
    messageErrorStore.update((current) => withEntry(current, messageId, error))
  },

  /** A run against `triggerMessageId` started. */
  startRun(triggerMessageId: string | undefined, taskId: string, reply?: ThreadRun): void {
    if (triggerMessageId === undefined) return
    if (countedTasks.has(taskId)) return
    runEpoch += 1
    countedTasks.set(taskId, { triggerMessageId, epoch: runEpoch, reply })
    publishThreadRuns()
    liveTriggerStore.update((current) =>
      withEntry(current, triggerMessageId, (current.get(triggerMessageId) ?? 0) + 1)
    )
  },

  /** A run ended — done, failed or cancelled alike (D7): the shimmer must stop either way. */
  endRun(taskId: string): void {
    browserRunStore.update((runs) => runs.filter((run) => run.taskId !== taskId))
    const entry = countedTasks.get(taskId)
    countedTasks.delete(taskId)
    publishThreadRuns()
    endedTasks.add(taskId)
    if (endedTasks.size > ENDED_MEMORY) {
      const oldest = endedTasks.values().next()
      if (oldest.done !== true) endedTasks.delete(oldest.value)
    }
    if (entry === undefined) return
    liveTriggerStore.update((current) => {
      const left = (current.get(entry.triggerMessageId) ?? 1) - 1
      const next = new Map(current)
      if (left > 0) next.set(entry.triggerMessageId, left)
      else next.delete(entry.triggerMessageId)
      return next
    })
  },

  /** The epoch to read before a seed query goes out, and to hand back to `seedRuns` (D9). */
  runEpoch(): number {
    return runEpoch
  },

  /**
   * Rebuild the set from `GET /api/tasks?live=true` (D9). `since` is the epoch when that request
   * went out: anything the socket started after it survives the rebuild, because the snapshot was
   * taken too early to know about it. Everything else is the snapshot's to decide, which is what
   * makes this the recovery path after a refresh or a reconnect.
   */
  seedRuns(
    runs: ReadonlyArray<
      { readonly taskId: string; readonly triggerMessageId?: string } & Partial<ThreadRun>
    >,
    since = runEpoch
  ): void {
    const kept = new Map<string, CountedTask>()
    for (const [taskId, entry] of countedTasks) {
      if (entry.epoch > since) kept.set(taskId, entry)
    }
    for (const run of runs) {
      if (run.triggerMessageId === undefined) continue
      if (kept.has(run.taskId) || endedTasks.has(run.taskId)) continue
      kept.set(run.taskId, {
        triggerMessageId: run.triggerMessageId,
        epoch: since,
        reply:
          run.threadId !== undefined && run.messageId !== undefined && run.agentId !== undefined
            ? { threadId: run.threadId, messageId: run.messageId, agentId: run.agentId }
            : undefined
      })
    }
    countedTasks.clear()
    const counts = new Map<string, number>()
    for (const [taskId, entry] of kept) {
      countedTasks.set(taskId, entry)
      counts.set(entry.triggerMessageId, (counts.get(entry.triggerMessageId) ?? 0) + 1)
    }
    liveTriggerStore.set(counts)
    browserRunStore.update((current) => current.filter((run) => kept.has(run.taskId)))
    publishThreadRuns()
  },

  setThreadContext(context: ThreadContext): void {
    contextStore.update((current) =>
      withEntry(current, contextKey(context.agentId, context.threadId), context)
    )
  },

  /** Replace every window in one channel from `GET /channels/:id/context`. */
  seedThreadContexts(contexts: ReadonlyArray<ThreadContext>): void {
    contextStore.update((current) => {
      const next = new Map(current)
      for (const context of contexts)
        next.set(contextKey(context.agentId, context.threadId), context)
      return next
    })
  },

  rememberSeq(seq: number, channelId: string): void {
    seqToChannel.set(seq, channelId)
    if (seqToChannel.size > SEQ_MEMORY) {
      const oldest = seqToChannel.keys().next()
      if (oldest.done !== true) seqToChannel.delete(oldest.value)
    }
  },

  channelForSeq(seq: number): string | undefined {
    return seqToChannel.get(seq)
  },

  /** Company switch: none of this survives the boundary. */
  reset(): void {
    presenceStore.set(new Map())
    unreadStore.set(new Map())
    typingStore.set(new Map())
    messageErrorStore.set(new Map())
    liveTriggerStore.set(new Map())
    activityStore.set(new Map())
    browserRunStore.set([])
    contextStore.set(new Map())
    canvasStore.set(new Map())
    countedTasks.clear()
    publishThreadRuns()
    endedTasks.clear()
    runEpoch = 0
    seqToChannel.clear()
  }
}

export function useCanvasState(channelId: string, threadId?: string): CanvasState {
  const map = React.useSyncExternalStore(canvasStore.subscribe, canvasStore.get)
  return (
    map.get(threadId === undefined ? channelId : `${channelId}:${threadId}`) ?? emptyCanvasState
  )
}

export function usePresence(memberId: string | undefined, fallback: Presence): Presence {
  const map = React.useSyncExternalStore(presenceStore.subscribe, presenceStore.get)
  return (memberId === undefined ? undefined : map.get(memberId)) ?? fallback
}

/**
 * How full `agentId`'s window is in `threadId`, or `undefined` when nothing is known —
 * which is the normal state before the agent's first turn, and the permanent state for a
 * runtime that reports no usage (docs/build-plan-context-meter.md D5).
 */
export function useThreadContext(
  agentId: string | undefined,
  threadId: string | undefined
): ThreadContext | undefined {
  const map = React.useSyncExternalStore(contextStore.subscribe, contextStore.get)
  if (agentId === undefined || threadId === undefined) return undefined
  return map.get(contextKey(agentId, threadId))
}

/**
 * Every agent window open in `threadId`. Two agents in one thread hold two, which is the case
 * the thread header exists to make visible (docs/build-plan-context-meter.md D11).
 */
export function useThreadContexts(threadId: string | undefined): ReadonlyArray<ThreadContext> {
  const map = React.useSyncExternalStore(contextStore.subscribe, contextStore.get)
  return React.useMemo(() => {
    if (threadId === undefined) return NO_CONTEXTS
    const found = [...map.values()].filter((context) => context.threadId === threadId)
    return found.length === 0 ? NO_CONTEXTS : found
  }, [map, threadId])
}

export function useUnread(channelId: string): UnreadCounts {
  const map = React.useSyncExternalStore(unreadStore.subscribe, unreadStore.get)
  return map.get(channelId) ?? NO_UNREAD
}

/** User ids currently typing in `channelId`, excluding `exceptUserId`. */
export function useTypingUsers(channelId: string, exceptUserId?: string): readonly string[] {
  const map = React.useSyncExternalStore(typingStore.subscribe, typingStore.get)
  const channel = map.get(channelId)
  // Expiry is swept by the timer in `markTyping`, never computed during render.
  return React.useMemo(() => {
    if (channel === undefined) return NO_TYPING
    const ids: string[] = []
    for (const userId of channel.keys()) {
      if (userId !== exceptUserId) ids.push(userId)
    }
    return ids.length === 0 ? NO_TYPING : ids
  }, [channel, exceptUserId])
}

/**
 * What `messageId`'s agent is doing right now, or `undefined` when nothing has been said —
 * before the first tool call, and always for a runtime that reports neither reasoning nor
 * tools (cursor).
 */
export function useMessageActivity(messageId: string): Activity | undefined {
  const map = React.useSyncExternalStore(activityStore.subscribe, activityStore.get)
  return map.get(messageId)
}

export function useMessageError(messageId: string): string | undefined {
  const map = React.useSyncExternalStore(messageErrorStore.subscribe, messageErrorStore.get)
  return map.get(messageId)
}

/**
 * True while `messageId` has at least one agent run in flight, which is what the shimmer means
 * (docs/build-plan-shimmer.md D2).
 */
export function useIsInvoking(messageId: string): boolean {
  const map = React.useSyncExternalStore(liveTriggerStore.subscribe, liveTriggerStore.get)
  return (map.get(messageId) ?? 0) > 0
}

/** Pending replies remain visible even when the thread has never been opened. */
export function useThreadRuns(threadId: string): readonly ThreadRun[] {
  const runs = React.useSyncExternalStore(threadRunStore.subscribe, threadRunStore.get)
  return React.useMemo(() => runs.filter((run) => run.threadId === threadId), [runs, threadId])
}

/** The exact run behind this reply, for interrupting one agent without stopping its peers. */
export function useMessageTaskId(messageId: string): string | undefined {
  return React.useSyncExternalStore(threadRunStore.subscribe, () => {
    for (const [taskId, entry] of countedTasks) {
      if (entry.reply?.messageId === messageId) return taskId
    }
    return undefined
  })
}

/** Browser use stays attached to its task until completion, independent of status copy. */
export function useBrowserRuns(
  channelId: string | undefined,
  threadId?: string
): readonly BrowserRun[] {
  const runs = React.useSyncExternalStore(browserRunStore.subscribe, browserRunStore.get)
  return React.useMemo(
    () =>
      runs.filter(
        (run) =>
          run.channelId === channelId && (threadId === undefined || run.threadId === threadId)
      ),
    [runs, channelId, threadId]
  )
}
