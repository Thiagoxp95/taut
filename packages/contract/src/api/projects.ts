import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import {
  IssueActivity,
  IssueDetail,
  IssueOptions,
  LinearConnection,
  LinearUser,
  Project,
  ProjectDetail,
  ProjectIssue,
  ProjectPriority
} from '../domain/project.js'
import { Forbidden, NotFound, Validation } from '../errors.js'
import { ProjectId, UserId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

/**
 * The Linear personal API key, on its way in and never on its way out
 * (docs/build-plan-projects.md D2). The server validates it against Linear
 * before it stores anything (D3), so a typo is a `Validation` and not a
 * connection that fails at the next sync.
 */
export const ConnectLinearPayload = Schema.Struct({
  apiKey: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(512))
})

const ProjectPath = Schema.Struct({ projectId: ProjectId })

/** Linear's own UUID for a person in the workspace, straight off the mirror. */
const LinearUserPath = Schema.Struct({ linearUserId: Schema.String })

/**
 * Who a Linear person is in Taut (docs/build-plan-projects.md D16). `null` is the
 * default and a real choice: it unmaps, and is what the "None" option sends.
 */
export const LinkLinearUserPayload = Schema.Struct({
  member: Schema.NullOr(UserId)
})

/**
 * Where a card was dropped (docs/build-plan-projects.md D13). `statusId` is
 * Linear's own status UUID, taken from a project already in the mirror — Taut
 * never invents one, so a board that is out of date fails at Linear rather than
 * moving a project somewhere nobody asked for.
 */
export const MoveProjectPayload = Schema.Struct({
  statusId: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64))
})

/**
 * How an issue is named in a URL (docs/build-plan-issues.md D15). A plain
 * `Schema.String`, not `ProjectIssueId`, because it accepts either a `pis_…` id or
 * the Linear identifier a human quotes in chat (`ENG-4636`) — a link to a ticket
 * has to work without the reader knowing which project it is under. The service
 * resolves it: `pis_…` first, then the identifier within the company.
 */
const IssuePath = Schema.Struct({ issueId: Schema.String })

/**
 * A change to one ticket, written through to Linear and re-read
 * (docs/build-plan-issues.md D2).
 *
 * Every field is optional and there are two kinds of absence, which is the whole
 * shape of this payload: a field left out is never sent to Linear, and an
 * explicit `null` is sent as `null` and *clears* the value. Only the fields that
 * can be cleared in Linear's own UI are nullable. An empty payload is a
 * `Validation` — a patch that changes nothing is a bug in the caller, not a
 * no-op worth a round trip to Linear.
 */
export const UpdateIssuePayload = Schema.Struct({
  title: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255))),
  description: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(50_000)))),
  /** Linear's workflow-state UUID, out of the `options` pick-list (D14). */
  stateId: Schema.optional(Schema.String),
  priority: Schema.optional(ProjectPriority),
  assigneeId: Schema.optional(Schema.NullOr(Schema.String)),
  /** The full label set, not a delta: Linear's `labelIds` replaces, it does not merge. */
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  milestoneId: Schema.optional(Schema.NullOr(Schema.String)),
  /** `YYYY-MM-DD` (Linear's `TimelessDate`), like every other date in the mirror. */
  dueDate: Schema.optional(Schema.NullOr(Schema.String)),
  estimate: Schema.optional(Schema.NullOr(Schema.Number)),
  /** Re-parents the ticket, or `null` to pull it out from under its parent (D16). */
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  /**
   * Moves the ticket to another project. Linear's own project UUID, not a
   * `ProjectId`: this goes straight into a Linear mutation, and the picker that
   * fills it is fed by `IssueOptions.projects`, which speaks Linear too.
   */
  projectLinearId: Schema.optional(Schema.String)
})

/**
 * A new ticket, filed under the project in the path
 * (docs/build-plan-issues.md D1). The team comes from the project, never from the
 * caller — a project whose team id the mirror does not know is the existing "sync
 * first" error (docs/build-plan-projects.md D21), not a guess.
 *
 * Nothing here is nullable: an absent field is a field Linear defaults, and there
 * is no value on a ticket that does not exist yet to clear.
 */
