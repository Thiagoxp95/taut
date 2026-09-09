import {
  Agent,
  AgentFileGrant,
  AgentRepoGrant,
  Attachment,
  AgentSkill,
  AgentStatus,
  AuthorKind,
  Avatar,
  Call,
  CallParticipant,
  Channel,
  ChannelKind,
  ChannelMember,
  Company,
  CredentialKind,
  Department,
  DepartmentMember,
  DepartmentShape,
  DisplayName,
  Email,
  FileGrantMode,
  GithubConnection,
  Handle,
  Handover,
  HandoverStatus,
  Invite,
  IssueLabel,
  IssueState,
  IssueStateType,
  LimitWindow,
  LinearConnection,
  LinearUser,
  MemberKind,
  Membership,
  MembershipRole,
  Message,
  MessageStatus,
  Notification,
  NotificationKind,
  PermissionMode,
  Project,
  ProjectHealth,
  ProjectIssue,
  ProjectLead,
  ProjectMilestone,
  ProjectMilestoneStatus,
  ProjectPriority,
  ProjectState,
  ProjectStatus,
  ProjectTeam,
  PushDevice,
  Repository,
  Routine,
  RoutineRunStatus,
  RunOverride,
  RuntimeKind,
  Signal,
  SignalName,
  SignalPayload,
  SignalStatus,
  SkillOrigin,
  SkillSourceKind,
  SkillState,
  SkillUpdatePolicy,
  Slug,
  Subscription,
  SubscriptionStatus,
  Task,
  TaskStatus,
  Trigger,
  User,
  VaultItemMeta
} from '@taut/contract/domain'
import {
  AgentId,
  AttachmentId,
  CallId,
  ChannelId,
  CompanyId,
  DepartmentId,
  EventSeq,
  HandoverId,
  InviteId,
  MemberId,
  MessageId,
  NotificationId,
  ProjectId,
  ProjectIssueId,
  ProjectMilestoneId,
  PushDeviceId,
  RepositoryId,
  RoutineId,
  SessionId,
  SignalId,
  SubscriptionId,
  TaskId,
  UserId,
  VaultItemId
} from '@taut/contract/ids'
import { Either, Option, Schema } from 'effect'
import { isBuiltinSkill } from '../agents/defaultSkills.js'

/**
 * Internal row shapes (snake_case columns, JSON columns parsed) and the mappers
 * to the public `@taut/contract` classes. Decoding happens at the SQL boundary
 * via `SqlSchema`; nothing downstream touches a raw row.
 */

const AvatarJson = Schema.parseJson(Avatar)

const orUndefined = <A>(value: A | null): A | undefined => value ?? undefined

// ── users & sessions ─────────────────────────────────────────────────────────

export const UserRow = Schema.Struct({
  id: UserId,
  email: Email,
  name: DisplayName,
  avatar_json: AvatarJson,
  created_at: Schema.DateTimeUtc
})
export type UserRow = typeof UserRow.Type

export const toUser = (r: UserRow): User =>
  new User({
    id: r.id,
    email: r.email,
    name: r.name,
    avatar: r.avatar_json,
    createdAt: r.created_at
  })

export const UserAuthRow = Schema.Struct({ ...UserRow.fields, password_hash: Schema.String })
export type UserAuthRow = typeof UserAuthRow.Type

export const SessionRow = Schema.Struct({
  id: SessionId,
  user_id: UserId,
  expires_at: Schema.DateTimeUtc,
  active_company_id: Schema.NullOr(CompanyId),
  role: Schema.NullOr(MembershipRole)
})
export type SessionRow = typeof SessionRow.Type

// ── companies ────────────────────────────────────────────────────────────────

export const CompanyRow = Schema.Struct({
  id: CompanyId,
  slug: Slug,
  name: DisplayName,
  avatar_json: AvatarJson,
  created_at: Schema.DateTimeUtc
})
export type CompanyRow = typeof CompanyRow.Type

export const toCompany = (r: CompanyRow): Company =>
  new Company({
    id: r.id,
    slug: r.slug,
    name: r.name,
    avatar: r.avatar_json,
    createdAt: r.created_at
  })

export const MembershipRow = Schema.Struct({
  company_id: CompanyId,
  user_id: UserId,
  role: MembershipRole
})
export type MembershipRow = typeof MembershipRow.Type

export const toMembership = (r: MembershipRow): Membership =>
  new Membership({ companyId: r.company_id, userId: r.user_id, role: r.role })

/** `companies ⋈ memberships` for one user. */
export const CompanyWithRoleRow = Schema.Struct({ ...CompanyRow.fields, role: MembershipRole })
/** `users ⋈ memberships` for one company. */
export const UserWithRoleRow = Schema.Struct({ ...UserRow.fields, role: MembershipRole })

export const InviteRow = Schema.Struct({
  id: InviteId,
  company_id: CompanyId,
  email: Email,
  role: MembershipRole,
  token: Schema.String,
  invited_by: UserId,
  expires_at: Schema.DateTimeUtc,
  accepted_at: Schema.NullOr(Schema.DateTimeUtc)
})
export type InviteRow = typeof InviteRow.Type

export const toInvite = (r: InviteRow): Invite =>
  new Invite({
    id: r.id,
    companyId: r.company_id,
    email: r.email,
    role: r.role,
    token: r.token,
    invitedBy: r.invited_by,
    expiresAt: r.expires_at,
    acceptedAt: orUndefined(r.accepted_at)
  })

