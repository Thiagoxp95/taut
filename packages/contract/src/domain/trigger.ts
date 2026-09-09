/**
 * What makes a routine fire (docs/build-plan-triggers.md D1). A routine is "a named prompt that
 * fires on a condition"; the condition was always the variable part, and the clock is only one
 * kind of it. `Trigger` is that condition: a `Schedule` in one arm, a bus event in the other.
 *
 * The event catalogue is a closed union whose `_tag` **is** the event name (D3), so matching is a
 * switch on the same literal the bus carries and no filter can be built that cannot match. Each
 * variant carries only the filters that make sense for it; adding an event later is one variant,
 * one `matchesEvent` case and one `describeTrigger` sentence.
 *
 * Everything here is pure and total, because the web previews on it and the server fires on it —
 * a disagreement between the two would be a user-visible bug, the same reason `nextRuns` lives in
 * `schedule.ts`. `matchesEvent` deliberately contains **no** D6 (self-trigger) or D7 (rate cap)
 * logic: those need the routine and its history, not the trigger.
 */
import { Schema } from 'effect'

import type { Event } from '../events.js'
import type { ValidationIssue } from '../errors.js'
import { AgentId, ChannelId, ProjectId } from '../ids.js'
import { MemberKind } from './enums.js'
import { Schedule, Timezone, describeSchedule, validateSchedule } from './schedule.js'
import { SignalName } from './signal.js'

// --- the event catalogue (D4) --------------------------------------------

export const CallEndedTrigger = Schema.TaggedStruct('call.ended', {
  /** Empty = any channel the agent can see. */
  channelIds: Schema.optionalWith(Schema.Array(ChannelId), { default: () => [] }),
  /** Ignore huddles shorter than this — a misclick is not a meeting. 0 = fire on all. */
  minSeconds: Schema.optionalWith(Schema.Int.pipe(Schema.between(0, 3600)), { default: () => 60 })
})
export type CallEndedTrigger = typeof CallEndedTrigger.Type

export const CallStartedTrigger = Schema.TaggedStruct('call.started', {
  channelIds: Schema.optionalWith(Schema.Array(ChannelId), { default: () => [] })
})
export type CallStartedTrigger = typeof CallStartedTrigger.Type

/**
 * Loud by nature, so the filter is mandatory: at least one channel, and by default only
 * humans. Combined with D6 (never the routine's own agent) this cannot self-feed.
 */
export const MessageCreatedTrigger = Schema.TaggedStruct('message.created', {
  channelIds: Schema.NonEmptyArray(ChannelId),
  authorKinds: Schema.optionalWith(Schema.NonEmptyArray(MemberKind), {
    default: () => ['user'] as const
  }),
  /** Case-insensitive substring the body must contain. Absent = every message. */
  containing: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  /** Replies in a thread, or only top-level posts. */
  includeThreadReplies: Schema.optionalWith(Schema.Boolean, { default: () => false })
})
export type MessageCreatedTrigger = typeof MessageCreatedTrigger.Type

export const TaskFailedTrigger = Schema.TaggedStruct('agent.task.failed', {
  /**
   * Empty = any agent in the company. Watching yourself is allowed here: D6 only blocks the
   * *actor*, and a failed task has no actor.
   */
  agentIds: Schema.optionalWith(Schema.Array(AgentId), { default: () => [] })
})
export type TaskFailedTrigger = typeof TaskFailedTrigger.Type

export const IssueCreatedTrigger = Schema.TaggedStruct('project.issue.created', {
  /** Empty = any project in the company's mirror. */
  projectIds: Schema.optionalWith(Schema.Array(ProjectId), { default: () => [] })
})
export type IssueCreatedTrigger = typeof IssueCreatedTrigger.Type

/**
 * The sixth variant (D17): an agent-emitted signal. D3 was built for this — listening for a
 * signal is one more case everywhere, not a second subscription mechanism. The custom name is
 * data inside `signal.emitted`, never an `EventType` of its own (D16).
 */
export const SignalTrigger = Schema.TaggedStruct('signal.emitted', {
  names: Schema.NonEmptyArray(SignalName),
  /** Empty = from anyone. A broadcast listener usually leaves this empty. */
  fromAgentIds: Schema.optionalWith(Schema.Array(AgentId), { default: () => [] })
})
export type SignalTrigger = typeof SignalTrigger.Type

export const EventTrigger = Schema.Union(
  CallEndedTrigger,
  CallStartedTrigger,
  MessageCreatedTrigger,
  TaskFailedTrigger,
  IssueCreatedTrigger,
  SignalTrigger
)
export type EventTrigger = typeof EventTrigger.Type

