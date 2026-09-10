/**
 * Issues as a Linear client (docs/build-plan-issues.md), the properties that are
 * load-bearing rather than merely nice:
 *
 * 1. every write is write-through and re-read — the row is the issue Linear
 *    answered with, never the one the browser hoped for (D2);
 * 2. a mutation Linear refuses leaves the mirror exactly as it was (D2);
 * 3. member+ edits and creates, admin+ deletes (D4);
 * 4. an empty patch never reaches Linear (D2, and the contract's own words);
 * 5. a ticket resolves by `pis_…` id or by identifier, inside the actor's company
 *    and nowhere else (D15).
 *
 * `test/issue-thread.test.ts` covers the conversation half (D8–D12); this file
 * never opens a thread.
 */
import { HttpClient, HttpClientResponse } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { CurrentUserShape } from '@taut/contract/api'
import { CompanyId, UserId } from '@taut/contract/ids'
import { Effect, Layer } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Bus } from '../src/realtime/bus.js'
import { EventLog } from '../src/realtime/eventLog.js'
import { Attachments } from '../src/services/attachments.js'
import { Channels } from '../src/services/channels.js'
import { Linear } from '../src/services/linear.js'
import { Messages } from '../src/services/messages.js'
import { Projects } from '../src/services/projects.js'
import { EventPublisher } from '../src/services/publisher.js'
import { Reactions } from '../src/services/reactions.js'
import { Users } from '../src/services/users.js'
import { makeTempDir, removeDir, testDb } from './_harness.js'

const avatar = { kind: 'emoji', value: 'A' } as const

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const COMPANY = CompanyId.make('cmp_issues-test')
const OTHER = CompanyId.make('cmp_someone-else')
const OWNER = UserId.make('usr_owner')
const TEDY = UserId.make('usr_tedy')

const admin: CurrentUserShape = { userId: OWNER, activeCompanyId: COMPANY, role: 'owner' }
const member: CurrentUserShape = { userId: TEDY, activeCompanyId: COMPANY, role: 'member' }

/**
 * A Linear that answers per GraphQL operation. Unlike the projects test's single
 * slot this one is a table, because one issue write touches three documents in a
 * row (`TautIssue`, `TautUpdateIssue`, `TautIssueOptions`) and a shared slot
 * would make each test a story about the order they happen in.
 */
interface Script {
  answers: Record<string, unknown>
  status: number
  calls: number
  /** The last request body, so a test can assert what actually went to Linear. */
  sent: string
}

const OPERATIONS = [
  'TautViewer',
  'TautProjects',
  'TautUsers',
  'TautIssues',
  'TautCreateIssue',
  'TautUpdateIssue',
  'TautDeleteIssue',
  'TautIssueHistory',
  'TautIssueOptions',
  'TautCreateComment',
  'TautIssue'
] as const

const stubLinear = (script: Script) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) => {
      script.calls += 1
      const sent =
        request.body._tag === 'Uint8Array' ? new TextDecoder().decode(request.body.body) : ''
      script.sent = sent
      // `TautIssue` is a prefix of `TautIssueHistory`, so the longest match wins.
      const name = [...OPERATIONS]
        .sort((a, b) => b.length - a.length)
        .find((operation) => sent.includes(operation))
      const answer = name === undefined ? {} : (script.answers[name] ?? {})
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

const projectsData = (nodes: ReadonlyArray<Record<string, unknown>>) => ({
  data: { projects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }
})

const issuesData = (nodes: ReadonlyArray<Record<string, unknown>>) => ({
  data: { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes } }
})

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

const SHAPING = { id: 'ws_shaping', name: 'Shaping', type: 'started', color: null, position: 1 }
const DONE = { id: 'ws_done', name: 'Done', type: 'completed', color: null, position: 8 }

const issue = (
  id: string,
  identifier: string,
  title: string,
  extra: Record<string, unknown> = {}
) => ({
  id,
  identifier,
  title,
  description: null,
  url: `https://linear.app/acme/issue/${identifier}`,
  priority: 0,
  priorityLabel: 'No priority',
  sortOrder: 1,
  dueDate: null,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: null,
  completedAt: null,
  canceledAt: null,
  state: SHAPING,
  assignee: null,
  creator: { id: 'lu_tedy', name: 'Tedy', avatarUrl: null },
  projectMilestone: null,
  labels: { nodes: [] },
  team: { id: 'team_eng', key: 'ENG' },
  parent: null,
  children: { nodes: [] },
  estimate: null,
  project: { id: 'lin_1' },
  ...extra
})

const dir = makeTempDir()

