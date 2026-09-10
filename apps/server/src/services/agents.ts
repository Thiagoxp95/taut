import { FileSystem } from '@effect/platform'
import type { Multipart } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import type {
  AgentDetail,
  ConnectorInput,
  UpdateConnectorInput,
  CurrentUserShape,
  FileEntry,
  SkillCandidate
} from '@taut/contract/api'
import {
  type Agent,
  type AgentFileGrant,
  type AgentRepoGrant,
  type AgentSkill,
  AgentSkillDetail,
  AgentStatus,
  type Avatar,
  FileGrantMode,
  Handle,
  PermissionMode,
  RuntimeKind,
  SkillOrigin,
  type SkillSource,
  SkillState,
  SkillUpdatePolicy,
  parseSkillSource
} from '@taut/contract/domain'
import { Conflict, Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import {
  AgentId,
  CompanyId,
  DepartmentId,
  type RepositoryId,
  SubscriptionId,
  newAgentId
} from '@taut/contract/ids'
import { Effect, Either, Option, Schema } from 'effect'
import { BUILTIN_SKILLS, isBuiltinSkill } from '../agents/defaultSkills.js'
import {
  asValidation as skillValidation,
  type ResolvedSkill,
  SkillRegistry
} from './skillRegistry.js'
import { Count, findAll, findOne, nowIso, run, single } from '../db/sql.js'
import {
  AgentFileGrantRow,
  AgentRow,
  AgentSkillRow,
  DepartmentRow,
  toAgent,
  toAgentFileGrant,
  toAgentSkill,
  toDepartment
} from '../domain/rows.js'
import { actor, isAdmin } from './access.js'
import { makeAgentAccess } from './agentAccess.js'
import { makeAgentConnectors } from './agentConnectors.js'
import { Channels } from './channels.js'
import { AgentHomes } from './homes.js'
import { type Emit, EventPublisher } from './publisher.js'
import { Repositories } from './repositories.js'

const COLUMNS =
  'id, company_id, handle, name, avatar_json, role, mandate, runtime_kind, pinned_subscription_id, model, permission_mode, browser_access, status, archived_at, created_at, updated_at'

export interface CreateAgentInput {
  readonly handle: Handle
  readonly name: string
  readonly avatar: Avatar
  readonly role: string
  readonly mandate: string
  readonly runtimeKind: RuntimeKind
  readonly pinnedSubscriptionId?: SubscriptionId | undefined
  readonly model?: string | undefined
  readonly permissionMode: PermissionMode
  /** Headless browser inside the machine; `false` when absent. */
  readonly browserAccess?: boolean | undefined
  readonly connectors?: ReadonlyArray<ConnectorInput> | undefined
  readonly departmentId?: DepartmentId | undefined
  /**
   * Repositories the agent may use from its first task
   * (docs/build-plan-repositories.md). Every id must already be attached to the
   * company; anything else fails the whole create with `NotFound`.
   */
  readonly repoGrants?:
    ReadonlyArray<{ readonly repositoryId: RepositoryId; readonly mode: FileGrantMode }> | undefined
}

/** `null` clears an optional field; `undefined` leaves it alone. */
export interface UpdateAgentInput {
  readonly name?: string | undefined
  readonly avatar?: Avatar | undefined
  readonly role?: string | undefined
  readonly mandate?: string | undefined
  readonly runtimeKind?: RuntimeKind | undefined
  readonly pinnedSubscriptionId?: SubscriptionId | null | undefined
  readonly model?: string | null | undefined
  readonly permissionMode?: PermissionMode | undefined
  readonly browserAccess?: boolean | undefined
  readonly status?: AgentStatus | undefined
  /** See `del`: `false` un-archives the agent and its DMs. */
  readonly archived?: boolean | undefined
}

const INBOX = 'inbox'
const isInbox = (rel: string): boolean => {
  const clean = rel.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '')
  return clean === INBOX || clean.startsWith(`${INBOX}/`)
}

/**
 * Agents (docs/agent-model.md §5): DB row + home folder. Agents belong to departments through
 * `department_members` only; the department head (or admin+) manages them, admin+ manages
 * agents in no department. Every file operation resolves inside the home (`AgentHomes`).
 */