/** The `EventType` an `EventTrigger` listens for — its own tag (D3). */
export type TriggerEventType = EventTrigger['_tag']
export const TriggerEventType = Schema.Literal(
  'call.ended',
  'call.started',
  'message.created',
  'agent.task.failed',
  'project.issue.created',
  'signal.emitted'
) satisfies Schema.Schema<TriggerEventType>

// --- the trigger ----------------------------------------------------------

export const ScheduleTrigger = Schema.TaggedStruct('schedule', {
  schedule: Schedule,
  /** IANA zone, e.g. "America/Toronto". Wall-clock times are read in it (routines D4). */
  timezone: Timezone
})
export type ScheduleTrigger = typeof ScheduleTrigger.Type

export const Trigger = Schema.Union(
  ScheduleTrigger,
  Schema.TaggedStruct('event', { event: EventTrigger })
)
export type Trigger = typeof Trigger.Type

/**
 * Which arm a trigger is in — the server's denormalised `trigger_kind` column and the
 * `ListRoutinesQuery` filter chip (D9, D14).
 */
export type TriggerKind = Trigger['_tag']
export const TriggerKind = Schema.Literal('schedule', 'event') satisfies Schema.Schema<TriggerKind>

// --- matching -------------------------------------------------------------

/**
 * Facts a filter needs that the `Event` payload does not carry. Exactly one today: how long a
 * huddle lasted, because `call.ended` carries `{ callId, channelId, endedAt }` and nothing more
 * (D5). The runner loads the `Call` anyway to render the context block, so it has this in hand;
 * when it is missing, a `minSeconds` filter cannot be satisfied and the occurrence is dropped —
 * a misconfigured trigger degrades into silence, never into a spurious fire (D7's posture).
 */
export interface EventFacts {
  readonly callDurationSeconds?: number | undefined
}

/** Empty list = "any of them"; every id filter in the catalogue reads this way. */
const anyOrIncludes = (ids: ReadonlyArray<string>, id: string): boolean =>
  ids.length === 0 || ids.some((candidate) => candidate === id)

/**
 * Does this event satisfy this trigger's filters? A switch on `trigger._tag`, whose every arm
 * starts by comparing that tag to `event.type` (D3): one comparison rules out every mismatch and
 * narrows the payload at the same time. Pure, total, and free of D6/D7 — those are the runner's.
 */
export const matchesEvent = (
  trigger: EventTrigger,
  event: Event,
  facts: EventFacts = {}
): boolean => {
  switch (trigger._tag) {
    case 'call.ended': {
      if (event.type !== trigger._tag) return false
      if (!anyOrIncludes(trigger.channelIds, event.payload.channelId)) return false
      if (trigger.minSeconds <= 0) return true
      return (facts.callDurationSeconds ?? -1) >= trigger.minSeconds
    }
    case 'call.started': {
      if (event.type !== trigger._tag) return false
      return anyOrIncludes(trigger.channelIds, event.payload.call.channelId)
    }
    case 'message.created': {
      if (event.type !== trigger._tag) return false
      const message = event.payload.message
      if (!anyOrIncludes(trigger.channelIds, message.channelId)) return false
      if (!trigger.authorKinds.some((kind) => kind === message.authorKind)) return false
      if (!trigger.includeThreadReplies && message.threadId !== undefined) return false
      if (trigger.containing === undefined) return true
      return message.body.toLowerCase().includes(trigger.containing.toLowerCase())
    }
    case 'agent.task.failed': {
      if (event.type !== trigger._tag) return false
      return anyOrIncludes(trigger.agentIds, event.payload.task.agentId)
    }
    case 'project.issue.created': {
      if (event.type !== trigger._tag) return false
      return anyOrIncludes(trigger.projectIds, event.payload.projectId)
    }
    case 'signal.emitted': {
      if (event.type !== trigger._tag) return false
      const signal = event.payload.signal
      if (!trigger.names.some((name) => name === signal.name)) return false
      // a broadcast from a human matches only a listener that asked for anyone
      if (trigger.fromAgentIds.length === 0) return true
      return (
        signal.emittedByKind === 'agent' && anyOrIncludes(trigger.fromAgentIds, signal.emittedById)
      )
    }
  }
}

// --- describe -------------------------------------------------------------

/**
 * Turns an id into what a human calls it — `#design`, `@nova`, `Taut v2`. The web passes a
 * lookup, the server passes nothing and prints ids, and both get the same sentence otherwise.
 */
export type TriggerNames = (id: string) => string | undefined

/** "a", "a and b", "a, b and c" — the same joiner `describeSchedule` uses. */
const list = (items: ReadonlyArray<string>): string =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

const named = (ids: ReadonlyArray<string>, names?: TriggerNames): string =>
  list(ids.map((id) => names?.(id) ?? id))

/** ` in #design and #eng`, or nothing at all when the filter is empty (= any channel). */
const inChannels = (ids: ReadonlyArray<string>, names?: TriggerNames): string =>
  ids.length === 0 ? '' : ` in ${named(ids, names)}`

