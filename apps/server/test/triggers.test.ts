/**
 * Event-fired routines (docs/build-plan-triggers.md Part I), end to end against the fake machine
 * provider. Every case drives `TriggerRunner.handle(companyId, event)` with a synthetic `Event`
 * rather than waiting on the bus: the daemon consumes the same function, and calling it directly
 * is what makes a fire deterministic instead of a race with the 30-second clock.
 *
 * The `call.ended` cases insert the `calls` row by hand. That is the point of the D5 seam — the
 * event carries only `{ callId, channelId, endedAt }`, so the runner has to load the call to
 * answer `minSeconds` at all, and a test that never wrote a call row would pass while the
 * feature failed closed in production.
 */
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Agent, Company, Department, Message, Task } from '@taut/contract/domain'
import type { CallId, ChannelId, RoutineId, UserId } from '@taut/contract/ids'
import { EventSeq } from '@taut/contract/ids'
import type { Event } from '@taut/contract/events'
import { DateTime, Duration, Effect, Option, Redacted, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { TriggerRunner } from '../src/agents/triggerRunner.js'
import { Messages } from '../src/services/messages.js'
import { Tasks } from '../src/services/tasks.js'
import { makeClient, type TestClient } from './_client.js'
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
  design?: ChannelId
  ops?: ChannelId
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

const taskWith = (taskId: Task['id'], statuses: ReadonlyArray<Task['status']>) =>
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

/** The message that triggered a task: what the trigger posted. */
const triggerOf = (task: Task): Effect.Effect<Message, never, Tasks | Messages> =>
  Effect.gen(function* () {
    const tasks = yield* Tasks
    const messages = yield* Messages
    const acme = need(state.acme, 'acme')
    const internal = yield* tasks.internal(acme.id, task.id).pipe(Effect.orDie)
    const id = need(internal.triggerMessageId, 'trigger message id')
    return yield* messages.byId(acme.id, id).pipe(Effect.map(Option.getOrThrow))
  })

const handle = (event: Event) =>
  TriggerRunner.pipe(Effect.flatMap((r) => r.handle(event.companyId, event)))

/** The tasks a routine has produced so far, newest first. */
const tasksOf = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const owner = need(state.owner, 'owner')
    const page = yield* owner.api.tasks.list({ urlParams: {} })
    return page.items.filter((task) => task.routineId === routineId)
  })

const seqCounter = { n: 1000 }
const eventOf = <T extends Event['type']>(
  type: T,
  payload: Extract<Event, { type: T }>['payload']
): Event =>
  ({
    seq: EventSeq.make((seqCounter.n += 1)),
    companyId: need(state.acme, 'acme').id,
    at: DateTime.unsafeNow(),
    type,
    payload
  }) as Event

/**
 * A closed huddle in `channelId` that ran for `seconds`, inserted straight into the table:
 * `Calls.join` needs LiveKit configured, and what the runner reads back is only this row.
 */
const closedCall = (channelId: ChannelId, seconds: number) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const acme = need(state.acme, 'acme')
    const id = `cal_${Math.random().toString(16).slice(2, 10)}` as CallId
    const endedAt = DateTime.unsafeNow()
    const startedAt = DateTime.subtract(endedAt, { seconds })
    yield* sql`
      INSERT INTO calls (id, company_id, channel_id, room, started_by_kind, started_by_id,
                         started_at, ended_at, summary_message_id)
      VALUES (${id}, ${acme.id}, ${channelId}, ${'room-' + id}, 'user',
              ${need(state.ownerId, 'owner id')}, ${DateTime.formatIso(startedAt)},
              ${DateTime.formatIso(endedAt)}, NULL)`
    yield* sql`
      INSERT INTO call_participants (call_id, member_kind, member_id, joined_at, left_at, sharing)
      VALUES (${id}, 'user', ${need(state.ownerId, 'owner id')},
              ${DateTime.formatIso(startedAt)}, ${DateTime.formatIso(endedAt)}, 0)`
    return { callId: id, channelId, endedAt }
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

const CountRow = Schema.Tuple(Schema.Struct({ n: Schema.Number }))