// ── departments ──────────────────────────────────────────────────────────────

export const DepartmentRow = Schema.Struct({
  id: DepartmentId,
  company_id: CompanyId,
  name: DisplayName,
  slug: Slug,
  head_user_id: UserId,
  shape: Schema.NullOr(DepartmentShape),
  created_at: Schema.DateTimeUtc
})
export type DepartmentRow = typeof DepartmentRow.Type

export const toDepartment = (r: DepartmentRow): Department =>
  new Department({
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    slug: r.slug,
    headUserId: r.head_user_id,
    shape: orUndefined(r.shape),
    createdAt: r.created_at
  })

export const DepartmentMemberRow = Schema.Struct({
  department_id: DepartmentId,
  member_kind: MemberKind,
  member_id: MemberId
})
export type DepartmentMemberRow = typeof DepartmentMemberRow.Type

export const toDepartmentMember = (r: DepartmentMemberRow): DepartmentMember =>
  new DepartmentMember({
    departmentId: r.department_id,
    memberKind: r.member_kind,
    memberId: r.member_id
  })

// ── channels ─────────────────────────────────────────────────────────────────

export const ChannelRow = Schema.Struct({
  id: ChannelId,
  company_id: CompanyId,
  department_id: Schema.NullOr(DepartmentId),
  name: DisplayName,
  kind: ChannelKind,
  archived_at: Schema.NullOr(Schema.DateTimeUtc),
  created_at: Schema.DateTimeUtc
})
export type ChannelRow = typeof ChannelRow.Type

export const toChannel = (r: ChannelRow): Channel =>
  new Channel({
    id: r.id,
    companyId: r.company_id,
    departmentId: orUndefined(r.department_id),
    name: r.name,
    kind: r.kind,
    archivedAt: orUndefined(r.archived_at),
    createdAt: r.created_at
  })

export const ChannelMemberRow = Schema.Struct({
  channel_id: ChannelId,
  member_kind: MemberKind,
  member_id: MemberId,
  last_read_seq: EventSeq
})
export type ChannelMemberRow = typeof ChannelMemberRow.Type

export const toChannelMember = (r: ChannelMemberRow): ChannelMember =>
  new ChannelMember({
    channelId: r.channel_id,
    memberKind: r.member_kind,
    memberId: r.member_id,
    lastReadSeq: r.last_read_seq
  })

// ── messages & notifications ─────────────────────────────────────────────────

export const MessageRow = Schema.Struct({
  id: MessageId,
  company_id: CompanyId,
  channel_id: ChannelId,
  thread_id: Schema.NullOr(MessageId),
  author_kind: AuthorKind,
  author_id: MemberId,
  body: Schema.String,
  status: MessageStatus,
  seq: EventSeq,
  error: Schema.NullOr(Schema.String),
  created_at: Schema.DateTimeUtc,
  edited_at: Schema.NullOr(Schema.DateTimeUtc),
  /** `RunOverride` as JSON, or NULL — which is what almost every row holds (0025). */
  run_override: Schema.optionalWith(Schema.NullOr(Schema.String), { default: () => null })
})
export type MessageRow = typeof MessageRow.Type

/**
 * The message's `run_override` column, decoded. A row written by an older build
 * (or hand-edited into nonsense) reads as "no override" rather than failing the
 * whole page of messages: this is a hint for one run, never load-bearing.
 */
const decodeOverride = Schema.decodeUnknownOption(RunOverride)
export const parseRunOverride = (json: string | null): RunOverride | undefined => {
  if (json === null || json === '') return undefined
  try {
    return Option.getOrUndefined(decodeOverride(JSON.parse(json)))
  } catch {
    return undefined
  }
}

export const toMessage = (r: MessageRow): Message =>
  new Message({
    id: r.id,
    companyId: r.company_id,
    channelId: r.channel_id,
    threadId: orUndefined(r.thread_id),
    authorKind: r.author_kind,
    authorId: r.author_id,
    body: r.body,
    status: r.status,
    seq: r.seq,
    error: orUndefined(r.error),
    createdAt: r.created_at,
    editedAt: orUndefined(r.edited_at),
    runOverride: parseRunOverride(r.run_override)
  })

/** `message_id` is NULL while the upload is an orphan (docs/build-plan-attachments.md D1). */
export const AttachmentRow = Schema.Struct({
  id: AttachmentId,
  company_id: CompanyId,
  channel_id: ChannelId,
  message_id: Schema.NullOr(MessageId),
  uploader_kind: AuthorKind,
  uploader_id: MemberId,
  name: Schema.String,
  mime_type: Schema.String,
  size: Schema.NonNegativeInt,
  created_at: Schema.DateTimeUtc
})
export type AttachmentRow = typeof AttachmentRow.Type

export const toAttachment = (r: AttachmentRow): Attachment =>
  new Attachment({
    id: r.id,
    companyId: r.company_id,
    channelId: r.channel_id,
    messageId: orUndefined(r.message_id),
    uploaderKind: r.uploader_kind,
    uploaderId: r.uploader_id,
    name: r.name,
    mimeType: r.mime_type,
    size: r.size,
    createdAt: r.created_at
  })

