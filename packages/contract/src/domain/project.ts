import { Schema } from 'effect'

import { CompanyId, ProjectId, ProjectIssueId, ProjectMilestoneId, UserId } from '../ids.js'

/**
 * Projects mirrored from a company's Linear workspace
 * (docs/build-plan-projects.md D1).
 *
 * Everything here is a *copy*. Taut decides nothing about a project: there is no
 * `createdBy` and no archive flag, and the mirror holds what Linear said at
 * `syncedAt`.
 *
 * One exception, added with the board (docs/build-plan-projects.md D13): a card
 * dragged to another column writes the new status *to Linear* and then re-reads
 * it. Taut still owns no state of its own — the drag is a remote control for
 * `projectUpdate`, not a local edit that Linear will later contradict.
 */

/**
 * Where a project stands, normalised out of Linear's `Project.state` string.
 * `unknown` is deliberate: Linear may add a state, and a mirror that refuses to
 * decode is worse than one that shows a project it cannot label.
 */
export const ProjectState = Schema.Literal(
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled',
  'unknown'
)
export type ProjectState = typeof ProjectState.Type

/**
 * A column of Linear's project board: a workspace-defined status like `Problems`
 * or `Pitch review` (D13). Linear's fixed `ProjectState` is the *type* underneath
 * it, so several statuses can share one type — which is exactly why the board
 * groups by status and not by state.
 *
 * Optional on a project: a workspace that predates custom statuses, or a Linear
 * that stops answering the field, still mirrors and still renders.
 */
export class ProjectStatus extends Schema.Class<ProjectStatus>('ProjectStatus')({
  /** Linear's UUID for the status — what a drag sends back to `projectUpdate`. */
  id: Schema.String,
  name: Schema.String,
  /** The fixed state this status rolls up to. */
  type: ProjectState,
  /** Linear's own colour, `#rrggbb`. Used raw: it is the workspace's choice. */
  color: Schema.optional(Schema.String),
  /** Linear's board order, ascending. */
  position: Schema.Number
}) {}

/**
 * Linear's project priority, as the number Linear stores it (D14): `0` is *no*
 * priority, and 1–4 run urgent, high, medium, low. The number is what orders a
 * board; `priorityLabel` is Linear's own word for it, mirrored rather than
 * re-derived so a workspace that renames a level still reads correctly.
 */
export const ProjectPriority = Schema.Literal(0, 1, 2, 3, 4)
export type ProjectPriority = typeof ProjectPriority.Type

/**
 * How the project is going, out of Linear's last project update (D14). Absent
 * until somebody posts an update, which is most projects most of the time.
 */
export const ProjectHealth = Schema.Literal('onTrack', 'atRisk', 'offTrack')
export type ProjectHealth = typeof ProjectHealth.Type

/**
 * Where a milestone stands. Linear's own words, and the reason a board card can
 * name *one* milestone out of several: the one it is working towards is `next`.
 */
export const ProjectMilestoneStatus = Schema.Literal('unstarted', 'next', 'overdue', 'done')
export type ProjectMilestoneStatus = typeof ProjectMilestoneStatus.Type

/**
 * The milestone a board card names (D14) — the `next` one, or failing that the
 * first unfinished one. Just enough to draw a row; the full set is on the detail.
 */
export const ProjectMilestoneRef = Schema.Struct({
  name: Schema.String,
  targetDate: Schema.optional(Schema.String)
})
export type ProjectMilestoneRef = typeof ProjectMilestoneRef.Type

/**
 * One team the project belongs to, as Linear names it (`ENG`, `Engineering`).
 *
 * `id` is Linear's UUID and is optional only for age: a mirror synced before D21
 * has teams with no id, and the create tool says "sync first" rather than
 * guessing one. Every sync since fills it in.
 */
export const ProjectTeam = Schema.Struct({
  id: Schema.optional(Schema.String),
  key: Schema.String,
  name: Schema.String
})
export type ProjectTeam = typeof ProjectTeam.Type

/**
 * Whoever leads the project in Linear. Display only — this is a Linear user, not
 * a Taut member, and no attempt is made to match the two.
 */
export const ProjectLead = Schema.Struct({
  name: Schema.String,
  email: Schema.optional(Schema.String),
  avatarUrl: Schema.optional(Schema.String)
})
export type ProjectLead = typeof ProjectLead.Type

