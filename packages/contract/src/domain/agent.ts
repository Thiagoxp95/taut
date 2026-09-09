import { Schema } from 'effect'

import { AgentId, CompanyId, DepartmentId, SubscriptionId } from '../ids.js'
import { Avatar } from './avatar.js'
import {
  AgentStatus,
  FileGrantMode,
  PermissionMode,
  RuntimeKind,
  SkillOrigin,
  SkillState,
  SkillUpdatePolicy
} from './enums.js'
import { DisplayName, Handle } from './primitives.js'

export class Agent extends Schema.Class<Agent>('Agent')({
  id: AgentId,
  companyId: CompanyId,
  handle: Handle,
  name: DisplayName,
  avatar: Avatar,
  /** One line, the job title shown in member lists. */
  role: Schema.String,
  /** Markdown standing instructions; rendered to AGENT.md on disk. */
  mandate: Schema.String,
  runtimeKind: RuntimeKind,
  /** Skip pool rotation and always run on this seat. */
  pinnedSubscriptionId: Schema.optional(SubscriptionId),
  /** Overrides `Subscription.defaultModel`. */
  model: Schema.optional(Schema.String),
  permissionMode: PermissionMode,
  /**
   * Whether the agent gets a headless browser (Playwright MCP, tools `mcp__browser__*`) inside
   * its machine. Off by default; settable by whoever may manage the agent. Encoded as optional
   * so `agent.*` events logged before Phase 7 still decode (they read as `false`).
   */
  browserAccess: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  status: AgentStatus,
  /**
   * When the agent was archived — what `agents.delete` does. The row, the home folder and
   * every message it ever posted stay where they are; the runtime never wakes it again and
   * its DMs are archived with it. Absent while the agent is live.
   */
  archivedAt: Schema.optional(Schema.DateTimeUtc),
  /**
   * Departments the agent belongs to (`department_members`), oldest first. Populated by
   * `agents.list` / `agents.get` and every `agent.*` event; decodes to `[]` when absent.
   */
  departmentIds: Schema.optionalWith(Schema.Array(DepartmentId), { default: () => [] }),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}

/**
 * Skill body lives on disk at `<home>/skills/<name>/SKILL.md`.
 *
 * `builtin` skills are baked into the server (`agents/defaultSkills.ts`), not authored by
 * anyone: every agent has them, `putSkill` and `deleteSkill` refuse them with `Forbidden`,
 * and the server rewrites them from source on boot. Clients show them read-only.
 */
export class AgentSkill extends Schema.Class<AgentSkill>('AgentSkill')({
  agentId: AgentId,
  name: Handle,
  description: Schema.String,
  /** Shipped with Taut and unmodifiable. Kept as `origin === 'builtin'` so older clients still read. */
  builtin: Schema.Boolean,
  /**
   * Where the skill came from (docs/build-plan-skills.md D6). Optional on the wire so every
   * `agent.*` event logged before this build still decodes, as `authored` — which is what those
   * skills are.
   */
  origin: Schema.optionalWith(SkillOrigin, { default: () => 'authored' as const }),
  /** `pending` waits on a human (D7); it is never rendered into the runtime's instructions. */
  state: Schema.optionalWith(SkillState, { default: () => 'active' as const }),
  /** Canonical source string, e.g. `github:mattpocock/skills#grill-with-docs`. `installed` only. */
  source: Schema.optional(Schema.String),
  updatePolicy: Schema.optionalWith(SkillUpdatePolicy, { default: () => 'notify' as const }),
  /** Upstream has changed since this was installed and the change has not been applied (D9). */
  updateAvailable: Schema.optionalWith(Schema.Boolean, { default: () => false })
}) {}

/** `agents.getSkill`: the skill row plus the markdown body below the frontmatter. */
export class AgentSkillDetail extends Schema.Class<AgentSkillDetail>('AgentSkillDetail')({
  agentId: AgentId,
  name: Handle,
  description: Schema.String,
  /** See `AgentSkill.builtin`. */
  builtin: Schema.Boolean,
  /** `SKILL.md` without its `---` frontmatter block; `""` when the file is missing on disk. */
  body: Schema.String,
  /** See `AgentSkill`; same defaults, same reason. */
  origin: Schema.optionalWith(SkillOrigin, { default: () => 'authored' as const }),
  state: Schema.optionalWith(SkillState, { default: () => 'active' as const }),
  source: Schema.optional(Schema.String),
  updatePolicy: Schema.optionalWith(SkillUpdatePolicy, { default: () => 'notify' as const }),
  updateAvailable: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** The commit this was installed from. */
  resolvedSha: Schema.optional(Schema.String),
  /** Last time the updater looked upstream (D9). */
  checkedAt: Schema.optional(Schema.DateTimeUtc),
  /** Upstream `SKILL.md` body when `updateAvailable`; the UI diffs it against `body`. */
  upstreamBody: Schema.optional(Schema.String),
  /** Sibling files kept next to `SKILL.md` (D5), home-relative, for the file list in the UI. */
  files: Schema.optionalWith(Schema.Array(Schema.String), { default: () => [] })
}) {}

/** A path outside the agent's home it may read (`ro`) or write (`rw`). */
export class AgentFileGrant extends Schema.Class<AgentFileGrant>('AgentFileGrant')({
  agentId: AgentId,
  path: Schema.String,
  mode: FileGrantMode
}) {}