export const CreateIssuePayload = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(50_000))),
  stateId: Schema.optional(Schema.String),
  priority: Schema.optional(ProjectPriority),
  assigneeId: Schema.optional(Schema.String),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  milestoneId: Schema.optional(Schema.String),
  dueDate: Schema.optional(Schema.String),
  /** Set to file this as a sub-issue of an existing ticket (D16). */
  parentId: Schema.optional(Schema.String)
})

/**
 * The first message of a ticket's thread — the call that creates the thread
 * (docs/build-plan-issues.md D8, D10).
 *
 * Just a body, because the root message is the first thing somebody said and is
 * authored by whoever said it. There is no synthetic system author and no ticket
 * card to fill in: the issue is identified by `threadId` on its row, not by
 * anything in this text.
 */
export const OpenIssueThreadPayload = Schema.Struct({
  body: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_000))
})

/**
 * The company's Linear connection and the projects mirrored from it
 * (docs/build-plan-projects.md). Company scope comes from the session's active
 * company, exactly as the repositories and vault groups do.
 *
 * Every endpoint here is a read of the mirror, an operation on the connection, or
 * a write to *one issue*. There is still no create, rename or delete for a
 * project: Linear owns them, Taut copies them (D1). Issues are the amendment
 * (docs/build-plan-issues.md D1) — and every write among them goes to Linear
 * first and re-reads the answer, so Taut never stores a field Linear has not
 * confirmed (D2).
 */
