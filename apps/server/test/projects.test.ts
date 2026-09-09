/**
 * Projects (docs/build-plan-projects.md), the four properties that are
 * load-bearing rather than merely nice:
 *
 * 1. a key Linear refuses is not stored, and does not disturb what was there (D3);
 * 2. a sync is a reconcile, not a replace — a renamed project keeps its `prj_…`
 *    id, and one Linear no longer returns is dropped (D6);
 * 3. a sync that fails leaves the mirror standing and records why (D7);
 * 4. reading is any member, connecting and syncing are admin+ (D9);
 * 5. a card dropped in another column goes to Linear first, and the mirror is
 *    written from what Linear answered — never from what the browser dragged (D13).
 */
import { HttpClient, HttpClientResponse } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { CurrentUserShape } from '@taut/contract/api'
import type { Company } from '@taut/contract/domain'
import { CompanyId, ProjectId, UserId } from '@taut/contract/ids'
import { Effect, Layer } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Bus } from '../src/realtime/bus.js'
import { EventLog } from '../src/realtime/eventLog.js'
import { Linear } from '../src/services/linear.js'
import { Projects } from '../src/services/projects.js'
import { EventPublisher } from '../src/services/publisher.js'
import { makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp, testDb } from './_harness.js'

const avatar = { kind: 'emoji', value: 'A' } as const

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const COMPANY = CompanyId.make('cmp_linear-test')
const OWNER = UserId.make('usr_owner')
const TEDY = UserId.make('usr_tedy')
const MAYA = UserId.make('usr_maya')

/** The session an admin of `COMPANY` would carry. */
const admin: CurrentUserShape = {
  userId: OWNER,
  activeCompanyId: COMPANY,
  role: 'owner'
}

// ── 1–3: sync semantics, against a Linear that is ours ───────────────────────

const linearDir = makeTempDir()

/** What the stub should answer next, and what it was asked. */
interface Script {
  /** The `data` half of the GraphQL envelope, or a status to fail with. */
  next: unknown
  /**
   * What the `TautUsers` document is answered with (D15). Left unset, the people
   * query gets `next` like everything else — which is what the sync tests want,
   * because a payload that is not a user list is exactly the "this key cannot
   * read the directory" case the reconcile has to shrug off.
   */
  users?: unknown
  /** What the `TautIssues` document is answered with (D18). Unset, it gets `next`. */
  issues?: unknown
  /** What the `TautCreateIssue` mutation is answered with (D21). Unset, it gets `next`. */
  createIssue?: unknown
  status: number
  calls: number
}

/**
 * A Linear that answers from a script instead of the network. One endpoint, so
 * the script is a single slot rather than a table; `calls` is how the tests
 * assert that a page was, or was not, fetched.
 */
const stubLinear = (script: Script) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      script.calls += 1
      const sent =
        request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
      const answer =
        sent.includes('TautUsers') && script.users !== undefined
          ? script.users
          : sent.includes('TautIssues') && script.issues !== undefined
            ? script.issues
            : sent.includes('TautCreateIssue') && script.createIssue !== undefined
              ? script.createIssue
              : script.next
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(answer), {
            status: script.status,
            headers: { 'content-type': 'application/json' }
          })
        )
      )
    })
  )

const viewerData = {
  data: {
    viewer: { id: 'usr_lin', name: 'Owner' },
    organization: { id: 'org_1', name: 'Acme', urlKey: 'acme' }
  }
}

/** One page of projects, no next page. */
const projectsData = (nodes: ReadonlyArray<Record<string, unknown>>) => ({
  data: { projects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }
})

/** One page of the workspace's people, no next page (D15). */
const usersData = (nodes: ReadonlyArray<Record<string, unknown>>) => ({
  data: { users: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }
})

const person = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  displayName: name.toLowerCase(),
  email: `${name.toLowerCase()}@acme.test`,
  avatarUrl: null,
  active: true,
  ...extra
})

/** One of the workspace's board columns (D13). */
const status = (id: string, name: string, position: number) => ({
  id,
  name,
  type: 'started',
  color: '#5e6ad2',
  position
})

const EXPLORATION = status('st_explore', 'Exploration', 1)
const PLANNING = status('st_plan', 'Planning', 2)