export const NotificationRow = Schema.Struct({
  id: NotificationId,
  company_id: CompanyId,
  user_id: UserId,
  event_seq: EventSeq,
  kind: NotificationKind,
  read_at: Schema.NullOr(Schema.DateTimeUtc)
})
export type NotificationRow = typeof NotificationRow.Type

export const toNotification = (r: NotificationRow): Notification =>
  new Notification({
    id: r.id,
    companyId: r.company_id,
    userId: r.user_id,
    eventSeq: r.event_seq,
    kind: r.kind,
    readAt: orUndefined(r.read_at)
  })

// ── vault & subscriptions ────────────────────────────────────────────────────

/** Never selects `ciphertext`: the meta row is what every list/event carries. */
export const VaultItemMetaRow = Schema.Struct({
  id: VaultItemId,
  company_id: CompanyId,
  kind: CredentialKind,
  label: Schema.String,
  hint: Schema.String,
  created_at: Schema.DateTimeUtc,
  last_used_at: Schema.NullOr(Schema.DateTimeUtc),
  last_used_by: Schema.NullOr(AgentId),
  /** NULL = company item; set = the one agent that may use it. */
  agent_id: Schema.NullOr(AgentId)
})
export type VaultItemMetaRow = typeof VaultItemMetaRow.Type

export const toVaultItemMeta = (r: VaultItemMetaRow): VaultItemMeta =>
  new VaultItemMeta({
    id: r.id,
    companyId: r.company_id,
    kind: r.kind,
    label: r.label,
    hint: r.hint,
    createdAt: r.created_at,
    lastUsedAt: orUndefined(r.last_used_at),
    lastUsedBy: orUndefined(r.last_used_by),
    agentId: orUndefined(r.agent_id)
  })

export const SubscriptionRow = Schema.Struct({
  id: SubscriptionId,
  company_id: CompanyId,
  runtime: RuntimeKind,
  label: Schema.String,
  credential_id: VaultItemId,
  /** The probe's own credential; null = probe the seat's `credential_id`. */
  usage_credential_id: Schema.NullOr(VaultItemId),
  default_model: Schema.NullOr(Schema.String),
  status: SubscriptionStatus,
  weight: Schema.NonNegativeInt,
  cooldown_until: Schema.NullOr(Schema.DateTimeUtc),
  /** The last provider snapshot, `LimitWindow[]` encoded. Null until first probed. */
  limits_json: Schema.NullOr(Schema.String),
  limits_checked_at: Schema.NullOr(Schema.DateTimeUtc),
  limits_error: Schema.NullOr(Schema.String),
  tasks_today: Schema.NonNegativeInt,
  /** UTC `YYYY-MM-DD` the counter belongs to; another day reads as 0. */
  tasks_today_date: Schema.NullOr(Schema.String),
  last_checked_at: Schema.NullOr(Schema.DateTimeUtc)
})
export type SubscriptionRow = typeof SubscriptionRow.Type

const LimitWindows = Schema.Array(LimitWindow)
const parseLimits = Schema.decodeUnknownEither(Schema.parseJson(LimitWindows))

/**
 * A snapshot written by an older build (or hand-edited) must not take the
 * whole seat down, so an unparseable blob reads as "never probed".
 */
const decodeLimits = (json: string | null): ReadonlyArray<LimitWindow> => {
  if (json === null) return []
  const parsed = parseLimits(json)
  return Either.isRight(parsed) ? parsed.right : []
}

/** UTC calendar day used for `tasks_today` (docs/agent-model.md §4). */
export const utcDay = (now: Date = new Date()): string => now.toISOString().slice(0, 10)

export const toSubscription = (r: SubscriptionRow, today: string = utcDay()): Subscription =>
  new Subscription({
    id: r.id,
    companyId: r.company_id,
    runtime: r.runtime,
    label: r.label,
    credentialId: r.credential_id,
    usageCredentialId: orUndefined(r.usage_credential_id),
    defaultModel: orUndefined(r.default_model),
    status: r.status,
    weight: r.weight,
    cooldownUntil: orUndefined(r.cooldown_until),
    limits: decodeLimits(r.limits_json),
    limitsCheckedAt: orUndefined(r.limits_checked_at),
    limitsError: orUndefined(r.limits_error),
    tasksToday: r.tasks_today_date === today ? r.tasks_today : 0,
    lastCheckedAt: orUndefined(r.last_checked_at)
  })

// ── agents ───────────────────────────────────────────────────────────────────

export const AgentRefRow = Schema.Struct({ id: AgentId, handle: Handle, name: DisplayName })
export type AgentRefRow = typeof AgentRefRow.Type

export const AgentRow = Schema.Struct({
  id: AgentId,
  company_id: CompanyId,
  handle: Handle,
  name: DisplayName,
  avatar_json: AvatarJson,
  role: Schema.String,
  mandate: Schema.String,
  runtime_kind: RuntimeKind,
  pinned_subscription_id: Schema.NullOr(SubscriptionId),
  model: Schema.NullOr(Schema.String),
  permission_mode: PermissionMode,
  /** SQLite INTEGER 0/1 (`browser_access`). */
  browser_access: Schema.Number,
  status: AgentStatus,
  archived_at: Schema.NullOr(Schema.DateTimeUtc),
  created_at: Schema.DateTimeUtc,
  updated_at: Schema.DateTimeUtc
})
export type AgentRow = typeof AgentRow.Type

