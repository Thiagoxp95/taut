/**
 * The realtime event log (docs/agent-model.md §6). One `Event` per mutation,
 * numbered per company; the WebSocket replays from `?since=<seq>`.
 *
 * `Event` is a discriminated union on `type`, so `switch (event.type)` narrows
 * `event.payload`. `EventBody` is the `{ type, payload }` half the server's
 * `EventLog.append` takes before `seq`/`at` are assigned.
 */
import { Schema } from 'effect'

import { Agent, AgentSkill } from './domain/agent.js'
import { Call } from './domain/call.js'
import { Channel } from './domain/channel.js'
import { Company, Membership } from './domain/company.js'
import { ThreadContext } from './domain/context.js'
import { Department } from './domain/department.js'
import { AgentPresence, FileGrantMode, MemberKind, UserPresence } from './domain/enums.js'
import { Message } from './domain/message.js'
import { Handle } from './domain/primitives.js'
import { Notification } from './domain/notification.js'
import { LinearConnection, LinearUser, Project, ProjectIssue } from './domain/project.js'
import { GithubConnection, Repository } from './domain/repository.js'
import { Routine } from './domain/routine.js'
import { Signal } from './domain/signal.js'
import { Subscription } from './domain/subscription.js'
import { Task } from './domain/task.js'
import { User } from './domain/user.js'
import { VaultItemMeta } from './domain/vault.js'
import {
  AgentId,
  CallId,
  ChannelId,
  CompanyId,
  DepartmentId,
  EventSeq,
  MemberId,
  MessageId,
  ProjectId,
  RepositoryId,
  RoutineId,
  SubscriptionId,
  TaskId,
  UserId,
  VaultItemId
} from './ids.js'

const variant = <const T extends string, P extends Schema.Schema.Any>(type: T, payload: P) =>
  Schema.Struct({
    seq: EventSeq,
    companyId: CompanyId,
    at: Schema.DateTimeUtc,
    type: Schema.Literal(type),
    payload
  })

// --- messages -------------------------------------------------------------

/** An `@handle` in a message body resolved to a user or agent of the company. */
export const Mention = Schema.Struct({
  memberKind: MemberKind,
  memberId: MemberId,
  handle: Schema.String
})
export type Mention = typeof Mention.Type

/** `mentions` lists the resolved `@handle`s (users + agents); the scheduler keys off agent mentions. */
export const MessageCreated = variant(
  'message.created',
  Schema.Struct({ message: Message, mentions: Schema.optional(Schema.Array(Mention)) })
)
export const MessageUpdated = variant('message.updated', Schema.Struct({ message: Message }))
export const MessageDeleted = variant(
  'message.deleted',
  Schema.Struct({
    messageId: MessageId,
    channelId: ChannelId,
    threadId: Schema.optional(MessageId)
  })
)

// --- agent tasks ----------------------------------------------------------

/** `message` is the new `streaming` message the agent's output grows into. */
export const AgentTaskStarted = variant(
  'agent.task.started',
  Schema.Struct({ task: Task, message: Message })
)
/** Appended to the streaming message. Coalesced to ≤ 10/sec per task. */
export const AgentTaskDelta = variant(
  'agent.task.delta',
  Schema.Struct({ taskId: TaskId, messageId: MessageId, delta: Schema.String })
)
export const AgentTaskDone = variant(
  'agent.task.done',
  Schema.Struct({ task: Task, message: Message })
)
export const AgentTaskFailed = variant(
  'agent.task.failed',
  Schema.Struct({ task: Task, message: Message, error: Schema.String })
)

/**
 * How full an agent's window is, in one thread (docs/build-plan-context-meter.md D10).
 *
 * Emitted while the run is going, coalesced to at most one a second per task — the same
 * discipline `agent.task.delta` keeps, and for the same reason: watching the ring fill is
 * the point, ten broadcasts a second for a number that moves once a turn is not.
 */
export const AgentContextUpdated = variant('agent.context.updated', ThreadContext)

// --- presence / typing ----------------------------------------------------

export const PresencePayload = Schema.Union(
  Schema.Struct({ memberKind: Schema.Literal('user'), memberId: UserId, state: UserPresence }),
  Schema.Struct({ memberKind: Schema.Literal('agent'), memberId: AgentId, state: AgentPresence })
)
export type PresencePayload = typeof PresencePayload.Type
export const PresenceChanged = variant('presence.changed', PresencePayload)

