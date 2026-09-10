/**
 * A ticket's conversation (docs/build-plan-issues.md D8–D12, D21, D22):
 *
 * 1. the first message creates the project's hidden channel and the root message,
 *    exactly once, and a second call replies instead of opening a second thread (D8);
 * 2. the channel is a real channel that the sidebar does not draw (D9), and a
 *    company member who has never posted can still read it and its root (D22);
 * 3. an `@agent` in the first message is joined to the channel on demand (D21);
 * 4. a Linear comment mirrors in as a Taut message only when its author maps to a
 *    Taut human — once, and never twice (D11, D12);
 * 5. a Taut reply is pushed out as a Linear comment, and a push Linear refuses is
 *    dropped rather than failing the message (D11).
 */
import { HttpClient, HttpClientResponse } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { CurrentUserShape } from '@taut/contract/api'
import { AgentId, CompanyId, UserId } from '@taut/contract/ids'
import { DateTime, Effect, Layer, Option } from 'effect'
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

const COMPANY = CompanyId.make('cmp_thread-test')
const OWNER = UserId.make('usr_owner')
const TEDY = UserId.make('usr_tedy')
const MAYA = UserId.make('usr_maya')
const BRUNO = AgentId.make('agt_bruno')

const admin: CurrentUserShape = { userId: OWNER, activeCompanyId: COMPANY, role: 'owner' }
const tedy: CurrentUserShape = { userId: TEDY, activeCompanyId: COMPANY, role: 'member' }
/** Maya never posts on the ticket: she is the D22 reader. */
const maya: CurrentUserShape = { userId: MAYA, activeCompanyId: COMPANY, role: 'member' }