/** `departmentIds` comes from `department_members`; the caller joins it (see `Agents`). */
export const toAgent = (r: AgentRow, departmentIds: ReadonlyArray<DepartmentId> = []): Agent =>
  new Agent({
    id: r.id,
    companyId: r.company_id,
    handle: r.handle,
    name: r.name,
    avatar: r.avatar_json,
    role: r.role,
    mandate: r.mandate,
    runtimeKind: r.runtime_kind,
    pinnedSubscriptionId: orUndefined(r.pinned_subscription_id),
    model: orUndefined(r.model),
    permissionMode: r.permission_mode,
    browserAccess: r.browser_access !== 0,
    status: r.status,
    archivedAt: orUndefined(r.archived_at),
    departmentIds,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  })

/**
 * Everything after `description` arrives with migration 0021 (docs/build-plan-skills.md D6):
 * where the skill came from, whether a human has let the agent use it yet, and what upstream
 * looked like the last time anyone checked.
 */
export const AgentSkillRow = Schema.Struct({
  agent_id: AgentId,
  name: Handle,
  description: Schema.String,
  origin: SkillOrigin,
  state: SkillState,
  source: Schema.NullOr(Schema.String),
  source_kind: Schema.NullOr(SkillSourceKind),
  source_ref: Schema.NullOr(Schema.String),
  source_path: Schema.NullOr(Schema.String),
  resolved_sha: Schema.NullOr(Schema.String),
  content_hash: Schema.NullOr(Schema.String),
  /** Set only while upstream differs from `content_hash`; cleared when the update is applied. */
  upstream_hash: Schema.NullOr(Schema.String),
  update_policy: SkillUpdatePolicy,
  checked_at: Schema.NullOr(Schema.DateTimeUtc),
  installed_by: Schema.NullOr(Schema.String),
  created_at: Schema.NullOr(Schema.DateTimeUtc),
  updated_at: Schema.NullOr(Schema.DateTimeUtc)
})
export type AgentSkillRow = typeof AgentSkillRow.Type

/**
 * `builtin` stays the derived truth it has always been (`isBuiltinSkill`), and `origin` is
 * forced to match it: a name in `BUILTIN_SKILLS` is a built-in whatever the row says, so a
 * hand-edited row cannot turn one into an ordinary skill.
 */
export const toAgentSkill = (r: AgentSkillRow): AgentSkill => {
  const builtin = isBuiltinSkill(r.name)
  return new AgentSkill({
    agentId: r.agent_id,
    name: r.name,
    description: r.description,
    builtin,
    origin: builtin ? 'builtin' : r.origin,
    state: r.state,
    source: orUndefined(r.source),
    updatePolicy: r.update_policy,
    updateAvailable: r.upstream_hash !== null && r.upstream_hash !== r.content_hash
  })
}

export const AgentFileGrantRow = Schema.Struct({
  agent_id: AgentId,
  path: Schema.String,
  mode: FileGrantMode
})
export type AgentFileGrantRow = typeof AgentFileGrantRow.Type

export const toAgentFileGrant = (r: AgentFileGrantRow): AgentFileGrant =>
  new AgentFileGrant({ agentId: r.agent_id, path: r.path, mode: r.mode })

// ── tasks ────────────────────────────────────────────────────────────────────

export const TaskRow = Schema.Struct({
  id: TaskId,
  company_id: CompanyId,
  agent_id: AgentId,
  channel_id: ChannelId,
  /** Joined from `channels`; NULL if the channel is gone. */
  channel_kind: Schema.NullOr(ChannelKind),
  /** NULL only after the root message was deleted; falls back to `message_id`. */
  thread_id: Schema.NullOr(MessageId),
  message_id: MessageId,
  subscription_id: Schema.NullOr(SubscriptionId),
  status: TaskStatus,
  started_at: Schema.DateTimeUtc,
  ended_at: Schema.NullOr(Schema.DateTimeUtc),
  error: Schema.NullOr(Schema.String),
  parent_task_id: Schema.NullOr(TaskId),
  handoff_depth: Schema.Number,
  trigger_message_id: Schema.NullOr(MessageId),
  trigger_user_id: Schema.NullOr(UserId),
  /** The routine whose fire posted the trigger (docs/build-plan-routines.md D9). */
  routine_id: Schema.NullOr(RoutineId),
  /** The signal whose delivery posted the trigger (docs/build-plan-triggers.md D21). */
  signal_id: Schema.NullOr(SignalId)
})
export type TaskRow = typeof TaskRow.Type

export const toTask = (r: TaskRow): Task =>
  new Task({
    id: r.id,
    companyId: r.company_id,
    agentId: r.agent_id,
    channelId: r.channel_id,
    channelKind: r.channel_kind ?? 'channel',
    threadId: r.thread_id ?? r.message_id,
    messageId: r.message_id,
    subscriptionId: orUndefined(r.subscription_id),
    routineId: orUndefined(r.routine_id),
    signalId: orUndefined(r.signal_id),
    triggerMessageId: orUndefined(r.trigger_message_id),
    status: r.status,
    startedAt: r.started_at,
    endedAt: orUndefined(r.ended_at),
    error: orUndefined(r.error)
  })

