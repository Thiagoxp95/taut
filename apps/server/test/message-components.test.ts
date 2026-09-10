import { layer } from '@effect/vitest'
import { SqlClient } from '@effect/sql'
import { DateTime, Effect, Schema } from 'effect'
import { SignalRunner } from '../src/agents/signalRunner.js'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect } from 'vitest'
import { TaskTokens } from '../src/agents/tokens.js'
import { Tasks } from '../src/services/tasks.js'
import { baseUrl, makeClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const

const setup = Effect.gen(function* () {
  const suffix = randomUUID().slice(0, 8)
  const owner = yield* makeClient
  yield* owner.api.auth.signup({
    payload: { email: `component-${suffix}@taut.local`, password: 'password123', name: 'Owner' }
  })
  const company = yield* owner.api.companies.create({
    payload: { slug: `components-${suffix}`, name: 'Components', avatar }
  })
  const me = yield* owner.api.auth.me()
  const department = yield* owner.api.departments.create({
    payload: { name: 'Design', slug: 'design', headUserId: me.user.id }
  })
  const invite = yield* owner.api.invites.create({
    payload: { email: `member-${suffix}@taut.local`, role: 'member' }
  })
  const member = yield* makeClient
  const accepted = yield* member.api.invites.accept({
    payload: { token: invite.token, name: 'Member', password: 'password123' }
  })
  yield* owner.api.departments.addMember({
    path: { departmentId: department.id },
    payload: { memberKind: 'user', memberId: accepted.user.id }
  })
  const agent = yield* owner.api.agents.create({
    payload: {
      handle: 'designer',
      name: 'Designer',
      avatar,
      role: 'Design',
      mandate: '# Help with interactive components',
      runtimeKind: 'claude-code',
      permissionMode: 'plan',
      departmentId: department.id
    }
  })
  const dm = yield* member.api.channels.dm({ payload: { memberKind: 'agent', memberId: agent.id } })
  const root = yield* member.api.messages.create({
    payload: { channelId: dm.id, body: 'Help me pick a color and set a timer.' }
  })
  const tasks = yield* Tasks
  const task = yield* tasks.create(company.id, {
    agentId: agent.id,
    channelId: dm.id,
    threadId: root.id,
    messageId: root.id,
    triggerMessageId: root.id,
    triggerUserId: accepted.user.id
  })
  const tokens = yield* TaskTokens
  const token = yield* tokens.mint({ companyId: company.id, agentId: agent.id, taskId: task.id })
  const { http } = yield* baseUrl
  const cookie = yield* member.cookieHeader
  const request = (path: string, body: unknown, auth: Record<string, string> = { cookie }) =>
    Effect.promise(() =>
      fetch(`${http}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    )
  return {
    owner,
    member,
    company,
    department,
    agent,
    root,
    task,
    tokens,
    token,
    http,
    cookie,
    request,
    userId: accepted.user.id
  }
})

describe('interactive agent components', () => {
  layer(testAppWith(dir, makeFakeRuntime().layer), { excludeTestServices: true })((it) => {
    it.effect(
      'persists a question, accepts only its recipient, and returns the answer to the ask',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          const questions = [
            {
              id: 'color',
              question: 'Which color?',
              options: [{ label: 'Blue' }, { label: 'Green' }]
            }
          ]
          // The fixture email's handle is available through the authenticated profile.
          const profile = yield* s.member.api.auth.me()
          const response = yield* s.request(
            '/api/agent-runtime/ask',
            {
              to: `@${profile.user.email.split('@')[0]}`,
              text: 'Pick a color',
              questions
            },
            { authorization: `Bearer ${s.token}` }
          )
          expect(response.status).toBe(200)
          const result = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(
              Schema.decodeUnknown(
                Schema.Struct({ messageId: Schema.String, askId: Schema.optional(Schema.String) })
              )
            )
          )
          const sql = yield* SqlClient.SqlClient
          const rows =
            yield* sql`SELECT component_json FROM messages WHERE id = ${result.messageId}`
          expect(JSON.parse(String(rows[0]?.component_json))).toMatchObject({
            kind: 'questions',
            status: 'pending',
            questions
          })
          const path = `/api/messages/${result.messageId}/component/answer`
          const answers = [{ questionId: 'color', selections: ['Blue'], text: 'Use a soft shade.' }]
          const ownerCookie = yield* s.owner.cookieHeader
          expect((yield* s.request(path, { answers }, { cookie: ownerCookie })).status).toBe(403)
          expect(
            (yield* s.request(path, { answers: [{ questionId: 'color', selections: ['Red'] }] }))
              .status
          ).toBe(422)
          const answered = yield* s.request(path, { answers })
          expect(answered.status).toBe(200)
          expect(yield* Effect.promise(() => answered.json())).toMatchObject({
            component: { status: 'answered', answers, answeredBy: s.userId }
          })
          expect((yield* s.request(path, { answers })).status).toBe(409)
          const status = yield* Effect.promise(() =>
            fetch(`${s.http}/api/agent-runtime/ask/${result.askId}`, {
              headers: { authorization: `Bearer ${s.token}` }
            })
          )
          expect(yield* Effect.promise(() => status.json())).toMatchObject({
            status: 'answered',
            answer: { text: expect.stringContaining('Blue') }
          })
        })
    )
    it.effect(
      'accepts text-only and multi-select answers once, including simultaneous submissions',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          const profile = yield* s.member.api.auth.me()
          const questions = [
            {
              id: 'notes',
              question: 'Direction?',
              options: [{ label: 'Classic' }, { label: 'Modern' }]
            },
            {
              id: 'features',
              question: 'Features?',
              options: [{ label: 'Sound' }, { label: 'Animation' }],
              multiSelect: true
            }
          ]
          const create = (qs: unknown) =>
            s.request(
              '/api/agent-runtime/ask',
              { to: `@${profile.user.email.split('@')[0]}`, text: 'Two questions', questions: qs },
              { authorization: `Bearer ${s.token}` }
            )
          expect((yield* create([questions[0], questions[0]])).status).toBe(422)
          const response = yield* create(questions)
          const result = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ messageId: Schema.String })))
          )
          const path = `/api/messages/${result.messageId}/component/answer`
          expect(
            (yield* s.request(path, {
              answers: [{ questionId: 'notes', selections: [], text: '  ' }]
            })).status
          ).toBe(422)
          const answers = [
            { questionId: 'notes', selections: [], text: 'Something playful' },
            { questionId: 'features', selections: ['Sound', 'Animation'] }
          ]
          const results = yield* Effect.all(
            [s.request(path, { answers }), s.request(path, { answers })],
            { concurrency: 'unbounded' }
          )
          expect(results.map((r) => r.status).sort()).toEqual([200, 409])
          const sql = yield* SqlClient.SqlClient
          const replies =
            yield* sql`SELECT body FROM messages WHERE channel_id = ${s.root.channelId} AND body LIKE '%Something playful%'`
          expect(replies).toHaveLength(1)
        })
    )
    it.effect('creates a timer backed by one durable signal and rejects invalid durations', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const render = (body: unknown) =>
          s.request('/api/agent-runtime/components/render', body, {
            authorization: `Bearer ${s.token}`
          })
        expect(
          (yield* render({
            kind: 'timer',
            title: 'Focus',
            durationSeconds: -1,
            onComplete: 'Report back'
          })).status
        ).toBe(422)
        const response = yield* render({
          kind: 'timer',
          title: 'Focus',
          durationSeconds: 60,
          onComplete: 'Report back'
        })
        expect(response.status).toBe(200)
        const result = yield* Effect.promise(() => response.json()).pipe(
          Effect.flatMap(
            Schema.decodeUnknown(
              Schema.Struct({ messageId: Schema.String, askId: Schema.optional(Schema.String) })
            )
          )
        )
        const sql = yield* SqlClient.SqlClient
        const rows = yield* sql`SELECT component_json FROM messages WHERE id = ${result.messageId}`
        const timer = JSON.parse(String(rows[0]?.component_json))
        expect(timer).toMatchObject({
          kind: 'timer',
          title: 'Focus',
          durationSeconds: 60,
          onComplete: 'Report back'
        })
        const signals = yield* sql`SELECT * FROM signals WHERE id = ${timer.signalId}`
        expect(signals).toHaveLength(1)
        expect(signals[0]).toMatchObject({
          target_agent_id: s.agent.id,
          note: 'Report back',
          status: 'pending'
        })
        expect(new Date(timer.endsAt).getTime()).toBeGreaterThan(Date.now())
        const runner = yield* SignalRunner
        const outcomes = yield* runner.tick(
          DateTime.unsafeMake(new Date(timer.endsAt).getTime() + 1000)
        )
        expect(
          outcomes.find((o) => o._tag !== 'stale' && o.signal.id === timer.signalId)?._tag
        ).toBe('delivered')
        const woken =
          yield* sql`SELECT agent_id, thread_id FROM tasks WHERE signal_id = ${timer.signalId}`
        expect(woken).toHaveLength(1)
        expect(woken[0]).toMatchObject({ agent_id: s.agent.id, thread_id: s.root.id })
        yield* runner.tick(DateTime.unsafeMake(new Date(timer.endsAt).getTime() + 2000))
        expect(yield* sql`SELECT id FROM tasks WHERE signal_id = ${timer.signalId}`).toHaveLength(1)
      })
    )
  })
})
