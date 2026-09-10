import { FetchHttpClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import type { CompanyId, UserId } from '@taut/contract/ids'
import { Data, Effect, Either, Option, Redacted, Schema } from 'effect'
import { AppConfig } from '../config.js'
import { findOne, nowIso, run } from '../db/sql.js'
import { LinearConnectionRow } from '../domain/rows.js'
import { decryptToString, encrypt, hint } from '../vault/crypto.js'

/**
 * The company's Linear connection (docs/build-plan-projects.md D2, D3).
 *
 * One personal API key per company, pasted by an admin, encrypted at rest with
 * `vault/crypto.ts` under the company's key with the company id as AAD. No method
 * here returns it — `keyHint` is its last four characters and that is the only
 * plaintext anything outside this module ever sees. The key leaves this frame
 * only as an `authorization` header on a request to `api.linear.app`.
 *
 * Linear has no App-installation primitive to narrow a credential the way GitHub
 * does, so a key carries whatever access the human who made it has. The mirror is
 * still read-only in the sense that matters (D1) — Taut holds no state Linear can
 * contradict — but the board's drag writes one field back through this key
 * (`projectUpdate` with a status, D13), which is why moving a card is admin+.
 *
 * linear.app only (D12): the constant below is the whole surface to change.
 */

/** D12: the one place Linear's API is named. */
export const LINEAR_API = 'https://api.linear.app/graphql'
export const LINEAR_WEB = 'https://linear.app'

const REQUEST_TIMEOUT_MS = 20_000
/** Linear's page size for projects. Fifty keeps one response comfortably small. */
const PAGE_SIZE = 50
/** A workspace with more than this many projects is pathological; stop paging. */
const MAX_PROJECT_PAGES = 40
/**
 * Issues outnumber projects by orders of magnitude, so this ceiling is higher —
 * and it is still a ceiling: a workspace with more than 10 000 project issues
 * gets the first 10 000, which is a mirror that syncs rather than one that hangs.
 */
const MAX_ISSUE_PAGES = 200

/**
 * Anything Linear (or the flow around it) refused. `reason` is operator-facing:
 * it is rendered to the user, written to logs and stored in `last_sync_error`
 * (D7), so an API key must not be able to reach it.
 */
export class LinearFailure extends Data.TaggedError('LinearFailure')<{
  readonly reason: string
}> {}

// ── payloads ─────────────────────────────────────────────────────────────────

/**
 * A GraphQL body is `{ data }`, `{ errors }` or both. A 200 carrying `errors` is
 * a failure here: Linear answers an unauthorised key that way.
 */
const GraphQlEnvelope = <A, I>(data: Schema.Schema<A, I>) =>
  Schema.Struct({
    data: Schema.optional(Schema.NullOr(data)),
    errors: Schema.optional(
      Schema.NullOr(Schema.Array(Schema.Struct({ message: Schema.optional(Schema.String) })))
    )
  })

const nullableString = Schema.optional(Schema.NullOr(Schema.String))

const ViewerPayload = Schema.Struct({
  viewer: Schema.Struct({ id: Schema.String, name: nullableString }),
  organization: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    urlKey: nullableString
  })
})

const LinearUserPayload = Schema.Struct({
  id: Schema.String,
  name: nullableString,
  displayName: nullableString,
  email: nullableString,
  avatarUrl: nullableString,
  active: Schema.optional(Schema.NullOr(Schema.Boolean))
})

const UsersPayload = Schema.Struct({
  users: Schema.Struct({
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: nullableString }),
    nodes: Schema.Array(LinearUserPayload)
  })
})

const LinearStatusPayload = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  type: nullableString,
  color: nullableString,
  position: Schema.optional(Schema.NullOr(Schema.Number))
})

const LinearProjectPayload = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  description: nullableString,
  state: nullableString,
  status: Schema.optional(Schema.NullOr(LinearStatusPayload)),
  priority: Schema.optional(Schema.NullOr(Schema.Number)),
  priorityLabel: nullableString,
  prioritySortOrder: Schema.optional(Schema.NullOr(Schema.Number)),
  health: nullableString,
  /** Linear's issue count for the project — what a board card calls "N issues". */
  scope: Schema.optional(Schema.NullOr(Schema.Number)),
  progress: Schema.optional(Schema.NullOr(Schema.Number)),
  icon: nullableString,
  color: nullableString,
  url: nullableString,
  startDate: nullableString,
  targetDate: nullableString,
  updatedAt: nullableString,
  lead: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ name: nullableString, email: nullableString, avatarUrl: nullableString })
    )
  ),
  teams: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({ id: nullableString, key: nullableString, name: nullableString })
        )
      })
    )
  ),
  projectMilestones: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            name: Schema.String,
            description: nullableString,
            targetDate: nullableString,
            status: nullableString,
            sortOrder: Schema.optional(Schema.NullOr(Schema.Number))
          })
        )
      })
    )
  )
})

/** A person as every Linear payload here names one: id, maybe a name, maybe a face. */
const LinearPersonPayload = Schema.Struct({
  id: Schema.String,
  name: nullableString,
  avatarUrl: nullableString
})

/**
 * One issue of a project (D18), widened into the whole ticket
 * (docs/build-plan-issues.md D6). Every field nullable, like everything else Linear
 * answers: the mirror normalises, the payload just has to decode — and the D6
 * fields are asked for conditionally (`issueFields`), so a payload that arrives
 * without any of them is the normal shape on an older API, not a broken sync.
 */
const LinearIssuePayload = Schema.Struct({
  id: Schema.String,
  identifier: nullableString,
  title: nullableString,
  description: nullableString,
  url: nullableString,
  priority: Schema.optional(Schema.NullOr(Schema.Number)),
  priorityLabel: nullableString,
  sortOrder: Schema.optional(Schema.NullOr(Schema.Number)),
  dueDate: nullableString,
  createdAt: nullableString,
  updatedAt: nullableString,
  state: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        name: Schema.String,
        type: nullableString,
        color: nullableString,
        position: Schema.optional(Schema.NullOr(Schema.Number))
      })
    )
  ),
  assignee: Schema.optional(Schema.NullOr(LinearPersonPayload)),
  creator: Schema.optional(Schema.NullOr(LinearPersonPayload)),
  projectMilestone: Schema.optional(
    Schema.NullOr(Schema.Struct({ id: nullableString, name: nullableString }))
  ),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(Schema.Struct({ name: nullableString, color: nullableString }))
      })
    )
  ),
  team: Schema.optional(Schema.NullOr(Schema.Struct({ id: nullableString, key: nullableString }))),
  parent: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ id: Schema.String, identifier: nullableString, title: nullableString })
    )
  ),
  /** Only the ids: the count is all a card draws, and the list is its own read (D16). */
  children: Schema.optional(
    Schema.NullOr(Schema.Struct({ nodes: Schema.Array(Schema.Struct({ id: Schema.String })) }))
  ),
  estimate: Schema.optional(Schema.NullOr(Schema.Number)),
  completedAt: nullableString,
  canceledAt: nullableString,
  /** Present only on the single-issue read (D12); the bulk sync never asks for it. */
  comments: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            body: nullableString,
            url: nullableString,
            createdAt: nullableString,
            user: Schema.optional(Schema.NullOr(LinearPersonPayload))
          })
        )
      })
    )
  ),
  project: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.String })))
})

const IssuesPayload = Schema.Struct({
  issues: Schema.Struct({
    pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: nullableString }),
    nodes: Schema.Array(LinearIssuePayload)
  })
})

const ProjectsPayload = Schema.Struct({
  projects: Schema.Struct({
    pageInfo: Schema.Struct({
      hasNextPage: Schema.Boolean,
      endCursor: nullableString
    }),
    nodes: Schema.Array(LinearProjectPayload)
  })
})