const describeMinSeconds = (seconds: number): string =>
  seconds % 60 === 0 ? `over ${seconds / 60} min` : `over ${seconds} seconds`

/** "anyone", "an agent", "anyone or an agent" — the subject of a `message.created` sentence. */
const describeAuthorKinds = (kinds: ReadonlyArray<MemberKind>): string => {
  const people = kinds.includes('user')
  const agents = kinds.includes('agent')
  if (people && agents) return 'anyone or an agent'
  return agents ? 'an agent' : 'anyone'
}

const describeEventTrigger = (trigger: EventTrigger, names?: TriggerNames): string => {
  switch (trigger._tag) {
    case 'call.ended': {
      const shorter = trigger.minSeconds > 0 ? ` (${describeMinSeconds(trigger.minSeconds)})` : ''
      return `When a huddle ends${inChannels(trigger.channelIds, names)}${shorter}`
    }
    case 'call.started':
      return `When a huddle starts${inChannels(trigger.channelIds, names)}`
    case 'message.created': {
      const containing =
        trigger.containing === undefined ? '' : ` containing "${trigger.containing}"`
      const replies = trigger.includeThreadReplies ? ', including thread replies' : ''
      const who = describeAuthorKinds(trigger.authorKinds)
      return `When ${who} posts${inChannels(trigger.channelIds, names)}${containing}${replies}`
    }
    case 'agent.task.failed':
      return trigger.agentIds.length === 0
        ? "When any agent's run fails"
        : `When ${named(trigger.agentIds, names)}'s run fails`
    case 'project.issue.created':
      return trigger.projectIds.length === 0
        ? 'When an issue is filed in any project'
        : `When an issue is filed in ${named(trigger.projectIds, names)}`
    case 'signal.emitted': {
      const signals = list(trigger.names.map((name) => `\`${name}\``))
      const from =
        trigger.fromAgentIds.length === 0 ? '' : ` by ${named(trigger.fromAgentIds, names)}`
      return `When the signal ${signals} is emitted${from}`
    }
  }
}

/**
 * The human sentence for a trigger, identical in list rows and the dialog preview (D14) —
 * "When a huddle ends in #design (over 1 min)", "Every weekday at 9:00 AM". The schedule arm
 * delegates to `describeSchedule`, which is the only place that knows how to say a clock.
 */
export const describeTrigger = (trigger: Trigger, names?: TriggerNames): string =>
  trigger._tag === 'schedule'
    ? describeSchedule(trigger.schedule, trigger.timezone)
    : describeEventTrigger(trigger.event, names)

// --- validate -------------------------------------------------------------

/** Paths are relative to the `trigger` field itself, so an issue points at `trigger.event.…`. */
const under = (
  prefix: string,
  issues: ReadonlyArray<ValidationIssue>
): ReadonlyArray<ValidationIssue> =>
  issues.map((issue) => ({ ...issue, path: [prefix, ...issue.path] }))

const validateEventTrigger = (trigger: EventTrigger): ReadonlyArray<ValidationIssue> => {
  const issues: Array<ValidationIssue> = []
  const checkContaining = (containing: string | undefined) => {
    if (containing !== undefined && containing.trim() === '') {
      issues.push({
        path: ['containing'],
        message: 'type something to look for, or leave it empty'
      })
    }
  }
  const checkNonEmpty = (path: string, values: ReadonlyArray<unknown>, message: string) => {
    if (values.length === 0) issues.push({ path: [path], message })
  }
  switch (trigger._tag) {
    case 'message.created':
      checkNonEmpty('channelIds', trigger.channelIds, 'pick at least one channel')
      checkNonEmpty('authorKinds', trigger.authorKinds, 'pick at least one kind of author')
      checkContaining(trigger.containing)
      break
    case 'signal.emitted':
      checkNonEmpty('names', trigger.names, 'name at least one signal')
      trigger.names.forEach((name, i) => {
        // the same shape `SignalName` brands on decode (D28), checked here so the editor can say so
        if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name)) {
          issues.push({
            path: ['names', i],
            message: 'expected lower-case letters, digits, ".", "_" or "-" (max 64)'
          })
        }
      })
      break
    case 'call.ended':
    case 'call.started':
    case 'agent.task.failed':
    case 'project.issue.created':
      break
  }
  return issues
}

/**
 * Everything the editor can get wrong before the payload is decoded, same shape as
 * `Validation.issues` so the server can throw the result as-is. `[]` means valid.
 */
export const validateTrigger = (trigger: Trigger): ReadonlyArray<ValidationIssue> =>
  trigger._tag === 'schedule'
    ? under('schedule', validateSchedule(trigger.schedule))
    : under('event', validateEventTrigger(trigger.event))