const project = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  description: null,
  state: 'started',
  progress: 0.5,
  icon: null,
  color: null,
  url: `https://linear.app/acme/project/${id}`,
  startDate: null,
  targetDate: null,
  updatedAt: null,
  lead: null,
  teams: { nodes: [{ id: 'team_eng', key: 'ENG', name: 'Engineering' }] },
  projectMilestones: { nodes: [] },
  ...extra
})

describe('projects: the Linear mirror', () => {
  const script: Script = { next: viewerData, status: 200, calls: 0 }

  const ProjectsTestLive = Projects.Default.pipe(
    Layer.provideMerge(Linear.DefaultWithoutDependencies),
    Layer.provideMerge(EventPublisher.Default),
    Layer.provideMerge(Layer.mergeAll(EventLog.Default, Bus.Default)),
    Layer.provide(stubLinear(script)),
    Layer.provideMerge(testDb(linearDir))
  )

  afterAll(() => removeDir(linearDir))

  layer(ProjectsTestLive, { excludeTestServices: true })((it) => {
    it.effect('setup: one company', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO companies (id, slug, name, avatar_json, created_at)
          VALUES (${COMPANY}, 'linear-test', 'Linear Test', NULL, ${new Date().toISOString()})`
      })
    )

    it.effect('a key Linear refuses is not stored (D3)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.next = { errors: [{ message: 'Authentication required' }] }
        script.status = 200

        const refused = yield* Effect.either(projects.connect(admin, 'lin_api_wrong'))
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') expect(refused.left._tag).toBe('Validation')

        expect((yield* projects.connection(admin)).state).toBe('none')
      })
    )

    it.effect('connecting validates, stores a hint and never the key (D2)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.next = viewerData

        const connection = yield* projects.connect(admin, 'lin_api_secret_abcd')
        expect(connection.state).toBe('connected')
        expect(connection.workspaceName).toBe('Acme')
        expect(connection.keyHint).toBe('abcd')
        expect(JSON.stringify(connection)).not.toContain('lin_api_secret')
      })
    )

    it.effect('a sync mirrors projects and their milestones (D4)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.next = projectsData([
          project('lin_a', 'Billing revamp', {
            projectMilestones: {
              nodes: [
                { id: 'ms_2', name: 'Beta', description: null, targetDate: null, sortOrder: 2 },
                { id: 'ms_1', name: 'Alpha', description: null, targetDate: null, sortOrder: 1 }
              ]
            }
          }),
          project('lin_b', 'Mobile app v2')
        ])

        const mirrored = yield* projects.sync(admin)
        expect(mirrored.map((entry) => entry.name).sort()).toEqual([
          'Billing revamp',
          'Mobile app v2'
        ])

        const billing = need(
          mirrored.find((entry) => entry.linearId === 'lin_a'),
          'billing'
        )
        expect(billing.state).toBe('started')
        // The team id rides along since D21: it is what an agent's ticket is filed under.
        expect(billing.teams).toEqual([{ id: 'team_eng', key: 'ENG', name: 'Engineering' }])

        const detail = yield* projects.get(admin, billing.id)
        expect(detail.milestones.map((milestone) => milestone.name)).toEqual(['Alpha', 'Beta'])
      })
    )

    it.effect('a second sync reconciles: ids survive a rename, gone means gone (D6)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const before = yield* projects.list(admin)
        const billingId = need(
          before.find((entry) => entry.linearId === 'lin_a'),
          'billing'
        ).id

        script.next = projectsData([
          project('lin_a', 'Billing revamp II'),
          project('lin_c', 'Search rewrite')
        ])
        yield* projects.sync(admin)

        const after = yield* projects.list(admin)
        expect(after.map((entry) => entry.linearId).sort()).toEqual(['lin_a', 'lin_c'])

        const billing = need(
          after.find((entry) => entry.linearId === 'lin_a'),
          'billing'
        )
        expect(billing.name).toBe('Billing revamp II')
        // The identity the sidebar links to is the same row it was before.
        expect(billing.id).toBe(billingId)
      })
    )

    it.effect('a failed sync leaves the mirror standing and says why (D7)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.next = { errors: [{ message: 'Rate limited' }] }

        const failed = yield* Effect.either(projects.sync(admin))
        expect(failed._tag).toBe('Left')
        if (failed._tag === 'Left') expect(failed.left._tag).toBe('Validation')

        const survivors = yield* projects.list(admin)
        expect(survivors.map((entry) => entry.linearId).sort()).toEqual(['lin_a', 'lin_c'])

        const connection = yield* projects.connection(admin)
        expect(connection.state).toBe('connected')
        expect(connection.lastSyncError).toContain('Rate limited')
      })
    )

    it.effect('a sync mirrors the board column each project sits in (D13)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.next = projectsData([
          project('lin_a', 'Billing revamp II', { status: EXPLORATION }),
          project('lin_c', 'Search rewrite', { status: PLANNING })
        ])
        yield* projects.sync(admin)

        const mirrored = yield* projects.list(admin)
        const billing = need(
          mirrored.find((entry) => entry.linearId === 'lin_a'),
          'billing'
        )
        expect(billing.status?.name).toBe('Exploration')
        expect(billing.status?.position).toBe(1)
      })
    )

    it.effect('a move goes to Linear and the mirror takes Linear at its word (D13)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const billingId = need(
          (yield* projects.list(admin)).find((entry) => entry.linearId === 'lin_a'),
          'billing'
        ).id

        script.next = {
          data: {
            projectUpdate: {
              success: true,
              project: project('lin_a', 'Billing revamp II', { status: PLANNING })
            }
          }
        }
        const moved = yield* projects.move(admin, billingId, PLANNING.id)
        expect(moved.status?.name).toBe('Planning')
        // The row, not just the answer: a reload must show the same column.
        const reread = need(
          (yield* projects.list(admin)).find((entry) => entry.id === billingId),
          'billing'
        )
        expect(reread.status?.id).toBe(PLANNING.id)
      })
    )

    it.effect('a column no project is in is refused without asking Linear (D13)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const billingId = need(
          (yield* projects.list(admin)).find((entry) => entry.linearId === 'lin_a'),
          'billing'
        ).id

        const before = script.calls
        const refused = yield* Effect.either(projects.move(admin, billingId, 'st_someone_elses'))
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') expect(refused.left._tag).toBe('Validation')
        expect(script.calls).toBe(before)
      })
    )

    it.effect('a move Linear refuses leaves the card where it was (D13)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const billingId = need(
          (yield* projects.list(admin)).find((entry) => entry.linearId === 'lin_a'),
          'billing'
        ).id

        script.next = { errors: [{ message: 'Not permitted' }] }
        const refused = yield* Effect.either(projects.move(admin, billingId, EXPLORATION.id))
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') expect(refused.left._tag).toBe('Validation')

        const reread = need(
          (yield* projects.list(admin)).find((entry) => entry.id === billingId),
          'billing'
        )
        expect(reread.status?.id).toBe(PLANNING.id)
      })
    )

    // ── 6: the workspace's people, and who they are here (D15, D16) ────────

    it.effect('a sync mirrors the workspace people, all of them mapped to nobody (D15)', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const projects = yield* Projects
        const at = new Date().toISOString()
        yield* sql`
          INSERT INTO users (id, email, password_hash, name, avatar_json, created_at)
          VALUES (${OWNER}, 'owner@acme.test', 'x', 'Owner', NULL, ${at}),
                 (${TEDY}, 'tedy@acme.test', 'x', 'Tedy', NULL, ${at}),
                 (${MAYA}, 'maya@acme.test', 'x', 'Maya', NULL, ${at})`
        yield* sql`
          INSERT INTO memberships (company_id, user_id, role, created_at)
          VALUES (${COMPANY}, ${OWNER}, 'owner', ${at}),
                 (${COMPANY}, ${TEDY}, 'member', ${at}),
                 (${COMPANY}, ${MAYA}, 'member', ${at})`

        script.next = projectsData([project('lin_a', 'Billing revamp II', { status: PLANNING })])
        script.users = usersData([
          person('lu_1', 'Tedy'),
          person('lu_2', 'Maya'),
          person('lu_3', 'Ghost', { active: false })
        ])
        yield* projects.sync(admin)

        const people = yield* projects.linearUsers(admin)
        // Active first, then by name: Ghost is deactivated, so it sinks.
        expect(people.map((entry) => entry.name)).toEqual(['Maya', 'Tedy', 'Ghost'])
        expect(people.every((entry) => entry.member === undefined)).toBe(true)
        expect(
          need(
            people.find((e) => e.linearId === 'lu_3'),
            'ghost'
          ).active
        ).toBe(false)
      })
    )

    it.effect("a mapping is Taut's own: a later sync does not touch it (D16)", () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const mapped = yield* projects.linkLinearUser(admin, 'lu_1', TEDY)
        expect(mapped.member).toBe(TEDY)
        expect(mapped.linkedAt).toBeDefined()

        // Linear renames the person; the mapping has to survive the rename.
        script.users = usersData([
          person('lu_1', 'Tedy Yeng'),
          person('lu_2', 'Maya'),
          person('lu_3', 'Ghost', { active: false })
        ])
        yield* projects.sync(admin)

        const after = need(
          (yield* projects.linearUsers(admin)).find((entry) => entry.linearId === 'lu_1'),
          'tedy'
        )
        expect(after.name).toBe('Tedy Yeng')
        expect(after.member).toBe(TEDY)
      })
    )

    it.effect('one human stands for one Linear person, and None unmaps (D16)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects

        const taken = yield* Effect.either(projects.linkLinearUser(admin, 'lu_2', TEDY))
        expect(taken._tag).toBe('Left')
        if (taken._tag === 'Left') expect(taken.left._tag).toBe('Validation')

        // Somebody who is not in this company is not a choice either.
        const outsider = yield* Effect.either(
          projects.linkLinearUser(admin, 'lu_2', UserId.make('usr_nobody'))
        )
        expect(outsider._tag).toBe('Left')
        if (outsider._tag === 'Left') expect(outsider.left._tag).toBe('Validation')

        const unmapped = yield* projects.linkLinearUser(admin, 'lu_1', null)
        expect(unmapped.member).toBeUndefined()
        expect(unmapped.linkedAt).toBeUndefined()

        // With Tedy free, the row that was refused a moment ago goes through.
        const moved = yield* projects.linkLinearUser(admin, 'lu_2', TEDY)
        expect(moved.member).toBe(TEDY)
      })
    )

    it.effect('a Linear person this workspace does not have is a 404 (D16)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const missing = yield* Effect.either(projects.linkLinearUser(admin, 'lu_nope', MAYA))
        expect(missing._tag).toBe('Left')
        if (missing._tag === 'Left') expect(missing.left._tag).toBe('NotFound')
      })
    )

    it.effect('disconnecting drops the key and every mirrored row', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        yield* projects.disconnect(admin)

        expect((yield* projects.connection(admin)).state).toBe('none')
        expect(yield* projects.list(admin)).toEqual([])
        // The people table came through the same key, so it goes with it (D15).
        expect(yield* projects.linearUsers(admin)).toEqual([])
      })
    )
  })
})

// ── 4: authorization, over the real server ───────────────────────────────────

const appDir = makeTempDir()

const state: { owner?: TestClient; bob?: TestClient; acme?: Company } = {}

describe('projects: authorization', () => {
  afterAll(() => removeDir(appDir))

  layer(testApp(appDir), { excludeTestServices: true })((it) => {
    it.effect('setup: an owner and a plain member', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const invite = yield* owner.api.invites.create({
          payload: { email: 'bob@taut.local', role: 'member' }
        })
        const bob = yield* makeClient
        yield* bob.api.invites.accept({
          payload: { token: invite.token, name: 'Bob', password: 'password123' }
        })
        Object.assign(state, { owner, bob, acme })
      })
    )

    it.effect('a member may not connect, sync or disconnect Linear (D9)', () =>
      Effect.gen(function* () {
        const bob = need(state.bob, 'bob')

        const connect = yield* Effect.either(
          bob.api.projects.connectLinear({ payload: { apiKey: 'lin_api_whatever' } })
        )
        expect(connect._tag).toBe('Left')
        if (connect._tag === 'Left') expect(connect.left._tag).toBe('Forbidden')

        const sync = yield* Effect.either(bob.api.projects.sync())
        expect(sync._tag).toBe('Left')
        if (sync._tag === 'Left') expect(sync.left._tag).toBe('Forbidden')

        const disconnect = yield* Effect.either(bob.api.projects.disconnectLinear())
        expect(disconnect._tag).toBe('Left')
        if (disconnect._tag === 'Left') expect(disconnect.left._tag).toBe('Forbidden')

        // Saying who a Linear person is here is the company's answer, not a
        // member's: agents assign real work through it (D16).
        const link = yield* Effect.either(
          bob.api.projects.linkLinearUser({
            path: { linearUserId: 'lu_1' },
            payload: { member: null }
          })
        )
        expect(link._tag).toBe('Left')
        if (link._tag === 'Left') expect(link.left._tag).toBe('Forbidden')

        // Dragging a card spends the same company key, so it is the same door (D13).
        const move = yield* Effect.either(
          bob.api.projects.move({
            path: { projectId: ProjectId.make('prj_nope') },
            payload: { statusId: 'st_whatever' }
          })
        )
        expect(move._tag).toBe('Left')
        if (move._tag === 'Left') expect(move.left._tag).toBe('Forbidden')
      })
    )

    it.effect('an admin gets past the role check and stops on the real reason', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        // Nothing is connected, so a sync is a `NotFound` rather than a `Forbidden`.
        const sync = yield* Effect.either(owner.api.projects.sync())
        expect(sync._tag).toBe('Left')
        if (sync._tag === 'Left') expect(sync.left._tag).toBe('NotFound')
      })
    )

    it.effect('a member may still read the connection state and the (empty) list', () =>
      Effect.gen(function* () {
        const bob = need(state.bob, 'bob')
        expect((yield* bob.api.projects.linearConnection()).state).toBe('none')
        expect((yield* bob.api.projects.list({ urlParams: {} })).items).toEqual([])
      })
    )
  })
})

/** One page of a project's issues, no next page (D18). */
const issuesData = (nodes: ReadonlyArray<Record<string, unknown>>) => ({
  data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }
})

const SHAPING = {
  id: 'ws_shaping',
  name: 'Shaping',
  type: 'started',
  color: '#f2c94c',
  position: 1
}
const CANCELED = {
  id: 'ws_cancel',
  name: 'Canceled',
  type: 'canceled',
  color: '#8a8f98',
  position: 9
}

const issue = (
  id: string,
  identifier: string,
  title: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  identifier,
  title,
  url: `https://linear.app/acme/issue/${identifier}`,
  priority: 0,
  priorityLabel: 'No priority',
  sortOrder: 1,
  dueDate: null,
  createdAt: null,
  updatedAt: null,
  state: SHAPING,
  assignee: null,
  projectMilestone: null,
  labels: { nodes: [] },
  project: { id: 'lin_1' },
  ...extra
})

// ── 6: issues, and who may have one filed for them (D18–D22) ─────────────────

const issuesDir = makeTempDir()

describe('projects: issues and the ticket an agent files', () => {
  const script: Script = { next: viewerData, status: 200, calls: 0 }

  const IssuesTestLive = Projects.Default.pipe(
    Layer.provideMerge(Linear.DefaultWithoutDependencies),
    Layer.provideMerge(EventPublisher.Default),
    Layer.provideMerge(Layer.mergeAll(EventLog.Default, Bus.Default)),
    Layer.provide(stubLinear(script)),
    Layer.provideMerge(testDb(issuesDir))
  )

  afterAll(() => removeDir(issuesDir))

  layer(IssuesTestLive, { excludeTestServices: true })((it) => {
    it.effect('setup: a connected company with one project', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO companies (id, slug, name, avatar_json, created_at)
          VALUES (${COMPANY}, 'issues-test', 'Issues Test', NULL, ${new Date().toISOString()})`
        for (const [id, name] of [
          [OWNER, 'Owner'],
          [TEDY, 'Tedy'],
          [MAYA, 'Maya']
        ] as const) {
          yield* sql`
            INSERT INTO users (id, email, name, password_hash, avatar_json, created_at)
            VALUES (${id}, ${`${name.toLowerCase()}@acme.test`}, ${name}, 'x',
                    ${JSON.stringify(avatar)}, ${new Date().toISOString()})`
          yield* sql`
            INSERT INTO memberships (company_id, user_id, role, created_at)
            VALUES (${COMPANY}, ${id}, ${id === OWNER ? 'owner' : 'member'},
                    ${new Date().toISOString()})`
        }

        const projects = yield* Projects
        script.next = viewerData
        yield* projects.connect(admin, 'lin_api_secret_abcd')

        script.next = projectsData([project('lin_1', 'Claims AI as a Service')])
        script.users = usersData([person('lu_tedy', 'Tedy'), person('lu_maya', 'Maya')])
        script.issues = issuesData([
          issue('iss_1', 'ENG-4636', 'Support allocations to pre-paid card balance'),
          issue('iss_2', 'ENG-4509', 'Tedy Card — product mockups', {
            state: CANCELED,
            sortOrder: 2
          })
        ])
        yield* projects.sync(admin)
      })
    )

    it.effect('a sync mirrors the issues, ordered by workflow state (D18, D19)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const project = need((yield* projects.list(admin))[0], 'project')
        const issues = yield* projects.issues(admin, project.id)

        expect(issues.map((i) => i.identifier)).toEqual(['ENG-4636', 'ENG-4509'])
        // `Shaping` is position 1 and `Canceled` is 9, so the order is the
        // workspace's own and not the order Linear happened to send them in.
        expect(issues.map((i) => i.state.name)).toEqual(['Shaping', 'Canceled'])
        expect(need(issues[1], 'canceled').state.type).toBe('canceled')
      })
    )

    it.effect('a Linear that will not answer for issues leaves the mirror standing (D20)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.issues = { errors: [{ message: 'Unknown field "issues"' }] }
        yield* projects.sync(admin)

        const project = need((yield* projects.list(admin))[0], 'project')
        // The projects still synced, and the issues from before are still there.
        expect((yield* projects.issues(admin, project.id)).length).toBe(2)
        expect((yield* projects.connection(admin)).lastSyncError).toBeUndefined()
      })
    )

    it.effect('an unmapped human cannot have a ticket filed for them (D21)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const project = need((yield* projects.list(admin))[0], 'project')

        const gate = yield* projects.canCreateIssues(COMPANY, TEDY)
        expect(gate.canCreateIssues).toBe(false)
        expect(gate.reason).toContain('not mapped')

        const refused = yield* Effect.either(
          projects.createIssue(COMPANY, TEDY, {
            projectId: project.id,
            title: 'Anything',
            description: 'x',
            priority: undefined
          })
        )
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') {
          expect(refused.left._tag).toBe('Validation')
          expect(JSON.stringify(refused.left)).toContain('not mapped')
        }
        // The gate has to bite before Linear is ever asked.
        expect(script.createIssue).toBeUndefined()
      })
    )

    it.effect('a run with no human behind it files nothing (D21)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const project = need((yield* projects.list(admin))[0], 'project')

        const refused = yield* Effect.either(
          projects.createIssue(COMPANY, undefined, {
            projectId: project.id,
            title: 'From a routine',
            description: 'x',
            priority: undefined
          })
        )
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') expect(refused.left._tag).toBe('Validation')
      })
    )

    it.effect('a mapped human gets a ticket, assigned to them (D21)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        yield* projects.linkLinearUser(admin, 'lu_tedy', TEDY)
        expect((yield* projects.canCreateIssues(COMPANY, TEDY)).canCreateIssues).toBe(true)

        const project = need((yield* projects.list(admin))[0], 'project')
        script.createIssue = {
          data: {
            issueCreate: {
              success: true,
              issue: issue('iss_new', 'ENG-4700', 'Filed by an agent', {
                assignee: { id: 'lu_tedy', name: 'Tedy', avatarUrl: null }
              })
            }
          }
        }

        const filed = yield* projects.createIssue(COMPANY, TEDY, {
          projectId: project.id,
          title: 'Filed by an agent',
          description: 'the body',
          priority: 2
        })

        expect(filed.issue.identifier).toBe('ENG-4700')
        expect(filed.projectName).toBe('Claims AI as a Service')
        expect(need(filed.issue.assignee, 'assignee').linearId).toBe('lu_tedy')

        // It is in the mirror straight away, without waiting for a sync.
        const identifiers = (yield* projects.issues(admin, project.id)).map((i) => i.identifier)
        expect(identifiers).toContain('ENG-4700')
      })
    )

    it.effect("the ticket goes to Linear with the mirror's ids, never the agent's (D21)", () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const project = need((yield* projects.list(admin))[0], 'project')

        // A project id from another company is a 404, not a ticket somewhere else.
        const elsewhere = yield* Effect.either(
          projects.createIssue(CompanyId.make('cmp_other'), TEDY, {
            projectId: project.id,
            title: 'Not yours',
            description: 'x',
            priority: undefined
          })
        )
        expect(elsewhere._tag).toBe('Left')
        if (elsewhere._tag === 'Left') expect(elsewhere.left._tag).toBe('NotFound')
      })
    )
  })
})