// ── documents ────────────────────────────────────────────────────────────────

/** D3: what a key has to answer before Taut will store it. */
const VIEWER_QUERY = `query TautViewer {
  viewer { id name }
  organization { id name urlKey }
}`

/**
 * The fields one project is mirrored from (D4). Deliberately conservative:
 * GraphQL fails the whole document over one field Linear has since renamed, and a
 * mirror that cannot sync is worse than a mirror missing a column.
 *
 * The board fields (D13, D14) — the column, the priority, the health, the issue
 * count and a milestone's status — are the ones asked for conditionally, because
 * they are the newest things here and the sync must survive a workspace or an API
 * version that has no such concept. They stand or fall together: one flag means
 * one retry, and a Linear that has none of them still mirrors a plain list.
 */
const projectFields = (withBoard: boolean) => `
      id
      name
      description
      state
      ${withBoard ? 'status { id name type color position }' : ''}
      ${withBoard ? 'priority priorityLabel prioritySortOrder health scope' : ''}
      progress
      icon
      color
      url
      startDate
      targetDate
      updatedAt
      lead { name email avatarUrl }
      teams(first: 10) { nodes { id key name } }
      projectMilestones(first: 50) {
        nodes { id name description targetDate ${withBoard ? 'status' : ''} sortOrder }
      }`

/** One page of projects with their milestones. */
const projectsQuery = (withBoard: boolean) => `query TautProjects($after: String) {
  projects(first: ${PAGE_SIZE}, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes {${projectFields(withBoard)}
    }
  }
}`

/**
 * One page of the workspace's people (D15). Archived members are asked for too:
 * a Linear account that has been deactivated is still the author of half the
 * tickets, and a mapping that vanished when somebody left would be a mapping
 * nobody could trust.
 */
const USERS_QUERY = `query TautUsers($after: String) {
  users(first: ${PAGE_SIZE}, after: $after, includeArchived: true) {
    pageInfo { hasNextPage endCursor }
    nodes { id name displayName email avatarUrl active }
  }
}`

/**
 * The fields one issue is mirrored from (D18), widened to the whole ticket
 * (docs/build-plan-issues.md D6). `project { id }` comes back on every node because
 * the reconcile files issues under the project the mirror already holds, rather
 * than trusting the order they arrive in.
 *
 * `withDetail` is the D6 half, asked for behind one flag exactly as the board
 * fields are: GraphQL fails the whole document over a single field Linear has
 * since renamed, so the caller tries once with it and once without, and a Linear
 * that has none of it still mirrors everything it mirrored yesterday.
 */
const issueFields = (withDetail: boolean) => `
      id
      identifier
      title
      url
      priority
      priorityLabel
      sortOrder
      dueDate
      createdAt
      updatedAt
      state { id name type color position }
      assignee { id name avatarUrl }
      labels(first: 10) { nodes { name color } }
      ${withDetail ? 'description' : ''}
      ${withDetail ? 'parent { id identifier title }' : ''}
      ${withDetail ? 'children(first: 100) { nodes { id } }' : ''}
      ${withDetail ? 'team { id key }' : ''}
      ${withDetail ? 'estimate creator { id name avatarUrl } completedAt canceledAt' : ''}
      ${withDetail ? 'projectMilestone { id name }' : 'projectMilestone { name }'}
      project { id }`

/**
 * One page of the issues that belong to *some* project (D18). The filter is the
 * whole point: a workspace's issue count dwarfs its project count, and Taut
 * mirrors issues only as the contents of a project — an issue nobody filed under
 * one has no page here to appear on.
 */
const issuesQuery = (withDetail: boolean) => `query TautIssues($after: String) {
  issues(
    first: ${PAGE_SIZE}
    after: $after
    filter: { project: { null: false } }
  ) {
    pageInfo { hasNextPage endCursor }
    nodes {${issueFields(withDetail)}
    }
  }
}`

/**
 * One ticket, by Linear's UUID or by the identifier a human quotes
 * (docs/build-plan-issues.md D15) — Linear's `issue(id:)` takes either, so this is
 * one document and not two.
 *
 * `comments` rides along because the only reason to read one issue live is the
 * activity feed, and a second round trip for the comments would double the wait
 * for a page that is already asking Linear twice (D12, D13).
 */
const issueQuery = (withDetail: boolean) => `query TautIssue($id: String!) {
  issue(id: $id) {${issueFields(withDetail)}
    comments(first: 100) {
      nodes { id body url createdAt user { id name avatarUrl } }
    }
  }
}`

const IssuePayload = Schema.Struct({
  issue: Schema.optional(Schema.NullOr(LinearIssuePayload))
})

/**
 * D2: change one ticket and read back the issue Linear now holds, in the same
 * round trip. The input is a variable rather than an inlined literal so that the
 * *caller* decides what is in it: an absent field is never sent, and an explicit
 * `null` is sent as `null` and clears the value — a distinction that only survives
 * if the object is built in TypeScript and handed over whole.
 */
const updateIssueMutation = (withDetail: boolean) => `mutation TautUpdateIssue(
  $id: String!
  $input: IssueUpdateInput!
) {
  issueUpdate(id: $id, input: $input) {
    success
    issue {${issueFields(withDetail)}
    }
  }
}`

const UpdatePayload = Schema.Struct({
  issueUpdate: Schema.Struct({
    success: Schema.Boolean,
    issue: Schema.optional(Schema.NullOr(LinearIssuePayload))
  })
})

/**
 * D5: `issueDelete` is Linear's own Delete — the ticket goes to the trash and is
 * restorable for 30 days. Deliberately not `issueArchive`, which is a different
 * word in Linear's UI for a different thing, and not something a human clicking
 * Delete in Taut asked for.
 */
const DELETE_ISSUE_MUTATION = `mutation TautDeleteIssue($id: String!) {
  issueDelete(id: $id) { success }
}`

const DeletePayload = Schema.Struct({
  issueDelete: Schema.Struct({ success: Schema.Boolean })
})

/**
 * D13: Linear's own history for one ticket, read live and never stored. The
 * from/to pairs are deliberately the conservative set — the ones that have been in
 * Linear's schema longest — because one field Linear has since renamed fails the
 * whole document, and a feed that says "could not be read" is worse than a feed
 * missing a row about an estimate.
 */
const ISSUE_HISTORY_QUERY = `query TautIssueHistory($id: String!) {
  issue(id: $id) {
    history(first: 100) {
      nodes {
        id
        createdAt
        actor { id name avatarUrl }
        fromState { name }
        toState { name }
        fromAssignee { name }
        toAssignee { name }
        fromPriority
        toPriority
        fromTitle
        toTitle
        fromDueDate
        toDueDate
        fromEstimate
        toEstimate
        fromParent { identifier }
        toParent { identifier }
        fromProject { name }
        toProject { name }
        addedLabels { name }
        removedLabels { name }
        archived
        updatedDescription
      }
    }
  }
}`