/** Ephemeral: broadcast only, never written to the log (`seq` is the current head). */
export const Typing = variant(
  'typing',
  Schema.Struct({
    channelId: ChannelId,
    threadId: Schema.optional(MessageId),
    userId: UserId
  })
)

// --- per-user fan-out -----------------------------------------------------

/** `channelId`/`messageId` point at the message that caused it (set for every kind today). */
export const NotificationEvent = variant(
  'notification',
  Schema.Struct({
    notification: Notification,
    channelId: Schema.optional(ChannelId),
    messageId: Schema.optional(MessageId)
  })
)
export const UnreadChanged = variant(
  'unread.changed',
  Schema.Struct({
    userId: UserId,
    channelId: ChannelId,
    threadId: Schema.optional(MessageId),
    unread: Schema.NonNegativeInt,
    mentions: Schema.NonNegativeInt
  })
)

// --- directory (so the UI can live-update lists) --------------------------

export const MembershipCreated = variant(
  'membership.created',
  Schema.Struct({ membership: Membership, user: User })
)
export const MembershipUpdated = variant(
  'membership.updated',
  Schema.Struct({ membership: Membership })
)
export const MembershipDeleted = variant('membership.deleted', Schema.Struct({ userId: UserId }))

export const CompanyUpdated = variant('company.updated', Schema.Struct({ company: Company }))
/** The last event of a company's log; sockets on it get closed. */
export const CompanyDeleted = variant('company.deleted', Schema.Struct({ companyId: CompanyId }))

export const DepartmentCreated = variant(
  'department.created',
  Schema.Struct({ department: Department })
)
export const DepartmentUpdated = variant(
  'department.updated',
  Schema.Struct({ department: Department })
)
export const DepartmentDeleted = variant(
  'department.deleted',
  Schema.Struct({ departmentId: DepartmentId })
)

export const ChannelCreated = variant('channel.created', Schema.Struct({ channel: Channel }))
/** Also emitted when the member list changes. */
export const ChannelUpdated = variant('channel.updated', Schema.Struct({ channel: Channel }))
export const ChannelDeleted = variant('channel.deleted', Schema.Struct({ channelId: ChannelId }))

export const AgentCreated = variant('agent.created', Schema.Struct({ agent: Agent }))
export const AgentUpdated = variant('agent.updated', Schema.Struct({ agent: Agent }))
export const AgentDeleted = variant('agent.deleted', Schema.Struct({ agentId: AgentId }))

/**
 * One skill of one agent changed: installed, approved, rewritten, policy changed, or an upstream
 * update found (docs/build-plan-skills.md D13). Separate from `agent.updated` so the skills
 * section stays live without refetching the agent.
 */
export const AgentSkillChanged = variant(
  'agent.skill.changed',
  Schema.Struct({ skill: AgentSkill })
)
export const AgentSkillRemoved = variant(
  'agent.skill.removed',
  Schema.Struct({ agentId: AgentId, name: Handle })
)

/** Metadata only — never the ciphertext, never the plaintext. */
export const VaultItemCreated = variant(
  'vault.item.created',
  Schema.Struct({ item: VaultItemMeta })
)
export const VaultItemUpdated = variant(
  'vault.item.updated',
  Schema.Struct({ item: VaultItemMeta })
)
export const VaultItemRevoked = variant(
  'vault.item.revoked',
  Schema.Struct({ vaultItemId: VaultItemId })
)

export const SubscriptionCreated = variant(
  'subscription.created',
  Schema.Struct({ subscription: Subscription })
)
/** Also emitted on `check`, `setWeight`, `markUsed` and `markRateLimited`. */
export const SubscriptionUpdated = variant(
  'subscription.updated',
  Schema.Struct({ subscription: Subscription })
)
export const SubscriptionDeleted = variant(
  'subscription.deleted',
  Schema.Struct({ subscriptionId: SubscriptionId })
)

/** Status/subscription changes outside the streaming lifecycle (e.g. `tasks.cancel`). */
export const TaskUpdated = variant('task.updated', Schema.Struct({ task: Task }))

// --- routines -------------------------------------------------------------

export const RoutineCreated = variant('routine.created', Schema.Struct({ routine: Routine }))
/** Also emitted by every tick that fires or skips, since it stamps `nextRunAt`/`lastStatus`. */
export const RoutineUpdated = variant('routine.updated', Schema.Struct({ routine: Routine }))
export const RoutineDeleted = variant(
  'routine.deleted',
  Schema.Struct({ routineId: RoutineId, agentId: AgentId })
)