describe('triggers (event-fired routines)', () => {
  layer(testAppWith(dir, fake.layer), { excludeTestServices: true })((it) => {
    it.effect('setup: owner, engineering, @vera and @nova, #design and #ops', () =>
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
        const design = yield* owner.api.channels.create({
          payload: { name: 'design', departmentId: engineering.id }
        })
        const ops = yield* owner.api.channels.create({
          payload: { name: 'ops', departmentId: engineering.id }
        })
        Object.assign(state, {
          owner,
          ownerId: me.user.id,
          acme,
          engineering,
          vera,
          nova,
          design: design.id,
          ops: ops.id
        })
      })
    )

    it.effect(
      'a call.ended trigger fires the same fire the clock does: @handle + the D5 context block, and no next run (D9)',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const design = need(state.design, 'design')
          const routine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'Huddle recap',
              prompt: 'reply with exactly: pong',
              trigger: {
                _tag: 'event',
                event: { _tag: 'call.ended', channelIds: [design], minSeconds: 60 }
              },
              enabled: true
            }
          })
          // D9: an event trigger has no slot at all, so the 30-second tick never sees it.
          expect(routine.nextRunAt).toBeUndefined()
          expect(routine.trigger._tag).toBe('event')

          const payload = yield* closedCall(design, 25 * 60)
          const outcomes = yield* handle(eventOf('call.ended', payload))
          expect(outcomes.map((o) => o._tag)).toEqual(['fired'])

          const mine = yield* tasksOf(routine.id)
          expect(mine).toHaveLength(1)
          const task = mine[0]!
          expect(task.agentId).toBe(vera.id)
          const trigger = yield* triggerOf(task)
          expect(trigger.authorKind).toBe('user')
          expect(trigger.body.startsWith('@vera reply with exactly: pong')).toBe(true)
          expect(trigger.body).toContain('Context — the huddle in #design just ended.')
          expect(trigger.body).toContain('(25 minutes)')
          expect(trigger.body).toContain('Present: @owner.')

          yield* taskWith(task.id, ['done'])
          yield* owner.api.routines.delete({ path: { routineId: routine.id } })
        })
    )

    it.effect('the wrong channel and a huddle under minSeconds both fire nothing', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const vera = need(state.vera, 'vera')
        const design = need(state.design, 'design')
        const ops = need(state.ops, 'ops')
        const routine = yield* owner.api.routines.create({
          payload: {
            agentId: vera.id,
            name: 'Design huddles only',
            prompt: 'reply with exactly: pong',
            trigger: {
              _tag: 'event',
              event: { _tag: 'call.ended', channelIds: [design], minSeconds: 60 }
            },
            enabled: true
          }
        })

        const elsewhere = yield* closedCall(ops, 25 * 60)
        expect(yield* handle(eventOf('call.ended', elsewhere))).toHaveLength(0)

        // 20 seconds is a misclick, not a meeting — and the runner can only know that
        // because it loaded the call and passed `EventFacts` to `matchesEvent` (D5).
        const tooShort = yield* closedCall(design, 20)
        expect(yield* handle(eventOf('call.ended', tooShort))).toHaveLength(0)

        expect(yield* tasksOf(routine.id)).toHaveLength(0)
        yield* owner.api.routines.delete({ path: { routineId: routine.id } })
      })
    )

    it.effect('D6: a message.created trigger never fires on its own agent’s message', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const vera = need(state.vera, 'vera')
        const nova = need(state.nova, 'nova')
        const ops = need(state.ops, 'ops')
        yield* owner.api.channels.addMember({
          path: { channelId: ops },
          payload: { memberKind: 'agent', memberId: vera.id }
        })
        const routine = yield* owner.api.routines.create({
          payload: {
            agentId: vera.id,
            name: 'Watch ops',
            prompt: 'reply with exactly: pong',
            trigger: {
              _tag: 'event',
              event: {
                _tag: 'message.created',
                channelIds: [ops],
                authorKinds: ['user', 'agent'],
                includeThreadReplies: false
              }
            },
            enabled: true
          }
        })

        const messages = yield* Messages
        const acme = need(state.acme, 'acme')
        const own = yield* messages.postAsAgent(acme.id, {
          agentId: vera.id,
          channelId: ops,
          body: 'something I said myself',
          requireMembership: false
        })
        expect(yield* handle(eventOf('message.created', { message: own }))).toEqual([
          {
            _tag: 'skipped',
            routineId: routine.id,
            reason: 'the actor is the routine’s own agent (D6)'
          }
        ])
        expect(yield* tasksOf(routine.id)).toHaveLength(0)

        // Another agent in the same channel is a perfectly good reason to wake up.
        const theirs = yield* messages.postAsAgent(acme.id, {
          agentId: nova.id,
          channelId: ops,
          body: 'something nova said',
          requireMembership: false
        })
        const outcomes = yield* handle(eventOf('message.created', { message: theirs }))
        expect(outcomes.map((o) => o._tag)).toEqual(['fired'])
        const fired = yield* tasksOf(routine.id)
        expect(fired).toHaveLength(1)
        expect((yield* triggerOf(fired[0]!)).body).toContain('Context — @nova posted in #ops')

        yield* taskWith(fired[0]!.id, ['done'])
        yield* owner.api.routines.delete({ path: { routineId: routine.id } })
      })
    )

    it.effect(
      'D8 then D7: while the first run is live every occurrence is skipped, and past the hourly cap they are dropped',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const design = need(state.design, 'design')
          const routine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'Chatty',
              prompt: 'please hang around',
              trigger: {
                _tag: 'event',
                event: { _tag: 'call.ended', channelIds: [design], minSeconds: 0 }
              },
              enabled: true
            }
          })
          const fire = () =>
            closedCall(design, 90).pipe(
              Effect.flatMap((payload) => handle(eventOf('call.ended', payload)))
            )

          const first = yield* fire()
          expect(first.map((o) => o._tag)).toEqual(['fired'])
          const live = yield* tasksOf(routine.id)
          yield* taskWith(live[0]!.id, ['running'])

          // 19 more occurrences fill the hour's budget; every one is a D8 overlap skip.
          for (let i = 0; i < 19; i += 1) {
            const outcome = yield* fire()
            expect(outcome.map((o) => o._tag)).toEqual(['skipped'])
          }
          // The 21st is the cap itself (D7), and says so.
          const capped = yield* fire()
          expect(capped).toEqual([
            { _tag: 'skipped', routineId: routine.id, reason: 'over the hourly fire cap (D7)' }
          ])
          expect(yield* tasksOf(routine.id)).toHaveLength(1)

          yield* owner.api.tasks.cancel({ path: { taskId: live[0]!.id } })
          yield* taskWith(live[0]!.id, ['cancelled'])
          yield* owner.api.routines.delete({ path: { routineId: routine.id } })
        })
    )

    it.effect('a paused agent’s event routine is skipped, not fired', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const nova = need(state.nova, 'nova')
        const design = need(state.design, 'design')
        const routine = yield* owner.api.routines.create({
          payload: {
            agentId: nova.id,
            name: 'While paused',
            prompt: 'reply with exactly: pong',
            trigger: {
              _tag: 'event',
              event: { _tag: 'call.ended', channelIds: [design], minSeconds: 0 }
            },
            enabled: true
          }
        })
        yield* owner.api.agents.update({
          path: { agentId: nova.id },
          payload: { status: 'paused' }
        })
        const payload = yield* closedCall(design, 300)
        expect((yield* handle(eventOf('call.ended', payload))).map((o) => o._tag)).toEqual([
          'skipped'
        ])
        expect(yield* tasksOf(routine.id)).toHaveLength(0)
        yield* owner.api.agents.update({
          path: { agentId: nova.id },
          payload: { status: 'active' }
        })
        yield* owner.api.routines.delete({ path: { routineId: routine.id } })
      })
    )

    it.effect('D12: "Run now" fires an event trigger with the manual context block', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const vera = need(state.vera, 'vera')
        const design = need(state.design, 'design')
        const routine = yield* owner.api.routines.create({
          payload: {
            agentId: vera.id,
            name: 'Manual test',
            prompt: 'reply with exactly: pong',
            trigger: {
              _tag: 'event',
              event: { _tag: 'call.ended', channelIds: [design], minSeconds: 60 }
            },
            // Still disabled: testing a notifier must not require arming it first.
            enabled: false
          }
        })
        const task = yield* owner.api.routines.run({ path: { routineId: routine.id } })
        expect(task.routineId).toBe(routine.id)
        const trigger = yield* triggerOf(task)
        expect(trigger.body).toContain('Context — this was a manual test run; no event fired it.')
        expect(trigger.body).not.toContain('huddle')
        yield* taskWith(task.id, ['done'])
        yield* owner.api.routines.delete({ path: { routineId: routine.id } })
      })
    )

    it.effect('the kind filter splits the one list into schedules and triggers (D14)', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const vera = need(state.vera, 'vera')
        const design = need(state.design, 'design')
        const clock = yield* owner.api.routines.create({
          payload: {
            agentId: vera.id,
            name: 'Standup',
            prompt: 'reply with exactly: pong',
            trigger: {
              _tag: 'schedule',
              schedule: { _tag: 'interval', everyMinutes: 1440 },
              timezone: 'UTC'
            },
            enabled: true
          }
        })
        const bus = yield* owner.api.routines.create({
          payload: {
            agentId: vera.id,
            name: 'On huddle',
            prompt: 'reply with exactly: pong',
            trigger: {
              _tag: 'event',
              event: { _tag: 'call.started', channelIds: [design] }
            },
            enabled: true
          }
        })
        const schedules = yield* owner.api.routines.list({ urlParams: { kind: 'schedule' } })
        expect(schedules.items.map((r) => r.id)).toEqual([clock.id])
        const events = yield* owner.api.routines.list({ urlParams: { kind: 'event' } })
        expect(events.items.map((r) => r.id)).toEqual([bus.id])
        expect((yield* owner.api.routines.list({ urlParams: {} })).items).toHaveLength(2)

        // The denormalised columns are what makes that one indexed lookup (D9).
        const sql = yield* SqlClient.SqlClient
        const rows =
          yield* sql`SELECT COUNT(*) AS n FROM routines WHERE trigger_event = 'call.started'`.pipe(
            Effect.flatMap(Schema.decodeUnknown(CountRow))
          )
        expect(rows[0].n).toBe(1)

        yield* owner.api.routines.delete({ path: { routineId: clock.id } })
        yield* owner.api.routines.delete({ path: { routineId: bus.id } })
      })
    )
  })
})