export class Agents extends Effect.Service<Agents>()('Agents', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const fs = yield* FileSystem.FileSystem
    const publisher = yield* EventPublisher
    const homes = yield* AgentHomes
    const channels = yield* Channels
    const repositories = yield* Repositories
    const registry = yield* SkillRegistry
    const access = yield* makeAgentAccess
    const connectors = yield* makeAgentConnectors

    // ── queries: agents ──────────────────────────────────────────────────────

    const Key = Schema.Struct({ companyId: CompanyId, agentId: AgentId })

    const listOf = findAll({
      Request: CompanyId,
      Result: AgentRow,
      execute: (companyId) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM agents
        WHERE company_id = ${companyId} ORDER BY created_at ASC, rowid ASC`
    })

    const byId = findOne({
      Request: Key,
      Result: AgentRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM agents
        WHERE company_id = ${r.companyId} AND id = ${r.agentId}`
    })

    /** By id alone: the runtime token already fixes the company, so there is nothing to scope by. */
    const rowById = findOne({
      Request: AgentId,
      Result: AgentRow,
      execute: (agentId) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM agents WHERE id = ${agentId}`
    })

    const handleTaken = findOne({
      Request: Schema.Struct({ companyId: CompanyId, handle: Schema.String }),
      Result: Schema.Struct({ id: AgentId }),
      execute: (r) =>
        sql`SELECT id FROM agents WHERE company_id = ${r.companyId} AND handle = ${r.handle}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: AgentId,
        companyId: CompanyId,
        handle: Schema.String,
        name: Schema.String,
        avatarJson: Schema.String,
        role: Schema.String,
        mandate: Schema.String,
        runtimeKind: RuntimeKind,
        pinnedSubscriptionId: Schema.NullOr(SubscriptionId),
        model: Schema.NullOr(Schema.String),
        permissionMode: PermissionMode,
        browserAccess: Schema.Number,
        at: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO agents
          (id, company_id, handle, name, avatar_json, role, mandate, runtime_kind,
           pinned_subscription_id, model, permission_mode, browser_access, status, created_at, updated_at)
        VALUES (${r.id}, ${r.companyId}, ${r.handle}, ${r.name}, ${r.avatarJson}, ${r.role}, ${r.mandate},
                ${r.runtimeKind}, ${r.pinnedSubscriptionId}, ${r.model}, ${r.permissionMode}, ${r.browserAccess},
                'active', ${r.at}, ${r.at})`
    })

    const update = run({
      Request: Schema.Struct({
        ...Key.fields,
        name: Schema.String,
        avatarJson: Schema.String,
        role: Schema.String,
        mandate: Schema.String,
        runtimeKind: RuntimeKind,
        pinnedSubscriptionId: Schema.NullOr(SubscriptionId),
        model: Schema.NullOr(Schema.String),
        permissionMode: PermissionMode,
        browserAccess: Schema.Number,
        status: AgentStatus,
        at: Schema.String
      }),
      execute: (r) => sql`
        UPDATE agents SET name = ${r.name}, avatar_json = ${r.avatarJson}, role = ${r.role},
          mandate = ${r.mandate}, runtime_kind = ${r.runtimeKind},
          pinned_subscription_id = ${r.pinnedSubscriptionId}, model = ${r.model},
          permission_mode = ${r.permissionMode}, browser_access = ${r.browserAccess},
          status = ${r.status}, updated_at = ${r.at}
        WHERE company_id = ${r.companyId} AND id = ${r.agentId}`
    })

    const touch = run({
      Request: Schema.Struct({ ...Key.fields, at: Schema.String }),
      execute: (r) => sql`
        UPDATE agents SET updated_at = ${r.at} WHERE company_id = ${r.companyId} AND id = ${r.agentId}`
    })

    /** `null` brings the agent back; a timestamp files it away (see `del`). */
    const setArchived = run({
      Request: Schema.Struct({ agentId: AgentId, at: Schema.NullOr(Schema.String) }),
      execute: (r) => sql`UPDATE agents SET archived_at = ${r.at} WHERE id = ${r.agentId}`
    })

    /**
     * A runtime session (`agent_sessions`) replays the instruction file and the prompts that
     * were rendered when it started, so a resumed conversation keeps quoting the old mandate
     * and keeps honouring standing obligations the owner has just removed. Editing the mandate
     * therefore drops every session of the agent: the next task in each channel starts fresh
     * and still carries the last `CONTEXT_MESSAGES` of the conversation in its prompt.
     */
    const clearSessions = run({
      Request: AgentId,
      execute: (agentId) => sql`DELETE FROM agent_sessions WHERE agent_id = ${agentId}`
    })

    // ── queries: references ──────────────────────────────────────────────────

    /** Departments an agent belongs to, with their (human) heads — §9 routing. */
    const departmentsOfAgent = findAll({
      Request: AgentId,
      Result: DepartmentRow,
      execute: (agentId) => sql`
        SELECT d.id, d.company_id, d.name, d.slug, d.head_user_id, d.shape, d.created_at
        FROM department_members dm JOIN departments d ON d.id = dm.department_id
        WHERE dm.member_kind = 'agent' AND dm.member_id = ${agentId}
        ORDER BY d.created_at ASC, d.rowid ASC`
    })

    /** `agent → department ids` for one company (or every company when `companyId` is null). */
    const departmentMemberships = findAll({
      Request: Schema.NullOr(CompanyId),
      Result: Schema.Struct({ member_id: AgentId, department_id: DepartmentId }),
      execute: (companyId) => sql`
        SELECT dm.member_id, dm.department_id
        FROM department_members dm JOIN departments d ON d.id = dm.department_id
        WHERE dm.member_kind = 'agent' AND (${companyId} IS NULL OR d.company_id = ${companyId})
        ORDER BY d.created_at ASC, d.rowid ASC`
    })

    /** Rows → public agents with `departmentIds` filled in (one query per call, not per row). */
    const toAgents = (
      companyId: CompanyId | null,
      rows: ReadonlyArray<AgentRow>
    ): Effect.Effect<ReadonlyArray<Agent>> =>
      departmentMemberships(companyId).pipe(
        Effect.map((memberships) => {
          const byAgent = new Map<AgentId, DepartmentId[]>()
          for (const m of memberships) {
            const bucket = byAgent.get(m.member_id)
            if (bucket === undefined) byAgent.set(m.member_id, [m.department_id])
            else bucket.push(m.department_id)
          }
          return rows.map((row) => toAgent(row, byAgent.get(row.id) ?? []))
        })
      )

    const toAgentOne = (row: AgentRow): Effect.Effect<Agent> =>
      toAgents(row.company_id, [row]).pipe(Effect.map((agents) => agents[0] ?? toAgent(row)))

    const byHandleRow = findOne({
      Request: Schema.Struct({ companyId: CompanyId, handle: Schema.String }),
      Result: AgentRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM agents
        WHERE company_id = ${r.companyId} AND handle = ${r.handle}`
    })

    const allRows = findAll({
      Request: Schema.Void,
      Result: AgentRow,
      execute: () =>
        sql`SELECT ${sql.literal(COLUMNS)} FROM agents ORDER BY created_at ASC, rowid ASC`
    })

    const departmentRow = findOne({
      Request: Schema.Struct({ companyId: CompanyId, departmentId: DepartmentId }),
      Result: DepartmentRow,
      execute: (r) => sql`
        SELECT id, company_id, name, slug, head_user_id, shape, created_at FROM departments
        WHERE company_id = ${r.companyId} AND id = ${r.departmentId}`
    })

    const insertDepartmentMember = run({
      Request: Schema.Struct({ departmentId: DepartmentId, agentId: AgentId }),
      execute: (r) => sql`
        INSERT OR IGNORE INTO department_members (department_id, member_kind, member_id)
        VALUES (${r.departmentId}, 'agent', ${r.agentId})`
    })

    const subscriptionRuntime = findOne({
      Request: Schema.Struct({ companyId: CompanyId, subscriptionId: SubscriptionId }),
      Result: Schema.Struct({ runtime: RuntimeKind }),
      execute: (r) => sql`
        SELECT runtime FROM subscriptions WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    // ── queries: skills / file grants ────────────────────────────────────────

    const SKILL_COLUMNS = sql.literal(
      'agent_id, name, description, origin, state, source, source_kind, source_ref, source_path, resolved_sha, content_hash, upstream_hash, update_policy, checked_at, installed_by, created_at, updated_at'
    )

    /**
     * Only `active` skills (docs/build-plan-skills.md D7). This is the query that feeds
     * `runTask` and therefore the rendered `CLAUDE.md` / `AGENTS.md`, so a skill an agent
     * installed for itself and nobody has approved is invisible to the runtime here — not by a
     * later filter, but by never being selected.
     */
    const skillsOf = findAll({
      Request: AgentId,
      Result: AgentSkillRow,
      execute: (agentId) => sql`
        SELECT ${SKILL_COLUMNS} FROM agent_skills
        WHERE agent_id = ${agentId} AND state = 'active' ORDER BY name`
    })
    /** Every skill including the pending ones: the agent page, which is where they get approved. */
    const allSkillsOf = findAll({
      Request: AgentId,
      Result: AgentSkillRow,
      execute: (agentId) => sql`
        SELECT ${SKILL_COLUMNS} FROM agent_skills WHERE agent_id = ${agentId} ORDER BY name`
    })
    const skillRow = findOne({
      Request: Schema.Struct({ agentId: AgentId, name: Schema.String }),
      Result: AgentSkillRow,
      execute: (r) => sql`
        SELECT ${SKILL_COLUMNS} FROM agent_skills
        WHERE agent_id = ${r.agentId} AND name = ${r.name}`
    })
    const countSkills = single({
      Request: AgentId,
      Result: Count,
      execute: (agentId) => sql`SELECT COUNT(*) AS n FROM agent_skills WHERE agent_id = ${agentId}`
    })

    /**
     * The one write. Everything provenance-shaped is passed explicitly rather than defaulted,
     * so a path that forgets to say where a skill came from does not quietly record `authored`.
     */
    const SkillWrite = Schema.Struct({
      agentId: AgentId,
      name: Schema.String,
      description: Schema.String,
      origin: SkillOrigin,
      state: SkillState,
      source: Schema.NullOr(Schema.String),
      sourceKind: Schema.NullOr(Schema.String),
      sourceRef: Schema.NullOr(Schema.String),
      sourcePath: Schema.NullOr(Schema.String),
      resolvedSha: Schema.NullOr(Schema.String),
      contentHash: Schema.NullOr(Schema.String),
      updatePolicy: SkillUpdatePolicy,
      installedBy: Schema.NullOr(Schema.String),
      at: Schema.String
    })
    const writeSkillRow = run({
      Request: SkillWrite,
      execute: (r) => sql`
        INSERT INTO agent_skills (
          agent_id, name, description, origin, state, source, source_kind, source_ref,
          source_path, resolved_sha, content_hash, upstream_hash, update_policy, checked_at,
          installed_by, created_at, updated_at
        ) VALUES (
          ${r.agentId}, ${r.name}, ${r.description}, ${r.origin}, ${r.state}, ${r.source},
          ${r.sourceKind}, ${r.sourceRef}, ${r.sourcePath}, ${r.resolvedSha}, ${r.contentHash},
          NULL, ${r.updatePolicy}, ${r.at}, ${r.installedBy}, ${r.at}, ${r.at}
        )
        ON CONFLICT (agent_id, name) DO UPDATE SET
          description   = excluded.description,
          origin        = excluded.origin,
          state         = excluded.state,
          source        = excluded.source,
          source_kind   = excluded.source_kind,
          source_ref    = excluded.source_ref,
          source_path   = excluded.source_path,
          resolved_sha  = excluded.resolved_sha,
          content_hash  = excluded.content_hash,
          upstream_hash = NULL,
          update_policy = excluded.update_policy,
          checked_at    = excluded.checked_at,
          updated_at    = excluded.updated_at`
    })

    /** The narrow write `putSkill` and `ensureBuiltinSkills` use: description only, no provenance. */
    const upsertSkill = run({
      Request: Schema.Struct({
        agentId: AgentId,
        name: Schema.String,
        description: Schema.String,
        origin: SkillOrigin,
        at: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO agent_skills (agent_id, name, description, origin, state, update_policy,
                                  created_at, updated_at)
        VALUES (${r.agentId}, ${r.name}, ${r.description}, ${r.origin}, 'active', 'manual',
                ${r.at}, ${r.at})
        ON CONFLICT (agent_id, name) DO UPDATE SET
          description = excluded.description,
          origin      = excluded.origin,
          updated_at  = excluded.updated_at`
    })

    const markState = run({
      Request: Schema.Struct({
        agentId: AgentId,
        name: Schema.String,
        state: SkillState,
        at: Schema.String
      }),
      execute: (r) => sql`
        UPDATE agent_skills SET state = ${r.state}, updated_at = ${r.at}
        WHERE agent_id = ${r.agentId} AND name = ${r.name}`
    })
    const markPolicy = run({
      Request: Schema.Struct({
        agentId: AgentId,
        name: Schema.String,
        policy: SkillUpdatePolicy,
        at: Schema.String
      }),
      execute: (r) => sql`
        UPDATE agent_skills SET update_policy = ${r.policy}, updated_at = ${r.at}
        WHERE agent_id = ${r.agentId} AND name = ${r.name}`
    })
    /** What a check writes: what upstream looks like now, and that we looked. */
    const markChecked = run({
      Request: Schema.Struct({
        agentId: AgentId,
        name: Schema.String,
        upstreamHash: Schema.NullOr(Schema.String),
        at: Schema.String
      }),
      execute: (r) => sql`
        UPDATE agent_skills SET upstream_hash = ${r.upstreamHash}, checked_at = ${r.at}
        WHERE agent_id = ${r.agentId} AND name = ${r.name}`
    })
    const deleteSkill = run({
      Request: Schema.Struct({ agentId: AgentId, name: Schema.String }),
      execute: (r) =>
        sql`DELETE FROM agent_skills WHERE agent_id = ${r.agentId} AND name = ${r.name}`
    })

    /**
     * D9's tick query. `update_policy != 'manual'` and `origin = 'installed'` are what the
     * partial index covers; `checked_at IS NULL` puts a freshly installed skill at the front.
     */
    const dueForCheck = findAll({
      Request: Schema.Struct({ staleBefore: Schema.String, limit: Schema.Number }),
      Result: AgentSkillRow,
      execute: (r) => sql`
        SELECT ${SKILL_COLUMNS} FROM agent_skills
        WHERE origin = 'installed'
          AND update_policy != 'manual'
          AND (checked_at IS NULL OR checked_at < ${r.staleBefore})
        ORDER BY checked_at IS NOT NULL, checked_at ASC
        LIMIT ${r.limit}`
    })

    /** D7: whether this company makes an agent's own installs wait for a human. */
    const companyInstallPolicy = findOne({
      Request: Schema.String,
      Result: Schema.Struct({ skills_agent_install_policy: Schema.String }),
      execute: (companyId) =>
        sql`SELECT skills_agent_install_policy FROM companies WHERE id = ${companyId}`
    })

    const fileGrantsOf = findAll({
      Request: AgentId,
      Result: AgentFileGrantRow,
      execute: (agentId) =>
        sql`SELECT agent_id, path, mode FROM agent_file_grants WHERE agent_id = ${agentId} ORDER BY path`
    })
    const fileGrantRow = findOne({
      Request: Schema.Struct({ agentId: AgentId, path: Schema.String }),
      Result: AgentFileGrantRow,
      execute: (r) => sql`
        SELECT agent_id, path, mode FROM agent_file_grants
        WHERE agent_id = ${r.agentId} AND path = ${r.path}`
    })
    const upsertFileGrant = run({
      Request: Schema.Struct({ agentId: AgentId, path: Schema.String, mode: FileGrantMode }),
      execute: (r) => sql`
        INSERT INTO agent_file_grants (agent_id, path, mode) VALUES (${r.agentId}, ${r.path}, ${r.mode})
        ON CONFLICT (agent_id, path) DO UPDATE SET mode = excluded.mode`
    })
    const deleteFileGrant = run({
      Request: Schema.Struct({ agentId: AgentId, path: Schema.String }),
      execute: (r) =>
        sql`DELETE FROM agent_file_grants WHERE agent_id = ${r.agentId} AND path = ${r.path}`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    const load = (companyId: CompanyId, agentId: AgentId): Effect.Effect<AgentRow, NotFound> =>
      byId({ companyId, agentId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Agent', id: agentId })),
            onSome: Effect.succeed
          })
        )
      )

    const loadPublic = (companyId: CompanyId, agentId: AgentId): Effect.Effect<Agent> =>
      load(companyId, agentId).pipe(Effect.orDie, Effect.flatMap(toAgentOne))

    /** Admin+, or the head of a department the agent belongs to (`agentAccess.ts`). */
    const { canManageAgent: canManage, requireManageAgent: requireManage } = access

    /** A pinned subscription must exist in the company and match the agent's runtime. */
    const validatePinned = (
      companyId: CompanyId,
      runtimeKind: RuntimeKind,
      pinned: SubscriptionId | null
    ): Effect.Effect<void, NotFound | Validation> =>
      Effect.gen(function* () {
        if (pinned === null) return
        const sub = yield* subscriptionRuntime({ companyId, subscriptionId: pinned })
        if (Option.isNone(sub)) return yield* new NotFound({ entity: 'Subscription', id: pinned })
        if (sub.value.runtime !== runtimeKind) {
          return yield* new Validation({
            issues: [
              {
                path: ['pinnedSubscriptionId'],
                message: `subscription runs ${sub.value.runtime}, agent runs ${runtimeKind}`
              }
            ]
          })
        }
      })

    const homeOfRow = (row: AgentRow): Effect.Effect<string> =>
      homes.homeOf(row.company_id, row.handle)

    const emitUpdated = (emit: Emit, companyId: CompanyId, agentId: AgentId) =>
      touch({ companyId, agentId, at: nowIso() }).pipe(
        Effect.zipRight(loadPublic(companyId, agentId)),
        Effect.tap((agent) => emit({ type: 'agent.updated', payload: { agent } }))
      )

    // ── endpoints: crud ──────────────────────────────────────────────────────

    const list = (me: CurrentUserShape): Effect.Effect<ReadonlyArray<Agent>, Unauthorized> =>
      actor(me).pipe(
        Effect.flatMap((who) =>
          listOf(who.companyId).pipe(Effect.flatMap((rows) => toAgents(who.companyId, rows)))
        )
      )

    const get = (
      me: CurrentUserShape,
      agentId: AgentId
    ): Effect.Effect<AgentDetail, Unauthorized | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        const [skills, fileGrants, repoGrants, agentConnectors] = yield* Effect.all([
          // Pending included on purpose: the agent page is where a human approves one (D7).
          allSkillsOf(agentId),
          fileGrantsOf(agentId),
          repositories.grantsOfAgent(agentId),
          connectors.list(agentId)
        ])
        return {
          agent: yield* toAgentOne(row),
          skills: skills.map(toAgentSkill),
          fileGrants: fileGrants.map(toAgentFileGrant),
          repoGrants,
          connectors: agentConnectors
        }
      })

    const create = (
      me: CurrentUserShape,
      input: CreateAgentInput
    ): Effect.Effect<Agent, Unauthorized | Forbidden | Conflict | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const department = input.departmentId
        const dept =
          department === undefined
            ? Option.none()
            : yield* departmentRow({ companyId: who.companyId, departmentId: department })
        if (department !== undefined && Option.isNone(dept)) {
          return yield* new NotFound({ entity: 'Department', id: department })
        }
        const allowed =
          isAdmin(who.role) || (Option.isSome(dept) && dept.value.head_user_id === who.userId)
        if (!allowed) {
          return yield* new Forbidden({
            message:
              department === undefined
                ? 'Requires admin to create an agent outside a department'
                : 'Requires admin or the head of this department'
          })
        }
        if (Option.isSome(yield* handleTaken({ companyId: who.companyId, handle: input.handle }))) {
          return yield* new Conflict({ reason: `Agent handle "${input.handle}" is taken` })
        }
        yield* validatePinned(who.companyId, input.runtimeKind, input.pinnedSubscriptionId ?? null)
        yield* Effect.forEach(input.connectors ?? [], connectors.validate)

        const id = newAgentId()
        const home = yield* homes.homeOf(who.companyId, input.handle)
        yield* homes.writeAgentMd(home, input)
        yield* homes.writeMeta(home, { id, handle: input.handle, companyId: who.companyId })
        yield* Effect.forEach(BUILTIN_SKILLS, (skill) =>
          homes.writeSkill(home, skill.name, skill.description, skill.body)
        )

        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* insert({
              id,
              companyId: who.companyId,
              handle: input.handle,
              name: input.name,
              avatarJson: JSON.stringify(input.avatar),
              role: input.role,
              mandate: input.mandate,
              runtimeKind: input.runtimeKind,
              pinnedSubscriptionId: input.pinnedSubscriptionId ?? null,
              model: input.model ?? null,
              permissionMode: input.permissionMode,
              browserAccess: input.browserAccess === true ? 1 : 0,
              at: nowIso()
            })
            yield* Effect.forEach(BUILTIN_SKILLS, (skill) =>
              upsertSkill({
                agentId: id,
                name: skill.name,
                description: skill.description,
                origin: 'builtin',
                at: nowIso()
              })
            )
            // Join the department first so the returned agent (and `agent.created`) carry it.
            if (Option.isSome(dept)) {
              yield* insertDepartmentMember({ departmentId: dept.value.id, agentId: id })
            }
            // Repository grants from the create form (docs/build-plan-repositories.md).
            // Inside the transaction on purpose: an id that is not attached to the
            // company fails with `NotFound` and takes the whole agent with it,
            // rather than leaving an agent that silently has fewer repositories
            // than the form said it would.
            for (const grant of input.repoGrants ?? []) {
              yield* repositories.grantInternal(who.companyId, id, grant.repositoryId, grant.mode)
            }
            for (const connector of input.connectors ?? []) {
              yield* connectors.add(who.companyId, id, connector)
            }
            const agent = yield* loadPublic(who.companyId, id)
            yield* emit({ type: 'agent.created', payload: { agent } })
            for (const grant of input.repoGrants ?? []) {
              yield* emit({
                type: 'repository.grant.changed',
                payload: { agentId: id, repositoryId: grant.repositoryId, mode: grant.mode }
              })
            }
            if (Option.isSome(dept)) {
              yield* channels.addToDepartmentChannels(emit, who.companyId, dept.value.id, {
                memberKind: 'agent',
                memberId: id
              })
              yield* emit({
                type: 'department.updated',
                payload: { department: toDepartment(dept.value) }
              })
            }
            return agent
          })
        )
      })

    const patch = (
      me: CurrentUserShape,
      agentId: AgentId,
      input: UpdateAgentInput
    ): Effect.Effect<Agent, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        const next = {
          name: input.name ?? row.name,
          avatar: input.avatar ?? row.avatar_json,
          role: input.role ?? row.role,
          mandate: input.mandate ?? row.mandate,
          runtimeKind: input.runtimeKind ?? row.runtime_kind,
          pinnedSubscriptionId:
            input.pinnedSubscriptionId === undefined
              ? row.pinned_subscription_id
              : input.pinnedSubscriptionId,
          model: input.model === undefined ? row.model : input.model,
          permissionMode: input.permissionMode ?? row.permission_mode,
          browserAccess: input.browserAccess ?? row.browser_access !== 0,
          status: input.status ?? row.status,
          archived: input.archived ?? row.archived_at !== null
        }
        if (
          next.pinnedSubscriptionId !== row.pinned_subscription_id ||
          next.runtimeKind !== row.runtime_kind
        ) {
          yield* validatePinned(who.companyId, next.runtimeKind, next.pinnedSubscriptionId)
        }
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* update({
              companyId: who.companyId,
              agentId,
              name: next.name,
              avatarJson: JSON.stringify(next.avatar),
              role: next.role,
              mandate: next.mandate,
              runtimeKind: next.runtimeKind,
              pinnedSubscriptionId: next.pinnedSubscriptionId,
              model: next.model,
              permissionMode: next.permissionMode,
              browserAccess: next.browserAccess ? 1 : 0,
              status: next.status,
              at: nowIso()
            })
            if (next.mandate !== row.mandate || next.name !== row.name || next.role !== row.role) {
              const home = yield* homeOfRow(row)
              yield* homes.writeAgentMd(home, { ...next, handle: row.handle })
            }
            if (next.mandate !== row.mandate) yield* clearSessions(agentId)
            if (next.archived !== (row.archived_at !== null)) {
              const at = next.archived ? nowIso() : null
              yield* setArchived({ agentId, at })
              yield* channels.setDmsArchived(
                emit,
                who.companyId,
                { memberKind: 'agent', memberId: agentId },
                at
              )
            }
            const agent = yield* loadPublic(who.companyId, agentId)
            yield* emit({ type: 'agent.updated', payload: { agent } })
            return agent
          })
        )
      })

    /**
     * Archive, not delete — what the `agents.delete` endpoint does.
     *
     * Dropping the row took the name and the face off every message the agent had ever
     * posted ("Unknown member") and left its DMs in the sidebar with nobody on the other
     * end. So the row, the home folder, the memberships and the history all stay: the agent
     * stops being woken (`scheduler`), its DMs are archived with it, and the threads it
     * answered still read as answered by it, marked archived.
     *
     * Reversible: `update({ status })` on an archived agent brings both back.
     */
    const del = (
      me: CurrentUserShape,
      agentId: AgentId
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* setArchived({ agentId, at: nowIso() })
            yield* channels.setDmsArchived(
              emit,
              who.companyId,
              { memberKind: 'agent', memberId: agentId },
              nowIso()
            )
            yield* clearSessions(agentId)
            const agent = yield* loadPublic(who.companyId, agentId)
            yield* emit({ type: 'agent.updated', payload: { agent } })
          })
        )
      })

    // ── endpoints: skills ────────────────────────────────────────────────────

    const putSkill = (
      me: CurrentUserShape,
      agentId: AgentId,
      name: Handle,
      input: { readonly description: string; readonly body: string }
    ): Effect.Effect<AgentSkill, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        if (isBuiltinSkill(name)) {
          return yield* new Forbidden({
            message: `"${name}" ships with Taut and is read-only; it cannot be edited or replaced`
          })
        }
        const home = yield* homeOfRow(row)
        yield* homes.writeSkill(home, name, input.description, input.body)
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* upsertSkill({
              agentId,
              name,
              description: input.description,
              origin: 'authored',
              at: nowIso()
            })
            yield* emitUpdated(emit, who.companyId, agentId)
            const skill = toAgentSkill(
              yield* skillRow({ agentId, name }).pipe(Effect.flatMap(Effect.orDie))
            )
            yield* emitSkill(emit, skill)
            return skill
          })
        )
      })

    /** Any member: the row plus the `SKILL.md` body (frontmatter stripped). */
    const getSkill = (
      me: CurrentUserShape,
      agentId: AgentId,
      name: Handle
    ): Effect.Effect<AgentSkillDetail, Unauthorized | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        const skill = yield* skillRow({ agentId, name })
        if (Option.isNone(skill)) return yield* new NotFound({ entity: 'AgentSkill', id: name })
        return yield* detailOf(row, skill.value, undefined)
      })

    const removeSkill = (
      me: CurrentUserShape,
      agentId: AgentId,
      name: Handle
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        if (isBuiltinSkill(name)) {
          return yield* new Forbidden({
            message: `"${name}" ships with Taut and is read-only; it cannot be deleted`
          })
        }
        const existing = yield* skillRow({ agentId, name })
        if (Option.isNone(existing)) {
          return yield* new NotFound({ entity: 'AgentSkill', id: name })
        }
        yield* publisher.transact(who.companyId, (emit) =>
          deleteSkill({ agentId, name }).pipe(
            Effect.zipRight(emit({ type: 'agent.skill.removed', payload: { agentId, name } })),
            Effect.zipRight(emitUpdated(emit, who.companyId, agentId))
          )
        )
        const home = yield* homeOfRow(row)
        // Rejecting a pending install is the same call; its files are in the other directory.
        yield* homes.removeSkill(home, name, { pending: existing.value.state === 'pending' })
      })

    // ── endpoints: skills an agent absorbs (docs/build-plan-skills.md) ───────

    /** Cap so a runaway loop cannot fill a home with skills. */
    const MAX_SKILLS = 60
    const MAX_BODY_BYTES = 64 * 1024

    const emitSkill = (emit: Emit, skill: AgentSkill) =>
      emit({ type: 'agent.skill.changed', payload: { skill } })

    const loadSkill = (agentId: AgentId, name: string): Effect.Effect<AgentSkillRow, NotFound> =>
      skillRow({ agentId, name }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => new NotFound({ entity: 'AgentSkill', id: name }),
            onSome: Effect.succeed
          })
        )
      )

    const refuseBuiltin = (name: string, what: string): Effect.Effect<void, Forbidden> =>
      isBuiltinSkill(name)
        ? new Forbidden({
            message: `"${name}" ships with Taut and is read-only; it cannot be ${what}`
          })
        : Effect.void

    const parseSource = (source: string): Effect.Effect<SkillSource, Validation> =>
      parseSkillSource(source).pipe(
        Either.match({
          onLeft: (error) =>
            Effect.fail(new Validation({ issues: [{ path: ['source'], message: error.reason }] })),
          onRight: Effect.succeed
        })
      )

    /**
     * Write one resolved skill into a home and a row, in that order: the files first, so a row
     * never claims a skill the agent cannot read. `pending` decides which of the two directories
     * it lands in (D7) and is the only difference between "installed" and "waiting on a human".
     */
    const landSkill = (
      companyId: CompanyId,
      row: AgentRow,
      resolved: ResolvedSkill,
      options: {
        readonly pending: boolean
        readonly updatePolicy: SkillUpdatePolicy
        readonly installedBy: string
      }
    ): Effect.Effect<AgentSkill, Forbidden | Validation> =>
      Effect.gen(function* () {
        yield* refuseBuiltin(resolved.name, 'replaced by an install')
        const existing = yield* skillRow({ agentId: row.id, name: resolved.name })
        if (Option.isNone(existing) && (yield* countSkills(row.id)).n >= MAX_SKILLS) {
          return yield* new Validation({
            issues: [
              { path: ['source'], message: `an agent may hold at most ${MAX_SKILLS} skills` }
            ]
          })
        }
        const home = yield* homeOfRow(row)
        yield* homes
          .writeSkillDir(home, resolved.name, resolved, { pending: options.pending })
          .pipe(Effect.orDie)
        const at = nowIso()
        return yield* publisher
          .transact(companyId, (emit) =>
            Effect.gen(function* () {
              yield* writeSkillRow({
                agentId: row.id,
                name: resolved.name,
                description: resolved.description,
                origin: 'installed',
                state: options.pending ? 'pending' : 'active',
                source: resolved.canonical,
                sourceKind: resolved.source.kind,
                sourceRef: resolved.source.kind === 'github' ? (resolved.source.ref ?? null) : null,
                sourcePath: resolved.sourcePath ?? null,
                resolvedSha: resolved.resolvedSha ?? null,
                contentHash: resolved.contentHash,
                updatePolicy: options.updatePolicy,
                installedBy: options.installedBy,
                at
              })
              const skill = toAgentSkill(yield* loadSkill(row.id, resolved.name).pipe(Effect.orDie))
              yield* emitSkill(emit, skill)
              return skill
            })
          )
          .pipe(
            Effect.tap(() =>
              homes.appendAudit(
                home,
                `${at} skill.${options.pending ? 'pending' : 'installed'} ${resolved.name} from ${resolved.canonical} by ${options.installedBy}`
              )
            )
          )
      })

    /** What is installable at a source, without installing anything. Managers only. */
    const previewSkill = (
      me: CurrentUserShape,
      agentId: AgentId,
      source: string
    ): Effect.Effect<
      ReadonlyArray<SkillCandidate>,
      Unauthorized | NotFound | Forbidden | Validation
    > =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        const parsed = yield* parseSource(source)
        return yield* registry.preview(who.companyId, parsed).pipe(Effect.mapError(skillValidation))
      })

    /** Install for an agent, as a human. Lands `active`: a manager asking for it is the approval. */
    const installSkill = (
      me: CurrentUserShape,
      agentId: AgentId,
      input: {
        readonly source: string
        readonly name?: string | undefined
        /** Absent means D9's default. */
        readonly updatePolicy?: SkillUpdatePolicy | undefined
      }
    ): Effect.Effect<AgentSkill, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        const parsed = yield* parseSource(input.source)
        const resolved = yield* registry
          .fetch(who.companyId, parsed, input.name)
          .pipe(Effect.mapError(skillValidation))
        return yield* landSkill(who.companyId, row, resolved, {
          pending: false,
          updatePolicy: input.updatePolicy ?? 'notify',
          installedBy: `user:${who.userId}`
        })
      })

    /** Accept what an agent installed for itself: the files move into `skills/` (D7). */
    const approveSkill = (
      me: CurrentUserShape,
      agentId: AgentId,
      name: Handle
    ): Effect.Effect<AgentSkill, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        const skill = yield* loadSkill(agentId, name)
        if (skill.state !== 'pending') return toAgentSkill(skill)
        const home = yield* homeOfRow(row)
        yield* homes.promoteSkill(home, name).pipe(Effect.orDie)
        const at = nowIso()
        return yield* publisher
          .transact(who.companyId, (emit) =>
            Effect.gen(function* () {
              yield* markState({ agentId, name, state: 'active', at })
              const updated = toAgentSkill(yield* loadSkill(agentId, name).pipe(Effect.orDie))
              yield* emitSkill(emit, updated)
              return updated
            })
          )
          .pipe(
            Effect.tap(() =>
              homes.appendAudit(home, `${at} skill.approved ${name} by user:${who.userId}`)
            )
          )
      })

    /**
     * D10: ask upstream what it looks like now. Records the answer and returns the detail,
     * so the UI can show a diff without a second round trip.
     */
    const checkSkillCore = (
      companyId: CompanyId,
      row: AgentRow,
      skill: AgentSkillRow
    ): Effect.Effect<AgentSkillDetail, Validation> =>
      Effect.gen(function* () {
        if (skill.origin !== 'installed' || skill.source === null) {
          return yield* detailOf(row, skill, undefined)
        }
        const upstream = yield* registry
          .upstreamHash(companyId, skill.source, skill.source_path ?? undefined)
          .pipe(Effect.mapError(skillValidation))
        const at = nowIso()
        const hash = Option.getOrNull(upstream)
        yield* markChecked({
          agentId: skill.agent_id,
          name: skill.name,
          upstreamHash: hash === skill.content_hash ? null : hash,
          at
        })
        const fresh = yield* loadSkill(skill.agent_id, skill.name).pipe(Effect.orDie)
        yield* publisher.transact(companyId, (emit) => emitSkill(emit, toAgentSkill(fresh)))
        return yield* detailOf(row, fresh, undefined)
      })

    /** Refetch and rewrite one installed skill from its recorded source (D9 `auto`, or a click). */
    const applySkillUpdate = (
      companyId: CompanyId,
      row: AgentRow,
      skill: AgentSkillRow,
      by: string
    ): Effect.Effect<AgentSkill, Forbidden | Validation> =>
      Effect.gen(function* () {
        if (skill.origin !== 'installed' || skill.source === null) {
          return yield* new Validation({
            issues: [
              {
                path: ['name'],
                message: `"${skill.name}" was not installed from anywhere to update`
              }
            ]
          })
        }
        const parsed = yield* parseSource(skill.source)
        const resolved = yield* registry
          .fetch(companyId, parsed, skill.name)
          .pipe(Effect.mapError(skillValidation))
        return yield* landSkill(companyId, row, resolved, {
          // An update never changes who is allowed to use it: a pending skill stays pending.
          pending: skill.state === 'pending',
          updatePolicy: skill.update_policy,
          installedBy: by
        })
      })

    const detailOf = (
      row: AgentRow,
      skill: AgentSkillRow,
      upstreamBody: string | undefined
    ): Effect.Effect<AgentSkillDetail> =>
      Effect.gen(function* () {
        const home = yield* homeOfRow(row)
        const pending = skill.state === 'pending'
        // `name` is a validated Handle, so the path cannot escape; Forbidden is a defect.
        const body = yield* homes.readSkill(home, skill.name, { pending }).pipe(Effect.orDie)
        const files = yield* homes.listSkillFiles(home, skill.name, { pending }).pipe(Effect.orDie)
        const base = toAgentSkill(skill)
        return new AgentSkillDetail({
          agentId: skill.agent_id,
          name: skill.name,
          description: skill.description,
          builtin: base.builtin,
          body,
          origin: base.origin,
          state: base.state,
          source: base.source,
          updatePolicy: base.updatePolicy,
          updateAvailable: base.updateAvailable,
          resolvedSha: skill.resolved_sha ?? undefined,
          checkedAt: skill.checked_at ?? undefined,
          upstreamBody,
          files
        })
      })

    const checkSkill = (
      me: CurrentUserShape,
      agentId: AgentId,
      name: Handle
    ): Effect.Effect<AgentSkillDetail, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        return yield* checkSkillCore(who.companyId, row, yield* loadSkill(agentId, name))
      })

    const updateSkillNow = (
      me: CurrentUserShape,
      agentId: AgentId,
      name: Handle
    ): Effect.Effect<AgentSkill, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        yield* refuseBuiltin(name, 'updated')
        const skill = yield* loadSkill(agentId, name)
        return yield* applySkillUpdate(who.companyId, row, skill, `user:${who.userId}`)
      })

    const setSkillPolicy = (
      me: CurrentUserShape,
      agentId: AgentId,
      name: Handle,
      policy: SkillUpdatePolicy
    ): Effect.Effect<AgentSkill, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        yield* refuseBuiltin(name, 'configured')
        yield* loadSkill(agentId, name)
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* markPolicy({ agentId, name, policy, at: nowIso() })
            const skill = toAgentSkill(yield* loadSkill(agentId, name).pipe(Effect.orDie))
            yield* emitSkill(emit, skill)
            return skill
          })
        )
      })

    // ── the same three things, done by the agent itself (D8, D12) ────────────

    /**
     * Every method below takes the agent id from the runtime token and never from a payload, so
     * an agent can only ever act on its own skills — the rule the vault already enforces.
     */
    const agentRow = (agentId: AgentId): Effect.Effect<AgentRow, NotFound> =>
      rowById(agentId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => new NotFound({ entity: 'Agent', id: agentId }),
            onSome: Effect.succeed
          })
        )
      )

    /**
     * D8: an agent writing its own `SKILL.md` from what it learned. No approval, because the
     * body is the agent's own words and not a stranger's; still audited, still reversible, and
     * still refused for a built-in.
     */
    const writeSkillForAgent = (
      agentId: AgentId,
      name: string,
      description: string,
      body: string
    ): Effect.Effect<AgentSkill, NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const row = yield* agentRow(agentId)
        const clean = name.trim().toLowerCase()
        if (!/^[a-z0-9][a-z0-9_-]{1,31}$/.test(clean)) {
          return yield* new Validation({
            issues: [{ path: ['name'], message: 'a skill name is 2-32 chars of a-z, 0-9, _ and -' }]
          })
        }
        yield* refuseBuiltin(clean, 'rewritten')
        if (description.trim() === '') {
          return yield* new Validation({
            issues: [
              {
                path: ['description'],
                message:
                  'a skill needs one line saying when to use it; that is what you read when choosing'
              }
            ]
          })
        }
        if (Buffer.byteLength(body, 'utf8') > MAX_BODY_BYTES) {
          return yield* new Validation({
            issues: [{ path: ['body'], message: `a skill body is at most ${MAX_BODY_BYTES} bytes` }]
          })
        }
        const existing = yield* skillRow({ agentId, name: clean })
        if (Option.isNone(existing) && (yield* countSkills(agentId)).n >= MAX_SKILLS) {
          return yield* new Validation({
            issues: [{ path: ['name'], message: `you may hold at most ${MAX_SKILLS} skills` }]
          })
        }
        const home = yield* homeOfRow(row)
        yield* homes.writeSkill(home, clean, description, body).pipe(Effect.orDie)
        const at = nowIso()
        return yield* publisher
          .transact(row.company_id, (emit) =>
            Effect.gen(function* () {
              yield* upsertSkill({
                agentId,
                name: clean,
                description,
                origin: 'authored',
                at
              })
              const skill = toAgentSkill(yield* loadSkill(agentId, clean).pipe(Effect.orDie))
              yield* emitSkill(emit, skill)
              return skill
            })
          )
          .pipe(Effect.tap(() => homes.appendAudit(home, `${at} skill.authored ${clean} by agent`)))
      })

    /**
     * D7: an agent installing something it was handed. Lands `pending` unless the company has
     * opted out, and the caller is expected to tell the human it is waiting.
     */
    const installSkillForAgent = (
      agentId: AgentId,
      source: string,
      wanted: string | undefined,
      policy: SkillUpdatePolicy
    ): Effect.Effect<AgentSkill, NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const row = yield* agentRow(agentId)
        const parsed = yield* parseSource(source)
        const resolved = yield* registry
          .fetch(row.company_id, parsed, wanted)
          .pipe(Effect.mapError(skillValidation))
        const configured = yield* companyInstallPolicy(row.company_id)
        const pending = Option.match(configured, {
          onNone: () => true,
          onSome: (c) => c.skills_agent_install_policy !== 'auto'
        })
        return yield* landSkill(row.company_id, row, resolved, {
          pending,
          updatePolicy: policy,
          installedBy: 'agent'
        })
      })

    const updateSkillForAgent = (
      agentId: AgentId,
      name: string
    ): Effect.Effect<AgentSkill, NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const row = yield* agentRow(agentId)
        yield* refuseBuiltin(name, 'updated')
        const skill = yield* loadSkill(agentId, name)
        return yield* applySkillUpdate(row.company_id, row, skill, 'agent')
      })

    const removeSkillForAgent = (
      agentId: AgentId,
      name: string
    ): Effect.Effect<void, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const row = yield* agentRow(agentId)
        yield* refuseBuiltin(name, 'deleted')
        const skill = yield* loadSkill(agentId, name)
        yield* publisher.transact(row.company_id, (emit) =>
          deleteSkill({ agentId, name }).pipe(
            Effect.zipRight(emit({ type: 'agent.skill.removed', payload: { agentId, name } }))
          )
        )
        const home = yield* homeOfRow(row)
        yield* homes
          .removeSkill(home, name, { pending: skill.state === 'pending' })
          .pipe(Effect.orDie)
      })

    // ── endpoints: files ─────────────────────────────────────────────────────

    const listFiles = (
      me: CurrentUserShape,
      agentId: AgentId,
      subpath?: string | undefined
    ): Effect.Effect<ReadonlyArray<FileEntry>, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        const home = yield* homeOfRow(row)
        return yield* homes.list(home, subpath ?? '')
      })

    /**
     * One file's bytes, managers only (docs/build-plan-workspace.md D3, D12): the home
     * holds memory, sessions and the browser profile, so reading is gated like a shell.
     */
    const readFile = (
      me: CurrentUserShape,
      agentId: AgentId,
      subpath: string
    ): Effect.Effect<
      { readonly path: string; readonly size: number },
      Unauthorized | NotFound | Forbidden
    > =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        const home = yield* homeOfRow(row)
        return yield* homes.readFile(home, subpath)
      })

    /** Members may drop files into `inbox/`; managers anywhere inside the home. */
    const uploadFile = (
      me: CurrentUserShape,
      agentId: AgentId,
      input: { readonly path: string; readonly file: Multipart.PersistedFile }
    ): Effect.Effect<FileEntry, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, agentId)
        if (!isInbox(input.path) && !(yield* canManage(who, agentId))) {
          return yield* new Forbidden({ message: 'Members may only upload into inbox/' })
        }
        const home = yield* homeOfRow(row)
        const bytes = yield* fs.readFile(input.file.path).pipe(Effect.orDie)
        return yield* homes.writeFile(home, input.path, input.file.name, bytes)
      })

    /** Paths outside the home the agent may touch; must be absolute. */
    const grantFile = (
      me: CurrentUserShape,
      agentId: AgentId,
      input: { readonly path: string; readonly mode: FileGrantMode }
    ): Effect.Effect<AgentFileGrant, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        if (!input.path.startsWith('/') || input.path.split('/').includes('..')) {
          return yield* new Validation({
            issues: [{ path: ['path'], message: 'file grants are absolute paths without ".."' }]
          })
        }
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* upsertFileGrant({ agentId, path: input.path, mode: input.mode })
            yield* emitUpdated(emit, who.companyId, agentId)
            const grant = yield* fileGrantRow({ agentId, path: input.path }).pipe(
              Effect.flatMap(Effect.orDie)
            )
            return toAgentFileGrant(grant)
          })
        )
      })

    const revokeFileGrant = (
      me: CurrentUserShape,
      agentId: AgentId,
      path: string
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* load(who.companyId, agentId)
        yield* requireManage(who, agentId)
        if (Option.isNone(yield* fileGrantRow({ agentId, path }))) {
          return yield* new NotFound({ entity: 'AgentFileGrant', id: path })
        }
        yield* publisher.transact(who.companyId, (emit) =>
          deleteFileGrant({ agentId, path }).pipe(
            Effect.zipRight(emitUpdated(emit, who.companyId, agentId))
          )
        )
      })

    // ── scheduler hooks (Phase 4) ────────────────────────────────────────────

    /** The agent row scoped to its company (for the scheduler, which has no session). */
    const byIdInCompany = (
      companyId: CompanyId,
      agentId: AgentId
    ): Effect.Effect<Agent, NotFound> => load(companyId, agentId).pipe(Effect.flatMap(toAgentOne))

    /** Absolute home folder; Phase 4 mounts it as the machine's `/home/agent`. */
    const homeOf = (companyId: CompanyId, agentId: AgentId): Effect.Effect<string, NotFound> =>
      load(companyId, agentId).pipe(Effect.flatMap(homeOfRow))

    return {
      list,
      get,
      create,
      update: patch,
      /** Internal approval seam. The caller holds the transaction and has verified the human. */
      applyApprovedMandate: (
        emit: Emit,
        companyId: CompanyId,
        agentId: AgentId,
        previous: string,
        mandate: string
      ) =>
        Effect.gen(function* () {
          const row = yield* load(companyId, agentId)
          if (row.archived_at !== null || row.mandate !== previous) return false
          yield* sql`UPDATE agents SET mandate = ${mandate}, updated_at = ${nowIso()} WHERE company_id = ${companyId} AND id = ${agentId}`.pipe(
            Effect.orDie
          )
          yield* homes.writeAgentMd(yield* homeOfRow(row), {
            name: row.name,
            handle: row.handle,
            role: row.role,
            mandate
          })
          yield* clearSessions(agentId)
          const agent = yield* loadPublic(companyId, agentId)
          yield* emit({ type: 'agent.updated', payload: { agent } })
          return true
        }),
      delete: del,
      addConnector: (me: CurrentUserShape, agentId: AgentId, input: ConnectorInput) =>
        Effect.gen(function* () {
          const who = yield* actor(me)
          yield* load(who.companyId, agentId)
          yield* requireManage(who, agentId)
          return yield* publisher.transact(who.companyId, (emit) =>
            Effect.gen(function* () {
              const connector = yield* connectors.add(who.companyId, agentId, input)
              yield* clearSessions(agentId)
              yield* emitUpdated(emit, who.companyId, agentId)
              return connector
            })
          )
        }),
      updateConnector: (
        me: CurrentUserShape,
        agentId: AgentId,
        connectorId: string,
        input: UpdateConnectorInput
      ) =>
        Effect.gen(function* () {
          const who = yield* actor(me)
          yield* load(who.companyId, agentId)
          yield* requireManage(who, agentId)
          return yield* publisher.transact(who.companyId, (emit) =>
            Effect.gen(function* () {
              const connector = yield* connectors.update(who.companyId, agentId, connectorId, input)
              yield* clearSessions(agentId)
              yield* emitUpdated(emit, who.companyId, agentId)
              return connector
            })
          )
        }),
      removeConnector: (me: CurrentUserShape, agentId: AgentId, connectorId: string) =>
        Effect.gen(function* () {
          const who = yield* actor(me)
          yield* load(who.companyId, agentId)
          yield* requireManage(who, agentId)
          yield* publisher.transact(who.companyId, (emit) =>
            Effect.gen(function* () {
              yield* connectors.remove(agentId, connectorId)
              yield* clearSessions(agentId)
              yield* emitUpdated(emit, who.companyId, agentId)
            })
          )
        }),
      connectorsForRuntime: connectors.forRuntime,
      getSkill,
      putSkill,
      deleteSkill: removeSkill,
      // docs/build-plan-skills.md — human-facing
      previewSkill,
      installSkill,
      approveSkill,
      checkSkill,
      updateSkillNow,
      setSkillPolicy,
      // the same three things, done by the agent itself (D8, D12)
      writeSkillForAgent,
      installSkillForAgent,
      updateSkillForAgent,
      removeSkillForAgent,
      /** Every skill the agent has, pending included — what `skill_list` answers. */
      allSkillsOf: (agentId: AgentId): Effect.Effect<ReadonlyArray<AgentSkill>> =>
        allSkillsOf(agentId).pipe(Effect.map((rows) => rows.map(toAgentSkill))),
      listFiles,
      readFile,
      uploadFile,
      grantFile,
      revokeFileGrant,
      /**
       * Repository grants (docs/build-plan-repositories.md). `Repositories` owns
       * the `agent_repos` table and the `requireManageAgent` check that guards it;
       * these three are here only because the endpoints live under `/agents`.
       */
      listRepoGrants: (
        me: CurrentUserShape,
        agentId: AgentId
      ): Effect.Effect<ReadonlyArray<AgentRepoGrant>, Unauthorized | NotFound> =>
        repositories.listGrants(me, agentId),
      grantRepo: (
        me: CurrentUserShape,
        agentId: AgentId,
        repositoryId: RepositoryId,
        mode: FileGrantMode
      ): Effect.Effect<AgentRepoGrant, Unauthorized | NotFound | Forbidden> =>
        repositories.grant(me, agentId, repositoryId, mode),
      revokeRepo: (
        me: CurrentUserShape,
        agentId: AgentId,
        repositoryId: RepositoryId
      ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
        repositories.revoke(me, agentId, repositoryId),
      /** Admin+, or the head of a department the agent belongs to (shared with `Vault`). */
      canManage,
      byId: byIdInCompany,
      byHandle: (companyId: CompanyId, handle: string): Effect.Effect<Option.Option<Agent>> =>
        byHandleRow({ companyId, handle: handle.toLowerCase() }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) => toAgentOne(row).pipe(Effect.map(Option.some))
            })
          )
        ),
      /** Every agent of every company (memory ingest startup). */
      all: (): Effect.Effect<ReadonlyArray<Agent>> =>
        allRows(undefined).pipe(Effect.flatMap((rows) => toAgents(null, rows))),
      departmentsOf: (agentId: AgentId) =>
        departmentsOfAgent(agentId).pipe(Effect.map((rows) => rows.map(toDepartment))),
      homeOf,
      skillsOf: (agentId: AgentId) =>
        skillsOf(agentId).pipe(Effect.map((r) => r.map(toAgentSkill))),
      /**
       * `SkillUpdater`'s only read (docs/build-plan-skills.md D9): installed skills that opted
       * into checking and have not been looked at since `staleBefore`, oldest first. The partial
       * index `agent_skills_due` exists for exactly this query.
       */
      skillsDueForCheck: (
        staleBefore: string,
        limit: number
      ): Effect.Effect<ReadonlyArray<{ readonly agent: Agent; readonly skill: AgentSkillRow }>> =>
        dueForCheck({ staleBefore, limit }).pipe(
          Effect.flatMap((rows) =>
            Effect.forEach(rows, (skill) =>
              rowById(skill.agent_id).pipe(
                Effect.flatMap(
                  Option.match({
                    onNone: () => Effect.succeed(undefined),
                    onSome: (agent) =>
                      toAgentOne(agent).pipe(Effect.map((a) => ({ agent: a, skill })))
                  })
                )
              )
            )
          ),
          Effect.map((pairs) =>
            pairs.filter(
              (pair): pair is { readonly agent: Agent; readonly skill: AgentSkillRow } =>
                pair !== undefined
            )
          )
        ),
      /** One check, for the updater. Returns the row as it stands after the look. */
      checkSkillInternal: (
        companyId: CompanyId,
        agentId: AgentId,
        name: string
      ): Effect.Effect<AgentSkillDetail, NotFound | Validation> =>
        Effect.gen(function* () {
          const row = yield* load(companyId, agentId)
          return yield* checkSkillCore(companyId, row, yield* loadSkill(agentId, name))
        }),
      /** Apply an update the updater found, as the updater. */
      applySkillUpdateInternal: (
        companyId: CompanyId,
        agentId: AgentId,
        name: string
      ): Effect.Effect<AgentSkill, NotFound | Forbidden | Validation> =>
        Effect.gen(function* () {
          const row = yield* load(companyId, agentId)
          return yield* applySkillUpdate(companyId, row, yield* loadSkill(agentId, name), 'updater')
        }),
      /** The `SKILL.md` body as it is on disk, for the diff in a `notify` message. */
      skillBody: (agentId: AgentId, name: string): Effect.Effect<string, NotFound> =>
        Effect.gen(function* () {
          const skill = yield* loadSkill(agentId, name)
          const row = yield* agentRow(agentId)
          const home = yield* homeOfRow(row)
          return yield* homes
            .readSkill(home, name, { pending: skill.state === 'pending' })
            .pipe(Effect.orDie)
        }),
      /**
       * Startup re-assertion of the built-ins (`create` handles new agents). Every
       * agent gets every `BUILTIN_SKILLS` entry, and the row and the `SKILL.md` are
       * rewritten from source whether or not they already exist — built-ins are
       * policy, so a hand-edited file on disk or a bumped body in the code converges
       * here rather than drifting. `putSkill` / `deleteSkill` already refuse them, so
       * this only ever repairs out-of-band edits. Returns how many agents changed.
       */
      ensureBuiltinSkills: (): Effect.Effect<number> =>
        Effect.gen(function* () {
          const rows = yield* allRows(undefined)
          let touched = 0
          for (const row of rows) {
            const home = yield* homeOfRow(row)
            let changed = false
            for (const skill of BUILTIN_SKILLS) {
              const existing = yield* skillRow({ agentId: row.id, name: skill.name })
              const onDisk = yield* homes.readSkill(home, skill.name).pipe(
                Effect.orElseSucceed(() => ''),
                Effect.orDie
              )
              const current =
                Option.isSome(existing) &&
                existing.value.description === skill.description &&
                onDisk.trim() === skill.body.trim()
              if (current) continue
              yield* homes
                .writeSkill(home, skill.name, skill.description, skill.body)
                .pipe(Effect.orDie)
              yield* upsertSkill({
                agentId: row.id,
                name: skill.name,
                description: skill.description,
                origin: 'builtin',
                at: nowIso()
              })
              changed = true
            }
            if (changed) touched += 1
          }
          return touched
        }),
      fileGrantsOf: (agentId: AgentId) =>
        fileGrantsOf(agentId).pipe(Effect.map((r) => r.map(toAgentFileGrant)))
    } as const
  })
}) {}
