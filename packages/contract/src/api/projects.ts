import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import {
  LinearConnection,
  LinearUser,
  Project,
  ProjectDetail,
  ProjectIssue
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
 * The company's Linear connection and the projects mirrored from it
 * (docs/build-plan-projects.md). Company scope comes from the session's active
 * company, exactly as the repositories and vault groups do.
 *
 * Every endpoint here is a read of the mirror or an operation on the connection.
 * There is no create, rename or delete for a project: Linear owns them, Taut
 * copies them (D1).
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