describe('issues: Taut is a Linear client (D1, D2, D4, D15)', () => {
  const script: Script = { answers: { TautViewer: viewerData }, status: 200, calls: 0, sent: '' }

  /**
   * `Projects` needs no more than it ever did; `Messages` and the tier under it
   * are here because `deleteIssue` edits the thread's root message (D5), and a
   * service that can only be tested with half its collaborators is a service
   * whose tests are lying about something.
   */
  const IssuesTestLive = Layer.mergeAll(Projects.Default, Messages.Default).pipe(
    Layer.provideMerge(Layer.mergeAll(Attachments.Default, Reactions.Default)),
    Layer.provideMerge(Channels.Default),
    Layer.provideMerge(Users.Default),
    Layer.provideMerge(Linear.DefaultWithoutDependencies),
    Layer.provideMerge(EventPublisher.Default),
    Layer.provideMerge(Layer.mergeAll(EventLog.Default, Bus.Default)),
    Layer.provide(stubLinear(script)),
    Layer.provideMerge(testDb(dir))
  )

  afterAll(() => removeDir(dir))

  layer(IssuesTestLive, { excludeTestServices: true })((it) => {
    it.effect('setup: a connected company with one project and two tickets', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const at = new Date().toISOString()
        yield* sql`
          INSERT INTO companies (id, slug, name, avatar_json, created_at)
          VALUES (${COMPANY}, 'issues-test', 'Issues Test', NULL, ${at})`
        for (const [id, name] of [
          [OWNER, 'Owner'],
          [TEDY, 'Tedy']
        ] as const) {
          yield* sql`
            INSERT INTO users (id, email, name, password_hash, avatar_json, created_at)
            VALUES (${id}, ${`${name.toLowerCase()}@acme.test`}, ${name}, 'x',
                    ${JSON.stringify(avatar)}, ${at})`
          yield* sql`
            INSERT INTO memberships (company_id, user_id, role, created_at)
            VALUES (${COMPANY}, ${id}, ${id === OWNER ? 'owner' : 'member'}, ${at})`
        }

        const projects = yield* Projects
        yield* projects.connect(admin, 'lin_api_secret_abcd')

        script.answers['TautProjects'] = projectsData([project('lin_1', 'Claims AI')])
        script.answers['TautIssues'] = issuesData([
          issue('iss_1', 'ENG-4636', 'Support pre-paid balances'),
          issue('iss_2', 'ENG-4509', 'Product mockups', { sortOrder: 2 })
        ])
        yield* projects.sync(admin)
      })
    )

    it.effect('a ticket resolves by identifier, case and all (D15)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const detail = yield* projects.issue(admin, 'eng-4636')
        expect(detail.issue.title).toBe('Support pre-paid balances')
        expect(detail.project.name).toBe('Claims AI')
        // The whole ticket came off the mirror, so this read touched no network.
        expect(detail.issue.team).toEqual({ id: 'team_eng', key: 'ENG' })

        // And by its own id, which is what the page's links carry.
        const byId = yield* projects.issue(admin, detail.issue.id)
        expect(byId.issue.identifier).toBe('ENG-4636')
      })
    )

    it.effect("another company's identifier is a 404, not a ticket (D15)", () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const missing = yield* Effect.either(projects.issueForAgent(OTHER, 'ENG-4636'))
        expect(missing._tag).toBe('Left')
        if (missing._tag === 'Left') expect(missing.left._tag).toBe('NotFound')
      })
    )

    it.effect('an empty patch is a Validation and never reaches Linear (D2)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const before = script.calls
        const refused = yield* Effect.either(projects.updateIssue(admin, 'ENG-4636', {}))
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') expect(refused.left._tag).toBe('Validation')
        expect(script.calls).toBe(before)
      })
    )

    it.effect("an edit is written through and the row is Linear's answer (D2)", () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        // Linear answers with a *different* title from the one asked for: the row
        // has to follow Linear, not the request.
        script.answers['TautUpdateIssue'] = {
          data: {
            issueUpdate: {
              success: true,
              issue: issue('iss_1', 'ENG-4636', 'What Linear says it is now', { state: DONE })
            }
          }
        }
        const updated = yield* projects.updateIssue(member, 'ENG-4636', {
          title: 'What the browser asked for'
        })
        expect(updated.title).toBe('What Linear says it is now')
        expect(updated.state.name).toBe('Done')

        // The row, not just the answer: a reload must show the same thing.
        const reread = yield* projects.issue(admin, 'ENG-4636')
        expect(reread.issue.title).toBe('What Linear says it is now')
        expect(reread.issue.state.type).toBe('completed')
        // The id the page's URL is stayed the same across the write.
        expect(reread.issue.id).toBe(updated.id)
      })
    )

    it.effect('the mutation carries what was asked and nothing else (D2)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.answers['TautUpdateIssue'] = {
          data: {
            issueUpdate: {
              success: true,
              issue: issue('iss_1', 'ENG-4636', 'What Linear says it is now', { state: DONE })
            }
          }
        }
        yield* projects.updateIssue(admin, 'ENG-4636', { priority: 2, assigneeId: null })
        const sent = JSON.parse(script.sent) as { variables: { input: Record<string, unknown> } }
        // `null` clears; a field nobody mentioned is not in the input at all.
        expect(sent.variables.input).toEqual({ priority: 2, assigneeId: null })
      })
    )

    it.effect('a refused edit leaves the row exactly as it was (D2)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.answers['TautUpdateIssue'] = { errors: [{ message: 'Not permitted' }] }

        const refused = yield* Effect.either(
          projects.updateIssue(admin, 'ENG-4636', { title: 'Never happens' })
        )
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') {
          expect(refused.left._tag).toBe('Validation')
          expect(JSON.stringify(refused.left)).toContain('Not permitted')
        }

        const reread = yield* projects.issue(admin, 'ENG-4636')
        expect(reread.issue.title).toBe('What Linear says it is now')
      })
    )

    it.effect("a new ticket is filed under the project's team (D1)", () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const projectId = need((yield* projects.list(admin))[0], 'project').id
        script.answers['TautCreateIssue'] = {
          data: {
            issueCreate: {
              success: true,
              issue: issue('iss_new', 'ENG-4700', 'Filed from the page')
            }
          }
        }

        const filed = yield* projects.fileIssue(member, projectId, {
          title: 'Filed from the page',
          description: 'the body'
        })
        expect(filed.identifier).toBe('ENG-4700')

        // The team is the mirror's, never the caller's — nothing here was passed in.
        const sent = JSON.parse(script.sent) as { variables: { input: Record<string, unknown> } }
        expect(sent.variables.input['teamId']).toBe('team_eng')
        expect(sent.variables.input['projectId']).toBe('lin_1')

        // It is in the mirror straight away, without waiting for a sync.
        const identifiers = (yield* projects.issues(admin, projectId)).map((i) => i.identifier)
        expect(identifiers).toContain('ENG-4700')
      })
    )

    it.effect('a member may not delete a ticket, and Linear is never asked (D4)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const before = script.calls
        const refused = yield* Effect.either(projects.deleteIssue(member, 'ENG-4700'))
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') expect(refused.left._tag).toBe('Forbidden')
        expect(script.calls).toBe(before)
        expect((yield* projects.issue(admin, 'ENG-4700')).issue.identifier).toBe('ENG-4700')
      })
    )

    it.effect('an admin deletes, and the row goes with it (D4, D5)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.answers['TautDeleteIssue'] = { data: { issueDelete: { success: true } } }

        yield* projects.deleteIssue(admin, 'ENG-4700')
        const gone = yield* Effect.either(projects.issue(admin, 'ENG-4700'))
        expect(gone._tag).toBe('Left')
        if (gone._tag === 'Left') expect(gone.left._tag).toBe('NotFound')
        // The tickets that were not deleted are still there.
        expect((yield* projects.issue(admin, 'ENG-4636')).issue.identifier).toBe('ENG-4636')
      })
    )

    it.effect('a delete Linear refuses leaves the ticket standing (D2, D5)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.answers['TautDeleteIssue'] = { errors: [{ message: 'Not permitted' }] }

        const refused = yield* Effect.either(projects.deleteIssue(admin, 'ENG-4509'))
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') expect(refused.left._tag).toBe('Validation')
        expect((yield* projects.issue(admin, 'ENG-4509')).issue.identifier).toBe('ENG-4509')
      })
    )

    it.effect('the pick-lists come from the team, live (D14)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const projectId = need((yield* projects.list(admin))[0], 'project').id
        script.answers['TautIssueOptions'] = {
          data: {
            team: {
              states: { nodes: [SHAPING, DONE] },
              labels: { nodes: [{ id: 'lbl_1', name: 'Chore', color: '#8a8f98' }] },
              members: { nodes: [{ id: 'lu_tedy', name: 'Tedy', avatarUrl: null }] }
            },
            project: { projectMilestones: { nodes: [{ id: 'ms_1', name: 'Alpha' }] } },
            projects: { nodes: [{ id: 'lin_1', name: 'Claims AI' }] }
          }
        }

        const options = yield* projects.issueOptions(admin, projectId)
        expect(options.states.map((state) => state.name)).toEqual(['Shaping', 'Done'])
        expect(need(options.states[1], 'done').type).toBe('completed')
        expect(options.labels.map((label) => label.name)).toEqual(['Chore'])
        expect(options.milestones).toEqual([{ id: 'ms_1', name: 'Alpha' }])
      })
    )
  })
})