const HistoryNodePayload = Schema.Struct({
  id: Schema.String,
  createdAt: nullableString,
  actor: Schema.optional(Schema.NullOr(LinearPersonPayload)),
  fromState: Schema.optional(Schema.NullOr(Schema.Struct({ name: nullableString }))),
  toState: Schema.optional(Schema.NullOr(Schema.Struct({ name: nullableString }))),
  fromAssignee: Schema.optional(Schema.NullOr(Schema.Struct({ name: nullableString }))),
  toAssignee: Schema.optional(Schema.NullOr(Schema.Struct({ name: nullableString }))),
  fromPriority: Schema.optional(Schema.NullOr(Schema.Number)),
  toPriority: Schema.optional(Schema.NullOr(Schema.Number)),
  fromTitle: nullableString,
  toTitle: nullableString,
  fromDueDate: nullableString,
  toDueDate: nullableString,
  fromEstimate: Schema.optional(Schema.NullOr(Schema.Number)),
  toEstimate: Schema.optional(Schema.NullOr(Schema.Number)),
  fromParent: Schema.optional(Schema.NullOr(Schema.Struct({ identifier: nullableString }))),
  toParent: Schema.optional(Schema.NullOr(Schema.Struct({ identifier: nullableString }))),
  fromProject: Schema.optional(Schema.NullOr(Schema.Struct({ name: nullableString }))),
  toProject: Schema.optional(Schema.NullOr(Schema.Struct({ name: nullableString }))),
  addedLabels: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ name: nullableString })))
  ),
  removedLabels: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Struct({ name: nullableString })))
  ),
  archived: Schema.optional(Schema.NullOr(Schema.Boolean)),
  updatedDescription: Schema.optional(Schema.NullOr(Schema.Boolean))
})

const HistoryPayload = Schema.Struct({
  issue: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ history: Schema.Struct({ nodes: Schema.Array(HistoryNodePayload) }) })
    )
  )
})

/** D11: a Taut reply, pushed out as a comment on the ticket it was said about. */
const COMMENT_CREATE_MUTATION = `mutation TautCreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id url createdAt }
  }
}`

const CommentCreatePayload = Schema.Struct({
  commentCreate: Schema.Struct({
    success: Schema.Boolean,
    comment: Schema.optional(
      Schema.NullOr(
        Schema.Struct({ id: Schema.String, url: nullableString, createdAt: nullableString })
      )
    )
  })
})

/**
 * D14: the pick-lists the issue editors need, read live and never mirrored. Scoped
 * to the ticket's *team*, because that is what a workflow state and a label belong
 * to — a workspace-wide state list would offer states the ticket cannot be moved
 * into. The milestones come from the project and the projects from the workspace,
 * which is exactly how far each of those choices reaches.
 */
const TEAM_OPTIONS_QUERY = `query TautIssueOptions($teamId: String!, $projectId: String!) {
  team(id: $teamId) {
    states(first: 100) { nodes { id name type color position } }
    labels(first: 100) { nodes { id name color } }
    members(first: 100) { nodes { id name avatarUrl } }
  }
  project(id: $projectId) {
    projectMilestones(first: 100) { nodes { id name } }
  }
  projects(first: ${PAGE_SIZE}) { nodes { id name } }
}`

const OptionsPayload = Schema.Struct({
  team: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        states: Schema.Struct({ nodes: Schema.Array(LinearStatusPayload) }),
        labels: Schema.Struct({
          nodes: Schema.Array(
            Schema.Struct({ id: Schema.String, name: Schema.String, color: nullableString })
          )
        }),
        members: Schema.Struct({ nodes: Schema.Array(LinearPersonPayload) })
      })
    )
  ),
  project: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        projectMilestones: Schema.Struct({
          nodes: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
        })
      })
    )
  ),
  projects: Schema.Struct({
    nodes: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
  })
})

/**
 * D21: the second mutation Taut sends Linear, and the first one an *agent* can
 * cause. Taut supplies the team, the project and the assignee; the agent supplies
 * the title and the description. The issue comes back in the same round trip so
 * the caller can answer with Linear's own identifier rather than a guess.
 *
 * A personal API key authors every issue as the key's owner, so the human who
 * asked cannot be its creator in Linear. `assigneeId` is how they are on it
 * instead: the ticket lands in their Linear inbox, which is the outcome that
 * matters, and the description says which agent filed it and who asked.
 */
/**
 * The input is a variable now (docs/build-plan-issues.md D1): a human filing a
 * ticket from the issue page picks a state, labels, a milestone and a due date,
 * and none of those can be an inlined literal if an absent one is to stay absent.
 * The agent path (D21) sends the same three fields it always did.
 */
const createIssueMutation = (withDetail: boolean) => `mutation TautCreateIssue(
  $input: IssueCreateInput!
) {
  issueCreate(input: $input) {
    success
    issue {${issueFields(withDetail)}
    }
  }
}`

const CreateIssuePayload = Schema.Struct({
  issueCreate: Schema.Struct({
    success: Schema.Boolean,
    issue: Schema.optional(Schema.NullOr(LinearIssuePayload))
  })
})

/**
 * D13: the only mutation Taut sends Linear. One field, one project, and the
 * project comes back in the same round trip so the mirror is updated from
 * Linear's answer rather than from what the browser dragged.
 */
const MOVE_MUTATION = `mutation TautMoveProject($id: String!, $statusId: String!) {
  projectUpdate(id: $id, input: { statusId: $statusId }) {
    success
    project {${projectFields(true)}
    }
  }
}`

const MovePayload = Schema.Struct({
  projectUpdate: Schema.Struct({
    success: Schema.Boolean,
    project: Schema.optional(Schema.NullOr(LinearProjectPayload))
  })
})

// ── public shapes ────────────────────────────────────────────────────────────

/** The workspace a key resolves to — what the connection row remembers. */
export interface LinearWorkspace {
  readonly id: string
  readonly name: string
  readonly urlKey: string | undefined
}

/** One person in the workspace, normalised out of Linear's payload (D15). */
export interface LinearWorkspaceUser {
  readonly linearId: string
  readonly name: string
  readonly displayName: string | undefined
  readonly email: string | undefined
  readonly avatarUrl: string | undefined
  readonly active: boolean
}

/** One milestone, normalised out of Linear's payload. */
export interface LinearMilestone {
  readonly linearId: string
  readonly name: string
  readonly description: string | undefined
  readonly targetDate: string | undefined
  /** `unstarted` · `next` · `overdue` · `done`, as Linear words it (D14). */
  readonly status: string | undefined
  readonly sortOrder: number
}

/** One issue, normalised out of Linear's payload and ready for the mirror (D18). */
export interface LinearIssue {
  readonly linearId: string
  /** The project it belongs to, by Linear's UUID. Never blank: unfiled issues are not fetched. */
  readonly projectLinearId: string
  readonly identifier: string
  readonly title: string
  /** Everything from here down arrives only when `withDetail` was asked for (D6). */
  readonly description: string | undefined
  readonly stateId: string
  readonly stateName: string
  readonly stateType: string
  readonly stateColor: string | undefined
  readonly statePosition: number
  readonly priority: number
  readonly priorityLabel: string | undefined
  readonly assigneeId: string | undefined
  readonly assigneeName: string | undefined
  readonly assigneeAvatarUrl: string | undefined
  readonly creatorId: string | undefined
  readonly creatorName: string | undefined
  readonly creatorAvatarUrl: string | undefined
  readonly labels: ReadonlyArray<{ readonly name: string; readonly color: string | undefined }>
  readonly teamId: string | undefined
  readonly teamKey: string | undefined
  readonly milestoneName: string | undefined
  readonly milestoneId: string | undefined
  readonly dueDate: string | undefined
  readonly estimate: number | undefined
  readonly parentLinearId: string | undefined
  readonly parentIdentifier: string | undefined
  readonly parentTitle: string | undefined
  readonly subIssueCount: number
  readonly url: string
  readonly sortOrder: number
  readonly createdAt: string | undefined
  readonly updatedAt: string | undefined
  readonly completedAt: string | undefined
  readonly canceledAt: string | undefined
}

/**
 * One comment on a ticket, as Linear holds it (docs/build-plan-issues.md D11).
 * `authorLinearId` is the whole point: whether this becomes a Taut message or
 * stays a read-only card in the Activity list turns on whether that id maps to a
 * Taut human, and nothing else.
 */
export interface LinearIssueComment {
  readonly linearId: string
  readonly body: string
  readonly authorLinearId: string | undefined
  readonly authorName: string | undefined
  readonly authorAvatarUrl: string | undefined
  readonly createdAt: string | undefined
  readonly url: string
}