interface Script {
  answers: Record<string, unknown>
  status: number
  calls: number
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

const project = {
  id: 'lin_1',
  name: 'Claims AI',
  description: null,
  state: 'started',
  progress: 0.5,
  icon: null,
  color: null,
  url: 'https://linear.app/acme/project/lin_1',
  startDate: null,
  targetDate: null,
  updatedAt: null,
  lead: null,
  teams: { nodes: [{ id: 'team_eng', key: 'ENG', name: 'Engineering' }] },
  projectMilestones: { nodes: [] }
}

const SHAPING = { id: 'ws_shaping', name: 'Shaping', type: 'started', color: null, position: 1 }

const issueNode = (comments: ReadonlyArray<Record<string, unknown>> = []) => ({
  id: 'iss_1',
  identifier: 'ENG-4636',
  title: 'Support pre-paid balances',
  description: 'The body of the ticket.',
  url: 'https://linear.app/acme/issue/ENG-4636',
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
  comments: { nodes: comments }
})

const comment = (id: string, body: string, user: Record<string, unknown> | null) => ({
  id,
  body,
  url: `https://linear.app/acme/issue/ENG-4636#comment-${id}`,
  createdAt: '2026-09-02T09:00:00.000Z',
  user
})

/** Linear answered the history query with nothing to say; the feed is the ticket's own creation. */
const emptyHistory = { data: { issue: { history: { nodes: [] } } } }

const dir = makeTempDir()

describe("issues: the ticket's own thread (D8–D12, D21, D22)", () => {
  const script: Script = {
    answers: { TautViewer: viewerData, TautIssueHistory: emptyHistory },
    status: 200,
    calls: 0,
    sent: ''
  }

  const ThreadTestLive = Layer.mergeAll(Projects.Default, Messages.Default, Channels.Default).pipe(
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

  /** How many top-level messages the ticket's channel holds — the "exactly once" of D8. */
  const rootCount = (channelId: string) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const rows = yield* sql<{
        n: number
      }>`SELECT COUNT(*) AS n FROM messages WHERE channel_id = ${channelId} AND thread_id IS NULL`
      return need(rows[0], 'count').n
    })

  layer(ThreadTestLive, { excludeTestServices: true })((it) => {
    it.effect('setup: a connected company, one project, one ticket, one agent', () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const at = new Date().toISOString()
        yield* sql`
          INSERT INTO companies (id, slug, name, avatar_json, created_at)
          VALUES (${COMPANY}, 'thread-test', 'Thread Test', NULL, ${at})`
        for (const [id, name] of [
          [OWNER, 'Owner'],
          [TEDY, 'Tedy'],
          [MAYA, 'Maya']
        ] as const) {
          yield* sql`
            INSERT INTO users (id, email, name, password_hash, avatar_json, created_at)
            VALUES (${id}, ${`${name.toLowerCase()}@acme.test`}, ${name}, 'x',
                    ${JSON.stringify(avatar)}, ${at})`
          yield* sql`
            INSERT INTO memberships (company_id, user_id, role, created_at)
            VALUES (${COMPANY}, ${id}, ${id === OWNER ? 'owner' : 'member'}, ${at})`
        }
        yield* sql`
          INSERT INTO agents (id, company_id, handle, name, avatar_json, role, mandate,
                              runtime_kind, permission_mode, status, created_at, updated_at)
          VALUES (${BRUNO}, ${COMPANY}, 'bruno', 'Bruno', ${JSON.stringify(avatar)}, 'engineer',
                  'Review pull requests', 'claude', 'auto-edit', 'active', ${at}, ${at})`

        const projects = yield* Projects
        yield* projects.connect(admin, 'lin_api_secret_abcd')
        script.answers['TautProjects'] = {
          data: {
            projects: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [project] }
          }
        }
        script.answers['TautUsers'] = {
          data: {
            users: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                {
                  id: 'lu_tedy',
                  name: 'Tedy',
                  displayName: 'tedy',
                  email: 'tedy@acme.test',
                  avatarUrl: null,
                  active: true
                },
                {
                  id: 'lu_stranger',
                  name: 'Stranger',
                  displayName: 'stranger',
                  email: 'stranger@elsewhere.test',
                  avatarUrl: null,
                  active: true
                }
              ]
            }
          }
        }
        script.answers['TautIssues'] = {
          data: {
            issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [issueNode()] }
          }
        }
        yield* projects.sync(admin)
        // Tedy is who `lu_tedy` is here (docs/build-plan-projects.md D16).
        yield* projects.linkLinearUser(admin, 'lu_tedy', TEDY)
      })
    )

    it.effect('old Linear comments are visible before a Taut thread exists', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        script.answers['TautIssue'] = {
          data: {
            issue: issueNode([
              comment('cmt_1', 'From Linear, by somebody Taut knows', {
                id: 'lu_tedy',
                name: 'Tedy',
                avatarUrl: null
              })
            ])
          }
        }
        const activity = yield* projects.issueActivity(admin, 'ENG-4636')
        expect(activity.comments.map((c) => c.linearId)).toEqual(['cmt_1'])
        expect(DateTime.formatIso(need(activity.comments[0], 'comment').createdAt)).toBe(
          '2026-09-02T09:00:00.000Z'
        )
      })
    )

    it.effect('the first message makes the channel and the root, once (D8, D9, D21)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const channels = yield* Channels

        const before = yield* projects.issue(admin, 'ENG-4636')
        expect(before.issue.threadId).toBeUndefined()
        expect(before.threadChannelId).toBeUndefined()

        const opened = yield* projects.openIssueThread(
          tedy,
          'ENG-4636',
          '@bruno can you take a look at this one?'
        )
        const threadId = need(opened.threadId, 'threadId')

        const detail = yield* projects.issue(tedy, 'ENG-4636')
        const channelId = need(detail.threadChannelId, 'threadChannelId')
        expect(detail.issue.threadId).toBe(threadId)

        const channel = yield* channels.get(tedy, channelId)
        // A real channel in every way, and hidden from the sidebar in exactly one (D9).
        expect(channel.kind).toBe('channel')
        expect(channel.hidden).toBe(true)
        expect(channel.projectId).toBe(detail.project.id)
        expect(channel.departmentId).toBeUndefined()
        expect(yield* rootCount(channelId)).toBe(1)

        // The poster is a member, and so is the agent they mentioned (D21).
        expect(yield* channels.isMember(channelId, { memberKind: 'user', memberId: TEDY })).toBe(
          true
        )
        expect(yield* channels.isMember(channelId, { memberKind: 'agent', memberId: BRUNO })).toBe(
          true
        )
        // Nobody else was pre-seeded into it.
        expect(yield* channels.isMember(channelId, { memberKind: 'user', memberId: MAYA })).toBe(
          false
        )

        // And it is not in anybody's sidebar, member or admin.
        expect((yield* channels.list(tedy, {})).map((c) => c.id)).not.toContain(channelId)
        expect((yield* channels.list(admin, {})).map((c) => c.id)).not.toContain(channelId)
      })
    )

    it.effect('a second call replies instead of opening a second thread (D8)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const messages = yield* Messages
        const first = yield* projects.issue(admin, 'ENG-4636')
        const channelId = need(first.threadChannelId, 'threadChannelId')
        const threadId = need(first.issue.threadId, 'threadId')

        const again = yield* projects.openIssueThread(admin, 'ENG-4636', 'Second thing said')
        // Same thread, same root, one more reply under it.
        expect(again.threadId).toBe(threadId)
        expect(yield* rootCount(channelId)).toBe(1)
        const replies = yield* messages.thread(admin, threadId, {})
        expect(replies.items.map((m) => m.body)).toEqual(['Second thing said'])
      })
    )

    it.effect('a member who never posted can read the thread and its root (D22)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const messages = yield* Messages
        const channels = yield* Channels
        const detail = yield* projects.issue(maya, 'ENG-4636')
        const channelId = need(detail.threadChannelId, 'threadChannelId')

        // Maya is in no channel here, and can still see the conversation.
        expect(yield* channels.isMember(channelId, { memberKind: 'user', memberId: MAYA })).toBe(
          false
        )
        const channel = yield* channels.get(maya, channelId)
        expect(channel.id).toBe(channelId)
        const top = yield* messages.list(maya, { channelId })
        expect(top.items.map((m) => m.body)).toEqual(['@bruno can you take a look at this one?'])
      })
    )

    it.effect('replying joins you, so the thread can badge for you afterwards (D21)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const messages = yield* Messages
        const channels = yield* Channels
        const detail = yield* projects.issue(maya, 'ENG-4636')
        const channelId = need(detail.threadChannelId, 'threadChannelId')
        const threadId = need(detail.issue.threadId, 'threadId')

        yield* messages.create(maya, { channelId, threadId, body: 'Maya has an opinion' })
        expect(yield* channels.isMember(channelId, { memberKind: 'user', memberId: MAYA })).toBe(
          true
        )
      })
    )

    it.effect('a mapped Linear comment mirrors in once, and an unmapped one never (D11, D12)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const messages = yield* Messages
        const detail = yield* projects.issue(admin, 'ENG-4636')
        const threadId = need(detail.issue.threadId, 'threadId')

        script.answers['TautIssue'] = {
          data: {
            issue: issueNode([
              comment('cmt_1', 'From Linear, by somebody Taut knows', {
                id: 'lu_tedy',
                name: 'Tedy',
                avatarUrl: null
              }),
              comment('cmt_2', 'From a stranger', {
                id: 'lu_stranger',
                name: 'Stranger',
                avatarUrl: null
              })
            ])
          }
        }

        const activity = yield* projects.issueActivity(admin, 'ENG-4636')
        // The stranger's comment stays a Linear comment; picking a Taut author for
        // it would be a lie about who said it.
        expect(activity.comments.map((c) => c.linearId)).toEqual(['cmt_2'])
        expect(need(activity.comments[0], 'stranger').author?.name).toBe('Stranger')
        // Linear writes no history node for the creation, so the feed opens with one.
        expect(activity.history.map((event) => event.kind)).toEqual(['created'])

        const after = yield* messages.thread(admin, threadId, {})
        const mirrored = after.items.filter((m) => m.body === 'From Linear, by somebody Taut knows')
        expect(mirrored.length).toBe(1)
        // Authored by the human the Linear author maps to, and nobody else.
        expect(need(mirrored[0], 'mirrored').authorId).toBe(TEDY)
        expect(DateTime.formatIso(need(mirrored[0], 'mirrored').createdAt)).toBe(
          '2026-09-02T09:00:00.000Z'
        )
        // Import time must not move the old comment after the new conversation.
        const root = Option.getOrThrow(yield* messages.byId(COMPANY, threadId))
        expect(DateTime.toEpochMillis(need(mirrored[0], 'mirrored').createdAt)).toBeLessThan(
          DateTime.toEpochMillis(root.createdAt)
        )
        const sql = yield* SqlClient.SqlClient
        const events = yield* sql<{ payload_json: string }>`SELECT payload_json FROM events
          WHERE company_id = ${COMPANY} AND type = 'message.created'`
        const emitted = events
          .map((event) => JSON.parse(event.payload_json))
          .find((payload) => payload.message.id === need(mirrored[0], 'mirrored').id)
        expect(emitted.message.createdAt).toBe('2026-09-02T09:00:00.000Z')

        // Read it again: the ledger is what stops it being said twice.
        yield* projects.issueActivity(admin, 'ENG-4636')
        const twice = yield* messages.thread(admin, threadId, {})
        expect(
          twice.items.filter((m) => m.body === 'From Linear, by somebody Taut knows').length
        ).toBe(1)
      })
    )

    it.effect(
      'reconciliation repairs an already imported timestamp without duplicating the comment',
      () =>
        Effect.gen(function* () {
          const projects = yield* Projects
          const messages = yield* Messages
          const sql = yield* SqlClient.SqlClient
          const detail = yield* projects.issue(admin, 'ENG-4636')
          const threadId = need(detail.issue.threadId, 'threadId')
          const before = yield* messages.thread(admin, threadId, {})
          const mirrored = need(
            before.items.find((m) => m.body === 'From Linear, by somebody Taut knows'),
            'mirrored'
          )
          yield* sql`UPDATE messages SET created_at = '2026-09-10T05:43:00.000Z' WHERE id = ${mirrored.id}`
          yield* projects.issueActivity(admin, 'ENG-4636')
          const after = yield* messages.thread(admin, threadId, {})
          expect(after.items.length).toBe(before.items.length)
          const restored = need(
            after.items.find((m) => m.id === mirrored.id),
            'restored'
          )
          expect(DateTime.formatIso(restored.createdAt)).toBe('2026-09-02T09:00:00.000Z')
          expect(restored.seq).toBe(mirrored.seq)
          const events = yield* sql<{ payload_json: string }>`SELECT payload_json FROM events
          WHERE company_id = ${COMPANY} AND type = 'message.updated'`
          const emitted = events
            .map((event) => JSON.parse(event.payload_json))
            .find((payload) => payload.message.id === mirrored.id)
          expect(emitted.message.createdAt).toBe('2026-09-02T09:00:00.000Z')
        })
    )

    it.effect('a mirrored comment is not pushed straight back out (D11, D12)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const messages = yield* Messages
        const detail = yield* projects.issue(admin, 'ENG-4636')
        const threadId = need(detail.issue.threadId, 'threadId')
        const mirrored = need(
          (yield* messages.thread(admin, threadId, {})).items.find(
            (m) => m.body === 'From Linear, by somebody Taut knows'
          ),
          'mirrored'
        )

        const before = script.calls
        yield* projects.pushIssueComment(COMPANY, {
          id: mirrored.id,
          threadId,
          authorKind: 'user',
          authorId: TEDY,
          body: mirrored.body
        })
        // The ledger already knows this message: nothing left for Linear.
        expect(script.calls).toBe(before)
      })
    )

    it.effect('a Taut reply goes out as a comment, said by whoever said it (D11)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const messages = yield* Messages
        const detail = yield* projects.issue(admin, 'ENG-4636')
        const channelId = need(detail.threadChannelId, 'threadChannelId')
        const threadId = need(detail.issue.threadId, 'threadId')

        const reply = yield* messages.create(tedy, {
          channelId,
          threadId,
          body: 'On it — the balance call needs a retry'
        })
        script.answers['TautCreateComment'] = {
          data: {
            commentCreate: {
              success: true,
              comment: { id: 'cmt_out', url: null, createdAt: null }
            }
          }
        }

        yield* projects.pushIssueComment(COMPANY, {
          id: reply.id,
          threadId,
          authorKind: 'user',
          authorId: TEDY,
          body: reply.body
        })
        const sent = JSON.parse(script.sent) as { variables: { body: string; issueId: string } }
        expect(sent.variables.issueId).toBe('iss_1')
        // Prefixed, because a personal API key authors every comment as its owner.
        expect(sent.variables.body).toBe('@tedy via Taut — On it — the balance call needs a retry')

        // Linear's copy may have a different timestamp; Taut-authored posts retain theirs.
        script.answers['TautIssue'] = {
          data: {
            issue: issueNode([
              comment('cmt_out', reply.body, {
                id: 'lu_tedy',
                name: 'Tedy',
                avatarUrl: null
              })
            ])
          }
        }
        yield* projects.issueActivity(admin, 'ENG-4636')
        const unchanged = Option.getOrThrow(yield* messages.byId(COMPANY, reply.id))
        expect(DateTime.formatIso(unchanged.createdAt)).toBe(DateTime.formatIso(reply.createdAt))

        // Said once: a second run of the same message is a no-op.
        const before = script.calls
        yield* projects.pushIssueComment(COMPANY, {
          id: reply.id,
          threadId,
          authorKind: 'user',
          authorId: TEDY,
          body: reply.body
        })
        expect(script.calls).toBe(before)
      })
    )

    it.effect('a push Linear refuses is dropped, and the message stands (D11)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const messages = yield* Messages
        const detail = yield* projects.issue(admin, 'ENG-4636')
        const channelId = need(detail.threadChannelId, 'threadChannelId')
        const threadId = need(detail.issue.threadId, 'threadId')

        script.answers['TautCreateComment'] = { errors: [{ message: 'Linear is down' }] }
        const reply = yield* messages.create(tedy, {
          channelId,
          threadId,
          body: 'This one never reaches Linear'
        })

        // The push fails and says nothing: a chat message must not fail because
        // Linear is down.
        yield* projects.pushIssueComment(COMPANY, {
          id: reply.id,
          threadId,
          authorKind: 'user',
          authorId: TEDY,
          body: reply.body
        })
        const still = yield* messages.byId(COMPANY, reply.id)
        expect(Option.isSome(still)).toBe(true)
        // And it is not in the ledger, so a later attempt may still carry it out.
        const bodies = (yield* messages.thread(admin, threadId, {})).items.map((m) => m.body)
        expect(bodies).toContain('This one never reaches Linear')
      })
    )

    it.effect('a deleted ticket keeps its thread, and the root says so (D5)', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        const messages = yield* Messages
        const detail = yield* projects.issue(admin, 'ENG-4636')
        const threadId = need(detail.issue.threadId, 'threadId')
        script.answers['TautDeleteIssue'] = { data: { issueDelete: { success: true } } }

        yield* projects.deleteIssue(admin, 'ENG-4636')

        const gone = yield* Effect.either(projects.issue(admin, 'ENG-4636'))
        expect(gone._tag).toBe('Left')
        const root = yield* messages.byId(COMPANY, threadId)
        expect(Option.isSome(root)).toBe(true)
        if (Option.isSome(root)) {
          // The words somebody actually wrote are still there, with the news added.
          expect(root.value.body).toContain('@bruno can you take a look at this one?')
          expect(root.value.body).toContain('ENG-4636 was deleted in Linear')
        }
      })
    )
  })
})
