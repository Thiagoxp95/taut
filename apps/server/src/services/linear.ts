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

/**
 * One issue of a project (D18). Every field nullable, like everything else Linear
 * answers: the mirror normalises, the payload just has to decode.
 */
const LinearIssuePayload = Schema.Struct({
  id: Schema.String,
  identifier: nullableString,
  title: nullableString,
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
  assignee: Schema.optional(
    Schema.NullOr(
      Schema.Struct({ id: Schema.String, name: nullableString, avatarUrl: nullableString })
    )
  ),
  projectMilestone: Schema.optional(Schema.NullOr(Schema.Struct({ name: nullableString }))),
  labels: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(Schema.Struct({ name: nullableString, color: nullableString }))
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
 * The fields one issue is mirrored from (D18). `project { id }` comes back on
 * every node because the reconcile files issues under the project the mirror
 * already holds, rather than trusting the order they arrive in.
 */
const ISSUE_FIELDS = `
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
      projectMilestone { name }
      labels(first: 10) { nodes { name color } }
      project { id }`

/**
 * One page of the issues that belong to *some* project (D18). The filter is the
 * whole point: a workspace's issue count dwarfs its project count, and Taut
 * mirrors issues only as the contents of a project — an issue nobody filed under
 * one has no page here to appear on.
 */
const ISSUES_QUERY = `query TautIssues($after: String) {
  issues(
    first: ${PAGE_SIZE}
    after: $after
    filter: { project: { null: false } }
  ) {
    pageInfo { hasNextPage endCursor }
    nodes {${ISSUE_FIELDS}
    }
  }
}`

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
const CREATE_ISSUE_MUTATION = `mutation TautCreateIssue(
  $teamId: String!
  $projectId: String!
  $title: String!
  $description: String
  $assigneeId: String
  $priority: Int
) {
  issueCreate(input: {
    teamId: $teamId
    projectId: $projectId
    title: $title
    description: $description
    assigneeId: $assigneeId
    priority: $priority
  }) {
    success
    issue {${ISSUE_FIELDS}
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
  readonly labels: ReadonlyArray<{ readonly name: string; readonly color: string | undefined }>
  readonly milestoneName: string | undefined
  readonly dueDate: string | undefined
  readonly url: string
  readonly sortOrder: number
  readonly createdAt: string | undefined
  readonly updatedAt: string | undefined
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
    labels: (node.labels?.nodes ?? [])
      .map((label) => ({ name: orUndefined(label.name) ?? '', color: orUndefined(label.color) }))
      .filter((label) => label.name !== ''),
    milestoneName: orUndefined(node.projectMilestone?.name),
    dueDate: orUndefined(node.dueDate),
    url: orUndefined(node.url) ?? LINEAR_WEB,
    sortOrder: node.sortOrder ?? 0,
    createdAt: orUndefined(node.createdAt),
    updatedAt: orUndefined(node.updatedAt)
  }
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
    const issues = (
      companyId: CompanyId
    ): Effect.Effect<ReadonlyArray<LinearIssue>, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          Effect.gen(function* () {
            const collected: Array<LinearIssue> = []
            let after: string | undefined = undefined

            for (let page = 0; page < MAX_ISSUE_PAGES; page++) {
              const payload: typeof IssuesPayload.Type = yield* call(
                apiKey,
                ISSUES_QUERY,
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
        )
      )

    /**
     * D21: file one issue under a project. The caller has already decided that it
     * may — which team, which project, and which Linear person it is assigned to
     * are all resolved from the mirror before this is reached, so nothing an agent
     * typed reaches Linear as an id.
     */
    const createIssue = (
      companyId: CompanyId,
      input: {
        readonly teamId: string
        readonly projectLinearId: string
        readonly title: string
        readonly description: string
        readonly assigneeId: string | undefined
        readonly priority: number | undefined
      }
    ): Effect.Effect<LinearIssue, LinearFailure> =>
      keyFor(companyId).pipe(
        Effect.flatMap((apiKey) =>
          call(
            apiKey,
            CREATE_ISSUE_MUTATION,
            {
              teamId: input.teamId,
              projectId: input.projectLinearId,
              title: input.title,
              description: input.description,
              assigneeId: input.assigneeId ?? null,
              priority: input.priority ?? null
            },
            CreateIssuePayload,
            'create the issue'
          )
        ),
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
      recordSync
    } as const
  }),
  dependencies: [FetchHttpClient.layer]
}) {}