/** One issue plus the comments read in the same round trip (D12). */
export interface LinearIssueDetail {
  readonly issue: LinearIssue
  readonly comments: ReadonlyArray<LinearIssueComment>
}

/**
 * One entry of Linear's history, already rendered into Linear's own words (D13).
 * The sentence is composed here rather than in the browser because only this
 * frame ever sees the from/to pair — the client gets the sentence, not the diff.
 */
export interface LinearHistoryEvent {
  readonly linearId: string
  readonly at: string
  readonly actorLinearId: string | undefined
  readonly actorName: string | undefined
  readonly actorAvatarUrl: string | undefined
  readonly kind: string
  readonly summary: string
}

/** The pick-lists one issue's editors need, read live (D14). */
export interface LinearIssueOptions {
  readonly states: ReadonlyArray<LinearStatus>
  readonly labels: ReadonlyArray<{
    readonly id: string
    readonly name: string
    readonly color: string | undefined
  }>
  readonly members: ReadonlyArray<{
    readonly linearId: string
    readonly name: string
    readonly avatarUrl: string | undefined
  }>
  readonly milestones: ReadonlyArray<{ readonly id: string; readonly name: string }>
  readonly projects: ReadonlyArray<{ readonly id: string; readonly name: string }>
}

/**
 * A change to one ticket, on its way to `issueUpdate` (D2). Three states per
 * field and all three matter: absent is "leave it alone", `null` is "clear it",
 * and a value is a value. That is why nothing here is optional-with-undefined —
 * `undefined` would collapse the first two into one.
 */
export interface LinearIssueUpdate {
  readonly title?: string
  readonly description?: string | null
  readonly stateId?: string
  readonly priority?: number
  readonly assigneeId?: string | null
  readonly labelIds?: ReadonlyArray<string>
  readonly projectMilestoneId?: string | null
  readonly dueDate?: string | null
  readonly estimate?: number | null
  readonly parentId?: string | null
  readonly projectId?: string
}

/** A new ticket, on its way to `issueCreate` (D1). The team and project are Taut's, never the caller's. */
export interface LinearIssueCreate {
  readonly teamId: string
  readonly projectLinearId: string
  readonly title: string
  readonly description: string | undefined
  readonly stateId: string | undefined
  readonly priority: number | undefined
  readonly assigneeId: string | undefined
  readonly labelIds: ReadonlyArray<string> | undefined
  readonly milestoneId: string | undefined
  readonly dueDate: string | undefined
  readonly parentId: string | undefined
}

/** One board column, as the workspace defines it (D13). */
export interface LinearStatus {
  readonly id: string
  readonly name: string
  readonly type: string
  readonly color: string | undefined
  readonly position: number
}

/** One project, normalised out of Linear's payload and ready for the mirror. */
export interface LinearProject {
  readonly linearId: string
  readonly name: string
  readonly description: string | undefined
  readonly state: string
  readonly status: LinearStatus | undefined
  /** `0`–`4`; anything else Linear ever sends is clamped to `0` (D14). */
  readonly priority: number
  readonly priorityLabel: string | undefined
  readonly prioritySortOrder: number
  readonly health: string | undefined
  readonly issueCount: number
  readonly progress: number
  readonly icon: string | undefined
  readonly color: string | undefined
  readonly url: string
  readonly leadName: string | undefined
  readonly leadEmail: string | undefined
  readonly leadAvatarUrl: string | undefined
  readonly teams: ReadonlyArray<{
    readonly id: string | undefined
    readonly key: string
    readonly name: string
  }>
  readonly startDate: string | undefined
  readonly targetDate: string | undefined
  readonly updatedAt: string | undefined
  readonly milestones: ReadonlyArray<LinearMilestone>
}

const orUndefined = <A>(value: A | null | undefined): A | undefined => value ?? undefined

/** Linear's priority as one of the five levels the contract knows (D14). */
const priorityOf = (value: number | null | undefined): number =>
  value === null || value === undefined || !Number.isInteger(value) || value < 0 || value > 4
    ? 0
    : value

/** Only Linear's three health words survive; anything else is "no health yet". */
const healthOf = (value: string | null | undefined): string | undefined =>
  value === 'onTrack' || value === 'atRisk' || value === 'offTrack' ? value : undefined

/** Only Linear's four milestone words survive, for the same reason. */
const milestoneStatusOf = (value: string | null | undefined): string | undefined =>
  value === 'unstarted' || value === 'next' || value === 'overdue' || value === 'done'
    ? value
    : undefined

/**
 * A person, with a name that is always something. Linear can answer a null name
 * for a half-provisioned account; the display name, then the email's local part,
 * then a flat placeholder keep the row renderable rather than blank.
 */
const normaliseUser = (node: typeof LinearUserPayload.Type): LinearWorkspaceUser => {
  const email = orUndefined(node.email)
  const displayName = orUndefined(node.displayName)
  const name = orUndefined(node.name) ?? displayName ?? email?.split('@')[0]
  return {
    linearId: node.id,
    name: name === undefined || name.trim() === '' ? 'Unnamed' : name,
    displayName,
    email,
    avatarUrl: orUndefined(node.avatarUrl),
    active: node.active ?? true
  }
}

/** Linear's nullable-everything payload as the shape the mirror stores. */
const normalise = (node: typeof LinearProjectPayload.Type): LinearProject => ({
  linearId: node.id,
  name: node.name,
  description: orUndefined(node.description),
  state: orUndefined(node.state) ?? 'unknown',
  status:
    node.status === undefined || node.status === null
      ? undefined
      : {
          id: node.status.id,
          name: node.status.name,
          type: orUndefined(node.status.type) ?? 'unknown',
          color: orUndefined(node.status.color),
          position: node.status.position ?? 0
        },
  priority: priorityOf(node.priority),
  priorityLabel: orUndefined(node.priorityLabel),
  prioritySortOrder: node.prioritySortOrder ?? 0,
  health: healthOf(node.health),
  // Linear's `scope` counts issues; a negative or fractional one is Linear
  // changing its mind about the field, and zero is the honest fallback.
  issueCount: Math.max(0, Math.round(node.scope ?? 0)),
  progress: node.progress ?? 0,
  icon: orUndefined(node.icon),
  color: orUndefined(node.color),
  // A project with no URL should still be visible; link to the workspace.
  url: orUndefined(node.url) ?? LINEAR_WEB,
  leadName: orUndefined(node.lead?.name),
  leadEmail: orUndefined(node.lead?.email),
  leadAvatarUrl: orUndefined(node.lead?.avatarUrl),
  teams: (node.teams?.nodes ?? []).map((team) => ({
    id: orUndefined(team.id),
    key: team.key ?? '',
    name: team.name ?? team.key ?? ''
  })),
  startDate: orUndefined(node.startDate),
  targetDate: orUndefined(node.targetDate),
  updatedAt: orUndefined(node.updatedAt),
  milestones: (node.projectMilestones?.nodes ?? []).map((milestone, index) => ({
    linearId: milestone.id,
    name: milestone.name,
    description: orUndefined(milestone.description),
    targetDate: orUndefined(milestone.targetDate),
    status: milestoneStatusOf(milestone.status),
    sortOrder: milestone.sortOrder ?? index
  }))
})

/**
 * Linear's nullable-everything issue as the shape the mirror stores (D18).
 *
 * An issue with no workflow state is not a thing Linear has, but the payload
 * allows it: such a row lands in a synthetic `unknown` column rather than being
 * dropped, for the same reason a project with an unrecognised state still shows.
 */
