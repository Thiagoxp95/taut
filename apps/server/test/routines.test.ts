/**
 * Routines (docs/build-plan-routines.md), end to end against the fake machine provider. The
 * daemon's clock is not waited on: every case calls `RoutineRunner.tick(now)` with a stubbed
 * `now`, which is the only time the tick reads. Routines are created at the real clock, so
 * their first slot is minutes ahead of the background 30-second tick and it never interferes.
 */
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Agent, Company, Department, Routine, Task } from '@taut/contract/domain'
import { TimeOfDay } from '@taut/contract/domain'
import type { RoutineId, TaskId, UserId } from '@taut/contract/ids'
import { DateTime, Duration, Effect, Option, Redacted, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { RoutineRunner } from '../src/agents/routineRunner.js'
import { Channels } from '../src/services/channels.js'
import { Messages } from '../src/services/messages.js'
import { Tasks } from '../src/services/tasks.js'
import { makeClient, type TestClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const fake = makeFakeRuntime()
const avatar = { kind: 'emoji', value: 'A' } as const

/** The stubbed clock's origin: real "now" when the file loads. */
const T0 = DateTime.unsafeNow()
const at = (minutes: number) => DateTime.add(T0, { minutes })
const dayAt = (days: number, hours: number) =>
  DateTime.setPartsUtc(DateTime.add(T0, { days }), { hours, minutes: 0, seconds: 0, millis: 0 })
const ms = (d: DateTime.Utc | undefined) =>
  d === undefined ? undefined : DateTime.toEpochMillis(d)
const every = (minutes: number) => ({ _tag: 'interval', everyMinutes: minutes }) as const
const t = (time: string) => TimeOfDay.make(time)

const Count = Schema.Tuple(Schema.Struct({ n: Schema.Number }))

const state: {
  owner?: TestClient
  dana?: TestClient
  ownerId?: UserId
  acme?: Company
  engineering?: Department
  vera?: Agent
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

const tick = (now: DateTime.Utc) => RoutineRunner.pipe(Effect.flatMap((r) => r.tick(now)))

const fired = (outcomes: ReadonlyArray<{ _tag: string; task?: Task }>) =>
  outcomes.flatMap((o) => (o._tag === 'fired' && o.task !== undefined ? [o.task] : []))

const reload = (routineId: RoutineId) =>
  Effect.gen(function* () {
    const owner = need(state.owner, 'owner')
    const vera = need(state.vera, 'vera')
    const page = yield* owner.api.routines.list({ urlParams: { agentId: vera.id } })
    return need(
      page.items.find((r) => r.id === routineId),
      `routine ${routineId}`
    )
  })

/** The message that triggered a task: what the routine posted. */
const triggerOf = (task: Task) =>
  Effect.gen(function* () {
    const tasks = yield* Tasks
    const messages = yield* Messages
    const acme = need(state.acme, 'acme')
    const internal = yield* tasks.internal(acme.id, task.id)
    const id = need(internal.triggerMessageId, 'trigger message id')
    return yield* messages.byId(acme.id, id).pipe(Effect.map(Option.getOrThrow))
  })

const disable = (routine: Routine) =>
  need(state.owner, 'owner').api.routines.update({
    path: { routineId: routine.id },
    payload: { enabled: false }
  })

const agentPayload = (handle: string, departmentId: Department['id']) => ({
  handle,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  avatar,
  role: 'x',
  mandate: '# Mandate\n\nAnswer briefly.',
  runtimeKind: 'claude-code' as const,
  permissionMode: 'plan' as const,
  departmentId
})

describe('routines (scheduled agent prompts)', () => {
  layer(testAppWith(dir, fake.layer), { excludeTestServices: true })((it) => {
    it.effect('setup: owner, dana (member), engineering (head owner), a seat, @vera', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const me = yield* owner.api.auth.me()
        const invite = yield* owner.api.invites.create({
          payload: { email: 'dana@taut.local', role: 'member' }
        })
        const dana = yield* makeClient
        yield* dana.api.invites.accept({
          payload: { token: invite.token, name: 'Dana', password: 'password123' }
        })
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
        Object.assign(state, { owner, dana, ownerId: me.user.id, acme, engineering, vera })
      })
    )

    it.effect(
      'create: first slot is one step after now; any member can list; the event is logged',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const vera = need(state.vera, 'vera')
          const routine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'Ping',
              prompt: 'reply with exactly: pong',
              trigger: { _tag: 'schedule', schedule: every(5), timezone: 'UTC' },
              enabled: true
            }
          })
          expect(routine.enabled).toBe(true)
          expect(routine.ownerUserId).toBe(need(state.ownerId, 'owner id'))
          expect(routine.channelId).toBeUndefined()
          expect(routine.lastStatus).toBeUndefined()
          expect(ms(routine.nextRunAt)).toBe(DateTime.toEpochMillis(routine.createdAt) + 5 * 60_000)

          const seen = yield* dana.api.routines.list({ urlParams: { agentId: vera.id } })
          expect(seen.items.map((r) => r.id)).toEqual([routine.id])

          const sql = yield* SqlClient.SqlClient
          const events =
            yield* sql`SELECT COUNT(*) AS n FROM events WHERE type = 'routine.created'`.pipe(
              Effect.flatMap(Schema.decodeUnknown(Count))
            )
          expect(events[0].n).toBe(1)
          yield* disable(routine)
        })
    )

    it.effect(
      'a member who is not the head of the agent’s department gets Forbidden on every write',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const vera = need(state.vera, 'vera')
          const mine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'Owner only',
              prompt: 'reply with exactly: pong',
              trigger: { _tag: 'schedule', schedule: every(60), timezone: 'UTC' },
              enabled: false
            }
          })
          const tag = <A, E extends { _tag: string }>(e: Effect.Effect<A, E>) =>
            e.pipe(
              Effect.either,
              Effect.map((r) => (r._tag === 'Left' ? r.left._tag : 'Right'))
            )

          expect(
            yield* tag(
              dana.api.routines.create({
                payload: {
                  agentId: vera.id,
                  name: 'Nope',
                  prompt: 'x',
                  trigger: { _tag: 'schedule', schedule: every(60), timezone: 'UTC' },
                  enabled: true
                }
              })
            )
          ).toBe('Forbidden')
          expect(
            yield* tag(
              dana.api.routines.update({ path: { routineId: mine.id }, payload: { name: 'Nope' } })
            )
          ).toBe('Forbidden')
          expect(yield* tag(dana.api.routines.run({ path: { routineId: mine.id } }))).toBe(
            'Forbidden'
          )
          expect(yield* tag(dana.api.routines.delete({ path: { routineId: mine.id } }))).toBe(
            'Forbidden'
          )
          yield* owner.api.routines.delete({ path: { routineId: mine.id } })
          expect(yield* tag(owner.api.routines.delete({ path: { routineId: mine.id } }))).toBe(
            'NotFound'
          )
        })
    )

    it.effect(
      'the tick fires a due routine: @handle message as the owner, in a DM opened on first fire (D7), task carries routineId (D9), next slot stays on the anchor grid',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const channels = yield* Channels
          const routine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'Ping DM',
              prompt: 'reply with exactly: pong',
              trigger: { _tag: 'schedule', schedule: every(5), timezone: 'UTC' },
              enabled: true
            }
          })
          const dmsBefore = (yield* owner.api.channels.list({ urlParams: {} })).items.filter(
            (c) => c.kind === 'dm'
          )
          expect(dmsBefore).toHaveLength(0)

          // not due yet: one step is five minutes
          expect(fired(yield* tick(at(1)))).toHaveLength(0)

          const tasks = fired(yield* tick(at(6)))
          expect(tasks).toHaveLength(1)
          const task = tasks[0]!
          expect(task.agentId).toBe(vera.id)
          expect(task.routineId).toBe(routine.id)
          expect(task.channelKind).toBe('dm')

          const dms = (yield* owner.api.channels.list({ urlParams: {} })).items.filter(
            (c) => c.kind === 'dm'
          )
          expect(dms.map((c) => c.id)).toEqual([task.channelId])
          expect(
            yield* channels.isMember(task.channelId, { memberKind: 'agent', memberId: vera.id })
          ).toBe(true)

          const trigger = yield* triggerOf(task)
          expect(trigger.body).toBe('@vera reply with exactly: pong')
          expect(trigger.authorKind).toBe('user')
          expect(trigger.authorId).toBe(need(state.ownerId, 'owner id'))
          expect(trigger.channelId).toBe(task.channelId)

          const after = yield* reload(routine.id)
          expect(after.lastStatus).toBe('fired')
          expect(after.lastTaskId).toBe(task.id)
          expect(ms(after.lastRunAt)).toBe(ms(at(6)))
          // anchored on createdAt: the slot after "6 minutes in" is createdAt + 10, not now + 5
          expect(ms(after.nextRunAt)).toBe(DateTime.toEpochMillis(routine.createdAt) + 10 * 60_000)

          // the same instant again is a no-op: nothing is due
          expect(yield* tick(at(6))).toHaveLength(0)

          const done = yield* taskWith(task.id, ['done'])
          const messages = yield* Messages
          const reply = yield* messages
            .byId(need(state.acme, 'acme').id, done.messageId)
            .pipe(Effect.map(Option.getOrThrow))
          expect(reply.body).toBe('pong')

          const disabled = yield* disable(routine)
          expect(disabled.nextRunAt).toBeUndefined()
        })
    )

    it.effect(
      'D5: a routine missed for three days fires once, and the next slot comes from now',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const routine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'Standup',
              prompt: 'reply with exactly: pong',
              trigger: {
                _tag: 'schedule',
                schedule: {
                  _tag: 'daily',
                  everyNDays: 1,
                  anchorDate: DateTime.formatIso(T0).slice(0, 10),
                  times: [t('09:00')]
                },
                timezone: 'UTC'
              },
              enabled: true
            }
          })
          // "the server was down": the next tick happens three days later, at 10:00
          const outcomes = yield* tick(dayAt(3, 10))
          const mine = fired(outcomes).filter((task) => task.routineId === routine.id)
          expect(mine).toHaveLength(1)

          const after = yield* reload(routine.id)
          expect(ms(after.nextRunAt)).toBe(ms(dayAt(4, 9)))
          expect(after.lastStatus).toBe('fired')

          // nothing is replayed: a second tick a minute later finds nothing for it
          expect(
            fired(yield* tick(DateTime.add(dayAt(3, 10), { minutes: 1 }))).filter(
              (task) => task.routineId === routine.id
            )
          ).toHaveLength(0)
          const all = yield* owner.api.tasks.list({ urlParams: { agentId: vera.id } })
          expect(all.items.filter((task) => task.routineId === routine.id)).toHaveLength(1)

          yield* taskWith(mine[0]!.id, ['done'])
          yield* disable(routine)
        })
    )

    it.effect(
      'D6: while the previous run is live the tick skips (and still advances); after cancel it fires again',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const routine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'Slow',
              prompt: 'please hang around',
              trigger: { _tag: 'schedule', schedule: every(5), timezone: 'UTC' },
              enabled: true
            }
          })
          const first = fired(yield* tick(at(20)))
          expect(first).toHaveLength(1)
          yield* taskWith(first[0]!.id, ['running'])

          const second = yield* tick(at(26))
          expect(second.map((o) => o._tag)).toEqual(['skipped'])
          const skipped = yield* reload(routine.id)
          expect(skipped.lastStatus).toBe('skipped')
          expect(skipped.lastTaskId).toBe(first[0]!.id)
          expect(ms(skipped.lastRunAt)).toBe(ms(at(26)))
          // advanced past the skipped slot
          expect(ms(skipped.nextRunAt)).toBe(
            DateTime.toEpochMillis(routine.createdAt) + 30 * 60_000
          )

          yield* owner.api.tasks.cancel({ path: { taskId: first[0]!.id } })
          yield* taskWith(first[0]!.id, ['cancelled'])

          const third = fired(yield* tick(at(35)))
          expect(third).toHaveLength(1)
          expect(third[0]!.id).not.toBe(first[0]!.id)
          expect((yield* reload(routine.id)).lastTaskId).toBe(third[0]!.id)

          yield* owner.api.tasks.cancel({ path: { taskId: third[0]!.id } })
          yield* taskWith(third[0]!.id, ['cancelled'])
          yield* disable(routine)
        })
    )

    it.effect(
      'D11: a paused agent’s routine is skipped and advances; unpausing does not fire a burst',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const routine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'While paused',
              prompt: 'reply with exactly: pong',
              trigger: { _tag: 'schedule', schedule: every(5), timezone: 'UTC' },
              enabled: true
            }
          })
          yield* owner.api.agents.update({
            path: { agentId: vera.id },
            payload: { status: 'paused' }
          })

          const outcomes = yield* tick(at(45))
          expect(outcomes.map((o) => o._tag)).toEqual(['skipped'])
          const skipped = yield* reload(routine.id)
          expect(skipped.lastStatus).toBe('skipped')
          expect(skipped.lastTaskId).toBeUndefined()
          const next = need(skipped.nextRunAt, 'next run')
          expect(DateTime.greaterThan(next, at(45))).toBe(true)

          yield* owner.api.agents.update({
            path: { agentId: vera.id },
            payload: { status: 'active' }
          })
          // the slot that was skipped is gone: the same instant fires nothing
          expect(yield* tick(at(45))).toHaveLength(0)
          expect(
            (yield* owner.api.tasks.list({ urlParams: { agentId: vera.id } })).items.filter(
              (task) => task.routineId === routine.id
            )
          ).toHaveLength(0)

          const resumed = fired(yield* tick(DateTime.add(next, { seconds: 1 })))
          expect(resumed.map((task) => task.routineId)).toEqual([routine.id])
          yield* taskWith(resumed[0]!.id, ['done'])
          yield* disable(routine)
        })
    )

    it.effect(
      'runNow fires regardless of the schedule and returns the task; Conflict while that run is live',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const routine = yield* owner.api.routines.create({
            payload: {
              agentId: vera.id,
              name: 'Manual',
              prompt: 'wait for release please',
              trigger: { _tag: 'schedule', schedule: every(1440), timezone: 'UTC' },
              enabled: false
            }
          })
          const task = yield* owner.api.routines.run({ path: { routineId: routine.id } })
          expect(task.routineId).toBe(routine.id)
          expect(task.agentId).toBe(vera.id)
          expect((yield* triggerOf(task)).body).toBe('@vera wait for release please')
          const after = yield* reload(routine.id)
          expect(after.lastStatus).toBe('fired')
          expect(after.lastTaskId).toBe(task.id)
          // still disabled: no slot
          expect(after.nextRunAt).toBeUndefined()

          yield* taskWith(task.id, ['running'])
          const again = yield* owner.api.routines
            .run({ path: { routineId: routine.id } })
            .pipe(Effect.either)
          expect(again._tag).toBe('Left')
          if (again._tag === 'Left') expect(again.left._tag).toBe('Conflict')

          // `running` is stamped before the process is spawned; release only once it is waiting
          yield* waitFor(
            'the runtime to be waiting for release',
            Effect.sync(() =>
              Option.fromNullable(
                fake.execs.find((e) => e.stdin?.includes('wait for release') && !e.finished)
              )
            )
          )
          fake.release('released')
          const done = yield* taskWith(task.id, ['done'])
          const messages = yield* Messages
          const reply = yield* messages
            .byId(need(state.acme, 'acme').id, done.messageId)
            .pipe(Effect.map(Option.getOrThrow))
          expect(reply.body).toBe('released')
        })
    )

    it.effect('a routine whose agent was archived is skipped and does not wedge the tick', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const vera = need(state.vera, 'vera')
        const engineering = need(state.engineering, 'engineering')
        const temp = yield* owner.api.agents.create({
          payload: agentPayload('temp', engineering.id)
        })
        const doomed = yield* owner.api.routines.create({
          payload: {
            agentId: temp.id,
            name: 'Doomed',
            prompt: 'reply with exactly: pong',
            trigger: { _tag: 'schedule', schedule: every(5), timezone: 'UTC' },
            enabled: true
          }
        })
        const survivor = yield* owner.api.routines.create({
          payload: {
            agentId: vera.id,
            name: 'Survivor',
            prompt: 'reply with exactly: pong',
            trigger: { _tag: 'schedule', schedule: every(5), timezone: 'UTC' },
            enabled: true
          }
        })
        // `agents.delete` archives: the routine survives with the agent, and stops firing.
        yield* owner.api.agents.delete({ path: { agentId: temp.id } })
        expect(
          (yield* owner.api.routines.list({ urlParams: { agentId: temp.id } })).items.map(
            (routine) => routine.id
          )
        ).toEqual([doomed.id])

        const tasks = fired(yield* tick(at(70)))
        expect(tasks.map((task) => task.routineId)).toEqual([survivor.id])
        expect(tasks.map((task) => task.routineId)).not.toContain(doomed.id)
        yield* taskWith(tasks[0]!.id, ['done'])
        yield* disable(survivor)
      })
    )

    it.effect(
      'a chosen channel must contain the agent (Validation); a run there lands in that channel',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const engineering = need(state.engineering, 'engineering')
          const general = yield* owner.api.channels.create({
            payload: { name: 'general', departmentId: engineering.id }
          })
          const payload = {
            agentId: vera.id,
            name: 'Team ping',
            prompt: 'reply with exactly: pong',
            channelId: general.id,
            trigger: { _tag: 'schedule', schedule: every(60), timezone: 'UTC' },
            enabled: false
          } as const
          const rejected = yield* owner.api.routines.create({ payload }).pipe(Effect.either)
          expect(rejected._tag).toBe('Left')
          if (rejected._tag === 'Left') expect(rejected.left._tag).toBe('Validation')

          yield* owner.api.channels.addMember({
            path: { channelId: general.id },
            payload: { memberKind: 'agent', memberId: vera.id }
          })
          const routine = yield* owner.api.routines.create({ payload })
          expect(routine.channelId).toBe(general.id)

          const task = yield* owner.api.routines.run({ path: { routineId: routine.id } })
          expect(task.channelId).toBe(general.id)
          expect(task.channelKind).toBe('channel')
          expect((yield* triggerOf(task)).channelId).toBe(general.id)
          yield* taskWith(task.id, ['done'])

          // `null` clears the target back to the DM; a duplicate weekday is a semantic 422
          const cleared = yield* owner.api.routines.update({
            path: { routineId: routine.id },
            payload: { channelId: null }
          })
          expect(cleared.channelId).toBeUndefined()
          const badSchedule = yield* owner.api.routines
            .update({
              path: { routineId: routine.id },
              payload: {
                trigger: {
                  _tag: 'schedule',
                  schedule: { _tag: 'weekly', weekdays: [1, 1], times: [t('09:00')] },
                  timezone: 'UTC'
                }
              }
            })
            .pipe(Effect.either)
          expect(badSchedule._tag).toBe('Left')
          if (badSchedule._tag === 'Left') expect(badSchedule.left._tag).toBe('Validation')

          // enabling recomputes the slot from now, disabling clears it
          const enabled = yield* owner.api.routines.update({
            path: { routineId: routine.id },
            payload: { enabled: true }
          })
          expect(DateTime.greaterThan(need(enabled.nextRunAt, 'next'), DateTime.unsafeNow())).toBe(
            true
          )
          yield* owner.api.routines.delete({ path: { routineId: routine.id } })
        })
    )
  })
})
