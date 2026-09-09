/**
 * Signals (docs/build-plan-triggers.md Part II), end to end against the fake machine provider.
 *
 * The case that matters is the watermelon one, and it is the first: a task calls `emit_signal`
 * with a three-minute delay, the task **ends**, the tick at +3 min posts into the *same thread*,
 * and the new task resumes the same `agent_sessions` row. Everything else in this file is a
 * guard rail around that — the budgets (D23, D24, D25) that make ending the turn safe, and the
 * broadcast path, which meets the trigger runner at the bus and nowhere else.
 *
 * The tick is never waited on: every case calls `SignalRunner.tick(now)` with a stubbed `now`,
 * which is the only time it reads. Signals are armed minutes ahead, so the background 5-second
 * daemon never sees them.
 */
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpClient } from '@effect/platform-node'
import type { Agent, Company, Department, Signal, Task } from '@taut/contract/domain'
import { SignalName } from '@taut/contract/domain'
import type { MessageId, SignalId, TaskId, UserId } from '@taut/contract/ids'
import { DateTime, Duration, Effect, Option, Redacted, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { SignalRunner } from '../src/agents/signalRunner.js'
import { Messages } from '../src/services/messages.js'
import { Signals } from '../src/services/signals.js'
import { Tasks } from '../src/services/tasks.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const fake = makeFakeRuntime()
const avatar = { kind: 'emoji', value: 'A' } as const

const state: {
  owner?: TestClient
  ownerId?: UserId
  acme?: Company
  engineering?: Department
  vera?: Agent
  nova?: Agent
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
      yield* Effect.sleep(Duration.millis(25))
    }
  })

const taskWith = (taskId: TaskId, statuses: ReadonlyArray<Task['status']>) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks
    const acme = need(state.acme, 'acme')
    return yield* waitFor(
      `task ${taskId} to be ${statuses.join('|')}`,
      tasks
        .byId(acme.id, taskId)
        .pipe(Effect.option, Effect.map(Option.filter((task) => statuses.includes(task.status))))
    )
  })

/** Raw call to `/api/agent-runtime/*` with the task's own bearer token. */
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

const tokenOf = (taskId: TaskId): string =>
  need(
    fake.mcpConfigs().find((c) => c.taskId === taskId),
    `mcp config for ${taskId}`
  ).token

const tick = (now: DateTime.Utc) => SignalRunner.pipe(Effect.flatMap((r) => r.tick(now)))

/** Ask @vera something in the owner↔agent DM and wait for the run it produces. */
const askVera = (body: string) =>
  Effect.gen(function* () {
    const owner = need(state.owner, 'owner')
    const vera = need(state.vera, 'vera')
    const dm = yield* owner.api.channels.dm({
      payload: { memberKind: 'agent', memberId: vera.id }
    })
    const message = yield* owner.api.messages.create({
      payload: { channelId: dm.id, body }
    })
    const tasks = yield* Tasks
    const acme = need(state.acme, 'acme')
    const task = yield* waitFor(
      `a task for ${message.id}`,
      tasks.byTrigger(acme.id, vera.id, message.id)
    )
    return { dm: dm.id, message, task }
  })

const agentPayload = (handleName: string, departmentId: Department['id']) => ({
  handle: handleName,
  name: handleName[0]!.toUpperCase() + handleName.slice(1),
  avatar,
  role: 'x',
  mandate: '# Mandate\n\nAnswer briefly.',
  runtimeKind: 'claude-code' as const,
  permissionMode: 'plan' as const,
  departmentId
})

const SessionRows = Schema.Array(Schema.Struct({ session_id: Schema.String }))
const CountRow = Schema.Tuple(Schema.Struct({ n: Schema.Number }))

const sessionsOf = (agentId: Agent['id'], threadId: MessageId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    return yield* sql`
      SELECT session_id FROM agent_sessions
      WHERE agent_id = ${agentId} AND thread_id = ${threadId}`.pipe(
      Effect.flatMap(Schema.decodeUnknown(SessionRows))
    )
  })