// ── handovers ────────────────────────────────────────────────────────────────

export const HandoverRow = Schema.Struct({
  id: HandoverId,
  company_id: CompanyId,
  from_agent_id: AgentId,
  from_department_id: DepartmentId,
  from_head_user_id: Schema.NullOr(UserId),
  to_agent_id: AgentId,
  to_department_id: DepartmentId,
  to_head_user_id: Schema.NullOr(UserId),
  channel_id: ChannelId,
  thread_id: Schema.NullOr(MessageId),
  task_id: Schema.NullOr(TaskId),
  text: Schema.String,
  status: HandoverStatus,
  raised_message_id: Schema.NullOr(MessageId),
  created_at: Schema.DateTimeUtc,
  resolved_at: Schema.NullOr(Schema.DateTimeUtc),
  resolved_by_user_id: Schema.NullOr(UserId)
})
export type HandoverRow = typeof HandoverRow.Type

export const toHandover = (r: HandoverRow): Handover =>
  new Handover({
    id: r.id,
    companyId: r.company_id,
    fromAgentId: r.from_agent_id,
    fromDepartmentId: r.from_department_id,
    fromHeadUserId: orUndefined(r.from_head_user_id),
    toAgentId: r.to_agent_id,
    toDepartmentId: r.to_department_id,
    toHeadUserId: orUndefined(r.to_head_user_id),
    channelId: r.channel_id,
    threadId: orUndefined(r.thread_id),
    taskId: orUndefined(r.task_id),
    text: r.text,
    status: r.status,
    raisedMessageId: orUndefined(r.raised_message_id),
    createdAt: r.created_at,
    resolvedAt: orUndefined(r.resolved_at),
    resolvedByUserId: orUndefined(r.resolved_by_user_id)
  })

// ── routines ─────────────────────────────────────────────────────────────────

/**
 * The `Trigger` union through `Schema.parseJson`, exactly as `schedule_json` was read before
 * it (docs/build-plan-triggers.md D1). `trigger_kind`/`trigger_event` beside it are the
 * denormalised copies SQLite can actually index (D9), never a second source of truth.
 */
const TriggerJson = Schema.parseJson(Trigger)

export const RoutineRow = Schema.Struct({
  id: RoutineId,
  company_id: CompanyId,
  agent_id: AgentId,
  owner_user_id: UserId,
  name: Schema.String,
  prompt: Schema.String,
  channel_id: Schema.NullOr(ChannelId),
  trigger_json: TriggerJson,
  /** SQLite INTEGER 0/1. */
  enabled: Schema.Number,
  next_run_at: Schema.NullOr(Schema.DateTimeUtc),
  last_run_at: Schema.NullOr(Schema.DateTimeUtc),
  last_task_id: Schema.NullOr(TaskId),
  last_status: Schema.NullOr(RoutineRunStatus),
  created_at: Schema.DateTimeUtc,
  updated_at: Schema.DateTimeUtc
})
export type RoutineRow = typeof RoutineRow.Type

export const toRoutine = (r: RoutineRow): Routine =>
  new Routine({
    id: r.id,
    companyId: r.company_id,
    agentId: r.agent_id,
    ownerUserId: r.owner_user_id,
    name: r.name,
    prompt: r.prompt,
    channelId: orUndefined(r.channel_id),
    trigger: r.trigger_json,
    enabled: r.enabled !== 0,
    nextRunAt: orUndefined(r.next_run_at),
    lastRunAt: orUndefined(r.last_run_at),
    lastTaskId: orUndefined(r.last_task_id),
    lastStatus: orUndefined(r.last_status),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  })

// ── signals (docs/build-plan-triggers.md Part II) ────────────────────────────

/** Free-form JSON the emitter attached, capped at 8 KB by `Signals.emit` (D22). */
const SignalPayloadJson = Schema.parseJson(SignalPayload)

export const SignalRow = Schema.Struct({
  id: SignalId,
  company_id: CompanyId,
  name: SignalName,
  payload_json: SignalPayloadJson,
  emitted_by_kind: MemberKind,
  emitted_by_id: MemberId,
  emitted_by_task_id: Schema.NullOr(TaskId),
  target_agent_id: Schema.NullOr(AgentId),
  channel_id: Schema.NullOr(ChannelId),
  thread_id: Schema.NullOr(MessageId),
  note: Schema.String,
  deliver_at: Schema.DateTimeUtc,
  depth: Schema.Number,
  status: SignalStatus,
  delivered_task_id: Schema.NullOr(TaskId),
  created_at: Schema.DateTimeUtc,
  updated_at: Schema.DateTimeUtc
})
export type SignalRow = typeof SignalRow.Type

export const toSignal = (r: SignalRow): Signal =>
  new Signal({
    id: r.id,
    companyId: r.company_id,
    name: r.name,
    payload: r.payload_json,
    emittedByKind: r.emitted_by_kind,
    emittedById: r.emitted_by_id,
    emittedByTaskId: orUndefined(r.emitted_by_task_id),
    targetAgentId: orUndefined(r.target_agent_id),
    channelId: orUndefined(r.channel_id),
    threadId: orUndefined(r.thread_id),
    note: r.note,
    deliverAt: r.deliver_at,
    // The column is a plain INTEGER; `Signal.depth` bounds it at MAX_SIGNAL_DEPTH (D23) and a
    // row past that bound can only come from a hand-edited database, which is a defect.
    depth: r.depth,
    status: r.status,
    deliveredTaskId: orUndefined(r.delivered_task_id),
    createdAt: r.created_at,
    updatedAt: r.updated_at
  })