export class ProjectsGroup extends HttpApiGroup.make('projects')
  .add(
    /** Any member: the connection state and the last sync. Never a key (D2). */
    HttpApiEndpoint.get('linearConnection', '/linear').addSuccess(LinearConnection)
  )
  .add(
    /**
     * Admin+. Validates the key against Linear first; a key Linear refuses is a
     * `Validation` and leaves any existing connection untouched (D3).
     */
    HttpApiEndpoint.post('connectLinear', '/linear')
      .setPayload(ConnectLinearPayload)
      .addSuccess(LinearConnection)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    /** Admin+. Drops the key and every mirrored project and milestone with it. */
    HttpApiEndpoint.del('disconnectLinear', '/linear').addError(Forbidden).addError(NotFound)
  )
  .add(
    /**
     * Admin+. Pulls Linear and reconciles the mirror (D6). Answers with the
     * mirror as it now stands; a Linear that refuses is a `Validation` and the
     * previous rows survive (D7).
     */
    HttpApiEndpoint.post('sync', '/sync')
      .addSuccess(Page(Project))
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /**
     * Any member: the people in the Linear workspace and who each of them is in
     * Taut (D15). Ordered active first, then by name, which is the order the
     * mapping table is read in.
     */
    HttpApiEndpoint.get('linearUsers', '/linear/users').addSuccess(Page(LinearUser))
  )
  .add(
    /**
     * Admin+. Point one Linear person at one Taut human, or at nobody (D16).
     * A human already mapped to another Linear person is a `Validation`: the
     * mapping is one-to-one, or "who is this ticket for" has two answers.
     */
    HttpApiEndpoint.put('linkLinearUser', '/linear/users/:linearUserId')
      .setPath(LinearUserPath)
      .setPayload(LinkLinearUserPayload)
      .addSuccess(LinearUser)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  // Everything below, down to `issueOptions`, is registered *before* the
  // `/:projectId` endpoints on purpose (docs/build-plan-issues.md D20).
  // `/:projectId` is a catch-all for a single path segment, so a route added
  // after it never matches. Nothing here may be moved down.
  .add(
    /** Any member: one ticket, its project and its sub-issues, in one read (D15). */
    HttpApiEndpoint.get('issue', '/issues/:issueId')
      .setPath(IssuePath)
      .addSuccess(IssueDetail)
      .addError(NotFound)
  )
  .add(
    /**
     * Any member: Linear's own history for the ticket plus the comments Taut
     * refuses to author (D13). Read live from Linear on every call and never
     * stored, so a Linear that refuses is a `Validation` — the page keeps the
     * thread it already has and says the history could not be read.
     *
     * This is also where comments reconcile (D12): a Linear comment whose author
     * maps to a Taut human is posted into the thread when the page opens, rather
     * than during the bulk sync, where 50 comments per issue would multiply the
     * payload by two orders of magnitude to serve a page nobody opened.
     */
    HttpApiEndpoint.get('issueActivity', '/issues/:issueId/activity')
      .setPath(IssuePath)
      .addSuccess(IssueActivity)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /**
     * Member+. Changes one or more fields of a ticket by writing them to Linear
     * and re-reading the issue Linear answers with (D2, D4). The answer is the
     * mirror row as it now stands, which is what an optimistic client snaps back
     * to when Linear refuses (D3).
     */
    HttpApiEndpoint.patch('updateIssue', '/issues/:issueId')
      .setPath(IssuePath)
      .setPayload(UpdateIssuePayload)
      .addSuccess(ProjectIssue)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /**
     * Admin+. Trashes the ticket in Linear (`issueDelete`, restorable for 30
     * days) and drops the mirror row (D5). Admin rather than member because it is
     * the one write here Taut cannot undo, so it keeps the gate the connection
     * has (D4). The thread survives: dropping the conversation with the row would
     * destroy the only record of why the ticket was deleted.
     */
    HttpApiEndpoint.del('deleteIssue', '/issues/:issueId')
      .setPath(IssuePath)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /**
     * Member+. Posts the first message of the ticket's thread, creating the
     * thread — and, the first time in a project, the hidden channel it lives in
     * (D8, D9). Idempotent: a ticket that already has a thread gets a reply
     * instead of a second one. Answers with the issue, because the row now
     * carries `threadId` and the page needs it to subscribe.
     */
    HttpApiEndpoint.post('openIssueThread', '/issues/:issueId/thread')
      .setPath(IssuePath)
      .setPayload(OpenIssueThreadPayload)
      .addSuccess(ProjectIssue)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /**
     * Any member: the pick-lists the issue editors need — states, labels,
     * members, milestones, sibling projects — read live from Linear and cached
     * per session by the client (D14). No table backs this: a mirrored pick-list
     * goes stale silently and files tickets into states that no longer exist.
     */
    HttpApiEndpoint.get('issueOptions', '/:projectId/options')
      .setPath(ProjectPath)
      .addSuccess(IssueOptions)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /**
     * Member+. Files a new ticket under this project in Linear and mirrors the
     * issue Linear answers with (D1, D2). Same write-through rule as the patch:
     * the row is Linear's answer, never the browser's hope.
     */
    HttpApiEndpoint.post('createIssue', '/:projectId/issues')
      .setPath(ProjectPath)
      .setPayload(CreateIssuePayload)
      .addSuccess(ProjectIssue)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /** Any member: the mirrored projects, newest activity first. */
    HttpApiEndpoint.get('list', '/').setUrlParams(PageQuery).addSuccess(Page(Project))
  )
  .add(
    /**
     * Admin+. Moves a project to another board column by writing the status to
     * Linear and re-reading it (D13). The mirror is updated from Linear's answer,
     * never from what the browser hoped; a Linear that refuses is a `Validation`
     * and the card goes back where it was.
     */
    HttpApiEndpoint.post('move', '/:projectId/status')
      .setPath(ProjectPath)
      .setPayload(MoveProjectPayload)
      .addSuccess(Project)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /**
     * Any member: one project's issues, ordered the way the Issues tab draws
     * them — by workflow state, then Linear's own order inside it (D19).
     */
    HttpApiEndpoint.get('issues', '/:projectId/issues')
      .setPath(ProjectPath)
      .addSuccess(Page(ProjectIssue))
      .addError(NotFound)
  )
  .add(
    /** Any member: one project and its milestones (D10). */
    HttpApiEndpoint.get('get', '/:projectId')
      .setPath(ProjectPath)
      .addSuccess(ProjectDetail)
      .addError(NotFound)
  )
  .middleware(Authentication)
  .prefix('/projects') {}