const normaliseIssue = (node: typeof LinearIssuePayload.Type): LinearIssue | undefined => {
  const projectLinearId = node.project?.id
  if (projectLinearId === undefined || projectLinearId === null) return undefined
  return {
    linearId: node.id,
    projectLinearId,
    // Linear always has one; a blank falls back to something a human can still
    // click rather than an empty cell in the row's leading column.
    identifier: orUndefined(node.identifier) ?? node.id.slice(0, 8),
    title: orUndefined(node.title) ?? 'Untitled',
    stateId: node.state?.id ?? 'unknown',
    stateName: node.state?.name ?? 'No status',
    stateType: orUndefined(node.state?.type) ?? 'unknown',
    stateColor: orUndefined(node.state?.color),
    statePosition: node.state?.position ?? 0,
    priority: priorityOf(node.priority),
    priorityLabel: orUndefined(node.priorityLabel),
    assigneeId: orUndefined(node.assignee?.id),
    assigneeName: orUndefined(node.assignee?.name),
    assigneeAvatarUrl: orUndefined(node.assignee?.avatarUrl),
    creatorId: orUndefined(node.creator?.id),
    creatorName: orUndefined(node.creator?.name),
    creatorAvatarUrl: orUndefined(node.creator?.avatarUrl),
    description: orUndefined(node.description),
    labels: (node.labels?.nodes ?? [])
      .map((label) => ({ name: orUndefined(label.name) ?? '', color: orUndefined(label.color) }))
      .filter((label) => label.name !== ''),
    teamId: orUndefined(node.team?.id),
    teamKey: orUndefined(node.team?.key),
    milestoneName: orUndefined(node.projectMilestone?.name),
    milestoneId: orUndefined(node.projectMilestone?.id),
    dueDate: orUndefined(node.dueDate),
    estimate: orUndefined(node.estimate),
    parentLinearId: orUndefined(node.parent?.id),
    parentIdentifier: orUndefined(node.parent?.identifier),
    parentTitle: orUndefined(node.parent?.title),
    // Absent means "Linear was not asked" as often as "there are none", and the
    // page draws no sub-issue section either way — exactly as Linear's own does.
    subIssueCount: node.children?.nodes.length ?? 0,
    url: orUndefined(node.url) ?? LINEAR_WEB,
    sortOrder: node.sortOrder ?? 0,
    createdAt: orUndefined(node.createdAt),
    updatedAt: orUndefined(node.updatedAt),
    completedAt: orUndefined(node.completedAt),
    canceledAt: orUndefined(node.canceledAt)
  }
}

/** Linear's comment nodes as the shape the reconcile decides about (D11, D12). */
const normaliseComments = (
  node: typeof LinearIssuePayload.Type
): ReadonlyArray<LinearIssueComment> =>
  (node.comments?.nodes ?? []).map((comment) => ({
    linearId: comment.id,
    body: orUndefined(comment.body) ?? '',
    authorLinearId: orUndefined(comment.user?.id),
    authorName: orUndefined(comment.user?.name),
    authorAvatarUrl: orUndefined(comment.user?.avatarUrl),
    createdAt: orUndefined(comment.createdAt),
    // A comment with no URL of its own still has a ticket to point at; the caller
    // fills that in, because only it knows the issue's URL.
    url: orUndefined(comment.url) ?? ''
  }))

/** Linear's five priority words, so a history line reads the way Linear's does. */
const PRIORITY_WORDS = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const

const priorityWord = (value: number | null | undefined): string =>
  PRIORITY_WORDS[priorityOf(value)] ?? 'No priority'

/**
 * One history node in Linear's own words (D13): `moved from Todo to In progress`,
 * `assigned to Ana`, `added label Chore`.
 *
 * The order of the checks *is* the priority: a node can carry several from/to
 * pairs at once (Linear batches one edit's changes into one node), and the feed
 * wants the one thing that reads as what happened, not a list of every column
 * that moved. Anything Taut does not recognise renders as `changed the issue`
 * rather than not rendering — a feed that silently drops a row is a feed that
 * cannot be trusted about the rows it does show.
 */
export const renderHistory = (
  node: typeof HistoryNodePayload.Type
): { readonly kind: string; readonly summary: string } => {
  const added = (node.addedLabels ?? [])
    .map((l) => orUndefined(l.name))
    .filter((n) => n !== undefined)
  const removed = (node.removedLabels ?? [])
    .map((l) => orUndefined(l.name))
    .filter((n) => n !== undefined)

  const toState = orUndefined(node.toState?.name)
  if (toState !== undefined) {
    const from = orUndefined(node.fromState?.name)
    return {
      kind: 'state',
      summary: from === undefined ? `moved to ${toState}` : `moved from ${from} to ${toState}`
    }
  }
  const toAssignee = orUndefined(node.toAssignee?.name)
  if (toAssignee !== undefined) return { kind: 'assignee', summary: `assigned to ${toAssignee}` }
  // Only an *un*assignment has a from with no to, so this cannot swallow the case above.
  const fromAssignee = orUndefined(node.fromAssignee?.name)
  if (fromAssignee !== undefined) {
    return { kind: 'assignee', summary: `unassigned ${fromAssignee}` }
  }
  if (added.length > 0) {
    return { kind: 'label', summary: `added label ${added.join(', ')}` }
  }
  if (removed.length > 0) {
    return { kind: 'label', summary: `removed label ${removed.join(', ')}` }
  }
  if (node.toPriority !== undefined && node.toPriority !== null) {
    return {
      kind: 'priority',
      summary: `set priority to ${priorityWord(node.toPriority)}`
    }
  }
  const toTitle = orUndefined(node.toTitle)
  if (toTitle !== undefined) return { kind: 'title', summary: `renamed it to "${toTitle}"` }
  const toProject = orUndefined(node.toProject?.name)
  if (toProject !== undefined) return { kind: 'project', summary: `moved it to ${toProject}` }
  const toParent = orUndefined(node.toParent?.identifier)
  if (toParent !== undefined)
    return { kind: 'parent', summary: `made it a sub-issue of ${toParent}` }
  const fromParent = orUndefined(node.fromParent?.identifier)
  if (fromParent !== undefined) {
    return { kind: 'parent', summary: `removed it from under ${fromParent}` }
  }
  const toDueDate = orUndefined(node.toDueDate)
  if (toDueDate !== undefined)
    return { kind: 'dueDate', summary: `set the due date to ${toDueDate}` }
  if (orUndefined(node.fromDueDate) !== undefined) {
    return { kind: 'dueDate', summary: 'removed the due date' }
  }
  if (node.toEstimate !== undefined && node.toEstimate !== null) {
    return { kind: 'estimate', summary: `set the estimate to ${node.toEstimate}` }
  }
  if (node.archived === true) return { kind: 'archived', summary: 'archived it' }
  if (node.updatedDescription === true) {
    return { kind: 'description', summary: 'updated the description' }
  }
  return { kind: 'other', summary: 'changed the issue' }
}