// ── push devices ─────────────────────────────────────────────────────────────

/** `p256dh`/`auth` are the endpoint's encryption keys; they never leave the server. */
export const PushDeviceRow = Schema.Struct({
  id: PushDeviceId,
  user_id: UserId,
  endpoint: Schema.String,
  p256dh: Schema.String,
  auth: Schema.String,
  label: Schema.NullOr(Schema.String),
  created_at: Schema.DateTimeUtc,
  last_seen_at: Schema.DateTimeUtc
})
export type PushDeviceRow = typeof PushDeviceRow.Type

export const toPushDevice = (r: PushDeviceRow): PushDevice =>
  new PushDevice({
    id: r.id,
    userId: r.user_id,
    endpoint: r.endpoint,
    label: orUndefined(r.label),
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at
  })

// ── repositories (docs/build-plan-repositories.md) ───────────────────────────

export const RepositoryRow = Schema.Struct({
  id: RepositoryId,
  company_id: CompanyId,
  github_id: Schema.Number,
  owner: Schema.String,
  name: Schema.String,
  full_name: Schema.String,
  default_branch: Schema.String,
  /** SQLite has no boolean: 0/1. */
  private: Schema.Number,
  clone_url: Schema.String,
  attached_at: Schema.DateTimeUtc
})
export type RepositoryRow = typeof RepositoryRow.Type

export const toRepository = (r: RepositoryRow): Repository =>
  new Repository({
    id: r.id,
    companyId: r.company_id,
    githubId: r.github_id,
    owner: r.owner,
    name: r.name,
    fullName: r.full_name,
    defaultBranch: r.default_branch,
    private: r.private !== 0,
    cloneUrl: r.clone_url,
    attachedAt: r.attached_at
  })

export const AgentRepoGrantRow = Schema.Struct({
  agent_id: AgentId,
  repository_id: RepositoryId,
  mode: FileGrantMode
})
export type AgentRepoGrantRow = typeof AgentRepoGrantRow.Type

export const toAgentRepoGrant = (r: AgentRepoGrantRow): AgentRepoGrant =>
  new AgentRepoGrant({ agentId: r.agent_id, repositoryId: r.repository_id, mode: r.mode })

/**
 * The company's GitHub App, secrets excluded. Selecting `*_ct` here would put
 * ciphertext one careless `emit` away from an event payload, so the encrypted
 * columns live in their own query inside `GitHubApp` and never in this shape
 * (docs/build-plan-repositories.md D8).
 */
export const GithubAppRow = Schema.Struct({
  company_id: CompanyId,
  app_id: Schema.Number,
  app_slug: Schema.String,
  client_id: Schema.String,
  installation_id: Schema.NullOr(Schema.Number),
  account_login: Schema.NullOr(Schema.String),
  created_at: Schema.DateTimeUtc,
  connected_at: Schema.NullOr(Schema.DateTimeUtc)
})
export type GithubAppRow = typeof GithubAppRow.Type

/** No row at all is `none`: the company has never started the manifest flow. */
export const toGithubConnection = (
  companyId: CompanyId,
  row: GithubAppRow | undefined
): GithubConnection =>
  row === undefined
    ? new GithubConnection({ companyId, state: 'none' })
    : new GithubConnection({
        companyId,
        state: row.installation_id === null ? 'app-created' : 'connected',
        appSlug: row.app_slug,
        accountLogin: orUndefined(row.account_login),
        connectedAt: orUndefined(row.connected_at)
      })

// ── projects (docs/build-plan-projects.md) ───────────────────────────────────

/** `teams` is the one JSON column here; the rest of Linear's shape is flat. */
const TeamsJson = Schema.parseJson(Schema.Array(ProjectTeam))

/**
 * Linear may add a project state at any time, and a mirror that refuses to decode
 * a project is worse than one that shows it without a label (D1). Anything
 * unrecognised lands on `unknown` rather than failing the row.
 */
const toProjectState = (raw: string): ProjectState =>
  Schema.is(ProjectState)(raw) ? raw : 'unknown'

/** Same tolerance for the fields D14 added: a word we do not know is no word. */
const toProjectPriority = (raw: number): ProjectPriority =>
  Schema.is(ProjectPriority)(raw) ? raw : 0

const toProjectHealth = (raw: string | null): ProjectHealth | undefined =>
  raw !== null && Schema.is(ProjectHealth)(raw) ? raw : undefined

const toMilestoneStatus = (raw: string | null): ProjectMilestoneStatus | undefined =>
  raw !== null && Schema.is(ProjectMilestoneStatus)(raw) ? raw : undefined