/** One project of the company's Linear workspace, as of `syncedAt`. */
export class Project extends Schema.Class<Project>('Project')({
  id: ProjectId,
  companyId: CompanyId,
  /** Linear's UUID: the identity that survives a rename (D6). */
  linearId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  state: ProjectState,
  /** The board column Linear puts it in (D13). Absent if Linear reported none. */
  status: Schema.optional(ProjectStatus),
  /** Linear's priority, `0` (none) to `4` (low) (D14). */
  priority: ProjectPriority,
  /** Linear's word for that number — `Urgent`, `High`, `No priority` (D14). */
  priorityLabel: Schema.optional(Schema.String),
  /**
   * Linear's tie-break *inside* a priority level (D14). A board column reads
   * top to bottom as priority first and this second, so mirroring the number is
   * what lets Taut put the cards in the order Linear shows them.
   */
  prioritySortOrder: Schema.Number,
  /** Health from Linear's last project update (D14), if there has been one. */
  health: Schema.optional(ProjectHealth),
  /**
   * Linear's `scope`: the issue count a board card shows (D14). Zero both when
   * a project has no issues and when Linear declined to say, which is fine —
   * the card reads "0 issues" either way, exactly as Linear's does.
   */
  issueCount: Schema.Number,
  /** The milestone a board card names (D14): `next`, else the first unfinished. */
  nextMilestone: Schema.optional(ProjectMilestoneRef),
  /** 0–1, as Linear reports it. */
  progress: Schema.Number,
  /** Linear's icon name and colour, which the sidebar dot borrows. */
  icon: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  /** Deep link back to Linear — the only place a mutation can happen (D1). */
  url: Schema.String,
  lead: Schema.optional(ProjectLead),
  teams: Schema.Array(ProjectTeam),
  /** `YYYY-MM-DD` (Linear's `TimelessDate`). A calendar day, not a timestamp. */
  startDate: Schema.optional(Schema.String),
  targetDate: Schema.optional(Schema.String),
  /** When Linear last changed it, not when Taut last looked. */
  updatedAt: Schema.optional(Schema.DateTimeUtc),
  syncedAt: Schema.DateTimeUtc
}) {}

/**
 * Where one issue stands, out of Linear's workflow-state *type*
 * (docs/build-plan-projects.md D18).
 *
 * A workspace names its own columns — `Shaping`, `In review`, `Ready to ship` —
 * but every one of them rolls up to one of these six. The name is what the
 * Issues tab groups by; the type is what tells the group which glyph to draw, so
 * two workspaces that call the same column different things still read alike.
 *
 * `unknown` is here for the same reason it is on `ProjectState`: Linear may add a
 * type, and a mirror that refuses to decode is worse than one showing an issue it
 * cannot label.
 */
export const IssueStateType = Schema.Literal(
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
  'unknown'
)
export type IssueStateType = typeof IssueStateType.Type

/**
 * One column of the team's issue workflow, as the workspace defines it. This is
 * the thing the Issues tab groups and orders by: `position` is Linear's own
 * ordering, so `Shaping` sits above `Canceled` here because it does there.
 */
export class IssueState extends Schema.Class<IssueState>('IssueState')({
  /** Linear's UUID for the workflow state. */
  id: Schema.String,
  name: Schema.String,
  type: IssueStateType,
  /** Linear's own colour, `#rrggbb`. Used raw: it is the workspace's choice. */
  color: Schema.optional(Schema.String),
  /** Linear's order within the team's workflow, ascending. */
  position: Schema.Number
}) {}

/** One label on an issue, with the colour the workspace gave it. */
export const IssueLabel = Schema.Struct({
  name: Schema.String,
  color: Schema.optional(Schema.String)
})
export type IssueLabel = typeof IssueLabel.Type

/**
 * Whoever an issue is assigned to in Linear. Display only, like `ProjectLead` —
 * but unlike a lead this one carries `linearId`, because the create tool
 * (D21) resolves a Taut human to exactly this id before it files anything.
 */
export const IssueAssignee = Schema.Struct({
  linearId: Schema.String,
  name: Schema.String,
  avatarUrl: Schema.optional(Schema.String)
})
export type IssueAssignee = typeof IssueAssignee.Type

/**
 * One issue of a mirrored project (docs/build-plan-projects.md D18).
 *
 * Same rule as everything else here: a copy of what Linear said at `syncedAt`,
 * with no Taut-owned field on it. An issue an agent files through D21 is not
 * written here directly — it is created in Linear and arrives in the mirror on
 * the next sync, because a row Taut invented is a row Linear can contradict.
 */
