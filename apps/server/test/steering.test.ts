/**
 * Live steering + agents reacting (docs/build-plan-steering-reactions.md), end to end against
 * the fake machine provider: real scheduler, task runner, agent-runtime API and reactions, with
 * a run parked on "wait for release" standing in for an agent that is mid-turn.
 *
 * The scenario is the one in the owner's screenshot: two members answer the same question at
 * once, the first one lands while the second is still thinking, and the second answers with a
 * reaction instead of repeating them.
 */
import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpClient } from '@effect/platform-node'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Agent, Channel, Company, Department, Task } from '@taut/contract/domain'
import type { AgentId, UserId } from '@taut/contract/ids'
import { Duration, Effect, Option, Redacted, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Scheduler } from '../src/agents/scheduler.js'
import { TaskTokens } from '../src/agents/tokens.js'
import { Messages } from '../src/services/messages.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const fake = makeFakeRuntime()
const avatar = { kind: 'emoji', value: 'A' } as const
const SEAT_SECRET = 'sk-ant-api03-steering-seat-000000000000000'

const state: {
  owner?: TestClient
  ownerId?: UserId
  acme?: Company
  engineering?: Department
  channel?: Channel
  clarifier?: Agent
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const waitFor = <A, E, R>(
  what: string,
  probe: Effect.Effect<Option.Option<A>, E, R>,
  timeoutMs = 10_000
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = yield* probe
      if (Option.isSome(found)) return found.value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      yield* Effect.sleep(Duration.millis(50))
    }
  })

/**
 * Wait until the run has actually reached the runtime — otherwise the test is talking to a
 * task that has not spawned yet, and `fake.release` has nothing parked to release.
 */
const parkedExecs = (n: number) =>
  waitFor(
    `${n} exec(s) to be parked in the runtime`,
    Effect.sync(() => Option.liftPredicate(fake.execs, (e) => e.length >= n))
  )

const taskFor = (agentId: AgentId, triggerId: string) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const acme = need(state.acme, 'acme')
    return yield* scheduler.taskOf(acme.id, agentId, triggerId as Task['messageId'])
  })

const endedTask = (agentId: AgentId, triggerId: string, timeoutMs = 10_000) =>
  waitFor(
    `task of ${triggerId} to end`,
    taskFor(agentId, triggerId).pipe(
      Effect.map(
        Option.filter(
          (t) => t.status === 'done' || t.status === 'failed' || t.status === 'cancelled'
        )
      )
    ),
    timeoutMs
  )

/** Raw call to `/api/agent-runtime/*` with a bearer token. */
const runtimeCall = (token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { http } = yield* baseUrl
    const client = yield* HttpClient.HttpClient
    const url = `${http}/api/agent-runtime${path}`
    const request =
      method === 'GET'
        ? HttpClientRequest.get(url)
        : yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(body ?? {}))
    const response = yield* client.execute(
      request.pipe(HttpClientRequest.setHeader('authorization', `Bearer ${token}`))
    )
    const json = (yield* response.json) as Record<string, unknown>
    return { status: response.status, json }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layer))

const CountRows = Schema.Array(Schema.Struct({ n: Schema.Number }))
const ReactionRows = Schema.Array(
  Schema.Struct({ member_kind: Schema.String, member_id: Schema.String, emoji: Schema.String })
)

/** The steer list on any agent-runtime response, or `[]`. */
const steerOf = (json: Record<string, unknown>): ReadonlyArray<Record<string, unknown>> =>
  Array.isArray(json['steer']) ? (json['steer'] as ReadonlyArray<Record<string, unknown>>) : []