export const ProjectRow = Schema.Struct({
  id: ProjectId,
  company_id: CompanyId,
  linear_id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  state: Schema.String,
  status_id: Schema.NullOr(Schema.String),
  status_name: Schema.NullOr(Schema.String),
  status_type: Schema.NullOr(Schema.String),
  status_color: Schema.NullOr(Schema.String),
  status_position: Schema.NullOr(Schema.Number),
  priority: Schema.Number,
  priority_label: Schema.NullOr(Schema.String),
  priority_sort_order: Schema.Number,
  health: Schema.NullOr(Schema.String),
  issue_count: Schema.Number,
  /** Computed by the query, not stored: the milestone a board card names (D14). */
  next_milestone_name: Schema.NullOr(Schema.String),
  next_milestone_target: Schema.NullOr(Schema.String),
  progress: Schema.Number,
  icon: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  url: Schema.String,
  lead_name: Schema.NullOr(Schema.String),
  lead_email: Schema.NullOr(Schema.String),
  lead_avatar: Schema.NullOr(Schema.String),
  teams: TeamsJson,
  start_date: Schema.NullOr(Schema.String),
  target_date: Schema.NullOr(Schema.String),
  updated_at: Schema.NullOr(Schema.DateTimeUtc),
  synced_at: Schema.DateTimeUtc
})
export type ProjectRow = typeof ProjectRow.Type

export const toProject = (r: ProjectRow): Project =>
  new Project({
    id: r.id,
    companyId: r.company_id,
    linearId: r.linear_id,
    name: r.name,
    description: orUndefined(r.description),
    state: toProjectState(r.state),
    status:
      r.status_id === null || r.status_name === null
        ? undefined
        : ProjectStatus.make({
            id: r.status_id,
            name: r.status_name,
            // A status Linear types with a word we do not know still draws a
            // column; only the roll-up label falls back.
            type: toProjectState(r.status_type ?? 'unknown'),
            color: orUndefined(r.status_color),
            position: r.status_position ?? 0
          }),
    priority: toProjectPriority(r.priority),
    priorityLabel: orUndefined(r.priority_label),
    prioritySortOrder: r.priority_sort_order,
    health: toProjectHealth(r.health),
    issueCount: r.issue_count,
    nextMilestone:
      r.next_milestone_name === null
        ? undefined
        : { name: r.next_milestone_name, targetDate: orUndefined(r.next_milestone_target) },
    progress: r.progress,
    icon: orUndefined(r.icon),
    color: orUndefined(r.color),
    url: r.url,
    lead:
      r.lead_name === null
        ? undefined
        : ProjectLead.make({
            name: r.lead_name,
            email: orUndefined(r.lead_email),
            avatarUrl: orUndefined(r.lead_avatar)
          }),
    teams: r.teams,
    startDate: orUndefined(r.start_date),
    targetDate: orUndefined(r.target_date),
    updatedAt: orUndefined(r.updated_at),
    syncedAt: r.synced_at
  })

/** Labels are the issues' one JSON column, for the reason `teams` is the projects'. */
const LabelsJson = Schema.parseJson(Schema.Array(IssueLabel))

/** Same tolerance as every other Linear enum here: a type we do not know is `unknown`. */
const toIssueStateType = (raw: string): IssueStateType =>
  Schema.is(IssueStateType)(raw) ? raw : 'unknown'

export const ProjectIssueRow = Schema.Struct({
  id: ProjectIssueId,
  project_id: ProjectId,
  linear_id: Schema.String,
  identifier: Schema.String,
  title: Schema.String,
  state_id: Schema.String,
  state_name: Schema.String,
  state_type: Schema.String,
  state_color: Schema.NullOr(Schema.String),
  state_position: Schema.Number,
  priority: Schema.Number,
  priority_label: Schema.NullOr(Schema.String),
  assignee_id: Schema.NullOr(Schema.String),
  assignee_name: Schema.NullOr(Schema.String),
  assignee_avatar: Schema.NullOr(Schema.String),
  labels: LabelsJson,
  milestone_name: Schema.NullOr(Schema.String),
  due_date: Schema.NullOr(Schema.String),
  url: Schema.String,
  sort_order: Schema.Number,
  created_at: Schema.NullOr(Schema.DateTimeUtc),
  updated_at: Schema.NullOr(Schema.DateTimeUtc),
  synced_at: Schema.DateTimeUtc
})
export type ProjectIssueRow = typeof ProjectIssueRow.Type

export const toProjectIssue = (r: ProjectIssueRow): ProjectIssue =>
  new ProjectIssue({
    id: r.id,
    projectId: r.project_id,
    linearId: r.linear_id,
    identifier: r.identifier,
    title: r.title,
    state: IssueState.make({
      id: r.state_id,
      name: r.state_name,
      type: toIssueStateType(r.state_type),
      color: orUndefined(r.state_color),
      position: r.state_position
    }),
    priority: toProjectPriority(r.priority),
    priorityLabel: orUndefined(r.priority_label),
    assignee:
      r.assignee_id === null || r.assignee_name === null
        ? undefined
        : {
            linearId: r.assignee_id,
            name: r.assignee_name,
            avatarUrl: orUndefined(r.assignee_avatar)
          },
    labels: r.labels,
    milestoneName: orUndefined(r.milestone_name),
    dueDate: orUndefined(r.due_date),
    url: r.url,
    sortOrder: r.sort_order,
    createdAt: orUndefined(r.created_at),
    updatedAt: orUndefined(r.updated_at),
    syncedAt: r.synced_at
  })

export const ProjectMilestoneRow = Schema.Struct({
  id: ProjectMilestoneId,
  project_id: ProjectId,
  linear_id: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  target_date: Schema.NullOr(Schema.String),
  status: Schema.NullOr(Schema.String),
  sort_order: Schema.Number
})
export type ProjectMilestoneRow = typeof ProjectMilestoneRow.Type

