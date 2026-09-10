import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpClient } from '@effect/platform-node'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Agent, Channel, Company, Department, Task } from '@taut/contract/domain'
import type { AgentId, UserId } from '@taut/contract/ids'
import { Duration, Effect, Option, Redacted } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { flattenThread } from '../../web/src/lib/message-cache.js'
import { Scheduler } from '../src/agents/scheduler.js'
import { TaskTokens } from '../src/agents/tokens.js'
import { Messages } from '../src/services/messages.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const fake = makeFakeRuntime({ waitForRelease: true })
const avatar = { kind: 'emoji', value: 'A' } as const
const SEAT_SECRET = 'sk-ant-api03-steering-seat-000000000000000'

const state: {
  owner?: TestClient
  ownerId?: UserId
  acme?: Company
  engineering?: Department
  channel?: Channel
  clarifier?: Agent
  peer?: Agent
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

describe('agent conversation turns', () => {
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

    it.effect('two agents mentioned together take turns using the latest reply', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const channel = need(state.channel, 'channel')
        const clarifier = need(state.clarifier, 'clarifier')
        const peer = yield* owner.api.agents.create({
          payload: {
            handle: 'peer',
            name: 'Peer',
            avatar,
            role: 'Debates options',
            mandate: 'Discuss A versus B and reach a shared decision.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: need(state.engineering, 'engineering').id
          }
        })
        state.peer = peer
        const question = yield* owner.api.messages.create({
          payload: {
            channelId: channel.id,
            body: '@clarifier @peer wait for release: debate A versus B, agree, then report once.'
          }
        })
        yield* waitFor('both turns queued', taskFor(peer.id, question.id))
        yield* parkedExecs(1)
        yield* Effect.sleep('200 millis')
        expect(fake.execs).toHaveLength(1)
        expect(Option.getOrThrow(yield* taskFor(peer.id, question.id)).status).toBe('queued')
        const acme = need(state.acme, 'acme')
        const tokens = yield* TaskTokens
        const messages = yield* Messages
        const scheduler = yield* Scheduler
        const first = Option.getOrThrow(yield* taskFor(clarifier.id, question.id))
        const firstToken = yield* tokens.mint({
          taskId: first.id,
          agentId: clarifier.id,
          companyId: acme.id
        })
        const proposal = yield* runtimeCall(firstToken, 'POST', '/send', {
          to: '@peer',
          text: 'I propose A because it is simpler. What do you think?'
        })
        expect(proposal.json['posted']).toBe(true)
        yield* waitFor('proposal dispatched', taskFor(peer.id, String(proposal.json['messageId'])))
        // Sending the question is the whole turn: yield the floor without a duplicate bubble.
        const yielded = yield* runtimeCall(firstToken, 'POST', '/done', { summary: '' })
        expect(yielded.status).toBe(200)
        fake.release('I asked peer and am waiting.')
        yield* endedTask(clarifier.id, question.id)
        yield* parkedExecs(2)
        expect(Option.getOrThrow(yield* taskFor(peer.id, question.id)).status).toBe('running')
        expect(fake.execs[1]?.stdin).toContain('I propose A because it is simpler.')
        expect(fake.execs[1]?.stdin).toContain(String(proposal.json['messageId']))
        fake.release('@clarifier B costs less; I prefer B. Does that address your concern?')
        const second = yield* endedTask(peer.id, question.id)
        // A final-answer mention must deliver the next conversational turn too.
        const third = yield* waitFor(
          'clarifier hears the counterproposal',
          taskFor(clarifier.id, second.messageId)
        )
        yield* parkedExecs(3)
        expect(fake.execs[2]?.stdin).toContain('Reply as @clarifier')
        expect(fake.execs[2]?.stdin).toContain('B costs less; I prefer B.')
        fake.release('@peer What about migration effort?')
        const concern = yield* endedTask(clarifier.id, second.messageId)
        yield* waitFor('peer hears the concern', taskFor(peer.id, concern.messageId))
        yield* parkedExecs(4)
        fake.release('@clarifier Migration is a one-time cost; B remains cheaper.')
        const reason = yield* endedTask(peer.id, concern.messageId)
        yield* waitFor('clarifier hears the reason', taskFor(clarifier.id, reason.messageId))
        yield* parkedExecs(5)
        fake.release('@peer Agreed: B. We recommend B because the lower cost matters more here.')
        const agreement = yield* endedTask(clarifier.id, reason.messageId)
        const last = yield* waitFor(
          'peer hears the agreement',
          taskFor(peer.id, agreement.messageId)
        )
        yield* parkedExecs(6)
        const lastToken = yield* tokens.mint({
          taskId: last.id,
          agentId: peer.id,
          companyId: acme.id
        })
        const reacted = yield* runtimeCall(lastToken, 'POST', '/react', {
          messageId: agreement.messageId,
          emoji: '👍'
        })
        expect(reacted.status).toBe(200)
        const done = yield* runtimeCall(lastToken, 'POST', '/done', { summary: '' })
        expect(done.status).toBe(200)
        expect(done.json['withdrew']).toBe(true)
        // Some runtimes narrate after the tool result. Explicit silent completion wins.
        fake.release('Answered with a thumbs up; no second message was needed.')
        yield* endedTask(peer.id, agreement.messageId)
        yield* waitFor(
          'conversation settles',
          scheduler.runningTaskIds.pipe(Effect.map(Option.liftPredicate((ids) => ids.length === 0)))
        )
        expect(fake.execs).toHaveLength(6)
        expect(Option.getOrThrow(yield* taskFor(clarifier.id, question.id)).status).toBe('done')
        expect(Option.getOrThrow(yield* taskFor(peer.id, agreement.messageId)).status).toBe('done')
        const thread = yield* messages.recent(acme.id, channel.id, question.id, 20)
        expect(thread.filter((m) => m.authorKind === 'agent').map((m) => m.body)).toEqual([
          '@peer I propose A because it is simpler. What do you think?',
          '@clarifier B costs less; I prefer B. Does that address your concern?',
          '@peer What about migration effort?',
          '@clarifier Migration is a one-time cost; B remains cheaper.',
          '@peer Agreed: B. We recommend B because the lower cost matters more here.'
        ])
        expect(thread.find((m) => m.id === agreement.messageId)?.reactions).toEqual([
          { emoji: '👍', count: 1, members: [{ kind: 'agent', id: peer.id }] }
        ])
        // Realtime cache order still contains the early placeholder position, even
        // after message.updated replaces it with the completed counterproposal.
        const proposalMessage = need(
          thread.find((m) => m.id === proposal.json['messageId']),
          'proposal'
        )
        const counterproposal = need(
          thread.find((m) => m.id === second.messageId),
          'counterproposal'
        )
        expect(
          flattenThread({
            pages: [{ items: [counterproposal, proposalMessage] }],
            pageParams: [undefined]
          }).map((m) => m.body)
        ).toEqual([
          '@peer I propose A because it is simpler. What do you think?',
          '@clarifier B costs less; I prefer B. Does that address your concern?'
        ])
        expect(third.status).not.toBe('failed')
      })
    )
    it.effect(
      'asking a teammate in this thread parks immediately and yields without a waiting message',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const channel = need(state.channel, 'channel')
          const clarifier = need(state.clarifier, 'clarifier')
          const peer = need(state.peer, 'peer')
          const tokens = yield* TaskTokens
          const messages = yield* Messages
          const scheduler = yield* Scheduler
          const baseline = fake.execs.length
          const question = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: '@clarifier ask peer about cost.' }
          })
          const first = yield* waitFor('asker starts', taskFor(clarifier.id, question.id))
          yield* parkedExecs(baseline + 1)
          const token = yield* tokens.mint({
            taskId: first.id,
            agentId: clarifier.id,
            companyId: acme.id
          })
          const asked = yield* runtimeCall(token, 'POST', '/ask', {
            to: '@peer',
            text: 'Which option costs less?'
          })
          expect(asked.status).toBe(200)
          expect(asked.json['parked']).toBe(true)
          const answerTask = yield* waitFor(
            'answer queued',
            taskFor(peer.id, String(asked.json['messageId']))
          )
          expect(answerTask.status).toBe('queued')
          fake.release('I asked peer; waiting for their response.')
          yield* parkedExecs(baseline + 2)
          expect(Option.isNone(yield* messages.byId(acme.id, first.messageId))).toBe(true)
          fake.release('B costs less.')
          const answer = yield* endedTask(peer.id, String(asked.json['messageId']))
          const resumed = yield* waitFor(
            'asker resumes without an explicit mention',
            taskFor(clarifier.id, answer.messageId)
          )
          yield* parkedExecs(baseline + 3)
          const resumedToken = yield* tokens.mint({
            taskId: resumed.id,
            agentId: clarifier.id,
            companyId: acme.id
          })
          yield* runtimeCall(resumedToken, 'POST', '/react', {
            messageId: answer.messageId,
            emoji: '👍'
          })
          yield* runtimeCall(resumedToken, 'POST', '/done', { summary: '' })
          fake.release('')
          yield* waitFor(
            'ask settles',
            scheduler.runningTaskIds.pipe(
              Effect.map(Option.liftPredicate((ids) => ids.length === 0))
            )
          )
        })
    )

    it.effect('cancelling a queued turn cannot let its successor overtake the active speaker', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const channel = need(state.channel, 'channel')
        const clarifier = need(state.clarifier, 'clarifier')
        const peer = need(state.peer, 'peer')
        const scheduler = yield* Scheduler
        const baseline = fake.execs.length
        const root = yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: '@clarifier @peer take turns' }
        })
        yield* parkedExecs(baseline + 1)
        const queued = yield* waitFor('peer queued', taskFor(peer.id, root.id))
        const followup = yield* owner.api.messages.create({
          payload: {
            channelId: channel.id,
            threadId: root.id,
            body: '@clarifier follow up after the current turn'
          }
        })
        yield* waitFor('successor queued', taskFor(clarifier.id, followup.id))
        yield* owner.api.tasks.cancel({ path: { taskId: queued.id } })
        yield* Effect.sleep('150 millis')
        expect(fake.execs).toHaveLength(baseline + 1)
        fake.release('First contribution.')
        yield* parkedExecs(baseline + 2)
        expect(fake.execs[baseline + 1]?.stdin).toContain('First contribution.')
        fake.release('Following up.')
        yield* waitFor(
          'queue settles',
          scheduler.runningTaskIds.pipe(Effect.map(Option.liftPredicate((ids) => ids.length === 0)))
        )
        expect(Option.getOrThrow(yield* taskFor(peer.id, root.id)).status).toBe('cancelled')
      })
    )

    it.effect('other threads run concurrently and cancellation releases the occupied thread', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const acme = need(state.acme, 'acme')
        const channel = need(state.channel, 'channel')
        const clarifier = need(state.clarifier, 'clarifier')
        const peer = need(state.peer, 'peer')
        const scheduler = yield* Scheduler
        const baseline = fake.execs.length
        const firstRoot = yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: '@clarifier @peer first discussion' }
        })
        const first = yield* waitFor('first task', taskFor(clarifier.id, firstRoot.id))
        const queued = yield* waitFor('queued peer', taskFor(peer.id, firstRoot.id))
        yield* parkedExecs(baseline + 1)
        const otherRoot = yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: '@clarifier unrelated discussion' }
        })
        const other = yield* waitFor('other task', taskFor(clarifier.id, otherRoot.id))
        yield* parkedExecs(baseline + 2)
        expect(Option.getOrThrow(yield* taskFor(peer.id, firstRoot.id)).status).toBe('queued')
        yield* owner.api.tasks.cancel({ path: { taskId: first.id } })
        yield* parkedExecs(baseline + 3)
        expect(fake.execs[baseline]?.interrupted).toBe(true)
        expect(Option.getOrThrow(yield* taskFor(peer.id, firstRoot.id)).status).toBe('running')
        yield* owner.api.tasks.cancel({ path: { taskId: queued.id } })
        yield* owner.api.tasks.cancel({ path: { taskId: other.id } })
        yield* waitFor(
          'cancelled tasks settle',
          scheduler.runningTaskIds.pipe(Effect.map(Option.liftPredicate((ids) => ids.length === 0)))
        )
        expect(acme.id).toBe(first.companyId)
      })
    )
  })
})