describe('live steering + agents reacting', () => {
  layer(testAppWith(dir, fake.layer), { excludeTestServices: true })((it) => {
    it.effect('setup: company, seat, agent clarifier in #engineering', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const me = yield* owner.api.auth.me()
        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const credential = yield* owner.api.vault.add({
          payload: {
            kind: 'anthropic.api_key',
            label: 'seat',
            secret: Redacted.make(SEAT_SECRET)
          }
        })
        const seat = yield* owner.api.subscriptions.add({
          payload: { runtime: 'claude-code', label: 'Seat', credentialId: credential.id }
        })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${seat.id}`
        const clarifier = yield* owner.api.agents.create({
          payload: {
            handle: 'clarifier',
            name: 'Clarifier',
            avatar,
            role: 'Asks the obvious question',
            mandate: '# Mandate\n\nBe brief.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: engineering.id
          }
        })
        const channels = yield* owner.api.channels.list({ urlParams: {} })
        const channel = need(
          channels.items.find((c) => c.name === 'engineering'),
          '#engineering'
        )
        Object.assign(state, { owner, ownerId: me.user.id, acme, engineering, channel, clarifier })
      })
    )

    it.effect(
      'a message that lands mid-run deflects the reply once, then the agent reacts instead and withdraws its empty message',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const channel = need(state.channel, 'channel')
          const clarifier = need(state.clarifier, 'clarifier')
          const sql = yield* SqlClient.SqlClient
          const tokens = yield* TaskTokens
          const messages = yield* Messages

          // clarifier is invoked and parks mid-turn, exactly like an agent that is thinking.
          const question = yield* owner.api.messages.create({
            payload: {
              channelId: channel.id,
              body: '@clarifier wait for release: which colour did you agree on?'
            }
          })
          const running = yield* waitFor(
            'clarifier task to start',
            taskFor(clarifier.id, question.id)
          )
          const token = yield* tokens.mint({
            taskId: running.id,
            agentId: clarifier.id,
            companyId: acme.id
          })
          yield* parkedExecs(1)

          // Somebody else answers the same question while clarifier is still working.
          const answer = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: 'We agreed: teal.', threadId: question.id }
          })

          // D7: the first attempt to post is refused and hands back what landed.
          const deflected = yield* waitFor(
            'the send to be deflected',
            runtimeCall(token, 'POST', '/send', {
              to: '#engineering',
              text: 'We agreed: teal.'
            }).pipe(Effect.map(Option.liftPredicate((r) => r.json['posted'] === false)))
          )
          expect(deflected.status).toBe(200)
          expect(deflected.json['reason']).toBe('steered')
          const handed = steerOf(deflected.json)
          expect(handed.map((s) => s['messageId'])).toContain(answer.id)
          expect(handed[0]?.['text']).toBe('We agreed: teal.')
          expect(String(deflected.json['hint'])).toContain('taut_react')
          // Nothing was posted.
          const after = yield* messages.recent(acme.id, channel.id, null, 20)
          expect(after.filter((m) => m.authorKind === 'agent' && m.body.includes('teal'))).toEqual(
            []
          )

          // D7: one deflection per run — the same call now goes through. (It is not used here;
          // the point is that an agent that insists is never trapped in a loop.)
          const second = yield* runtimeCall(token, 'POST', '/send', {
            to: '#engineering',
            text: 'On reflection, still teal.',
            threadId: question.id
          })
          expect(second.json['posted']).toBe(true)
          expect(second.json['messageId']).toBeDefined()

          // D1-D3: the agent reacts to the message that beat it to the answer.
          const reacted = yield* runtimeCall(token, 'POST', '/react', {
            messageId: answer.id,
            emoji: '👍'
          })
          expect(reacted.status).toBe(200)
          expect(reacted.json['on']).toBe(true)
          expect(reacted.json['reactions']).toEqual([{ emoji: '👍', count: 1 }])

          // D2: stored as the agent, not as a user.
          const rows =
            yield* sql`SELECT member_kind, member_id, emoji FROM message_reactions WHERE message_id = ${answer.id}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(ReactionRows))
            )
          expect(rows).toEqual([{ member_kind: 'agent', member_id: clarifier.id, emoji: '👍' }])

          // …and the human sees it on the message itself.
          const hydrated = yield* messages
            .byId(acme.id, answer.id)
            .pipe(Effect.map(Option.getOrThrow))
          expect(hydrated.reactions).toEqual([
            { emoji: '👍', count: 1, members: [{ kind: 'agent', id: clarifier.id }] }
          ])

          // D4: the whole answer was a reaction, so `taut_done("")` is accepted…
          const finished = yield* runtimeCall(token, 'POST', '/done', { summary: '' })
          expect(finished.status).toBe(200)
          expect(finished.json['posted']).toBe(true)
          expect(finished.json['withdrew']).toBe(true)

          // …and the empty reply is taken back rather than left in the thread.
          fake.release('')
          const ended = yield* endedTask(clarifier.id, question.id)
          expect(ended.status).toBe('done')
          // The runner closes the reply after the task row is already `done`, so wait on the
          // row itself rather than on the status that races it.
          yield* waitFor(
            'the empty reply to be withdrawn',
            sql`SELECT COUNT(*) AS n FROM messages WHERE id = ${ended.messageId}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(CountRows)),
              Effect.map((rows) => Option.liftPredicate(rows, (r) => need(r[0], 'count').n === 0))
            )
          )
        })
    )

    it.effect(
      'an empty summary without a reaction is refused, and steer rides on every response',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const channel = need(state.channel, 'channel')
          const clarifier = need(state.clarifier, 'clarifier')
          const tokens = yield* TaskTokens

          const question = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: '@clarifier wait for release: anything?' }
          })
          const running = yield* waitFor(
            'clarifier task to start',
            taskFor(clarifier.id, question.id)
          )
          const token = yield* tokens.mint({
            taskId: running.id,
            agentId: clarifier.id,
            companyId: acme.id
          })
          yield* parkedExecs(2)

          // D4: silence is only an answer when something was actually said.
          const refused = yield* runtimeCall(token, 'POST', '/done', { summary: '' })
          expect(refused.status).toBe(422)

          // D6: a message that lands mid-run reaches the agent on the next call it makes,
          // whatever that call was for — here the one deflection is spent on `/done` above's
          // sibling, so this is the plain injection path.
          const landed = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: 'one more thing', threadId: question.id }
          })
          const inbox = yield* waitFor(
            'steer to ride on the inbox response',
            runtimeCall(token, 'GET', '/inbox').pipe(
              Effect.map(Option.liftPredicate((r) => steerOf(r.json).length > 0))
            )
          )
          expect(steerOf(inbox.json).map((s) => s['messageId'])).toContain(landed.id)
          // Draining is real: the next call does not repeat it.
          const again = yield* runtimeCall(token, 'GET', '/inbox')
          expect(steerOf(again.json)).toEqual([])

          fake.release('done here')
          const ended = yield* endedTask(clarifier.id, question.id)
          expect(ended.status).toBe('done')
        })
    )

    it.effect('an agent is never steered by its own message', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const acme = need(state.acme, 'acme')
        const channel = need(state.channel, 'channel')
        const clarifier = need(state.clarifier, 'clarifier')
        const tokens = yield* TaskTokens

        const question = yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: '@clarifier wait for release: say something' }
        })
        const running = yield* waitFor(
          'clarifier task to start',
          taskFor(clarifier.id, question.id)
        )
        const token = yield* tokens.mint({
          taskId: running.id,
          agentId: clarifier.id,
          companyId: acme.id
        })
        yield* parkedExecs(3)

        const posted = yield* runtimeCall(token, 'POST', '/send', {
          to: '#engineering',
          text: 'thinking out loud'
        })
        expect(posted.json['posted']).toBe(true)
        // Its own message must not come back at it as news.
        yield* Effect.sleep(Duration.millis(300))
        const next = yield* runtimeCall(token, 'GET', '/inbox')
        expect(steerOf(next.json)).toEqual([])

        fake.release('done')
        yield* endedTask(clarifier.id, question.id)
      })
    )
  })
})