export const toProjectMilestone = (r: ProjectMilestoneRow): ProjectMilestone =>
  new ProjectMilestone({
    id: r.id,
    projectId: r.project_id,
    linearId: r.linear_id,
    name: r.name,
    description: orUndefined(r.description),
    targetDate: orUndefined(r.target_date),
    status: toMilestoneStatus(r.status),
    sortOrder: r.sort_order
  })

/**
 * The company's Linear connection, key excluded. `api_key_ct` is deliberately not
 * a column of this shape: selecting it here would put the ciphertext one careless
 * `emit` away from an event payload, so it lives in its own query inside `Linear`
 * (docs/build-plan-projects.md D2).
 */
export const LinearConnectionRow = Schema.Struct({
  company_id: CompanyId,
  key_hint: Schema.String,
  workspace_name: Schema.NullOr(Schema.String),
  workspace_url_key: Schema.NullOr(Schema.String),
  connected_at: Schema.DateTimeUtc,
  last_synced_at: Schema.NullOr(Schema.DateTimeUtc),
  last_sync_error: Schema.NullOr(Schema.String)
})
export type LinearConnectionRow = typeof LinearConnectionRow.Type

/** No row at all is `none`: nobody has ever pasted a key for this company. */
export const toLinearConnection = (
  companyId: CompanyId,
  row: LinearConnectionRow | undefined
): LinearConnection =>
  row === undefined
    ? new LinearConnection({ companyId, state: 'none' })
    : new LinearConnection({
        companyId,
        state: 'connected',
        workspaceName: orUndefined(row.workspace_name),
        workspaceUrlKey: orUndefined(row.workspace_url_key),
        keyHint: row.key_hint,
        connectedAt: row.connected_at,
        lastSyncedAt: orUndefined(row.last_synced_at),
        lastSyncError: orUndefined(row.last_sync_error)
      })

/**
 * One person in the workspace (docs/build-plan-projects.md D15). `active` is
 * SQLite's 0/1; `user_id` is the only column the sync does not write.
 */
export const LinearUserRow = Schema.Struct({
  company_id: CompanyId,
  linear_id: Schema.String,
  name: Schema.String,
  display_name: Schema.NullOr(Schema.String),
  email: Schema.NullOr(Schema.String),
  avatar_url: Schema.NullOr(Schema.String),
  active: Schema.Number,
  user_id: Schema.NullOr(UserId),
  linked_at: Schema.NullOr(Schema.DateTimeUtc),
  synced_at: Schema.DateTimeUtc
})
export type LinearUserRow = typeof LinearUserRow.Type

export const toLinearUser = (r: LinearUserRow): LinearUser =>
  new LinearUser({
    companyId: r.company_id,
    linearId: r.linear_id,
    name: r.name,
    displayName: orUndefined(r.display_name),
    email: orUndefined(r.email),
    avatarUrl: orUndefined(r.avatar_url),
    active: r.active !== 0,
    member: orUndefined(r.user_id),
    linkedAt: orUndefined(r.linked_at),
    syncedAt: r.synced_at
  })

// ── calls (huddles) ──────────────────────────────────────────────────────────

/**
 * One huddle (docs/build-plan-calls.md). `room` is stored rather than derived so the
 * webhook can find the call by the only thing LiveKit tells us — the room name — with
 * a plain lookup instead of parsing an id back out of it.
 */
export const CallRow = Schema.Struct({
  id: CallId,
  company_id: CompanyId,
  channel_id: ChannelId,
  room: Schema.String,
  started_by_kind: MemberKind,
  started_by_id: MemberId,
  started_at: Schema.DateTimeUtc,
  ended_at: Schema.NullOr(Schema.DateTimeUtc),
  summary_message_id: Schema.NullOr(MessageId)
})
export type CallRow = typeof CallRow.Type

export const CallParticipantRow = Schema.Struct({
  call_id: CallId,
  member_kind: MemberKind,
  member_id: MemberId,
  joined_at: Schema.DateTimeUtc,
  left_at: Schema.NullOr(Schema.DateTimeUtc),
  /** SQLite has no boolean: 0/1. */
  sharing: Schema.Number
})
export type CallParticipantRow = typeof CallParticipantRow.Type

export const toCallParticipant = (r: CallParticipantRow): CallParticipant =>
  new CallParticipant({
    kind: r.member_kind,
    id: r.member_id,
    joinedAt: r.joined_at,
    sharing: r.sharing !== 0
  })

/** `participants` is whoever the caller selected — normally the live ones, in join order. */
export const toCall = (r: CallRow, participants: ReadonlyArray<CallParticipantRow> = []): Call =>
  new Call({
    id: r.id,
    companyId: r.company_id,
    channelId: r.channel_id,
    room: r.room,
    startedByKind: r.started_by_kind,
    startedById: r.started_by_id,
    startedAt: r.started_at,
    endedAt: orUndefined(r.ended_at),
    // The column is still named for the summary; since D8 (docs/build-plan-huddle-window.md)
    // it holds the message from the moment the huddle opens, and D14 keeps the name.
    messageId: orUndefined(r.summary_message_id),
    participants: participants.map(toCallParticipant)
  })