// --- signals --------------------------------------------------------------

/**
 * An agent-emitted signal went off (docs/build-plan-triggers.md D16). Exactly **one** new event
 * type: the signal's custom name is data inside the payload, never an `EventType` of its own, so
 * the union stays closed and every `switch` in the codebase stays exhaustive.
 *
 * Carries the whole `Signal`, the `call.updated` precedent: one payload, no follow-up fetch. A
 * broadcast listener wakes from this event alone — a targeted wake is posted by the runner (D18).
 */
export const SignalEmitted = variant('signal.emitted', Schema.Struct({ signal: Signal }))

// --- repositories ---------------------------------------------------------

/**
 * Repository events carry no credential of any kind: `GithubConnection` is
 * metadata by construction and a `Repository` is public GitHub facts
 * (docs/build-plan-repositories.md D8).
 */
export const RepositoryAttached = variant(
  'repository.attached',
  Schema.Struct({ repository: Repository })
)
export const RepositoryDetached = variant(
  'repository.detached',
  Schema.Struct({ repositoryId: RepositoryId })
)
/** The company connected, installed or disconnected its GitHub App. */
export const RepositoryGithubChanged = variant(
  'repository.github.changed',
  Schema.Struct({ connection: GithubConnection })
)
/** Emitted on grant *and* on a mode change; the payload is the grant as it now stands. */
export const RepositoryGrantChanged = variant(
  'repository.grant.changed',
  Schema.Struct({ agentId: AgentId, repositoryId: RepositoryId, mode: FileGrantMode })
)
export const RepositoryGrantRevoked = variant(
  'repository.grant.revoked',
  Schema.Struct({ agentId: AgentId, repositoryId: RepositoryId })
)

// --- projects (docs/build-plan-projects.md) -------------------------------

/**
 * A sync replaced the mirror, so every client refetches the list once. The
 * projects themselves are not evented row by row: they are a copy of Linear, and
 * a copy that arrived in one reconcile should invalidate in one event (D6).
 */
export const ProjectSynced = variant(
  'project.synced',
  Schema.Struct({ count: Schema.Number, syncedAt: Schema.DateTimeUtc })
)

/**
 * One project moved on the board (D13). Carries the whole project, the same trick
 * as `message.updated`: a client that missed it still converges on the next sync,
 * and one that got it does not have to refetch the list to redraw a card.
 */
export const ProjectChanged = variant('project.changed', Schema.Struct({ project: Project }))

/**
 * The company connected or disconnected Linear. `LinearConnection` is metadata by
 * construction — the API key cannot reach this payload (D2).
 */
export const ProjectLinearChanged = variant(
  'project.linear.changed',
  Schema.Struct({ connection: LinearConnection })
)

/**
 * One Linear person was pointed at a different Taut human, or at nobody (D16).
 * Carries the row as it now stands, so a client that got it does not refetch —
 * and one that missed it converges on the next sync like everything else here.
 */
export const ProjectLinearMemberChanged = variant(
  'project.linear.member.changed',
  Schema.Struct({ user: LinearUser })
)

/**
 * An agent filed an issue in Linear (docs/build-plan-projects.md D21). Carries the
 * issue itself, so the Issues tab of the project it landed under redraws without
 * waiting for the next sync — and a client that missed it converges on that sync
 * like everything else in the mirror.
 */
export const ProjectIssueCreated = variant(
  'project.issue.created',
  Schema.Struct({ projectId: ProjectId, issue: ProjectIssue })
)

// --- calls (huddles) ------------------------------------------------------

/**
 * Huddle lifecycle (docs/build-plan-calls.md D2). `call.updated` carries the whole call — the
 * same trick as `message.updated`, so one cache entry per channel is enough and a client that
 * missed an event still converges. Participant churn is driven by LiveKit's webhooks, never by
 * the browser.
 */
export const CallStarted = variant('call.started', Schema.Struct({ call: Call }))
/** Someone joined, left, started or stopped sharing a screen. */
export const CallUpdated = variant('call.updated', Schema.Struct({ call: Call }))
/** The room emptied: LiveKit sent `room_finished`. */
export const CallEnded = variant(
  'call.ended',
  Schema.Struct({
    callId: CallId,
    channelId: ChannelId,
    endedAt: Schema.DateTimeUtc
  })
)

