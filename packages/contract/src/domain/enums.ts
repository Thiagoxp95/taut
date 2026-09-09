import { Schema } from 'effect'

export const MembershipRole = Schema.Literal('owner', 'admin', 'member')
export type MembershipRole = typeof MembershipRole.Type

export const MemberKind = Schema.Literal('user', 'agent')
export type MemberKind = typeof MemberKind.Type

export const ChannelKind = Schema.Literal('channel', 'dm')
export type ChannelKind = typeof ChannelKind.Type

export const MessageStatus = Schema.Literal('sent', 'streaming', 'failed')
export type MessageStatus = typeof MessageStatus.Type

export const AuthorKind = Schema.Literal('user', 'agent')
export type AuthorKind = typeof AuthorKind.Type

export const CredentialKind = Schema.Literal(
  'anthropic.api_key',
  'claude.oauth',
  'claude.login',
  'openai.api_key',
  'openai.oauth',
  'cursor.api_key',
  'generic.secret'
)
export type CredentialKind = typeof CredentialKind.Type

export const RuntimeKind = Schema.Literal('claude-code', 'codex', 'cursor', 'opencode')
export type RuntimeKind = typeof RuntimeKind.Type

/**
 * Which credential kinds each runtime accepts (docs/agent-model.md §3 table).
 *
 * First in each list is what the connect dialog offers by default. For Claude
 * that is `claude.login` — the whole `claude login` record — because it is the
 * only Claude credential that both runs the runtime and reads
 * `/api/oauth/usage`. A `claude.oauth` setup-token still works and is still
 * accepted; it just leaves the seat with no limits strip.
 */
export const RuntimeCredentialKinds: Record<RuntimeKind, ReadonlyArray<CredentialKind>> = {
  'claude-code': ['claude.login', 'claude.oauth', 'anthropic.api_key'],
  codex: ['openai.oauth', 'openai.api_key'],
  cursor: ['cursor.api_key'],
  opencode: ['anthropic.api_key', 'openai.api_key']
}

/**
 * Kinds that may back a seat's *usage* credential — what the probe reads when
 * the seat's own credential cannot answer (docs/build-plan-usage-limits.md).
 *
 * Claude is the whole reason this exists. `claude setup-token` mints a
 * `user:inference` token that cannot read `/api/oauth/usage`, so a seat pasted
 * as `claude.oauth` needs a second, usage-scoped credential to show a limits
 * strip. A seat pasted as `claude.login` needs nothing extra, and neither does
 * Codex: a seat with no usage credential falls back to its own `credentialId`.
 */
export const RuntimeUsageCredentialKinds: Record<RuntimeKind, ReadonlyArray<CredentialKind>> = {
  'claude-code': ['claude.login'],
  codex: ['openai.oauth'],
  cursor: [],
  opencode: []
}

export const SubscriptionStatus = Schema.Literal('ok', 'auth-failed', 'binary-missing', 'unchecked')
export type SubscriptionStatus = typeof SubscriptionStatus.Type

/** "full-auto" is deferred (docs/agent-model.md §4). */
export const PermissionMode = Schema.Literal('plan', 'auto-edit')
export type PermissionMode = typeof PermissionMode.Type

export const AgentStatus = Schema.Literal('active', 'paused')
export type AgentStatus = typeof AgentStatus.Type

export const TaskStatus = Schema.Literal('queued', 'running', 'done', 'failed', 'cancelled')
export type TaskStatus = typeof TaskStatus.Type

/**
 * A cross-department attempt the server refused (docs/agent-model.md §9). `open` until the
 * head either `raised` it with the other department's head or `dismissed` it.
 */
export const HandoverStatus = Schema.Literal('open', 'raised', 'dismissed')
export type HandoverStatus = typeof HandoverStatus.Type

/**
 * Where a skill came from (docs/build-plan-skills.md D6).
 *
 * `builtin`   — baked into the server (`agents/defaultSkills.ts`), unmodifiable.
 * `authored`  — written by a human in the UI, or by the agent itself via `skill_write`.
 *               No upstream, never checked for updates.
 * `installed` — resolved from an external source; the row carries where and at which commit.
 */
export const SkillOrigin = Schema.Literal('builtin', 'authored', 'installed')
export type SkillOrigin = typeof SkillOrigin.Type