export class ProjectIssue extends Schema.Class<ProjectIssue>('ProjectIssue')({
  id: ProjectIssueId,
  projectId: ProjectId,
  /** Linear's UUID for the issue. The identity that survives a move or a rename. */
  linearId: Schema.String,
  /** Linear's human key: `ENG-4636`. What the row shows and a human quotes. */
  identifier: Schema.String,
  title: Schema.String,
  state: IssueState,
  /** Linear's priority, `0` (none) to `4` (low), exactly as a project's is (D14). */
  priority: ProjectPriority,
  priorityLabel: Schema.optional(Schema.String),
  assignee: Schema.optional(IssueAssignee),
  labels: Schema.Array(IssueLabel),
  /** The milestone it hangs off, if Linear put it under one. */
  milestoneName: Schema.optional(Schema.String),
  /** `YYYY-MM-DD` (Linear's `TimelessDate`), like every other date here. */
  dueDate: Schema.optional(Schema.String),
  /** Deep link to the issue in Linear — the only place it can be edited (D1). */
  url: Schema.String,
  /** Linear's tie-break inside a workflow state, which is how a column is ordered. */
  sortOrder: Schema.Number,
  createdAt: Schema.optional(Schema.DateTimeUtc),
  updatedAt: Schema.optional(Schema.DateTimeUtc),
  syncedAt: Schema.DateTimeUtc
}) {}

/** A milestone inside a project (D10). Ordered by `sortOrder`, as Linear orders it. */
export class ProjectMilestone extends Schema.Class<ProjectMilestone>('ProjectMilestone')({
  id: ProjectMilestoneId,
  projectId: ProjectId,
  linearId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  targetDate: Schema.optional(Schema.String),
  /** Linear's own status for it (D14). Absent on a mirror synced before D14. */
  status: Schema.optional(ProjectMilestoneStatus),
  sortOrder: Schema.Number
}) {}

/**
 * Where the company stands with Linear. The API key is not part of this shape and
 * never will be: `keyHint` is its last four characters, which is the only
 * plaintext anything outside the service is allowed to see (D2).
 */
export class LinearConnection extends Schema.Class<LinearConnection>('LinearConnection')({
  companyId: CompanyId,
  /** `none` → no key stored · `connected` → a key Linear accepted (D3). */
  state: Schema.Literal('none', 'connected'),
  /** The workspace the key resolves to, e.g. `Acme`. */
  workspaceName: Schema.optional(Schema.String),
  /** Linear's URL key: `acme` in `linear.app/acme`. */
  workspaceUrlKey: Schema.optional(Schema.String),
  keyHint: Schema.optional(Schema.String),
  connectedAt: Schema.optional(Schema.DateTimeUtc),
  lastSyncedAt: Schema.optional(Schema.DateTimeUtc),
  /** Why the last sync failed; cleared by the next one that succeeds (D7). */
  lastSyncError: Schema.optional(Schema.String)
}) {}

/**
 * One person in the company's Linear workspace, and the Taut human they are
 * (docs/build-plan-projects.md D15).
 *
 * Everything but `member` is a mirror of Linear. `member` is Taut's own answer to
 * "who is this, here" — set by an admin, kept across syncs, and `undefined` until
 * somebody says. It is what lets a Linear assignee render as a Taut member you can
 * click through to, and what an agent writing back to Linear will resolve a name
 * through: Taut member → Linear id, rather than matching on an email that may not
 * be the same in both places.
 */
export class LinearUser extends Schema.Class<LinearUser>('LinearUser')({
  companyId: CompanyId,
  /** Linear's UUID for the person. The identity that survives a rename. */
  linearId: Schema.String,
  name: Schema.String,
  /** Linear's short handle, e.g. `tedy`. Absent if Linear did not say. */
  displayName: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  avatarUrl: Schema.optional(Schema.String),
  /** Linear still counts them as a member of the workspace. */
  active: Schema.Boolean,
  /** The Taut human they map to (D16). `undefined` is the default: nobody. */
  member: Schema.optional(UserId),
  /** When the mapping was last set. Absent while `member` is. */
  linkedAt: Schema.optional(Schema.DateTimeUtc),
  syncedAt: Schema.DateTimeUtc
}) {}

/** One project with the milestones under it — what `GET /projects/:projectId` answers. */
export class ProjectDetail extends Schema.Class<ProjectDetail>('ProjectDetail')({
  project: Project,
  milestones: Schema.Array(ProjectMilestone)
}) {}