describe('signals (agent-emitted events)', () => {
  layer(testAppWith(dir, fake.layer), { excludeTestServices: true })((it) => {
    it.effect('setup: owner, engineering, @vera and @nova, one seat', () =>
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
        const seatItem = yield* owner.api.vault.add({
          payload: {
            kind: 'anthropic.api_key',
            label: 'seat',
            secret: Redacted.make('sk-ant-api03-seat-secret-0000000000000000')
          }
        })
        const seat = yield* owner.api.subscriptions.add({
          payload: { runtime: 'claude-code', label: 'Seat', credentialId: seatItem.id }
        })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${seat.id}`
        const vera = yield* owner.api.agents.create({
          payload: agentPayload('vera', engineering.id)
        })
        const nova = yield* owner.api.agents.create({
          payload: agentPayload('nova', engineering.id)
        })
        Object.assign(state, { owner, ownerId: me.user.id, acme, engineering, vera, nova })
      })
    )

    it.effect(
      'the watermelon: a three-minute signal outlives its task, wakes the same thread, and resumes the same session',
      () =>
        Effect.gen(function* () {
          const vera = need(state.vera, 'vera')
          const acme = need(state.acme, 'acme')
          const asked = yield* askVera('reply with exactly: pong — and remind me in 3 minutes')
          const first = yield* taskWith(asked.task.id, ['done'])

          // The agent's one tool call. Its turn is over by the time this returns — nothing is
          // held open, and the process is gone.
          const armed = yield* runtimeCall(tokenOf(first.id), 'POST', '/signals/emit', {
            name: 'remind',
            note: 'tell Ted to buy watermelon',
            deliverIn: '3 minutes'
          })
          expect(armed.status).toBe(200)
          const signal = armed.json['signal'] as {
            signalId: SignalId
            deliverAt: string
            status: string
            threadId?: string
          }
          expect(signal.status).toBe('pending')
          // D20: it is armed against this thread, which is what makes the wake a resume.
          expect(signal.threadId).toBe(first.threadId)
          const deliverAt = Option.getOrThrow(DateTime.make(signal.deliverAt))
          expect(
            DateTime.toEpochMillis(deliverAt) - DateTime.toEpochMillis(first.startedAt)
          ).toBeGreaterThan(2 * 60_000)

          const before = yield* sessionsOf(vera.id, first.threadId)
          expect(before).toHaveLength(1)

          // Nothing is due yet: a minute in, the tick finds nothing.
          expect(yield* tick(DateTime.add(deliverAt, { minutes: -1 }))).toHaveLength(0)

          const outcomes = yield* tick(DateTime.add(deliverAt, { seconds: 1 }))
          expect(outcomes.map((o) => o._tag)).toEqual(['delivered'])

          const tasks = yield* Tasks
          const woken = yield* waitFor(
            'the woken task',
            tasks
              .list(
                { userId: need(state.ownerId, 'owner'), activeCompanyId: acme.id, role: 'owner' },
                { agentId: vera.id }
              )
              .pipe(
                Effect.map((page) =>
                  Option.fromNullable(page.items.find((t) => t.signalId === signal.signalId))
                )
              )
          )
          // D20 + D21: the same thread, and the row says where the turn came from.
          expect(woken.threadId).toBe(first.threadId)
          expect(woken.id).not.toBe(first.id)
          expect(woken.signalId).toBe(signal.signalId)

          const messages = yield* Messages
          const internal = yield* tasks.internal(acme.id, woken.id)
          const trigger = yield* messages
            .byId(acme.id, need(internal.triggerMessageId, 'trigger'))
            .pipe(Effect.map(Option.getOrThrow))
          expect(trigger.body).toBe('@vera tell Ted to buy watermelon')
          expect(trigger.authorKind).toBe('user')
          expect(trigger.authorId).toBe(need(state.ownerId, 'owner'))

          yield* taskWith(woken.id, ['done'])
          // The whole trick: the wake resumed the session this thread already was, rather than
          // starting a cold one. The fake runtime mints a fresh session id per exec, so what
          // proves it is the `--resume <sid>` the run was launched with — and the fact that
          // there is still exactly one `agent_sessions` row for this thread, not two.
          const resumed = fake.execs.filter((e) => e.stdin?.includes('buy watermelon'))
          expect(resumed).toHaveLength(1)
          expect(resumed[0]!.cmd).toContain('--resume')
          expect(resumed[0]!.cmd).toContain(before[0]!.session_id)
          const after = yield* sessionsOf(vera.id, first.threadId)
          expect(after).toHaveLength(1)

          const signals = yield* Signals
          const settled = yield* signals.byId(acme.id, signal.signalId)
          expect(Option.getOrThrow(settled).status).toBe('delivered')
          expect(Option.getOrThrow(settled).deliveredTaskId).toBe(woken.id)
        })
    )

    it.effect('D26: a cancelled signal never goes off, and the tools see their own only', () =>
      Effect.gen(function* () {
        const acme = need(state.acme, 'acme')
        const asked = yield* askVera('reply with exactly: pong (cancel me)')
        const done = yield* taskWith(asked.task.id, ['done'])
        const token = tokenOf(done.id)

        const armed = yield* runtimeCall(token, 'POST', '/signals/emit', {
          name: 'remind',
          note: 'this one is a mistake',
          deliverIn: '10 minutes'
        })
        const signalId = (armed.json['signal'] as { signalId: SignalId }).signalId

        const listed = yield* runtimeCall(token, 'GET', '/signals?status=pending')
        expect(
          (listed.json['signals'] as ReadonlyArray<{ signalId: string }>).map((s) => s.signalId)
        ).toContain(signalId)

        const cancelled = yield* runtimeCall(token, 'POST', '/signals/cancel', { signalId })
        expect(cancelled.status).toBe(200)
        expect(cancelled.json['cancelled']).toBe(true)

        // Ten minutes later there is nothing to deliver.
        expect(yield* tick(DateTime.add(DateTime.unsafeNow(), { minutes: 11 }))).toHaveLength(0)
        const signals = yield* Signals
        const row = yield* signals.byId(acme.id, signalId)
        expect(Option.getOrThrow(row).status).toBe('cancelled')

        // Somebody else's id is a 404, not a cancel.
        const stranger = yield* runtimeCall(token, 'POST', '/signals/cancel', {
          signalId: 'sig_00000000-0000-0000-0000-000000000000'
        })
        expect(stranger.status).toBe(404)
      })
    )

    it.effect(
      'D28 and D22: a bad name and an oversized payload are refused with something the agent can act on',
      () =>
        Effect.gen(function* () {
          const asked = yield* askVera('reply with exactly: pong (validation)')
          const done = yield* taskWith(asked.task.id, ['done'])
          const token = tokenOf(done.id)

          const badName = yield* runtimeCall(token, 'POST', '/signals/emit', {
            name: 'Deploy Finished!',
            note: 'nope'
          })
          expect(badName.status).toBe(422)
          expect((badName.json['error'] as { message: string }).message).toContain('lower-case')

          const huge = yield* runtimeCall(token, 'POST', '/signals/emit', {
            name: 'remind',
            note: 'too much',
            payload: { blob: 'x'.repeat(9000) }
          })
          expect(huge.status).toBe(422)
          expect((huge.json['error'] as { message: string }).message).toContain('8192 bytes')

          const nonsense = yield* runtimeCall(token, 'POST', '/signals/emit', {
            name: 'remind',
            note: 'when?',
            deliverIn: 'a fortnight'
          })
          expect(nonsense.status).toBe(422)
          expect((nonsense.json['error'] as { code: string }).code).toBe('invalid_delay')
        })
    )

    it.effect(
      'D23: eleven immediate hops stop at ten, and the same chain with a two-minute gap never caps',
      () =>
        Effect.gen(function* () {
          const acme = need(state.acme, 'acme')
          const vera = need(state.vera, 'vera')
          const signals = yield* Signals
          const tasks = yield* Tasks
          const sql = yield* SqlClient.SqlClient
          const asked = yield* askVera('reply with exactly: pong (chain)')
          const anchor = yield* taskWith(asked.task.id, ['done'])

          /** The task a wake would have produced: what the next hop is emitted from. */
          const wokenBy = (signalId: SignalId): Effect.Effect<TaskId> =>
            tasks
              .create(acme.id, {
                agentId: vera.id,
                channelId: asked.dm,
                threadId: anchor.threadId,
                messageId: anchor.messageId,
                status: 'done',
                signalId
              })
              .pipe(Effect.map((task) => task.id))

          const hop = (emittedByTaskId: TaskId | undefined): Effect.Effect<Signal, unknown> =>
            signals.emit({
              companyId: acme.id,
              name: 'chain',
              note: 'go again',
              emittedByKind: 'agent',
              emittedById: vera.id,
              emittedByTaskId,
              targetAgentId: vera.id,
              channelId: asked.dm,
              threadId: anchor.threadId,
              // Ten minutes out so the background tick never delivers any of them.
              deliverAt: DateTime.add(DateTime.unsafeNow(), { minutes: 10 })
            })

          let previous = yield* hop(undefined)
          expect(previous.depth).toBe(0)
          for (let i = 1; i <= 10; i += 1) {
            const from = yield* wokenBy(previous.id)
            previous = yield* hop(from)
            expect(previous.depth).toBe(i)
          }
          const eleventh = yield* Effect.either(hop(yield* wokenBy(previous.id)))
          expect(eleventh._tag).toBe('Left')

          // The same hop, but the parent went off two minutes ago: a fresh chain, depth 0.
          // A watcher that re-arms itself every three minutes is a pattern, not a runaway.
          yield* sql`
            UPDATE signals SET deliver_at = ${DateTime.formatIso(
              DateTime.subtract(DateTime.unsafeNow(), { minutes: 2 })
            )} WHERE id = ${previous.id}`
          const slow = yield* hop(yield* wokenBy(previous.id))
          expect(slow.depth).toBe(0)

          // Leave nothing armed for the later cases.
          yield* sql`UPDATE signals SET status = 'cancelled' WHERE name = 'chain'`
        })
    )

    it.effect('D25: past the pending cap an emit is refused with what to do about it', () =>
      Effect.gen(function* () {
        const acme = need(state.acme, 'acme')
        const nova = need(state.nova, 'nova')
        const signals = yield* Signals
        const sql = yield* SqlClient.SqlClient
        const arm = () =>
          signals.emit({
            companyId: acme.id,
            name: 'many',
            note: 'one of many',
            emittedByKind: 'agent',
            emittedById: nova.id,
            deliverAt: DateTime.add(DateTime.unsafeNow(), { hours: 1 })
          })
        for (let i = 0; i < 50; i += 1) yield* arm()
        const refused = yield* Effect.either(arm())
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') {
          expect(refused.left.issues[0]?.message).toContain('cancel one before setting another')
        }
        yield* sql`UPDATE signals SET status = 'cancelled' WHERE name = 'many'`
      })
    )

    it.effect('D24: a thread already at the turn cap cancels the wake and says so', () =>
      Effect.gen(function* () {
        const acme = need(state.acme, 'acme')
        const vera = need(state.vera, 'vera')
        const signals = yield* Signals
        const sql = yield* SqlClient.SqlClient
        const asked = yield* askVera('reply with exactly: pong (turn cap)')
        yield* taskWith(asked.task.id, ['done'])

        // Twenty agent-authored turns in this thread, inserted straight into the table: going
        // through the scheduler would take twenty real runs to prove one rule.
        for (let i = 0; i < 20; i += 1) {
          yield* sql`
            INSERT INTO messages (id, company_id, channel_id, thread_id, author_kind, author_id,
                                  body, status, created_at)
            VALUES (${`msg_cap_${i}`}, ${acme.id}, ${asked.dm}, ${asked.task.threadId},
                    'agent', ${vera.id}, ${'filler ' + i}, 'sent',
                    ${DateTime.formatIso(DateTime.unsafeNow())})`
        }

        const armed = yield* signals.emit({
          companyId: acme.id,
          name: 'remind',
          note: 'this will not fit',
          emittedByKind: 'agent',
          emittedById: vera.id,
          emittedByTaskId: asked.task.id,
          targetAgentId: vera.id,
          channelId: asked.dm,
          threadId: asked.task.threadId,
          deliverAt: DateTime.add(DateTime.unsafeNow(), { minutes: 5 })
        })
        const outcomes = yield* tick(DateTime.add(DateTime.unsafeNow(), { minutes: 6 }))
        expect(outcomes.map((o) => o._tag)).toEqual(['cancelled'])

        const settled = yield* signals.byId(acme.id, armed.id)
        // Cancelled, not dropped: the human has to be able to see why the reminder never came.
        expect(Option.getOrThrow(settled).status).toBe('cancelled')
        const notes =
          yield* sql`SELECT COUNT(*) AS n FROM messages WHERE thread_id = ${asked.task.threadId} AND body LIKE '%turn cap reached%'`.pipe(
            Effect.flatMap(Schema.decodeUnknown(CountRow))
          )
        expect(notes[0].n).toBe(1)
      })
    )

    it.effect(
      'D17: a broadcast wakes a listening agent through the bus, and leaves a non-matching one alone',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const vera = need(state.vera, 'vera')
          const nova = need(state.nova, 'nova')
          const signals = yield* Signals
          const tasks = yield* Tasks

          const listener = yield* owner.api.routines.create({
            payload: {
              agentId: nova.id,
              name: 'On deploy',
              prompt: 'reply with exactly: pong',
              trigger: {
                _tag: 'event',
                event: {
                  _tag: 'signal.emitted',
                  names: [SignalName.make('deploy-finished')],
                  fromAgentIds: []
                }
              },
              enabled: true
            }
          })

          const broadcast = (name: string) =>
            signals.emit({
              companyId: acme.id,
              name,
              note: 'the deploy is done',
              payload: { version: '1.4.2' },
              emittedByKind: 'agent',
              emittedById: vera.id,
              // No target: only a matching `SignalTrigger` wakes (D18).
              deliverAt: DateTime.add(DateTime.unsafeNow(), { minutes: 5 })
            })

          const wrong = yield* broadcast('something-else')
          yield* tick(DateTime.add(DateTime.unsafeNow(), { minutes: 6 }))
          yield* Effect.sleep(Duration.millis(200))
          const afterWrong = yield* owner.api.tasks.list({ urlParams: { agentId: nova.id } })
          expect(afterWrong.items.filter((t) => t.routineId === listener.id)).toHaveLength(0)
          expect(Option.getOrThrow(yield* signals.byId(acme.id, wrong.id)).status).toBe('delivered')

          yield* broadcast('deploy-finished')
          const outcomes = yield* tick(DateTime.add(DateTime.unsafeNow(), { minutes: 6 }))
          expect(outcomes.map((o) => o._tag)).toContain('announced')

          // Delivery of a broadcast *is* the bus event; the trigger runner picks it up from
          // there, which is the only place the two paths meet.
          const woken = yield* waitFor(
            'nova to be woken by the broadcast',
            owner.api.tasks
              .list({ urlParams: { agentId: nova.id } })
              .pipe(
                Effect.map((page) =>
                  Option.fromNullable(page.items.find((t) => t.routineId === listener.id))
                )
              )
          )
          const messages = yield* Messages
          const internal = yield* tasks.internal(acme.id, woken.id)
          const trigger = yield* messages
            .byId(acme.id, need(internal.triggerMessageId, 'trigger'))
            .pipe(Effect.map(Option.getOrThrow))
          expect(trigger.body).toContain('Context — the signal `deploy-finished` was emitted')
          expect(trigger.body).toContain('"version":"1.4.2"')

          yield* taskWith(woken.id, ['done'])
          yield* owner.api.routines.delete({ path: { routineId: listener.id } })
        })
    )

    it.effect('D26: a human can see and kill a pending reminder over HTTP', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const acme = need(state.acme, 'acme')
        const vera = need(state.vera, 'vera')
        const signals = yield* Signals
        const armed = yield* signals.emit({
          companyId: acme.id,
          name: 'remind',
          note: 'the human will kill this',
          emittedByKind: 'agent',
          emittedById: vera.id,
          targetAgentId: vera.id,
          deliverAt: DateTime.add(DateTime.unsafeNow(), { hours: 2 })
        })
        const listed = yield* owner.api.signals.list({
          urlParams: { agentId: vera.id, status: 'pending' }
        })
        expect(listed.items.map((s) => s.id)).toContain(armed.id)

        yield* owner.api.signals.delete({ path: { signalId: armed.id } })
        expect(Option.getOrThrow(yield* signals.byId(acme.id, armed.id)).status).toBe('cancelled')

        const missing = yield* owner.api.signals
          .delete({ path: { signalId: 'sig_00000000-0000-0000-0000-000000000000' as SignalId } })
          .pipe(Effect.either)
        expect(missing._tag).toBe('Left')
        if (missing._tag === 'Left') expect(missing.left._tag).toBe('NotFound')
      })
    )
  })
})
