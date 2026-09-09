import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import { ProjectDetail } from '@taut/contract/domain'
import type {
  LinearConnection,
  LinearUser,
  Project,
  ProjectIssue,
  ProjectMilestone
} from '@taut/contract/domain'
import { Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import {
  type CompanyId,
  ProjectId,
  type UserId,
  newProjectId,
  newProjectIssueId,
  newProjectMilestoneId
} from '@taut/contract/ids'
import { DateTime, Effect, Option, Schema } from 'effect'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import {
  LinearUserRow,
  ProjectIssueRow,
  ProjectMilestoneRow,
  ProjectRow,
  toLinearConnection,
  toLinearUser,
  toProject,
  toProjectIssue,
  toProjectMilestone
} from '../domain/rows.js'
import { type Actor, actor, requireAdmin } from './access.js'
import {
  type LinearFailure,
  Linear,
  type LinearIssue,
  type LinearProject,
  type LinearWorkspaceUser
} from './linear.js'
import { EventPublisher } from './publisher.js'

/**
 * The milestone a board card names (D14). Linear shows the one it is working
 * towards, so `next` wins; failing that the first unfinished one by Linear's own
 * order, which is also what a mirror synced before D14 — every status NULL —
 * falls back to.
 */
const NEXT_MILESTONE = (column: 'name' | 'target_date') => `(
    SELECT m.${column} FROM project_milestones m
    WHERE m.project_id = projects.id AND COALESCE(m.status, '') <> 'done'
    ORDER BY CASE WHEN m.status = 'next' THEN 0 ELSE 1 END, m.sort_order ASC, m.name ASC
    LIMIT 1
  )`

const COLUMNS =
  'id, company_id, linear_id, name, description, state, ' +
  'status_id, status_name, status_type, status_color, status_position, ' +
  'priority, priority_label, priority_sort_order, health, issue_count, ' +
  `${NEXT_MILESTONE('name')} AS next_milestone_name, ` +
  `${NEXT_MILESTONE('target_date')} AS next_milestone_target, ` +
  'progress, icon, color, url, ' +
  'lead_name, lead_email, lead_avatar, teams, start_date, target_date, updated_at, synced_at'

const MILESTONE_COLUMNS =
  'id, project_id, linear_id, name, description, target_date, status, sort_order'

const ISSUE_COLUMNS =
  'id, project_id, linear_id, identifier, title, ' +
  'state_id, state_name, state_type, state_color, state_position, ' +
  'priority, priority_label, assignee_id, assignee_name, assignee_avatar, ' +
  'labels, milestone_name, due_date, url, sort_order, created_at, updated_at, synced_at'

const LINEAR_USER_COLUMNS =
  'company_id, linear_id, name, display_name, email, avatar_url, active, user_id, ' +
  'linked_at, synced_at'

/**
 * Projects mirrored from the company's Linear workspace
 * (docs/build-plan-projects.md D1).
 *
 * The split is the vault's and the repositories': the company owns the
 * connection — connecting, disconnecting and syncing are admin+ — and every
 * member reads the mirror (D9). Unlike repositories there are no per-agent
 * grants, because there is nothing to hand out: a project is a name, a state and
 * a link, and it is read-only for everyone including the server (D1).
 *
 * `sync` is the mirror's bulk writer. It reconciles rather than replaces (D6): a
 * project keeps its `prj_…` id across syncs, because the sidebar links to that id
 * and a refresh must not break a bookmark or a back button.
 *
 * `move` is the one write that starts in Taut (D13). It does not edit the mirror
 * and then tell Linear: it asks Linear to change the status, waits, and writes the
 * row from the project Linear sends back. A Linear that refuses leaves the mirror
 * exactly as it was, which is what lets the board put a dropped card back.
 */
export class Projects extends Effect.Service<Projects>()('Projects', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const publisher = yield* EventPublisher
    const linear = yield* Linear

    // ── queries ──────────────────────────────────────────────────────────────

    const Key = Schema.Struct({ companyId: Schema.String, projectId: ProjectId })

    /**
     * Most recent Linear activity first, then name: what someone scanning a
     * sidebar wants, and stable when `updated_at` is missing.
     */
    const listOf = findAll({
      Request: Schema.String,
      Result: ProjectRow,
      execute: (companyId) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM projects
        WHERE company_id = ${companyId}
        ORDER BY updated_at DESC NULLS LAST, name ASC, rowid ASC`
    })

    const byId = findOne({
      Request: Key,
      Result: ProjectRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM projects
        WHERE company_id = ${r.companyId} AND id = ${r.projectId}`
    })

    const milestonesOf = findAll({
      Request: ProjectId,
      Result: ProjectMilestoneRow,
      execute: (projectId) => sql`
        SELECT ${sql.literal(MILESTONE_COLUMNS)} FROM project_milestones
        WHERE project_id = ${projectId} ORDER BY sort_order ASC, name ASC`
    })

    /**
     * One project's issues, in the order the Issues tab draws them (D19): by the
     * workflow state's own position, then by Linear's tie-break inside it, then by
     * identifier so a state with no ordering is still stable between reads.
     *
     * The grouping is left to the client. It has the states on the rows already,
     * and a `GROUP BY` here would only turn one list into several that the tab
     * would have to stitch back together.
     */
    const issuesOf = findAll({
      Request: ProjectId,
      Result: ProjectIssueRow,
      execute: (projectId) => sql`
        SELECT ${sql.literal(ISSUE_COLUMNS)} FROM project_issues
        WHERE project_id = ${projectId}
        ORDER BY state_position ASC, sort_order ASC, identifier ASC`
    })

    /** Every status id this company's mirror knows — the board's own vocabulary (D13). */
    const statusIds = findAll({
      Request: Schema.String,
      Result: Schema.Struct({ status_id: Schema.NullOr(Schema.String) }),
      execute: (companyId) =>
        sql`SELECT DISTINCT status_id FROM projects
            WHERE company_id = ${companyId} AND status_id IS NOT NULL`
    })

    /** The mirror as `(linearId → taut id)`, which is what makes a sync a reconcile (D6). */
    const identityMap = findAll({
      Request: Schema.String,
      Result: Schema.Struct({ id: ProjectId, linear_id: Schema.String }),
      execute: (companyId) =>
        sql`SELECT id, linear_id FROM projects WHERE company_id = ${companyId}`
    })

    const ProjectWrite = Schema.Struct({
      id: ProjectId,
      companyId: Schema.String,
      linearId: Schema.String,
      name: Schema.String,
      description: Schema.NullOr(Schema.String),
      state: Schema.String,
      statusId: Schema.NullOr(Schema.String),
      statusName: Schema.NullOr(Schema.String),
      statusType: Schema.NullOr(Schema.String),
      statusColor: Schema.NullOr(Schema.String),
      statusPosition: Schema.NullOr(Schema.Number),
      priority: Schema.Number,
      priorityLabel: Schema.NullOr(Schema.String),
      prioritySortOrder: Schema.Number,
      health: Schema.NullOr(Schema.String),
      issueCount: Schema.Number,
      progress: Schema.Number,
      icon: Schema.NullOr(Schema.String),
      color: Schema.NullOr(Schema.String),
      url: Schema.String,
      leadName: Schema.NullOr(Schema.String),
      leadEmail: Schema.NullOr(Schema.String),
      leadAvatar: Schema.NullOr(Schema.String),
      teams: Schema.String,
      startDate: Schema.NullOr(Schema.String),
      targetDate: Schema.NullOr(Schema.String),
      updatedAt: Schema.NullOr(Schema.String),
      syncedAt: Schema.String
    })

    /**
     * Upsert on `(company_id, linear_id)` — never on `id` — so a project Linear
     * renamed keeps the Taut id the sidebar already links to (D6).
     */
    const upsertProject = run({
      Request: ProjectWrite,
      execute: (r) => sql`
        INSERT INTO projects
          (id, company_id, linear_id, name, description, state,
           status_id, status_name, status_type, status_color, status_position,
           priority, priority_label, priority_sort_order, health, issue_count,
           progress, icon, color, url,
           lead_name, lead_email, lead_avatar, teams, start_date, target_date, updated_at, synced_at)
        VALUES (${r.id}, ${r.companyId}, ${r.linearId}, ${r.name}, ${r.description}, ${r.state},
                ${r.statusId}, ${r.statusName}, ${r.statusType}, ${r.statusColor},
                ${r.statusPosition},
                ${r.priority}, ${r.priorityLabel}, ${r.prioritySortOrder}, ${r.health},
                ${r.issueCount},
                ${r.progress}, ${r.icon}, ${r.color}, ${r.url}, ${r.leadName}, ${r.leadEmail},
                ${r.leadAvatar}, ${r.teams}, ${r.startDate}, ${r.targetDate}, ${r.updatedAt},
                ${r.syncedAt})
        ON CONFLICT (company_id, linear_id) DO UPDATE SET
          name = excluded.name, description = excluded.description, state = excluded.state,
          status_id = excluded.status_id, status_name = excluded.status_name,
          status_type = excluded.status_type, status_color = excluded.status_color,
          status_position = excluded.status_position,
          priority = excluded.priority, priority_label = excluded.priority_label,
          priority_sort_order = excluded.priority_sort_order,
          health = excluded.health, issue_count = excluded.issue_count,
          progress = excluded.progress, icon = excluded.icon, color = excluded.color,
          url = excluded.url, lead_name = excluded.lead_name, lead_email = excluded.lead_email,
          lead_avatar = excluded.lead_avatar, teams = excluded.teams,
          start_date = excluded.start_date, target_date = excluded.target_date,
          updated_at = excluded.updated_at, synced_at = excluded.synced_at`
    })

    const deleteProject = run({
      Request: ProjectId,
      execute: (projectId) => sql`DELETE FROM projects WHERE id = ${projectId}`
    })

    const deleteProjects = run({
      Request: Schema.String,
      execute: (companyId) => sql`DELETE FROM projects WHERE company_id = ${companyId}`
    })

    /**
     * Milestones are few per project and entirely Linear's, so a project's set is
     * replaced wholesale rather than diffed. Nothing links to a milestone id.
     */
    const deleteMilestones = run({
      Request: ProjectId,
      execute: (projectId) => sql`DELETE FROM project_milestones WHERE project_id = ${projectId}`
    })

    const insertMilestone = run({
      Request: Schema.Struct({
        id: Schema.String,
        projectId: ProjectId,
        linearId: Schema.String,
        name: Schema.String,
        description: Schema.NullOr(Schema.String),
        targetDate: Schema.NullOr(Schema.String),
        status: Schema.NullOr(Schema.String),
        sortOrder: Schema.Number
      }),
      execute: (r) => sql`
        INSERT INTO project_milestones
          (id, project_id, linear_id, name, description, target_date, status, sort_order)
        VALUES (${r.id}, ${r.projectId}, ${r.linearId}, ${r.name}, ${r.description},
                ${r.targetDate}, ${r.status}, ${r.sortOrder})`
    })

    /**
     * Issues are replaced per project, exactly as milestones are and for the same
     * reason: they are wholly Linear's, nothing in Taut links to a `pis_…` id, and
     * a diff would buy stability nobody can observe.
     */
    const deleteIssues = run({
      Request: ProjectId,
      execute: (projectId) => sql`DELETE FROM project_issues WHERE project_id = ${projectId}`
    })

    const insertIssue = run({
      Request: Schema.Struct({
        id: Schema.String,
        projectId: ProjectId,
        linearId: Schema.String,
        identifier: Schema.String,
        title: Schema.String,
        stateId: Schema.String,
        stateName: Schema.String,
        stateType: Schema.String,
        stateColor: Schema.NullOr(Schema.String),
        statePosition: Schema.Number,
        priority: Schema.Number,
        priorityLabel: Schema.NullOr(Schema.String),
        assigneeId: Schema.NullOr(Schema.String),
        assigneeName: Schema.NullOr(Schema.String),
        assigneeAvatar: Schema.NullOr(Schema.String),
        labels: Schema.String,
        milestoneName: Schema.NullOr(Schema.String),
        dueDate: Schema.NullOr(Schema.String),
        url: Schema.String,
        sortOrder: Schema.Number,
        createdAt: Schema.NullOr(Schema.String),
        updatedAt: Schema.NullOr(Schema.String),
        syncedAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO project_issues
          (id, project_id, linear_id, identifier, title,
           state_id, state_name, state_type, state_color, state_position,
           priority, priority_label, assignee_id, assignee_name, assignee_avatar,
           labels, milestone_name, due_date, url, sort_order, created_at, updated_at, synced_at)
        VALUES (${r.id}, ${r.projectId}, ${r.linearId}, ${r.identifier}, ${r.title},
                ${r.stateId}, ${r.stateName}, ${r.stateType}, ${r.stateColor}, ${r.statePosition},
                ${r.priority}, ${r.priorityLabel}, ${r.assigneeId}, ${r.assigneeName},
                ${r.assigneeAvatar}, ${r.labels}, ${r.milestoneName}, ${r.dueDate}, ${r.url},
                ${r.sortOrder}, ${r.createdAt}, ${r.updatedAt}, ${r.syncedAt})`
    })

    // ── the workspace's people (D15, D16) ────────────────────────────────────

    /**
     * Active first, then name: an admin scanning for somebody to map wants the
     * people who still work here at the top, and the ones who left below.
     */
    const listUsersOf = findAll({
      Request: Schema.String,
      Result: LinearUserRow,
      execute: (companyId) => sql`
        SELECT ${sql.literal(LINEAR_USER_COLUMNS)} FROM linear_users
        WHERE company_id = ${companyId}
        ORDER BY active DESC, name COLLATE NOCASE ASC, linear_id ASC`
    })

    const userByLinearId = findOne({
      Request: Schema.Struct({ companyId: Schema.String, linearId: Schema.String }),
      Result: LinearUserRow,
      execute: (r) => sql`
        SELECT ${sql.literal(LINEAR_USER_COLUMNS)} FROM linear_users
        WHERE company_id = ${r.companyId} AND linear_id = ${r.linearId}`
    })

    /** Whether a user id is actually one of this company's humans (D16). */
    const isMember = findOne({
      Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
      Result: Schema.Struct({ user_id: Schema.String }),
      execute: (r) => sql`
        SELECT user_id FROM memberships
        WHERE company_id = ${r.companyId} AND user_id = ${r.userId}`
    })

    /**
     * The Linear person a human is already mapped to, if any (D16). Also the
     * whole of the gate on D21: no row means the human has not been mapped, and
     * an agent may not file a ticket on their behalf.
     */
    const userByMember = findOne({
      Request: Schema.Struct({ companyId: Schema.String, userId: Schema.String }),
      Result: Schema.Struct({ linear_id: Schema.String, name: Schema.String }),
      execute: (r) => sql`
        SELECT linear_id, name FROM linear_users
        WHERE company_id = ${r.companyId} AND user_id = ${r.userId}`
    })

    /**
     * Every column here is Linear's except `user_id`, which is why the conflict
     * clause names them one by one instead of overwriting the row: a sync must
     * never unmap somebody (D16).
     */
    const upsertLinearUser = run({
      Request: Schema.Struct({
        companyId: Schema.String,
        linearId: Schema.String,
        name: Schema.String,
        displayName: Schema.NullOr(Schema.String),
        email: Schema.NullOr(Schema.String),
        avatarUrl: Schema.NullOr(Schema.String),
        active: Schema.Number,
        syncedAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO linear_users
          (company_id, linear_id, name, display_name, email, avatar_url, active,
           user_id, linked_by, linked_at, synced_at)
        VALUES (${r.companyId}, ${r.linearId}, ${r.name}, ${r.displayName}, ${r.email},
                ${r.avatarUrl}, ${r.active}, NULL, NULL, NULL, ${r.syncedAt})
        ON CONFLICT (company_id, linear_id) DO UPDATE SET
          name = excluded.name, display_name = excluded.display_name,
          email = excluded.email, avatar_url = excluded.avatar_url,
          active = excluded.active, synced_at = excluded.synced_at`
    })

    /** Rows Linear stopped returning — the person is gone, and so is the mapping. */
    const deleteStaleUsers = run({
      Request: Schema.Struct({ companyId: Schema.String, syncedAt: Schema.String }),
      execute: (r) => sql`
        DELETE FROM linear_users
        WHERE company_id = ${r.companyId} AND synced_at <> ${r.syncedAt}`
    })

    const deleteLinearUsers = run({
      Request: Schema.String,
      execute: (companyId) => sql`DELETE FROM linear_users WHERE company_id = ${companyId}`
    })

    const setLinearUserMember = run({
      Request: Schema.Struct({
        companyId: Schema.String,
        linearId: Schema.String,
        userId: Schema.NullOr(Schema.String),
        linkedBy: Schema.NullOr(Schema.String),
        linkedAt: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        UPDATE linear_users
        SET user_id = ${r.userId}, linked_by = ${r.linkedBy}, linked_at = ${r.linkedAt}
        WHERE company_id = ${r.companyId} AND linear_id = ${r.linearId}`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    /** `Projects` only ever fails with contract errors; Linear's refusals become 422. */
    const orValidation = <A>(
      effect: Effect.Effect<A, LinearFailure>
    ): Effect.Effect<A, Validation> =>
      effect.pipe(
        Effect.mapError(
          (error) => new Validation({ issues: [{ path: ['linear'], message: error.reason }] })
        )
      )

    const connectionOf = (companyId: CompanyId): Effect.Effect<LinearConnection> =>
      linear
        .row(companyId)
        .pipe(Effect.map((row) => toLinearConnection(companyId, Option.getOrUndefined(row))))

    const emitConnection = (companyId: CompanyId): Effect.Effect<void> =>
      publisher.transact(companyId, (emit) =>
        connectionOf(companyId).pipe(
          Effect.flatMap((connection) =>
            emit({ type: 'project.linear.changed', payload: { connection } })
          )
        )
      )

    const requireConnected = (who: Actor): Effect.Effect<void, NotFound> =>
      connectionOf(who.companyId).pipe(
        Effect.flatMap((connection) =>
          connection.state === 'connected'
            ? Effect.void
            : Effect.fail(new NotFound({ entity: 'LinearConnection', id: who.companyId }))
        )
      )

    // ── the Linear connection ────────────────────────────────────────────────

    const connection = (me: CurrentUserShape): Effect.Effect<LinearConnection, Unauthorized> =>
      actor(me).pipe(Effect.flatMap((who) => connectionOf(who.companyId)))

    /**
     * Paste a key (D2). It is validated against Linear before anything is stored,
     * so a typo leaves whatever connection existed untouched (D3), and the first
     * sync runs inside the same request — connecting to a workspace and then
     * seeing an empty page would read as a broken connection.
     */
    const connect = (
      me: CurrentUserShape,
      apiKey: string
    ): Effect.Effect<LinearConnection, Unauthorized | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const trimmed = apiKey.trim()
        if (trimmed === '') {
          return yield* new Validation({
            issues: [{ path: ['apiKey'], message: 'Paste a Linear API key' }]
          })
        }
        yield* orValidation(linear.connect(who.companyId, who.userId, trimmed))
        yield* emitConnection(who.companyId)
        // The mirror is best-effort here: the connection is already good, and a
        // sync that fails records itself (D7) rather than undoing the connect.
        yield* reconcile(who.companyId).pipe(Effect.ignore)
        return yield* connectionOf(who.companyId)
      })

    /** Forget the key and every row that came through it. */
    const disconnect = (
      me: CurrentUserShape
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        yield* requireConnected(who)
        yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            // Milestones cascade from projects; projects are dropped explicitly.
            yield* deleteProjects(who.companyId)
            yield* deleteLinearUsers(who.companyId)
            yield* linear.disconnect(who.companyId)
            yield* emit({
              type: 'project.synced',
              payload: { count: 0, syncedAt: yield* DateTime.now }
            })
            yield* emit({
              type: 'project.linear.changed',
              payload: { connection: yield* connectionOf(who.companyId) }
            })
          })
        )
      })

    // ── sync ─────────────────────────────────────────────────────────────────

    /**
     * Pull Linear and reconcile the mirror in one transaction (D6): upsert every
     * project that came back, then delete the rows Linear no longer returns.
     * A refusal from Linear fails before the transaction opens, so the previous
     * mirror survives untouched (D7).
     */
    const reconcile = (companyId: CompanyId): Effect.Effect<number, Validation> =>
      Effect.gen(function* () {
        const fetched = yield* orValidation(linear.projects(companyId)).pipe(
          Effect.tapError((error) =>
            linear.recordSync(companyId, {
              error: error.issues[0]?.message ?? 'the Linear sync failed'
            })
          )
        )
        /**
         * D15: the workspace's people ride along with the projects, and their
         * absence is not an error. A key that cannot read the directory still
         * mirrors every project; the mapping table simply stays as it was.
         */
        const people = yield* Effect.option(
          linear
            .users(companyId)
            .pipe(
              Effect.tapError((error) =>
                Effect.logWarning(`linear: could not list workspace members (${error.reason})`)
              )
            )
        )
        /**
         * D20: the issues ride along too, and their absence is not an error
         * either. They are grouped by the project Linear filed them under, so a
         * project that came back with none simply has its issues cleared.
         */
        const issuesByProject = new Map<string, Array<LinearIssue>>()
        const fetchedIssues = yield* Effect.option(
          linear
            .issues(companyId)
            .pipe(
              Effect.tapError((error) =>
                Effect.logWarning(`linear: could not list the project issues (${error.reason})`)
              )
            )
        )
        if (Option.isSome(fetchedIssues)) {
          for (const issue of fetchedIssues.value) {
            const bucket = issuesByProject.get(issue.projectLinearId)
            if (bucket === undefined) issuesByProject.set(issue.projectLinearId, [issue])
            else bucket.push(issue)
          }
        }
        const syncedAt = nowIso()
        const existing = yield* identityMap(companyId)
        const idOf = new Map(existing.map((row) => [row.linear_id, row.id]))
        const seen = new Set<string>()

        yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            for (const project of fetched) {
              const id = idOf.get(project.linearId) ?? newProjectId()
              seen.add(project.linearId)
              yield* upsertProject(write(companyId, id, project, syncedAt))
              yield* deleteMilestones(id)
              for (const milestone of project.milestones) {
                yield* insertMilestone({
                  id: newProjectMilestoneId(),
                  projectId: id,
                  linearId: milestone.linearId,
                  name: milestone.name,
                  description: milestone.description ?? null,
                  targetDate: milestone.targetDate ?? null,
                  status: milestone.status ?? null,
                  sortOrder: milestone.sortOrder
                })
              }
              /**
               * Only touched when Linear answered the issues query at all. A
               * refusal leaves the previous issues in place, so the tab keeps
               * showing what it last knew rather than emptying itself (D20).
               */
              if (Option.isSome(fetchedIssues)) {
                yield* deleteIssues(id)
                for (const issue of issuesByProject.get(project.linearId) ?? []) {
                  yield* insertIssue(issueWrite(id, issue, syncedAt))
                }
              }
            }
            for (const row of existing) {
              if (!seen.has(row.linear_id)) yield* deleteProject(row.id)
            }
            if (Option.isSome(people)) {
              for (const person of people.value) {
                yield* upsertLinearUser(personWrite(companyId, person, syncedAt))
              }
              // Anything not touched by the loop above is someone Linear no
              // longer has. The mapping goes with them (D16).
              yield* deleteStaleUsers({ companyId, syncedAt })
            }
            yield* linear.recordSync(companyId, { syncedAt })
            yield* emit({
              type: 'project.synced',
              payload: { count: fetched.length, syncedAt: yield* DateTime.now }
            })
          })
        )

        yield* Effect.logInfo(
          `linear: synced ${fetched.length} project(s) for company ${companyId}`
        )
        return fetched.length
      })

    /** One Linear issue as the row the mirror stores (D18). */
    const issueWrite = (projectId: ProjectId, issue: LinearIssue, syncedAt: string) => ({
      id: newProjectIssueId(),
      projectId,
      linearId: issue.linearId,
      identifier: issue.identifier,
      title: issue.title,
      stateId: issue.stateId,
      stateName: issue.stateName,
      stateType: issue.stateType,
      stateColor: issue.stateColor ?? null,
      statePosition: issue.statePosition,
      priority: issue.priority,
      priorityLabel: issue.priorityLabel ?? null,
      assigneeId: issue.assigneeId ?? null,
      assigneeName: issue.assigneeName ?? null,
      assigneeAvatar: issue.assigneeAvatarUrl ?? null,
      labels: JSON.stringify(issue.labels),
      milestoneName: issue.milestoneName ?? null,
      dueDate: issue.dueDate ?? null,
      url: issue.url,
      sortOrder: issue.sortOrder,
      createdAt: issue.createdAt ?? null,
      updatedAt: issue.updatedAt ?? null,
      syncedAt
    })

    /** One Linear person as the row the mapping table stores (D15). */
    const personWrite = (companyId: CompanyId, person: LinearWorkspaceUser, syncedAt: string) => ({
      companyId,
      linearId: person.linearId,
      name: person.name,
      displayName: person.displayName ?? null,
      email: person.email ?? null,
      avatarUrl: person.avatarUrl ?? null,
      active: person.active ? 1 : 0,
      syncedAt
    })

    /** One Linear project as the row the mirror stores. */
    const write = (
      companyId: CompanyId,
      id: ProjectId,
      project: LinearProject,
      syncedAt: string
    ): typeof ProjectWrite.Type => ({
      id,
      companyId,
      linearId: project.linearId,
      name: project.name,
      description: project.description ?? null,
      state: project.state,
      statusId: project.status?.id ?? null,
      statusName: project.status?.name ?? null,
      statusType: project.status?.type ?? null,
      statusColor: project.status?.color ?? null,
      statusPosition: project.status?.position ?? null,
      priority: project.priority,
      priorityLabel: project.priorityLabel ?? null,
      prioritySortOrder: project.prioritySortOrder,
      health: project.health ?? null,
      issueCount: project.issueCount,
      progress: project.progress,
      icon: project.icon ?? null,
      color: project.color ?? null,
      url: project.url,
      leadName: project.leadName ?? null,
      leadEmail: project.leadEmail ?? null,
      leadAvatar: project.leadAvatarUrl ?? null,
      teams: JSON.stringify(project.teams),
      startDate: project.startDate ?? null,
      targetDate: project.targetDate ?? null,
      updatedAt: project.updatedAt ?? null,
      syncedAt
    })

    const sync = (
      me: CurrentUserShape
    ): Effect.Effect<ReadonlyArray<Project>, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        yield* requireConnected(who)
        yield* reconcile(who.companyId)
        return (yield* listOf(who.companyId)).map(toProject)
      })

    // ── reads ────────────────────────────────────────────────────────────────

    const list = (me: CurrentUserShape): Effect.Effect<ReadonlyArray<Project>, Unauthorized> =>
      actor(me).pipe(
        Effect.flatMap((who) => listOf(who.companyId)),
        Effect.map((rows) => rows.map(toProject))
      )

    /**
     * D13: drag a card into another column. Admin+, like every other path that
     * spends the company's Linear key, and the key writes as whoever created it —
     * so this is deliberately not open to every member.
     *
     * `statusId` has to name a status some project in this company's mirror is
     * already in. That is not a permission check; it is what stops a stale or
     * hand-made board from moving a project into another workspace's column.
     */
    const move = (
      me: CurrentUserShape,
      projectId: ProjectId,
      statusId: string
    ): Effect.Effect<Project, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const row = yield* byId({ companyId: who.companyId, projectId })
        if (Option.isNone(row)) {
          return yield* new NotFound({ entity: 'Project', id: projectId })
        }

        const known = yield* statusIds(who.companyId)
        if (!known.some((s) => s.status_id === statusId)) {
          return yield* new Validation({
            issues: [{ path: ['statusId'], message: 'That column is not in this Linear workspace' }]
          })
        }
        if (row.value.status_id === statusId) return toProject(row.value)

        const moved = yield* orValidation(
          linear.moveProject(who.companyId, row.value.linear_id, statusId)
        )
        const syncedAt = nowIso()
        yield* upsertProject(write(who.companyId, projectId, moved, syncedAt))

        const after = yield* byId({ companyId: who.companyId, projectId })
        if (Option.isNone(after)) {
          return yield* new NotFound({ entity: 'Project', id: projectId })
        }
        const project = toProject(after.value)
        yield* publisher.transact(who.companyId, (emit) =>
          emit({ type: 'project.changed', payload: { project } })
        )
        yield* Effect.logInfo(
          `linear: moved project ${projectId} to status ${moved.status?.name ?? statusId}`
        )
        return project
      })

    // ── who these people are, here (D15, D16) ────────────────────────────────

    /** Any member: the workspace's people and the humans they map to. */
    const linearUsers = (
      me: CurrentUserShape
    ): Effect.Effect<ReadonlyArray<LinearUser>, Unauthorized> =>
      actor(me).pipe(
        Effect.flatMap((who) => listUsersOf(who.companyId)),
        Effect.map((rows) => rows.map(toLinearUser))
      )

    /**
     * D16: point one Linear person at one Taut human, or at nobody.
     *
     * Admin+, and the same reasoning as every other write here: this is the
     * company's answer to "who is this", and an agent will one day assign real
     * work through it. Three things are checked before the row moves — the Linear
     * person is in this company's mirror, the human is in this company, and that
     * human is not already somebody else's Linear identity — because a
     * many-to-one mapping makes "assign this to Ted" ambiguous rather than wrong,
     * which is worse.
     */
    const linkLinearUser = (
      me: CurrentUserShape,
      linearUserId: string,
      member: UserId | null
    ): Effect.Effect<LinearUser, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)

        const row = yield* userByLinearId({ companyId: who.companyId, linearId: linearUserId })
        if (Option.isNone(row)) {
          return yield* new NotFound({ entity: 'LinearUser', id: linearUserId })
        }

        if (member !== null) {
          const membership = yield* isMember({ companyId: who.companyId, userId: member })
          if (Option.isNone(membership)) {
            return yield* new Validation({
              issues: [{ path: ['member'], message: 'That person is not in this company' }]
            })
          }
          const taken = yield* userByMember({ companyId: who.companyId, userId: member })
          if (Option.isSome(taken) && taken.value.linear_id !== linearUserId) {
            return yield* new Validation({
              issues: [
                {
                  path: ['member'],
                  message: `That person is already mapped to ${taken.value.name} in Linear`
                }
              ]
            })
          }
        }

        const linkedAt = member === null ? null : nowIso()
        yield* setLinearUserMember({
          companyId: who.companyId,
          linearId: linearUserId,
          userId: member,
          linkedBy: member === null ? null : who.userId,
          linkedAt
        })

        const after = yield* userByLinearId({ companyId: who.companyId, linearId: linearUserId })
        if (Option.isNone(after)) {
          return yield* new NotFound({ entity: 'LinearUser', id: linearUserId })
        }
        const user = toLinearUser(after.value)
        yield* publisher.transact(who.companyId, (emit) =>
          emit({ type: 'project.linear.member.changed', payload: { user } })
        )
        yield* Effect.logInfo(
          member === null
            ? `linear: unmapped ${user.name} (${linearUserId})`
            : `linear: mapped ${user.name} (${linearUserId}) to user ${member}`
        )
        return user
      })

    const get = (
      me: CurrentUserShape,
      projectId: ProjectId
    ): Effect.Effect<ProjectDetail, Unauthorized | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* byId({ companyId: who.companyId, projectId })
        if (Option.isNone(row)) {
          return yield* new NotFound({ entity: 'Project', id: projectId })
        }
        const milestones: ReadonlyArray<ProjectMilestone> = (yield* milestonesOf(projectId)).map(
          toProjectMilestone
        )
        return new ProjectDetail({ project: toProject(row.value), milestones })
      })

    /**
     * D19: one project's issues, for the Issues tab. Every member of the company
     * may read them, exactly as they may read the project itself (D9): an issue
     * is no more private here than the project it hangs off, and Linear has
     * already decided what the key can see.
     */
    const issues = (
      me: CurrentUserShape,
      projectId: ProjectId
    ): Effect.Effect<ReadonlyArray<ProjectIssue>, Unauthorized | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* byId({ companyId: who.companyId, projectId })
        if (Option.isNone(row)) {
          return yield* new NotFound({ entity: 'Project', id: projectId })
        }
        return (yield* issuesOf(projectId)).map(toProjectIssue)
      })

    /**
     * D21: file an issue in Linear on behalf of the human who asked an agent for
     * it. The only write in Taut that an agent can cause to happen in another
     * company's system, so the gate is deliberately narrow and stated in one
     * place — here, not in a prompt.
     *
     * Four things must be true, and each refusal says which so the agent can tell
     * the human something useful rather than "no":
     *
     * 1. The company is connected to Linear at all.
     * 2. The project is in this company's mirror — the agent names a project id
     *    Taut already holds, so no id an agent invented reaches Linear.
     * 3. The project belongs to a team whose Linear id the mirror knows. A mirror
     *    synced before D21 has no team ids; one sync fixes it.
     * 4. **The human who asked is mapped to a Linear person** (D15, D16). This is
     *    the gate the feature exists for: a ticket has to be somebody's, and Taut
     *    will not guess who. An unmapped human gets a refusal naming the settings
     *    page, not a ticket assigned to whoever owns the API key.
     *
     * `requestedBy` is the human of the conversation the agent is answering in —
     * the task's trigger user — and never something the agent chose. An agent
     * running with no human behind it (a routine, a schedule) cannot file
     * anything, which is the same rule stated from the other side.
     */
    const createIssue = (
      companyId: CompanyId,
      requestedBy: UserId | undefined,
      input: {
        readonly projectId: ProjectId
        readonly title: string
        readonly description: string
        readonly priority: number | undefined
      }
    ): Effect.Effect<
      { readonly issue: ProjectIssue; readonly projectName: string },
      Validation | NotFound
    > =>
      Effect.gen(function* () {
        if (requestedBy === undefined) {
          return yield* new Validation({
            issues: [
              {
                path: ['requestedBy'],
                message:
                  'this run has no human behind it, so there is nobody to file the ticket for. Only a request from a person in a conversation can create a Linear issue.'
              }
            ]
          })
        }

        const row = yield* byId({ companyId, projectId: input.projectId })
        if (Option.isNone(row)) {
          return yield* new NotFound({ entity: 'Project', id: input.projectId })
        }
        const project = toProject(row.value)

        const team = project.teams.find((candidate) => candidate.id !== undefined)
        if (team?.id === undefined) {
          return yield* new Validation({
            issues: [
              {
                path: ['projectId'],
                message: `"${project.name}" has no Linear team in the mirror, and Linear files every issue under a team. An admin syncing projects again fixes this.`
              }
            ]
          })
        }

        const mapping = yield* userByMember({ companyId, userId: requestedBy })
        if (Option.isNone(mapping)) {
          return yield* new Validation({
            issues: [
              {
                path: ['requestedBy'],
                message:
                  'the person who asked is not mapped to anyone in Linear, so this ticket would have nobody to belong to. An admin can map them on Settings → Linear, and then this works.'
              }
            ]
          })
        }
        const person = mapping.value

        const created = yield* orValidation(
          linear.createIssue(companyId, {
            teamId: team.id,
            projectLinearId: project.linearId,
            title: input.title,
            description: input.description,
            assigneeId: person.linear_id,
            priority: input.priority
          })
        )

        /**
         * Written straight into the mirror rather than waited for: the next sync
         * would find it anyway, and an agent that just filed a ticket should be
         * able to tell the human it is there. The row is built from what Linear
         * answered, never from what was asked for (D1).
         */
        const syncedAt = nowIso()
        yield* insertIssue(issueWrite(project.id, created, syncedAt))

        const stored = yield* issuesOf(project.id)
        const mine = stored.find((candidate) => candidate.linear_id === created.linearId)
        if (mine === undefined) {
          return yield* new NotFound({ entity: 'ProjectIssue', id: created.linearId })
        }
        const issue = toProjectIssue(mine)

        yield* publisher.transact(companyId, (emit) =>
          emit({ type: 'project.issue.created', payload: { projectId: project.id, issue } })
        )
        yield* Effect.logInfo(
          `linear: ${created.identifier} filed under ${project.name} for user ${requestedBy}`
        )
        return { issue, projectName: project.name }
      })

    /**
     * D22: the company's projects for an agent, with no session behind the call.
     *
     * The agent's own token is the authority — it is already scoped to one
     * company by the time this is reached — so there is no `actor` here and no
     * role check: every agent of a company may see its projects, exactly as every
     * member may (D9). What an agent may *do* with one is the gate below.
     */
    const listForAgent = (companyId: CompanyId): Effect.Effect<ReadonlyArray<Project>> =>
      listOf(companyId).pipe(Effect.map((rows) => rows.map(toProject)))

    /**
     * D21: whether this human may have a ticket filed for them, asked ahead of
     * time so an agent can say "you are not mapped" instead of trying and failing.
     *
     * The same two conditions `createIssue` enforces, in the same order and with
     * the same words — deliberately duplicated rather than abstracted, because a
     * gate that answers one thing here and another there is worse than no gate.
     */
    const canCreateIssues = (
      companyId: CompanyId,
      userId: UserId
    ): Effect.Effect<{
      readonly canCreateIssues: boolean
      readonly reason: string | undefined
    }> =>
      Effect.gen(function* () {
        const connected = yield* linear.row(companyId)
        if (Option.isNone(connected)) {
          return {
            canCreateIssues: false,
            reason:
              'this company is not connected to Linear, so there is nowhere to file a ticket. An admin connects it on Settings → Linear.'
          }
        }
        const mapping = yield* userByMember({ companyId, userId })
        return Option.isNone(mapping)
          ? {
              canCreateIssues: false,
              reason:
                'you are not mapped to a Linear account, so a ticket filed for you would have nobody to belong to. An admin can map you on Settings → Linear.'
            }
          : { canCreateIssues: true, reason: undefined }
      })

    return {
      connection,
      connect,
      disconnect,
      sync,
      move,
      list,
      get,
      issues,
      createIssue,
      listForAgent,
      canCreateIssues,
      linearUsers,
      linkLinearUser
    } as const
  })
}) {}
