import { SqlClient } from '@effect/sql'
import type { CreateIssuePayload, CurrentUserShape, UpdateIssuePayload } from '@taut/contract/api'
import {
  IssueActivity,
  IssueDetail,
  IssueHistoryEvent,
  IssueHistoryKind,
  IssueLinearComment,
  IssueOptions,
  IssueState,
  IssueStateType,
  ProjectDetail
} from '@taut/contract/domain'
import type {
  LinearConnection,
  LinearUser,
  Message,
  Project,
  ProjectIssue,
  ProjectMilestone
} from '@taut/contract/domain'
import { Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import {
  AgentId,
  ChannelId,
  type CompanyId,
  MessageId,
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
import { Channels } from './channels.js'
import {
  type LinearFailure,
  Linear,
  type LinearIssue,
  type LinearIssueUpdate,
  type LinearProject,
  type LinearWorkspaceUser
} from './linear.js'
import { Messages } from './messages.js'
import { EventPublisher } from './publisher.js'

/**
 * The two payloads this service takes from the wire (docs/build-plan-issues.md).
 * Named locally so the methods below read as the plan words them, and so that the
 * MCP path (D18) hands over exactly the same shape a browser does — an agent
 * cannot do anything a human in the UI cannot.
 */
type UpdateIssuePayloadShape = typeof UpdateIssuePayload.Type
type CreateIssuePayloadShape = typeof CreateIssuePayload.Type

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

/**
 * Every column of a ticket (docs/build-plan-issues.md D6), qualified with `i.`
 * because every read of one issue now joins `projects` to scope it to the actor's
 * company — an identifier is a company-wide name, so resolving one without that
 * join would hand a reader somebody else's ticket (D15).
 */
const ISSUE_COLUMNS =
  'i.id, i.project_id, i.linear_id, i.identifier, i.title, i.description, ' +
  'i.state_id, i.state_name, i.state_type, i.state_color, i.state_position, ' +
  'i.priority, i.priority_label, i.assignee_id, i.assignee_name, i.assignee_avatar, ' +
  'i.creator_id, i.creator_name, i.creator_avatar, ' +
  'i.labels, i.team_id, i.team_key, i.milestone_name, i.milestone_id, ' +
  'i.due_date, i.estimate, ' +
  'i.parent_linear_id, i.parent_identifier, i.parent_title, i.sub_issue_count, ' +
  'i.url, i.sort_order, i.created_at, i.updated_at, i.completed_at, i.canceled_at, ' +
  'i.synced_at, i.thread_message_id'

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
        SELECT ${sql.literal(ISSUE_COLUMNS)} FROM project_issues i
        WHERE i.project_id = ${projectId}
        ORDER BY i.state_position ASC, i.sort_order ASC, i.identifier ASC`
    })

    // ── one ticket (docs/build-plan-issues.md) ───────────────────────────────

    /**
     * By Taut's own id, scoped to the company through the project it hangs under
     * (D15). The join is the scope: `project_issues` has no `company_id` of its
     * own, and a ticket is exactly as private as its project.
     */
    const issueById = findOne({
      Request: Schema.Struct({ companyId: Schema.String, issueId: Schema.String }),
      Result: ProjectIssueRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ISSUE_COLUMNS)} FROM project_issues i
        JOIN projects p ON p.id = i.project_id
        WHERE p.company_id = ${r.companyId} AND i.id = ${r.issueId}`
    })

    /**
     * By the identifier a human quotes (D15), case-insensitively — `eng-4636`
     * pasted out of a chat message has to resolve to `ENG-4636`. `LIMIT 1` because
     * a workspace could in principle mirror the same identifier twice mid-rename,
     * and answering with an arbitrary one of them beats failing the page.
     */
    const issueByIdentifier = findOne({
      Request: Schema.Struct({ companyId: Schema.String, identifier: Schema.String }),
      Result: ProjectIssueRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ISSUE_COLUMNS)} FROM project_issues i
        JOIN projects p ON p.id = i.project_id
        WHERE p.company_id = ${r.companyId} AND i.identifier = ${r.identifier} COLLATE NOCASE
        LIMIT 1`
    })

    /**
     * The ticket a thread belongs to (D8, D17). One indexed read on
     * `thread_message_id`, and it answers nothing for every ordinary thread —
     * which is what makes it cheap enough for the task runner to ask on every
     * single wake.
     */
    const issueByThread = findOne({
      Request: Schema.Struct({ companyId: Schema.String, threadId: Schema.String }),
      Result: ProjectIssueRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ISSUE_COLUMNS)} FROM project_issues i
        JOIN projects p ON p.id = i.project_id
        WHERE p.company_id = ${r.companyId} AND i.thread_message_id = ${r.threadId}`
    })

    /** The tickets filed under this one (D16), in the order a column reads. */
    const subIssuesOf = findAll({
      Request: Schema.Struct({ companyId: Schema.String, parentLinearId: Schema.String }),
      Result: ProjectIssueRow,
      execute: (r) => sql`
        SELECT ${sql.literal(ISSUE_COLUMNS)} FROM project_issues i
        JOIN projects p ON p.id = i.project_id
        WHERE p.company_id = ${r.companyId} AND i.parent_linear_id = ${r.parentLinearId}
        ORDER BY i.state_position ASC, i.sort_order ASC, i.identifier ASC`
    })

    /**
     * The channel one message is in (D22). Its own statement rather than a
     * `Messages` dependency, for the reason `authorHandle` is: this service is
     * built a tier below `Messages`, and one column is a smaller price than moving
     * the whole mirror up the layer graph.
     */
    const channelOfMessage = findOne({
      Request: Schema.String,
      Result: Schema.Struct({ channel_id: ChannelId }),
      execute: (messageId) => sql`SELECT channel_id FROM messages WHERE id = ${messageId}`
    })

    /** Where a ticket lands when Linear says it moved to another project (D2). */
    const projectByLinearId = findOne({
      Request: Schema.Struct({ companyId: Schema.String, linearId: Schema.String }),
      Result: Schema.Struct({ id: ProjectId }),
      execute: (r) => sql`
        SELECT id FROM projects WHERE company_id = ${r.companyId} AND linear_id = ${r.linearId}`
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

    /**
     * Everything a ticket is, as one row (docs/build-plan-issues.md D6). Shared by
     * the insert and the write-through update, so that the two can never disagree
     * about what a mirrored issue holds.
     */
    const IssueWrite = Schema.Struct({
      id: Schema.String,
      projectId: ProjectId,
      linearId: Schema.String,
      identifier: Schema.String,
      title: Schema.String,
      description: Schema.NullOr(Schema.String),
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
      creatorId: Schema.NullOr(Schema.String),
      creatorName: Schema.NullOr(Schema.String),
      creatorAvatar: Schema.NullOr(Schema.String),
      labels: Schema.String,
      teamId: Schema.NullOr(Schema.String),
      teamKey: Schema.NullOr(Schema.String),
      milestoneName: Schema.NullOr(Schema.String),
      milestoneId: Schema.NullOr(Schema.String),
      dueDate: Schema.NullOr(Schema.String),
      estimate: Schema.NullOr(Schema.Number),
      parentLinearId: Schema.NullOr(Schema.String),
      parentIdentifier: Schema.NullOr(Schema.String),
      parentTitle: Schema.NullOr(Schema.String),
      subIssueCount: Schema.Number,
      url: Schema.String,
      sortOrder: Schema.Number,
      createdAt: Schema.NullOr(Schema.String),
      updatedAt: Schema.NullOr(Schema.String),
      completedAt: Schema.NullOr(Schema.String),
      canceledAt: Schema.NullOr(Schema.String),
      syncedAt: Schema.String
    })

    const insertIssue = run({
      Request: IssueWrite,
      execute: (r) => sql`
        INSERT INTO project_issues
          (id, project_id, linear_id, identifier, title, description,
           state_id, state_name, state_type, state_color, state_position,
           priority, priority_label, assignee_id, assignee_name, assignee_avatar,
           creator_id, creator_name, creator_avatar,
           labels, team_id, team_key, milestone_name, milestone_id, due_date, estimate,
           parent_linear_id, parent_identifier, parent_title, sub_issue_count,
           url, sort_order, created_at, updated_at, completed_at, canceled_at, synced_at)
        VALUES (${r.id}, ${r.projectId}, ${r.linearId}, ${r.identifier}, ${r.title},
                ${r.description},
                ${r.stateId}, ${r.stateName}, ${r.stateType}, ${r.stateColor}, ${r.statePosition},
                ${r.priority}, ${r.priorityLabel}, ${r.assigneeId}, ${r.assigneeName},
                ${r.assigneeAvatar}, ${r.creatorId}, ${r.creatorName}, ${r.creatorAvatar},
                ${r.labels}, ${r.teamId}, ${r.teamKey}, ${r.milestoneName}, ${r.milestoneId},
                ${r.dueDate}, ${r.estimate},
                ${r.parentLinearId}, ${r.parentIdentifier}, ${r.parentTitle}, ${r.subIssueCount},
                ${r.url}, ${r.sortOrder}, ${r.createdAt}, ${r.updatedAt}, ${r.completedAt},
                ${r.canceledAt}, ${r.syncedAt})`
    })

    /**
     * D2: rewrite one row from the issue Linear answered with. By `id`, never by
     * `(project_id, linear_id)`, because the page's URL is that id and a ticket
     * moved to another project must keep it — the row changes project, not
     * identity. `thread_message_id` is untouched here on purpose: it is the one
     * column Linear knows nothing about (D8).
     */
    const updateIssueRow = run({
      Request: IssueWrite,
      execute: (r) => sql`
        UPDATE project_issues SET
          project_id = ${r.projectId}, linear_id = ${r.linearId},
          identifier = ${r.identifier}, title = ${r.title}, description = ${r.description},
          state_id = ${r.stateId}, state_name = ${r.stateName}, state_type = ${r.stateType},
          state_color = ${r.stateColor}, state_position = ${r.statePosition},
          priority = ${r.priority}, priority_label = ${r.priorityLabel},
          assignee_id = ${r.assigneeId}, assignee_name = ${r.assigneeName},
          assignee_avatar = ${r.assigneeAvatar},
          creator_id = ${r.creatorId}, creator_name = ${r.creatorName},
          creator_avatar = ${r.creatorAvatar},
          labels = ${r.labels}, team_id = ${r.teamId}, team_key = ${r.teamKey},
          milestone_name = ${r.milestoneName}, milestone_id = ${r.milestoneId},
          due_date = ${r.dueDate}, estimate = ${r.estimate},
          parent_linear_id = ${r.parentLinearId}, parent_identifier = ${r.parentIdentifier},
          parent_title = ${r.parentTitle}, sub_issue_count = ${r.subIssueCount},
          url = ${r.url}, sort_order = ${r.sortOrder},
          created_at = ${r.createdAt}, updated_at = ${r.updatedAt},
          completed_at = ${r.completedAt}, canceled_at = ${r.canceledAt},
          synced_at = ${r.syncedAt}
        WHERE id = ${r.id}`
    })

    /** D5: the row goes, the thread stays — nothing here touches `messages`. */
    const deleteIssueRow = run({
      Request: Schema.String,
      execute: (issueId) => sql`DELETE FROM project_issues WHERE id = ${issueId}`
    })

    /** D8: the one column Taut owns, written once when the first message is said. */
    const setThreadMessage = run({
      Request: Schema.Struct({ issueId: Schema.String, threadMessageId: Schema.String }),
      execute: (r) => sql`
        UPDATE project_issues SET thread_message_id = ${r.threadMessageId}
        WHERE id = ${r.issueId}`
    })

    // ── what has crossed between Linear and Taut (D11, D12) ──────────────────

    /** Comments of this ticket the ledger already knows, in either direction. */
    const commentsOfIssue = findAll({
      Request: Schema.String,
      Result: Schema.Struct({
        linear_comment_id: Schema.String,
        message_id: MessageId,
        direction: Schema.Literal('in', 'out')
      }),
      execute: (issueId) =>
        sql`SELECT linear_comment_id, message_id, direction FROM project_issue_comments WHERE issue_id = ${issueId}`
    })

    /** Whether this Taut message has already been pushed out — the "not twice" rule. */
    const commentByMessage = findOne({
      Request: Schema.String,
      Result: Schema.Struct({ linear_comment_id: Schema.String }),
      execute: (messageId) =>
        sql`SELECT linear_comment_id FROM project_issue_comments WHERE message_id = ${messageId}`
    })

    const insertComment = run({
      Request: Schema.Struct({
        linearCommentId: Schema.String,
        issueId: Schema.String,
        messageId: Schema.String,
        direction: Schema.Literal('in', 'out'),
        syncedAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT OR IGNORE INTO project_issue_comments
          (linear_comment_id, issue_id, message_id, direction, synced_at)
        VALUES (${r.linearCommentId}, ${r.issueId}, ${r.messageId}, ${r.direction}, ${r.syncedAt})`
    })

    /**
     * Who said it, as Linear should hear it (D11). Its own statement rather than a
     * `Users` dependency: this service is built a tier below `Messages` and reads
     * nothing but its own tables and `Linear`, and one join is a smaller price
     * than moving the whole mirror up the layer graph.
     */
    const authorHandle = findOne({
      Request: Schema.Struct({ companyId: Schema.String, authorId: Schema.String }),
      Result: Schema.Struct({ handle: Schema.String }),
      execute: (r) => sql`
        SELECT LOWER(SUBSTR(u.email, 1, INSTR(u.email, '@') - 1)) AS handle
        FROM users u JOIN memberships m ON m.user_id = u.id AND m.company_id = ${r.companyId}
        WHERE u.id = ${r.authorId}
        UNION ALL
        SELECT a.handle AS handle FROM agents a
        WHERE a.company_id = ${r.companyId} AND a.id = ${r.authorId}
        LIMIT 1`
    })

    /** The agents a first message `@`-mentioned, so they can be joined to the channel (D21). */
    const agentsByHandle = findAll({
      Request: Schema.String,
      Result: Schema.Struct({ id: AgentId, handle: Schema.String }),
      execute: (companyId) => sql`SELECT id, handle FROM agents WHERE company_id = ${companyId}`
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

    /**
     * Linear's timestamp as the contract's `DateTimeUtc`
     * (docs/build-plan-issues.md D13). A node Linear stamped unreadably is placed
     * at now rather than dropped: the Activity feed is a time-ordered list, and one
     * row in roughly the wrong place beats a row that silently is not there.
     */
    const atOf = (iso: string | undefined): DateTime.Utc =>
      Option.getOrElse(DateTime.make(new Date(iso ?? '')), () => DateTime.unsafeNow())

    /**
     * The Linear team a ticket is filed under (docs/build-plan-issues.md D1, D14).
     * Linear files every issue under a team and scopes every workflow state and
     * label to one, so a project whose team id the mirror does not know is the
     * existing "sync first" error (docs/build-plan-projects.md D21) rather than a
     * guess — said in the same words here as there, on purpose.
     */
    const requireTeam = (project: Project): Effect.Effect<string, Validation> => {
      const team = project.teams.find((candidate) => candidate.id !== undefined)
      return team?.id === undefined
        ? Effect.fail(
            new Validation({
              issues: [
                {
                  path: ['projectId'],
                  message: `"${project.name}" has no Linear team in the mirror, and Linear files every issue under a team. An admin syncing projects again fixes this.`
                }
              ]
            })
          )
        : Effect.succeed(team.id)
    }

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

    /**
     * One Linear issue as the row the mirror stores (D18), widened by
     * docs/build-plan-issues.md D6.
     *
     * `id` is a parameter because the same shape serves two writes with opposite
     * needs: the sync inserts a fresh row and wants a new `pis_…`, while a
     * write-through edit rewrites a row whose id the page's URL already is (D2).
     */
    const issueWrite = (
      projectId: ProjectId,
      issue: LinearIssue,
      syncedAt: string,
      id: string = newProjectIssueId()
    ): typeof IssueWrite.Type => ({
      id,
      projectId,
      linearId: issue.linearId,
      identifier: issue.identifier,
      title: issue.title,
      description: issue.description ?? null,
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
      creatorId: issue.creatorId ?? null,
      creatorName: issue.creatorName ?? null,
      creatorAvatar: issue.creatorAvatarUrl ?? null,
      labels: JSON.stringify(issue.labels),
      teamId: issue.teamId ?? null,
      teamKey: issue.teamKey ?? null,
      milestoneName: issue.milestoneName ?? null,
      milestoneId: issue.milestoneId ?? null,
      dueDate: issue.dueDate ?? null,
      estimate: issue.estimate ?? null,
      parentLinearId: issue.parentLinearId ?? null,
      parentIdentifier: issue.parentIdentifier ?? null,
      parentTitle: issue.parentTitle ?? null,
      subIssueCount: issue.subIssueCount,
      url: issue.url,
      sortOrder: issue.sortOrder,
      createdAt: issue.createdAt ?? null,
      updatedAt: issue.updatedAt ?? null,
      completedAt: issue.completedAt ?? null,
      canceledAt: issue.canceledAt ?? null,
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
            priority: input.priority,
            // An agent still files the three fields it always did (D21); the
            // pickers on the issue page are the human path's business, not its.
            stateId: undefined,
            labelIds: undefined,
            milestoneId: undefined,
            dueDate: undefined,
            parentId: undefined
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

    // ── one ticket, editable (docs/build-plan-issues.md) ─────────────────────

    /**
     * D15: `pis_…` first, then the identifier, case-insensitively and always
     * inside the actor's company. Both halves matter: the page's own links carry
     * the id, and everything a human pastes into chat is an identifier.
     *
     * A `NotFound` here says `ProjectIssue` and the ref as given, so a ticket in
     * another company reads exactly like a ticket that does not exist — which is
     * the only honest answer, and the one that does not confirm it exists.
     */
    const resolveIssue = (
      companyId: CompanyId,
      ref: string
    ): Effect.Effect<ProjectIssueRow, NotFound> =>
      Effect.gen(function* () {
        const byPisId = yield* issueById({ companyId, issueId: ref })
        if (Option.isSome(byPisId)) return byPisId.value
        const byIdentifier = yield* issueByIdentifier({ companyId, identifier: ref })
        if (Option.isSome(byIdentifier)) return byIdentifier.value
        return yield* new NotFound({ entity: 'ProjectIssue', id: ref })
      })

    /** The project a ticket hangs under, which the detail page draws as its breadcrumb. */
    const projectOfIssue = (
      companyId: CompanyId,
      row: ProjectIssueRow
    ): Effect.Effect<Project, NotFound> =>
      byId({ companyId, projectId: row.project_id }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Project', id: row.project_id })),
            onSome: (project) => Effect.succeed(toProject(project))
          })
        )
      )

    /**
     * D2, the shape every write here ends in: take the issue Linear answered with,
     * rewrite the row, re-read it and publish `project.issue.updated`. Nothing
     * between the mutation and this is allowed to invent a field — if Linear did
     * not say it, it is not in the row.
     *
     * A ticket Linear says now belongs to another project follows it, provided the
     * mirror holds that project; if it does not (a project synced after this row),
     * the ticket stays where it was until the next sync moves it.
     */
    const rewriteIssue = (
      companyId: CompanyId,
      row: ProjectIssueRow,
      answered: LinearIssue
    ): Effect.Effect<ProjectIssue, NotFound> =>
      Effect.gen(function* () {
        const moved = yield* projectByLinearId({ companyId, linearId: answered.projectLinearId })
        const projectId = Option.isSome(moved) ? moved.value.id : row.project_id
        yield* updateIssueRow(issueWrite(projectId, answered, nowIso(), row.id))

        const after = yield* issueById({ companyId, issueId: row.id })
        if (Option.isNone(after)) {
          return yield* new NotFound({ entity: 'ProjectIssue', id: row.id })
        }
        const issue = toProjectIssue(after.value)
        yield* publisher.transact(companyId, (emit) =>
          emit({ type: 'project.issue.updated', payload: { projectId, issue } })
        )
        return issue
      })

    /**
     * D15: one ticket, its project and its sub-issues, read entirely from the
     * mirror. Deliberately never touches Linear: a detail page that re-fetches to
     * draw itself is a page that is blank whenever Linear is slow (D6). The live
     * half of the page is the Activity feed, and that is its own call.
     *
     * Any member, exactly as the project it hangs under is (docs/build-plan-projects.md D9).
     */
    const issueDetail = (companyId: CompanyId, ref: string): Effect.Effect<IssueDetail, NotFound> =>
      Effect.gen(function* () {
        const row = yield* resolveIssue(companyId, ref)
        const project = yield* projectOfIssue(companyId, row)
        const children = yield* subIssuesOf({ companyId, parentLinearId: row.linear_id })
        /**
         * D22: where the conversation lives, when there is one. Read from the
         * root message rather than from the project, because it is the root that
         * says which channel this ticket's thread is actually in — and a page that
         * has the ticket but not the channel cannot render the one message that
         * may be the whole thread (D21 defers membership, so the reader cannot
         * find it themselves).
         */
        const threadChannelId =
          row.thread_message_id === null
            ? Option.none<ChannelId>()
            : (yield* channelOfMessage(row.thread_message_id)).pipe(
                Option.map((message) => message.channel_id)
              )
        return new IssueDetail({
          issue: toProjectIssue(row),
          project,
          subIssues: children.map(toProjectIssue),
          ...(Option.isNone(threadChannelId) ? {} : { threadChannelId: threadChannelId.value })
        })
      })

    const issue = (
      me: CurrentUserShape,
      ref: string
    ): Effect.Effect<IssueDetail, Unauthorized | NotFound> =>
      actor(me).pipe(Effect.flatMap((who) => issueDetail(who.companyId, ref)))

    /**
     * D2, D4: member+ may change any field of a ticket, by writing it to Linear
     * and taking Linear's answer as the row. An empty payload never reaches
     * Linear: a patch that changes nothing is a bug in the caller, not a round
     * trip worth making.
     */
    const updateIssueFields = (
      companyId: CompanyId,
      ref: string,
      payload: UpdateIssuePayloadShape
    ): Effect.Effect<ProjectIssue, NotFound | Validation> =>
      Effect.gen(function* () {
        const row = yield* resolveIssue(companyId, ref)

        const input: LinearIssueUpdate = {
          ...(payload.title === undefined ? {} : { title: payload.title }),
          ...(payload.description === undefined ? {} : { description: payload.description }),
          ...(payload.stateId === undefined ? {} : { stateId: payload.stateId }),
          ...(payload.priority === undefined ? {} : { priority: payload.priority }),
          ...(payload.assigneeId === undefined ? {} : { assigneeId: payload.assigneeId }),
          ...(payload.labelIds === undefined ? {} : { labelIds: payload.labelIds }),
          ...(payload.milestoneId === undefined ? {} : { projectMilestoneId: payload.milestoneId }),
          ...(payload.dueDate === undefined ? {} : { dueDate: payload.dueDate }),
          ...(payload.estimate === undefined ? {} : { estimate: payload.estimate }),
          ...(payload.parentId === undefined ? {} : { parentId: payload.parentId }),
          ...(payload.projectLinearId === undefined ? {} : { projectId: payload.projectLinearId })
        }
        if (Object.keys(input).length === 0) {
          return yield* new Validation({
            issues: [{ path: [], message: 'Nothing to change' }]
          })
        }

        const answered = yield* orValidation(linear.updateIssue(companyId, row.linear_id, input))
        const issue = yield* rewriteIssue(companyId, row, answered)
        yield* Effect.logInfo(`linear: updated ${issue.identifier} for company ${companyId}`)
        return issue
      })

    const updateIssue = (
      me: CurrentUserShape,
      ref: string,
      payload: UpdateIssuePayloadShape
    ): Effect.Effect<ProjectIssue, Unauthorized | Forbidden | NotFound | Validation> =>
      actor(me).pipe(Effect.flatMap((who) => updateIssueFields(who.companyId, ref, payload)))

    /**
     * D1, D2: file a ticket from the issue page. The sibling of the agent path
     * above and deliberately not the same function: an agent files *for* a mapped
     * human and may set three fields, while a member filing here is already
     * themselves and picks from the whole D14 pick-list. What the two share is the
     * rule that matters — the team and the project come from the mirror, never
     * from the caller.
     */
    const fileIssue = (
      me: CurrentUserShape,
      projectId: ProjectId,
      payload: CreateIssuePayloadShape
    ): Effect.Effect<ProjectIssue, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* byId({ companyId: who.companyId, projectId })
        if (Option.isNone(row)) {
          return yield* new NotFound({ entity: 'Project', id: projectId })
        }
        const project = toProject(row.value)
        const teamId = yield* requireTeam(project)

        const created = yield* orValidation(
          linear.createIssue(who.companyId, {
            teamId,
            projectLinearId: project.linearId,
            title: payload.title,
            description: payload.description,
            stateId: payload.stateId,
            priority: payload.priority,
            assigneeId: payload.assigneeId,
            labelIds: payload.labelIds,
            milestoneId: payload.milestoneId,
            dueDate: payload.dueDate,
            parentId: payload.parentId
          })
        )

        const write = issueWrite(project.id, created, nowIso())
        yield* insertIssue(write)
        const stored = yield* issueById({ companyId: who.companyId, issueId: write.id })
        if (Option.isNone(stored)) {
          return yield* new NotFound({ entity: 'ProjectIssue', id: created.linearId })
        }
        const issue = toProjectIssue(stored.value)
        yield* publisher.transact(who.companyId, (emit) =>
          emit({ type: 'project.issue.created', payload: { projectId: project.id, issue } })
        )
        yield* Effect.logInfo(`linear: ${issue.identifier} filed under ${project.name}`)
        return issue
      })

    /**
     * D4, D5: admin+ trashes the ticket in Linear and drops the mirror row. Admin
     * rather than member because it is the one write here Taut cannot undo, so it
     * keeps the gate the connection has.
     *
     * The thread survives the row and its root message is edited to say what
     * happened — dropping the conversation with the ticket would destroy the only
     * record of *why* it was deleted, and leaving it unmarked would leave a live
     * thread about a ticket that no longer exists.
     */
    const deleteIssue = (
      me: CurrentUserShape,
      ref: string
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound | Validation, Messages> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const row = yield* resolveIssue(who.companyId, ref)

        yield* orValidation(linear.deleteIssue(who.companyId, row.linear_id))

        const threadId = row.thread_message_id
        if (threadId !== null) {
          const messages = yield* Messages
          const root = yield* messages.byId(who.companyId, threadId)
          if (Option.isSome(root)) {
            yield* messages.editAsSystem(
              who.companyId,
              threadId,
              `${root.value.body}\n\n_${row.identifier} was deleted in Linear._`
            )
          }
        }

        yield* deleteIssueRow(row.id)
        yield* publisher.transact(who.companyId, (emit) =>
          emit({
            type: 'project.issue.deleted',
            payload: { projectId: row.project_id, issueId: row.id }
          })
        )
        yield* Effect.logInfo(`linear: ${row.identifier} deleted by ${who.userId}`)
      })

    /**
     * D14: the pick-lists, read live from Linear on every call. No table backs
     * them: a mirrored pick-list goes stale silently and files tickets into states
     * that no longer exist. The client caches them per session, which is the right
     * lifetime for something that changes when an admin changes a workflow.
     */
    const optionsOf = (
      companyId: CompanyId,
      projectId: ProjectId
    ): Effect.Effect<IssueOptions, NotFound | Validation> =>
      Effect.gen(function* () {
        const row = yield* byId({ companyId, projectId })
        if (Option.isNone(row)) {
          return yield* new NotFound({ entity: 'Project', id: projectId })
        }
        const project = toProject(row.value)
        const teamId = yield* requireTeam(project)
        const options = yield* orValidation(
          linear.issueOptions(companyId, teamId, project.linearId)
        )
        return new IssueOptions({
          states: options.states.map(
            (state) =>
              new IssueState({
                id: state.id,
                name: state.name,
                type: Schema.is(IssueStateType)(state.type) ? state.type : 'unknown',
                ...(state.color === undefined ? {} : { color: state.color }),
                position: state.position
              })
          ),
          labels: options.labels.map((label) => ({
            id: label.id,
            name: label.name,
            ...(label.color === undefined ? {} : { color: label.color })
          })),
          members: options.members.map((member) => ({
            linearId: member.linearId,
            name: member.name,
            ...(member.avatarUrl === undefined ? {} : { avatarUrl: member.avatarUrl })
          })),
          milestones: options.milestones,
          projects: options.projects
        })
      })

    const issueOptions = (
      me: CurrentUserShape,
      projectId: ProjectId
    ): Effect.Effect<IssueOptions, Unauthorized | NotFound | Validation> =>
      actor(me).pipe(Effect.flatMap((who) => optionsOf(who.companyId, projectId)))

    // ── the ticket's thread (D8–D11, D21) ────────────────────────────────────

    /**
     * D8, D9, D21: say the first thing on a ticket, and the conversation exists.
     *
     * Idempotent by design: a ticket that already has a thread gets a reply
     * instead of a second root, because "open the thread" is what the composer
     * calls the first time and there is no way for two people clicking at once to
     * mean two threads.
     *
     * The body goes through `Messages.postAsUser` and not through an insert of our
     * own, which is the whole of D9: mentions resolve, agents are woken, tasks are
     * created, notifications and unread counts move, and the message is in search —
     * because it is an ordinary message in an ordinary channel that the sidebar
     * happens not to draw.
     */
    const openIssueThread = (
      me: CurrentUserShape,
      ref: string,
      body: string
    ): Effect.Effect<
      ProjectIssue,
      Unauthorized | Forbidden | NotFound | Validation,
      Messages | Channels
    > =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const messages = yield* Messages
        const channels = yield* Channels
        const row = yield* resolveIssue(who.companyId, ref)
        const project = yield* projectOfIssue(who.companyId, row)

        const channelId = yield* channels.ensureProjectChannel(
          who.companyId,
          project.id,
          // `DisplayName` caps at 80; a project named longer than that still needs
          // a channel, and the name is only ever seen in a notification's title.
          project.name.slice(0, 80)
        )
        yield* channels.join(channelId, { memberKind: 'user', memberId: who.userId })

        /**
         * D21: an agent that was `@`-mentioned is joined too, on demand. Without
         * this the mention resolves to nobody — `Messages.resolveMentions` keeps
         * only handles that belong to the channel, precisely so that nobody can be
         * pinged into a room they are not in.
         */
        const handles = new Set(
          [...body.matchAll(/@([a-z0-9][a-z0-9._-]*)/gi)].map((match) =>
            (match[1] ?? '').toLowerCase().replace(/[._-]+$/, '')
          )
        )
        if (handles.size > 0) {
          const agents = yield* agentsByHandle(who.companyId)
          yield* Effect.forEach(
            agents.filter((agent) => handles.has(agent.handle)),
            (agent) => channels.join(channelId, { memberKind: 'agent', memberId: agent.id }),
            { discard: true }
          )
        }

        const existing = row.thread_message_id
        const opened =
          existing === null ? false : Option.isSome(yield* messages.byId(who.companyId, existing))
        const posted = yield* messages.postAsUser(who.companyId, {
          userId: who.userId,
          channelId,
          body,
          ...(opened && existing !== null ? { threadId: existing } : {})
        })
        if (opened) return toProjectIssue(row)

        yield* setThreadMessage({ issueId: row.id, threadMessageId: posted.id })
        const after = yield* issueById({ companyId: who.companyId, issueId: row.id })
        if (Option.isNone(after)) {
          return yield* new NotFound({ entity: 'ProjectIssue', id: row.id })
        }
        const issue = toProjectIssue(after.value)
        yield* publisher.transact(who.companyId, (emit) =>
          emit({
            type: 'project.issue.thread.opened',
            payload: { projectId: row.project_id, issueId: row.id, threadId: posted.id }
          })
        )
        yield* Effect.logInfo(`linear: thread opened on ${row.identifier} by ${who.userId}`)
        return issue
      })

    /**
     * D13: Linear's own history for the ticket, plus the comments Taut refuses to
     * author — and, on the way past, the reconcile of the comments it will (D12).
     *
     * Both halves are read live and neither is stored, so a Linear that refuses is
     * a `Validation`: the page keeps the thread it already has and says the
     * history could not be read, which is honest in a way a stale copy is not.
     */
    const issueActivity = (
      me: CurrentUserShape,
      ref: string
    ): Effect.Effect<IssueActivity, Unauthorized | NotFound | Validation, Messages> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const messages = yield* Messages
        const row = yield* resolveIssue(who.companyId, ref)

        const live = yield* orValidation(linear.issue(who.companyId, row.linear_id))
        const history = yield* orValidation(linear.issueHistory(who.companyId, row.linear_id))

        const known = new Map(
          (yield* commentsOfIssue(row.id)).map((entry) => [entry.linear_comment_id, entry])
        )
        const threadId = row.thread_message_id
        /**
         * The thread's root, read once: a mirrored comment is a reply in the
         * channel that root lives in, and a `thread_message_id` pointing at a
         * message somebody has since deleted means there is nowhere to put one.
         */
        const root =
          threadId === null ? Option.none<Message>() : yield* messages.byId(who.companyId, threadId)
        const unmapped: Array<IssueLinearComment> = []

        for (const comment of live.comments) {
          const existing = known.get(comment.linearId)
          if (existing !== undefined) {
            // Only inbound mirrors take their timestamp from Linear. Outbound
            // messages keep the time they were actually written in Taut.
            const sourceAt = DateTime.make(new Date(comment.createdAt ?? ''))
            if (existing.direction === 'in' && Option.isSome(sourceAt)) {
              yield* messages.restoreImportedCreatedAt(
                who.companyId,
                existing.message_id,
                sourceAt.value
              )
            }
            continue
          }
          const authorLinearId = comment.authorLinearId
          const mapping =
            authorLinearId === undefined
              ? Option.none<LinearUserRow>()
              : yield* userByLinearId({ companyId: who.companyId, linearId: authorLinearId })
          const member = Option.isSome(mapping) ? mapping.value.user_id : null

          /**
           * D11's honesty rule, and the one place it is enforced. A comment whose
           * Linear author is nobody in Taut stays a Linear comment: mirroring it
           * as a message means picking a Taut author for it, and every available
           * choice is a lie about who said it.
           *
           * A mapped author's comment still needs somewhere to land, so a ticket
           * with no thread yet keeps it in the Activity list and out of the
           * ledger — the next read after somebody opens the thread mirrors it (D8).
           */
          if (member === null || threadId === null || Option.isNone(root)) {
            unmapped.push(
              new IssueLinearComment({
                linearId: comment.linearId,
                body: comment.body,
                ...(comment.authorLinearId === undefined || comment.authorName === undefined
                  ? {}
                  : {
                      author: {
                        linearId: comment.authorLinearId,
                        name: comment.authorName,
                        ...(comment.authorAvatarUrl === undefined
                          ? {}
                          : { avatarUrl: comment.authorAvatarUrl })
                      }
                    }),
                createdAt: atOf(comment.createdAt),
                url: comment.url === '' ? row.url : comment.url
              })
            )
            continue
          }

          /**
           * Posted as the human the Linear author maps to, through `Messages` like
           * everything else in the thread (D9). `Effect.option` because one
           * comment Taut cannot post — the human left the company since — must not
           * take the whole Activity read down with it; it is simply not recorded,
           * and the next read tries again.
           */
          const mirrored = yield* messages
            .postAsUser(who.companyId, {
              userId: member,
              channelId: root.value.channelId,
              threadId,
              body: comment.body,
              createdAt: atOf(comment.createdAt)
            })
            .pipe(Effect.option)
          if (Option.isNone(mirrored)) continue
          yield* insertComment({
            linearCommentId: comment.linearId,
            issueId: row.id,
            messageId: mirrored.value.id,
            direction: 'in',
            syncedAt: nowIso()
          })
        }

        /**
         * Linear records no history node for the creation itself, so the feed's
         * first line is built from the ticket: `created` is a kind the contract
         * has (D13) and an event a reader expects to see.
         */
        const created =
          live.issue.createdAt === undefined
            ? []
            : [
                new IssueHistoryEvent({
                  linearId: `${row.linear_id}:created`,
                  at: atOf(live.issue.createdAt),
                  ...(live.issue.creatorId === undefined || live.issue.creatorName === undefined
                    ? {}
                    : {
                        actor: {
                          linearId: live.issue.creatorId,
                          name: live.issue.creatorName,
                          ...(live.issue.creatorAvatarUrl === undefined
                            ? {}
                            : { avatarUrl: live.issue.creatorAvatarUrl })
                        }
                      }),
                  kind: 'created' as const,
                  summary: 'created the issue'
                })
              ]

        const events = history.map(
          (event) =>
            new IssueHistoryEvent({
              linearId: event.linearId,
              at: atOf(event.at),
              ...(event.actorLinearId === undefined || event.actorName === undefined
                ? {}
                : {
                    actor: {
                      linearId: event.actorLinearId,
                      name: event.actorName,
                      ...(event.actorAvatarUrl === undefined
                        ? {}
                        : { avatarUrl: event.actorAvatarUrl })
                    }
                  }),
              kind: Schema.is(IssueHistoryKind)(event.kind) ? event.kind : 'other',
              summary: event.summary
            })
        )

        return new IssueActivity({ history: [...created, ...events], comments: unmapped })
      })

    // ── agent-facing (D18), and the task runner's one read (D17) ─────────────

    /**
     * D18: the same two operations an agent may perform on a ticket, with no
     * session behind them. They exist beside the member-facing pair above rather
     * than instead of them because the gate is different: a human is gated by
     * their role, an agent by whether the human it is answering is mapped to
     * Linear at all (D21) — which the caller checks with `canCreateIssues`.
     */
    const issueForAgent = (
      companyId: CompanyId,
      ref: string
    ): Effect.Effect<IssueDetail, NotFound> => issueDetail(companyId, ref)

    /**
     * D18: the same pick-lists, for an agent resolving a state *name* to the id a
     * mutation needs. An agent cannot know a workflow state's UUID, and asking it
     * to would be asking it to guess.
     */
    const issueOptionsForAgent = (
      companyId: CompanyId,
      projectId: ProjectId
    ): Effect.Effect<IssueOptions, NotFound | Validation> => optionsOf(companyId, projectId)

    const updateIssueForAgent = (
      companyId: CompanyId,
      ref: string,
      payload: UpdateIssuePayloadShape
    ): Effect.Effect<ProjectIssue, NotFound | Validation> =>
      updateIssueFields(companyId, ref, payload)

    /**
     * D17: the ticket a thread is about, or nothing. One indexed read that answers
     * nothing for every ordinary thread, which is why the task runner may ask it
     * on every wake without anybody noticing.
     */
    const issueForThread = (
      companyId: CompanyId,
      threadId: MessageId
    ): Effect.Effect<Option.Option<IssueDetail>> =>
      Effect.gen(function* () {
        const row = yield* issueByThread({ companyId, threadId })
        if (Option.isNone(row)) return Option.none()
        const detail = yield* issueDetail(companyId, row.value.id).pipe(Effect.option)
        return detail
      })

    /**
     * D11, D12: a Taut message about a ticket, out to Linear as a comment.
     *
     * Driven by a `message.created` subscriber and never by an HTTP handler, which
     * is the point: a chat message must not fail because Linear is down, so every
     * failure here is logged and dropped. The message is already posted; the worst
     * case is a comment Linear never hears about, and the ledger is what keeps a
     * later retry from saying it twice.
     */
    const pushIssueComment = (
      companyId: CompanyId,
      message: {
        readonly id: MessageId
        readonly threadId: MessageId | undefined
        readonly authorKind: 'user' | 'agent'
        readonly authorId: string
        readonly body: string
      }
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (message.body.trim() === '') return
        // The root of an issue thread is itself the thread; a reply names it.
        const threadId = message.threadId ?? message.id
        const row = yield* issueByThread({ companyId, threadId })
        if (Option.isNone(row)) return
        // Already crossed, in either direction: a comment mirrored *in* has a row
        // here too, which is what stops it being pushed straight back out (D12).
        if (Option.isSome(yield* commentByMessage(message.id))) return

        const handle = yield* authorHandle({ companyId, authorId: message.authorId })
        const who = Option.isSome(handle) ? handle.value.handle : message.authorId
        const pushed = yield* linear
          .createComment(companyId, row.value.linear_id, `@${who} via Taut — ${message.body}`)
          .pipe(Effect.option)
        if (Option.isNone(pushed)) {
          yield* Effect.logWarning(
            `linear: could not push a Taut reply to ${row.value.identifier}; dropped`
          )
          return
        }
        yield* insertComment({
          linearCommentId: pushed.value,
          issueId: row.value.id,
          messageId: message.id,
          direction: 'out',
          syncedAt: nowIso()
        })
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
      linkLinearUser,
      // one ticket (docs/build-plan-issues.md)
      issue,
      issueActivity,
      updateIssue,
      deleteIssue,
      openIssueThread,
      issueOptions,
      fileIssue,
      // server-internal
      issueForAgent,
      issueOptionsForAgent,
      updateIssueForAgent,
      issueForThread,
      pushIssueComment
    } as const
  })
}) {}