export class Linear extends Effect.Service<Linear>()('Linear', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const config = yield* AppConfig
    const masterKey = Redacted.value(config.masterKey)
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.transformResponse(Effect.timeout(REQUEST_TIMEOUT_MS))
    )

    // ── queries ──────────────────────────────────────────────────────────────

    const COLUMNS =
      'company_id, key_hint, workspace_name, workspace_url_key, connected_at, last_synced_at, last_sync_error'

    const connectionRow = findOne({
      Request: Schema.String,
      Result: LinearConnectionRow,
      execute: (companyId) =>
        sql`SELECT ${sql.literal(COLUMNS)} FROM linear_connections WHERE company_id = ${companyId}`
    })

    /** The only statement that reads ciphertext. Its result never leaves this module. */
    const keyRow = findOne({
      Request: Schema.String,
      Result: Schema.Struct({ api_key_ct: Schema.Uint8ArrayFromSelf }),
      execute: (companyId) =>
        sql`SELECT api_key_ct FROM linear_connections WHERE company_id = ${companyId}`
    })

    const upsertConnection = run({
      Request: Schema.Struct({
        companyId: Schema.String,
        apiKeyCt: Schema.Uint8ArrayFromSelf,
        keyHint: Schema.String,
        workspaceId: Schema.String,
        workspaceName: Schema.String,
        workspaceUrlKey: Schema.NullOr(Schema.String),
        connectedBy: Schema.String,
        connectedAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO linear_connections
          (company_id, api_key_ct, key_hint, workspace_id, workspace_name, workspace_url_key,
           connected_by, connected_at, last_synced_at, last_sync_error)
        VALUES (${r.companyId}, ${Buffer.from(r.apiKeyCt)}, ${r.keyHint}, ${r.workspaceId},
                ${r.workspaceName}, ${r.workspaceUrlKey}, ${r.connectedBy}, ${r.connectedAt},
                NULL, NULL)
        ON CONFLICT (company_id) DO UPDATE SET
          api_key_ct = excluded.api_key_ct, key_hint = excluded.key_hint,
          workspace_id = excluded.workspace_id, workspace_name = excluded.workspace_name,
          workspace_url_key = excluded.workspace_url_key,
          connected_by = excluded.connected_by, connected_at = excluded.connected_at,
          last_sync_error = NULL`
    })

    const markSync = run({
      Request: Schema.Struct({
        companyId: Schema.String,
        syncedAt: Schema.NullOr(Schema.String),
        error: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        UPDATE linear_connections
        SET last_synced_at = COALESCE(${r.syncedAt}, last_synced_at), last_sync_error = ${r.error}
        WHERE company_id = ${r.companyId}`
    })

    const deleteConnection = run({
      Request: Schema.String,
      execute: (companyId) => sql`DELETE FROM linear_connections WHERE company_id = ${companyId}`
    })

    // ── HTTP ─────────────────────────────────────────────────────────────────

    /**
     * One GraphQL call, decoded. Every failure becomes a `LinearFailure` whose
     * `reason` is built from the status and our own words: Linear echoes the
     * query it received in an error body, and the query is not the interesting
     * part — the header is, and that must never be quoted back.
     */
    const call = <A, I>(
      apiKey: string,
      query: string,
      variables: Record<string, unknown>,
      result: Schema.Schema<A, I>,
      what: string
    ): Effect.Effect<A, LinearFailure> =>
      HttpClientRequest.post(LINEAR_API).pipe(
        HttpClientRequest.setHeaders({
          // A Linear *personal* key is sent bare; only OAuth tokens take `Bearer`.
          authorization: apiKey,
          'content-type': 'application/json',
          accept: 'application/json'
        }),
        HttpClientRequest.bodyUnsafeJson({ query, variables }),
        client.execute,
        Effect.mapError((error) =>
          error._tag === 'ResponseError'
            ? new LinearFailure({
                reason: `Linear refused to ${what} (HTTP ${error.response.status})`
              })
            : new LinearFailure({ reason: `cannot reach Linear to ${what}` })
        ),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.json.pipe(
                Effect.mapError(
                  () => new LinearFailure({ reason: `Linear sent unreadable JSON for ${what}` })
                )
              )
            : Effect.fail(
                new LinearFailure({
                  reason:
                    response.status === 401 || response.status === 403
                      ? 'Linear rejected the API key'
                      : `Linear refused to ${what} (HTTP ${response.status})`
                })
              )
        ),
        Effect.flatMap((body) =>
          Schema.decodeUnknown(GraphQlEnvelope(result))(body).pipe(
            Effect.mapError(
              () => new LinearFailure({ reason: `Linear sent an unexpected payload for ${what}` })
            )
          )
        ),
        Effect.flatMap((envelope) => {
          const errors = envelope.errors ?? []
          if (errors.length > 0) {
            const first = errors[0]?.message
            return Effect.fail(
              new LinearFailure({
                reason:
                  first === undefined || first.trim() === ''
                    ? `Linear refused to ${what}`
                    : `Linear refused to ${what}: ${first}`
              })
            )
          }
          return envelope.data === undefined || envelope.data === null
            ? Effect.fail(new LinearFailure({ reason: `Linear sent no data for ${what}` }))
            : Effect.succeed(envelope.data)
        })
      )

    /** The stored key for a company, decrypted, or a `LinearFailure` saying why not. */
    const keyFor = (companyId: CompanyId): Effect.Effect<string, LinearFailure> =>
      keyRow(companyId).pipe(
        Effect.flatMap((row) =>
          Option.isNone(row)
            ? Effect.fail(new LinearFailure({ reason: 'this company is not connected to Linear' }))
            : Effect.succeed(row.value.api_key_ct)
        ),
        Effect.flatMap((ciphertext) => {
          const plain = decryptToString(masterKey, companyId, ciphertext, {
            aad: Buffer.from(companyId, 'utf8')
          })
          return Either.isLeft(plain)
            ? Effect.fail(
                new LinearFailure({
                  reason: 'the stored Linear API key cannot be decrypted with this TAUT_MASTER_KEY'
                })
              )
            : Effect.succeed(plain.right)
        })
      )

    // ── operations ───────────────────────────────────────────────────────────

    /** D3: ask Linear who the key is before believing it. */
    const validate = (apiKey: string): Effect.Effect<LinearWorkspace, LinearFailure> =>
      call(apiKey, VIEWER_QUERY, {}, ViewerPayload, 'identify the API key').pipe(
        Effect.map((payload) => ({
          id: payload.organization.id,
          name: payload.organization.name,
          urlKey: orUndefined(payload.organization.urlKey)
        }))
      )

    /**
     * Store a validated key (D2, D3). Replaces whatever was there; the mirror is
     * left alone, because the caller reconciles it in the same request.
     */
    const connect = (
      companyId: CompanyId,
      userId: UserId,
      apiKey: string
    ): Effect.Effect<LinearWorkspace, LinearFailure> =>
      Effect.gen(function* () {
        const workspace = yield* validate(apiKey)
        yield* upsertConnection({
          companyId,
          apiKeyCt: encrypt(masterKey, companyId, apiKey, {
            aad: Buffer.from(companyId, 'utf8')
          }),
          keyHint: hint(apiKey),
          workspaceId: workspace.id,
          workspaceName: workspace.name,
          workspaceUrlKey: workspace.urlKey ?? null,
          connectedBy: userId,
          connectedAt: nowIso()
        })
        yield* Effect.logInfo(`linear: connected company ${companyId} to ${workspace.name}`)
        return workspace
      })

    const disconnect = (companyId: CompanyId): Effect.Effect<void> =>
      deleteConnection(companyId).pipe(
        Effect.tap(() => Effect.logInfo(`linear: disconnected company ${companyId}`))
      )

    /**
     * Every project the key can see, paged until Linear says there is no more or
     * `MAX_PROJECT_PAGES` is reached. Normalising here — not in the caller — keeps
     * Linear's nullable-everything payload out of the reconcile.
     */
    /**
     * Every project the key can see, paged until Linear says there is no more or
     * `MAX_PROJECT_PAGES` is reached. `withBoard` is the newer board fields (D13, D14);
     * the caller retries without it once, so a workspace that has no project
     * statuses still mirrors everything else.
     */
    const projectPages = (
      apiKey: string,
      withBoard: boolean
    ): Effect.Effect<ReadonlyArray<LinearProject>, LinearFailure> =>
      Effect.gen(function* () {
        const document = projectsQuery(withBoard)
        const collected: Array<LinearProject> = []
        let after: string | undefined = undefined

        for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
          const payload: typeof ProjectsPayload.Type = yield* call(
            apiKey,
            document,
            after === undefined ? {} : { after },
            ProjectsPayload,
            'list projects'
          )
          for (const node of payload.projects.nodes) collected.push(normalise(node))
          if (!payload.projects.pageInfo.hasNextPage) break
          const cursor: string | undefined = orUndefined(payload.projects.pageInfo.endCursor)
          if (cursor === undefined) break
          after = cursor
        }

        return collected
      })

    const projects = (
      companyId: CompanyId
    ): Effect.Effect<ReadonlyArray<LinearProject>, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          projectPages(apiKey, true).pipe(
            // Asking for `status` is the only reason this document can fail on a
            // workspace whose projects are otherwise readable. One retry without
            // it turns "no board" into a plain list rather than a broken sync.
            Effect.catchAll((error) =>
              Effect.logWarning(
                `linear: retrying the project sync without statuses (${error.reason})`
              ).pipe(Effect.zipRight(projectPages(apiKey, false)))
            )
          )
        )
      )

    /**
     * D15: every person the key can see, paged the same way projects are. A
     * workspace that refuses the `users` query — an old API version, a key too
     * narrow to read the directory — answers an empty list rather than failing
     * the sync: the projects are the feature, and the mapping table is a page an
     * admin opens on purpose.
     */
    const users = (
      companyId: CompanyId
    ): Effect.Effect<ReadonlyArray<LinearWorkspaceUser>, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          Effect.gen(function* () {
            const collected: Array<LinearWorkspaceUser> = []
            let after: string | undefined = undefined

            for (let page = 0; page < MAX_PROJECT_PAGES; page++) {
              const payload: typeof UsersPayload.Type = yield* call(
                apiKey,
                USERS_QUERY,
                after === undefined ? {} : { after },
                UsersPayload,
                'list the workspace members'
              )
              for (const node of payload.users.nodes) collected.push(normaliseUser(node))
              if (!payload.users.pageInfo.hasNextPage) break
              const cursor: string | undefined = orUndefined(payload.users.pageInfo.endCursor)
              if (cursor === undefined) break
              after = cursor
            }

            return collected
          })
        )
      )

    /**
     * D18: every issue that belongs to a project, paged the way projects are.
     *
     * Unlike the projects call this one has no fallback query. Issues are an
     * addition to the mirror, not the mirror itself: a workspace or an API
     * version that refuses this document answers nothing here, and the caller
     * treats that as "no issues yet" rather than as a broken sync (D20).
     */
    /**
     * The D6 fields, once, and then without them (docs/build-plan-issues.md D6).
     *
     * Exactly the bargain the project sync makes with the board fields: one flag,
     * one retry. `description`, `parent`, `children`, `team`, `estimate` and the
     * timestamps are the newest things this file asks Linear for, and an API
     * version that has none of them must still mirror what it mirrored yesterday
     * rather than failing the whole document over one name.
     */
    const oneRetryWithoutDetail = <A>(
      what: string,
      run: (detail: boolean) => Effect.Effect<A, LinearFailure>
    ): Effect.Effect<A, LinearFailure> =>
      run(true).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(
            `linear: retrying ${what} without the ticket detail (${error.reason})`
          ).pipe(Effect.zipRight(run(false)))
        )
      )

    const issuePages = (
      apiKey: string,
      detail: boolean
    ): Effect.Effect<ReadonlyArray<LinearIssue>, LinearFailure> =>
      Effect.gen(function* () {
        const document = issuesQuery(detail)
        const collected: Array<LinearIssue> = []
        let after: string | undefined = undefined

        for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
          const payload: typeof IssuesPayload.Type = yield* call(
            apiKey,
            document,
            after === undefined ? {} : { after },
            IssuesPayload,
            'list the project issues'
          )
          for (const node of payload.issues.nodes) {
            const issue = normaliseIssue(node)
            if (issue !== undefined) collected.push(issue)
          }
          if (!payload.issues.pageInfo.hasNextPage) break
          const cursor: string | undefined = orUndefined(payload.issues.pageInfo.endCursor)
          if (cursor === undefined) break
          after = cursor
        }

        return collected
      })

    const issues = (
      companyId: CompanyId
    ): Effect.Effect<ReadonlyArray<LinearIssue>, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          oneRetryWithoutDetail('the issue sync', (detail) => issuePages(apiKey, detail))
        )
      )

    /**
     * D21: file one issue under a project. The caller has already decided that it
     * may — which team, which project, and which Linear person it is assigned to
     * are all resolved from the mirror before this is reached, so nothing an agent
     * typed reaches Linear as an id.
     *
     * Widened by docs/build-plan-issues.md D1: a human filing from the issue page
     * also picks a state, labels, a milestone, a due date and a parent. Every one
     * of them is left out of the input when the caller left it out, so Linear's own
     * defaults still apply.
     */
    const createIssue = (
      companyId: CompanyId,
      input: LinearIssueCreate
    ): Effect.Effect<LinearIssue, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) => {
          const fields: Record<string, unknown> = {
            teamId: input.teamId,
            projectId: input.projectLinearId,
            title: input.title
          }
          if (input.description !== undefined) fields['description'] = input.description
          if (input.stateId !== undefined) fields['stateId'] = input.stateId
          if (input.priority !== undefined) fields['priority'] = input.priority
          if (input.assigneeId !== undefined) fields['assigneeId'] = input.assigneeId
          if (input.labelIds !== undefined) fields['labelIds'] = input.labelIds
          if (input.milestoneId !== undefined) fields['projectMilestoneId'] = input.milestoneId
          if (input.dueDate !== undefined) fields['dueDate'] = input.dueDate
          if (input.parentId !== undefined) fields['parentId'] = input.parentId
          /**
           * The one call here that is *not* wrapped in `oneRetryWithoutDetail`: a
           * retried create is a second ticket. A document Linear refuses is
           * refused before it executes, but a timeout after it executed is not
           * distinguishable from one before, and filing twice is a worse failure
           * than filing not at all.
           */
          return call(
            apiKey,
            createIssueMutation(true),
            { input: fields },
            CreateIssuePayload,
            'create the issue'
          )
        }),
        Effect.flatMap((payload) => {
          const issue = payload.issueCreate.issue
          if (!payload.issueCreate.success || issue === undefined || issue === null) {
            return Effect.fail(new LinearFailure({ reason: 'Linear did not create the issue' }))
          }
          const normalised = normaliseIssue(issue)
          return normalised === undefined
            ? Effect.fail(
                new LinearFailure({ reason: 'Linear created the issue outside any project' })
              )
            : Effect.succeed(normalised)
        })
      )

    /**
     * D13: move one project to another board column. Answers with the project as
     * Linear now holds it, so the caller writes the mirror from Linear's own words.
     */
    const moveProject = (
      companyId: CompanyId,
      linearProjectId: string,
      statusId: string
    ): Effect.Effect<LinearProject, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          call(
            apiKey,
            MOVE_MUTATION,
            { id: linearProjectId, statusId },
            MovePayload,
            'move the project'
          )
        ),
        Effect.flatMap((payload) => {
          const project = payload.projectUpdate.project
          return !payload.projectUpdate.success || project === undefined || project === null
            ? Effect.fail(new LinearFailure({ reason: 'Linear did not move the project' }))
            : Effect.succeed(normalise(project))
        })
      )

    // ── one ticket (docs/build-plan-issues.md) ───────────────────────────────

    /**
     * D15: one ticket, live, with its comments. `ref` is Linear's UUID or the
     * identifier a human quotes (`ENG-4636`) — Linear's own `issue(id:)` takes
     * either, so there is one document here and not two.
     */
    const issue = (
      companyId: CompanyId,
      ref: string
    ): Effect.Effect<LinearIssueDetail, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          oneRetryWithoutDetail('the issue read', (detail) =>
            call(apiKey, issueQuery(detail), { id: ref }, IssuePayload, 'read the issue')
          )
        ),
        Effect.flatMap((payload) => {
          const node = payload.issue
          if (node === undefined || node === null) {
            return Effect.fail(new LinearFailure({ reason: `Linear has no issue ${ref}` }))
          }
          const normalised = normaliseIssue(node)
          return normalised === undefined
            ? Effect.fail(
                new LinearFailure({ reason: `issue ${ref} is not filed under a project` })
              )
            : Effect.succeed({ issue: normalised, comments: normaliseComments(node) })
        })
      )

    /**
     * D2: change one ticket and take the issue Linear answers with as the truth.
     * The retry without the detail fields is safe here in a way it is not on a
     * create: `issueUpdate` sets fields to values, so running it twice leaves the
     * ticket exactly where running it once did.
     */
    const updateIssue = (
      companyId: CompanyId,
      linearIssueId: string,
      input: LinearIssueUpdate
    ): Effect.Effect<LinearIssue, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) => {
          /**
           * Field by field, and `null` survives: an absent key is never sent, so
           * Linear leaves that field alone, while an explicit `null` is sent and
           * clears it. Spreading the payload instead would send `undefined`s that
           * JSON drops silently — the same wire, but by accident rather than on
           * purpose.
           */
          const fields: Record<string, unknown> = {}
          if (input.title !== undefined) fields['title'] = input.title
          if (input.description !== undefined) fields['description'] = input.description
          if (input.stateId !== undefined) fields['stateId'] = input.stateId
          if (input.priority !== undefined) fields['priority'] = input.priority
          if (input.assigneeId !== undefined) fields['assigneeId'] = input.assigneeId
          if (input.labelIds !== undefined) fields['labelIds'] = input.labelIds
          if (input.projectMilestoneId !== undefined) {
            fields['projectMilestoneId'] = input.projectMilestoneId
          }
          if (input.dueDate !== undefined) fields['dueDate'] = input.dueDate
          if (input.estimate !== undefined) fields['estimate'] = input.estimate
          if (input.parentId !== undefined) fields['parentId'] = input.parentId
          if (input.projectId !== undefined) fields['projectId'] = input.projectId
          return oneRetryWithoutDetail('the issue update', (detail) =>
            call(
              apiKey,
              updateIssueMutation(detail),
              { id: linearIssueId, input: fields },
              UpdatePayload,
              'update the issue'
            )
          )
        }),
        Effect.flatMap((payload) => {
          const node = payload.issueUpdate.issue
          if (!payload.issueUpdate.success || node === undefined || node === null) {
            return Effect.fail(new LinearFailure({ reason: 'Linear did not update the issue' }))
          }
          const normalised = normaliseIssue(node)
          return normalised === undefined
            ? Effect.fail(
                new LinearFailure({ reason: 'Linear moved the issue out of every project' })
              )
            : Effect.succeed(normalised)
        })
      )

    /** D5: Linear's own Delete — the trash, restorable for 30 days, not the archive. */
    const deleteIssue = (
      companyId: CompanyId,
      linearIssueId: string
    ): Effect.Effect<void, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          call(
            apiKey,
            DELETE_ISSUE_MUTATION,
            { id: linearIssueId },
            DeletePayload,
            'delete the issue'
          )
        ),
        Effect.flatMap((payload) =>
          payload.issueDelete.success
            ? Effect.void
            : Effect.fail(new LinearFailure({ reason: 'Linear did not delete the issue' }))
        )
      )

    /**
     * D13: Linear's history for one ticket, rendered into sentences here. Never
     * stored: history is derived state only Linear can author, and a stale copy of
     * it is worse than a spinner.
     */
    const issueHistory = (
      companyId: CompanyId,
      ref: string
    ): Effect.Effect<ReadonlyArray<LinearHistoryEvent>, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          call(apiKey, ISSUE_HISTORY_QUERY, { id: ref }, HistoryPayload, "read the issue's history")
        ),
        Effect.map((payload) =>
          (payload.issue?.history.nodes ?? []).flatMap((node) => {
            const at = orUndefined(node.createdAt)
            // A history entry with no timestamp cannot be placed in a
            // time-ordered feed, and a feed that guesses where it goes is worse
            // than one that leaves it out.
            if (at === undefined) return []
            const rendered = renderHistory(node)
            return [
              {
                linearId: node.id,
                at,
                actorLinearId: orUndefined(node.actor?.id),
                actorName: orUndefined(node.actor?.name),
                actorAvatarUrl: orUndefined(node.actor?.avatarUrl),
                kind: rendered.kind,
                summary: rendered.summary
              }
            ]
          })
        )
      )

    /**
     * D11: a Taut reply, out to Linear as a comment on the ticket. The body
     * already carries who said it — the caller prefixes `@handle via Taut —`,
     * because a personal API key authors every comment as the key's owner and a
     * comment that looks like the owner's is a lie about who said it.
     */
    const createComment = (
      companyId: CompanyId,
      linearIssueId: string,
      body: string
    ): Effect.Effect<string, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          call(
            apiKey,
            COMMENT_CREATE_MUTATION,
            { issueId: linearIssueId, body },
            CommentCreatePayload,
            'comment on the issue'
          )
        ),
        Effect.flatMap((payload) => {
          const comment = payload.commentCreate.comment
          return !payload.commentCreate.success || comment === undefined || comment === null
            ? Effect.fail(new LinearFailure({ reason: 'Linear did not take the comment' }))
            : Effect.succeed(comment.id)
        })
      )

    /**
     * D14: the pick-lists, live. A team that Linear will not answer for is a
     * failure rather than an empty list: an empty status picker reads as "this
     * ticket has no states", which is never true and would have somebody
     * reloading the page instead of telling their admin the key is too narrow.
     */
    const issueOptions = (
      companyId: CompanyId,
      teamId: string,
      projectLinearId: string
    ): Effect.Effect<LinearIssueOptions, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          call(
            apiKey,
            TEAM_OPTIONS_QUERY,
            { teamId, projectId: projectLinearId },
            OptionsPayload,
            'read the issue options'
          )
        ),
        Effect.flatMap((payload) => {
          const team = payload.team
          if (team === undefined || team === null) {
            return Effect.fail(new LinearFailure({ reason: `Linear has no team ${teamId}` }))
          }
          return Effect.succeed({
            states: team.states.nodes.map((state, index) => ({
              id: state.id,
              name: state.name,
              type: orUndefined(state.type) ?? 'unknown',
              color: orUndefined(state.color),
              position: state.position ?? index
            })),
            labels: team.labels.nodes.map((label) => ({
              id: label.id,
              name: label.name,
              color: orUndefined(label.color)
            })),
            members: team.members.nodes.map((member) => ({
              linearId: member.id,
              name: orUndefined(member.name) ?? 'Unnamed',
              avatarUrl: orUndefined(member.avatarUrl)
            })),
            milestones: payload.project?.projectMilestones.nodes ?? [],
            projects: payload.projects.nodes
          })
        })
      )

    /** D7: what the connection row remembers about the last attempt. */
    const recordSync = (
      companyId: CompanyId,
      outcome: { readonly syncedAt: string } | { readonly error: string }
    ): Effect.Effect<void> =>
      markSync({
        companyId,
        syncedAt: 'syncedAt' in outcome ? outcome.syncedAt : null,
        error: 'error' in outcome ? outcome.error : null
      })

    return {
      /** The connection row, key excluded. `None` means nobody has connected Linear. */
      row: (companyId: CompanyId) => connectionRow(companyId),
      validate,
      connect,
      disconnect,
      projects,
      users,
      issues,
      createIssue,
      moveProject,
      // one ticket (docs/build-plan-issues.md)
      issue,
      updateIssue,
      deleteIssue,
      issueHistory,
      createComment,
      issueOptions,
      recordSync
    } as const
  }),
  dependencies: [FetchHttpClient.layer]
}) {}
