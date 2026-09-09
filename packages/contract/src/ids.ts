/**
 * Branded, prefixed ids for every entity. Ids are `${prefix}_${uuid}` strings
 * (see docs/build-plan.md → "Effect conventions"). The prefix is validated on
 * decode; the body is left loose so seed/fixture ids like `agt_bruno` decode.
 *
 * `makeId` uses `globalThis.crypto.randomUUID()` (Node ≥ 19 and every browser)
 * so this module is safe to import from `@taut/web` as well as the server.
 */
import { Schema } from 'effect'

export const IdPrefix = {
  company: 'cmp',
  user: 'usr',
  session: 'ses',
  department: 'dep',
  channel: 'chn',
  message: 'msg',
  agent: 'agt',
  vaultItem: 'vlt',
  subscription: 'sub',
  invite: 'inv',
  task: 'tsk',
  event: 'evt',
  notification: 'ntf',
  pushDevice: 'psh',
  handover: 'hov',
  attachment: 'att',
  routine: 'rtn',
  repository: 'rep',
  project: 'prj',
  projectMilestone: 'pms',
  projectIssue: 'pis',
  call: 'cal',
  signal: 'sig'
} as const

export type IdPrefix = (typeof IdPrefix)[keyof typeof IdPrefix]

export type PrefixedId<P extends IdPrefix> = `${P}_${string}`

/** Generate a fresh id for the given prefix, e.g. `makeId('cmp')` → `cmp_5f3e…`. */
export const makeId = <P extends IdPrefix>(prefix: P): PrefixedId<P> =>
  `${prefix}_${globalThis.crypto.randomUUID()}`

const idSchema = <const P extends IdPrefix, const B extends string>(prefix: P, brand: B) =>
  Schema.String.pipe(
    Schema.pattern(new RegExp(`^${prefix}_[A-Za-z0-9_-]+$`), {
      identifier: brand,
      message: () => `expected an id starting with "${prefix}_"`
    }),
    Schema.brand(brand)
  )

export const CompanyId = idSchema('cmp', 'CompanyId')
export type CompanyId = typeof CompanyId.Type

export const UserId = idSchema('usr', 'UserId')
export type UserId = typeof UserId.Type

export const SessionId = idSchema('ses', 'SessionId')
export type SessionId = typeof SessionId.Type

export const DepartmentId = idSchema('dep', 'DepartmentId')
export type DepartmentId = typeof DepartmentId.Type

export const ChannelId = idSchema('chn', 'ChannelId')
export type ChannelId = typeof ChannelId.Type

export const MessageId = idSchema('msg', 'MessageId')
export type MessageId = typeof MessageId.Type

export const AgentId = idSchema('agt', 'AgentId')
export type AgentId = typeof AgentId.Type

export const VaultItemId = idSchema('vlt', 'VaultItemId')
export type VaultItemId = typeof VaultItemId.Type

export const SubscriptionId = idSchema('sub', 'SubscriptionId')
export type SubscriptionId = typeof SubscriptionId.Type

export const InviteId = idSchema('inv', 'InviteId')
export type InviteId = typeof InviteId.Type

export const TaskId = idSchema('tsk', 'TaskId')
export type TaskId = typeof TaskId.Type

export const CallId = idSchema('cal', 'CallId')
export type CallId = typeof CallId.Type

export const EventId = idSchema('evt', 'EventId')
export type EventId = typeof EventId.Type

export const HandoverId = idSchema('hov', 'HandoverId')
export type HandoverId = typeof HandoverId.Type

export const NotificationId = idSchema('ntf', 'NotificationId')
export type NotificationId = typeof NotificationId.Type

export const PushDeviceId = idSchema('psh', 'PushDeviceId')
export type PushDeviceId = typeof PushDeviceId.Type

export const AttachmentId = idSchema('att', 'AttachmentId')
export type AttachmentId = typeof AttachmentId.Type

export const RoutineId = idSchema('rtn', 'RoutineId')
export type RoutineId = typeof RoutineId.Type

export const RepositoryId = idSchema('rep', 'RepositoryId')
export type RepositoryId = typeof RepositoryId.Type

export const ProjectId = idSchema('prj', 'ProjectId')
export type ProjectId = typeof ProjectId.Type

export const ProjectMilestoneId = idSchema('pms', 'ProjectMilestoneId')
export type ProjectMilestoneId = typeof ProjectMilestoneId.Type

export const ProjectIssueId = idSchema('pis', 'ProjectIssueId')
export type ProjectIssueId = typeof ProjectIssueId.Type

export const SignalId = idSchema('sig', 'SignalId')
export type SignalId = typeof SignalId.Type

/** A member of a department/channel, or the author of a message: a human or an agent. */
export const MemberId = Schema.Union(UserId, AgentId)
export type MemberId = typeof MemberId.Type

/** Per-company, gap-free event sequence number (docs/agent-model.md §6). */
export const EventSeq = Schema.NonNegativeInt
export type EventSeq = typeof EventSeq.Type

export const newCompanyId = (): CompanyId => CompanyId.make(makeId('cmp'))
export const newUserId = (): UserId => UserId.make(makeId('usr'))
export const newSessionId = (): SessionId => SessionId.make(makeId('ses'))
export const newDepartmentId = (): DepartmentId => DepartmentId.make(makeId('dep'))
export const newChannelId = (): ChannelId => ChannelId.make(makeId('chn'))
export const newMessageId = (): MessageId => MessageId.make(makeId('msg'))
export const newAgentId = (): AgentId => AgentId.make(makeId('agt'))
export const newVaultItemId = (): VaultItemId => VaultItemId.make(makeId('vlt'))
export const newSubscriptionId = (): SubscriptionId => SubscriptionId.make(makeId('sub'))
export const newInviteId = (): InviteId => InviteId.make(makeId('inv'))
export const newTaskId = (): TaskId => TaskId.make(makeId('tsk'))
export const newEventId = (): EventId => EventId.make(makeId('evt'))
export const newNotificationId = (): NotificationId => NotificationId.make(makeId('ntf'))
export const newPushDeviceId = (): PushDeviceId => PushDeviceId.make(makeId('psh'))
export const newAttachmentId = (): AttachmentId => AttachmentId.make(makeId('att'))
export const newRoutineId = (): RoutineId => RoutineId.make(makeId('rtn'))
export const newRepositoryId = (): RepositoryId => RepositoryId.make(makeId('rep'))
export const newProjectId = (): ProjectId => ProjectId.make(makeId('prj'))
export const newProjectMilestoneId = (): ProjectMilestoneId =>
  ProjectMilestoneId.make(makeId('pms'))
export const newProjectIssueId = (): ProjectIssueId => ProjectIssueId.make(makeId('pis'))
export const newSignalId = (): SignalId => SignalId.make(makeId('sig'))