// --- the union ------------------------------------------------------------

export const Event = Schema.Union(
  MessageCreated,
  MessageUpdated,
  MessageDeleted,
  AgentTaskStarted,
  AgentTaskDelta,
  AgentTaskDone,
  AgentTaskFailed,
  AgentContextUpdated,
  PresenceChanged,
  Typing,
  NotificationEvent,
  UnreadChanged,
  MembershipCreated,
  MembershipUpdated,
  MembershipDeleted,
  CompanyUpdated,
  CompanyDeleted,
  DepartmentCreated,
  DepartmentUpdated,
  DepartmentDeleted,
  ChannelCreated,
  ChannelUpdated,
  ChannelDeleted,
  AgentCreated,
  AgentUpdated,
  AgentDeleted,
  AgentSkillChanged,
  AgentSkillRemoved,
  VaultItemCreated,
  VaultItemUpdated,
  VaultItemRevoked,
  SubscriptionCreated,
  SubscriptionUpdated,
  SubscriptionDeleted,
  TaskUpdated,
  RoutineCreated,
  RoutineUpdated,
  RoutineDeleted,
  SignalEmitted,
  RepositoryAttached,
  RepositoryDetached,
  RepositoryGithubChanged,
  RepositoryGrantChanged,
  RepositoryGrantRevoked,
  ProjectSynced,
  ProjectChanged,
  ProjectLinearChanged,
  ProjectLinearMemberChanged,
  ProjectIssueCreated,
  CallStarted,
  CallUpdated,
  CallEnded
)
export type Event = typeof Event.Type
/** The wire shape (dates as ISO strings). */
export type EventEncoded = typeof Event.Encoded

export type EventType = Event['type']
export const EventType = Schema.Literal(
  'message.created',
  'message.updated',
  'message.deleted',
  'agent.task.started',
  'agent.task.delta',
  'agent.task.done',
  'agent.task.failed',
  'agent.context.updated',
  'presence.changed',
  'typing',
  'notification',
  'unread.changed',
  'membership.created',
  'membership.updated',
  'membership.deleted',
  'company.updated',
  'company.deleted',
  'department.created',
  'department.updated',
  'department.deleted',
  'channel.created',
  'channel.updated',
  'channel.deleted',
  'agent.created',
  'agent.updated',
  'agent.deleted',
  'agent.skill.changed',
  'agent.skill.removed',
  'vault.item.created',
  'vault.item.updated',
  'vault.item.revoked',
  'subscription.created',
  'subscription.updated',
  'subscription.deleted',
  'task.updated',
  'routine.created',
  'routine.updated',
  'routine.deleted',
  'signal.emitted',
  'repository.attached',
  'repository.detached',
  'repository.github.changed',
  'repository.grant.changed',
  'repository.grant.revoked',
  'project.synced',
  'project.changed',
  'project.linear.changed',
  'project.linear.member.changed',
  'project.issue.created',
  'call.started',
  'call.updated',
  'call.ended'
) satisfies Schema.Schema<EventType>

/** Event types that are broadcast but never persisted. */
export const EphemeralEventTypes: ReadonlySet<EventType> = new Set<EventType>(['typing'])

export type EventOfType<T extends EventType> = Extract<Event, { readonly type: T }>
export type EventPayload<T extends EventType> = EventOfType<T>['payload']

/** What `EventLog.append(companyId, body)` takes: the event minus `seq`/`at`/`companyId`. */
export type EventBody = {
  [T in EventType]: { readonly type: T; readonly payload: EventPayload<T> }
}[EventType]

// --- client → server over the socket -------------------------------------

export const ClientSocketMessage = Schema.Union(
  Schema.Struct({
    type: Schema.Literal('typing'),
    channelId: ChannelId,
    threadId: Schema.optional(MessageId)
  }),
  Schema.Struct({ type: Schema.Literal('ping') })
)
export type ClientSocketMessage = typeof ClientSocketMessage.Type

export const ServerSocketMessage = Schema.Union(
  Schema.Struct({ type: Schema.Literal('event'), event: Event }),
  Schema.Struct({ type: Schema.Literal('pong') }),
  /** Sent when `?since` is older than the retained log; client must full-reload. */
  Schema.Struct({ type: Schema.Literal('resync'), head: EventSeq })
)
export type ServerSocketMessage = typeof ServerSocketMessage.Type