/**
 * `pending` is an install an agent asked for that a human has not approved yet (D7). Its files
 * live under `.taut/pending-skills/`, it is excluded from the rendered CLAUDE.md / AGENTS.md,
 * and approval moves it to `skills/<name>/` and flips it to `active`.
 */
export const SkillState = Schema.Literal('active', 'pending')
export type SkillState = typeof SkillState.Type

/**
 * What happens when an installed skill changes upstream (D9). `notify` is the default: the
 * agent posts an ask into its manager DM and the body is left byte-identical until someone
 * says yes. `auto` applies the change; `manual` never even checks.
 */
export const SkillUpdatePolicy = Schema.Literal('manual', 'notify', 'auto')
export type SkillUpdatePolicy = typeof SkillUpdatePolicy.Type

/** The shape of a parsed skill source (docs/build-plan-skills.md D3, `domain/skillSource.ts`). */
export const SkillSourceKind = Schema.Literal('github', 'raw', 'page', 'inline')
export type SkillSourceKind = typeof SkillSourceKind.Type

/** Whether an agent may install an external skill without a human approving it (D7). */
export const AgentInstallPolicy = Schema.Literal('approve', 'auto')
export type AgentInstallPolicy = typeof AgentInstallPolicy.Type

export const FileGrantMode = Schema.Literal('ro', 'rw')
export type FileGrantMode = typeof FileGrantMode.Type

/** docs/agent-model.md §6 "Notifications" table. */
export const NotificationKind = Schema.Literal(
  'mention',
  'dm',
  'thread_reply',
  'agent_done',
  'agent_failed',
  /** Someone started a huddle in a DM (docs/build-plan-calls.md D8). Channels stay quiet. */
  'huddle'
)
export type NotificationKind = typeof NotificationKind.Type

/** Human presence is set by the client; agent presence is derived from running tasks. */
export const UserPresence = Schema.Literal('online', 'away', 'offline')
export type UserPresence = typeof UserPresence.Type

export const AgentPresence = Schema.Literal('idle', 'working')
export type AgentPresence = typeof AgentPresence.Type

/** What the last tick did with a routine: posted, held back (D6/D11), or blew up. */
export const RoutineRunStatus = Schema.Literal('fired', 'skipped', 'failed')
export type RoutineRunStatus = typeof RoutineRunStatus.Type

/**
 * A department's blobatar silhouette — the shape every agent in it wears
 * (`apps/web/src/lib/agent-avatar.ts`). Stored as the generator's names rather
 * than its trait numbers: the 0–1 bands that select a silhouette are free to
 * move when blobatar takes a major, the names are not, so a name is what a
 * department can still be holding a year from now.
 *
 * Order is the generator's own, everyday shapes first — it is also the order
 * departments without a pick are assigned one, and the order of the picker.
 */
export const DepartmentShape = Schema.Literal(
  'round',
  'organic',
  'boxy',
  'capsule',
  'nub',
  'cloud',
  'droplet',
  'hexagon',
  'sun',
  'triangle'
)
export type DepartmentShape = typeof DepartmentShape.Type

/**
 * How hard the model should think before answering
 * (docs/build-plan-run-overrides.md D7).
 *
 * One vocabulary for every runtime, because the composer shows one row. Each
 * adapter maps it to whatever its CLI actually takes, and a runtime with no
 * such control simply lists none.
 */
export const ReasoningEffort = Schema.Literal('minimal', 'low', 'medium', 'high', 'max')
export type ReasoningEffort = typeof ReasoningEffort.Type

/**
 * Which efforts each runtime can honour (D7). Empty means the runtime has no
 * knob, so the picker hides the row rather than offering a setting that would
 * be dropped on the floor.
 *
 * `claude-code` gets them as `MAX_THINKING_TOKENS`, which has no "minimal":
 * the smallest useful budget is already a few thousand tokens. `codex` passes
 * them straight through as `model_reasoning_effort`, which has no "max".
 */
export const RuntimeReasoningEfforts: Record<RuntimeKind, ReadonlyArray<ReasoningEffort>> = {
  'claude-code': ['low', 'medium', 'high', 'max'],
  codex: ['minimal', 'low', 'medium', 'high'],
  cursor: [],
  opencode: []
}
