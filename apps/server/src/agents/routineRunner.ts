/**
 * The routine tick (docs/build-plan-routines.md) and the one `fire` every path goes through
 * (docs/build-plan-triggers.md D2). Every 30 seconds:
 *
 *   `Routines.due(now)` ─▶ per routine, under one lock shared with `runNow` and `TriggerRunner`:
 *     ├─ re-read the row: gone, disabled or no longer due → nothing (another fire got there first)
 *     ├─ agent paused → `skipped` (D11) · previous task still queued/running → `skipped` (D6)
 *     ├─ target = `channelId`, else the owner↔agent DM, opened on first fire (D7)
 *     ├─ `Messages.postAsUser("@handle prompt")` + `Scheduler.postAndDispatch` → the Task,
 *     │  with the routine id on it (D9); every §9 gate of the scheduler still applies
 *     └─ stamp `lastRunAt` / `lastTaskId` / `lastStatus` and the next slot, computed from `now`,
 *        never from the slot that was missed (D5) — and on a skip too, so an unpaused agent
 *        does not get a burst
 *
 * `Effect.repeat` runs ticks back to back, never two at once; a tick that outlives its interval
 * only delays the next. Every routine is isolated: one that blows up is logged and marked
 * `failed`, and the rest of the tick still runs. `tick(now)` is exposed so tests drive the clock
 * instead of waiting on it.
 *
 * `FireMode` is what generalising the fire condition (triggers D1) costs here: the clock arrives
 * as `due` and re-checks the slot, "Run now" arrives as `force` and ignores everything, and the
 * bus arrives as `event` carrying a rendered context block that is appended to the prompt (D5).
 * `fire` itself is exported so `TriggerRunner` calls the *same* function the tick does — the
 * semaphore lives in here precisely so the clock and the bus can never fire one routine twice
 * at once, whatever order they arrive in.
 */
import type { CurrentUserShape } from '@taut/contract/api'
import type { Agent, Routine, Task, TaskStatus } from '@taut/contract/domain'
import { Conflict, type Forbidden, NotFound, type Unauthorized } from '@taut/contract/errors'
import type { ChannelId, CompanyId, RoutineId } from '@taut/contract/ids'
import { DateTime, Duration, Effect, Option, Schedule, Schema } from 'effect'
import { actor } from '../services/access.js'
import { Agents } from '../services/agents.js'
import { Channels } from '../services/channels.js'
import { Messages } from '../services/messages.js'
import { Routines } from '../services/routines.js'
import { Tasks } from '../services/tasks.js'
import { Users } from '../services/users.js'
import { Scheduler } from './scheduler.js'
import { MANUAL_CONTEXT } from './triggerContext.js'

export const TICK_INTERVAL = Duration.seconds(30)

const LIVE: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['queued', 'running'])

/**
 * Why this fire is happening, and what the agent is told about it (triggers D2).
 *  - `due`   — the clock: the slot is re-checked under the lock, so a fire that raced another
 *              one becomes `stale` rather than a duplicate.
 *  - `force` — "Run now": the schedule and `enabled` are both ignored (D12). It carries a
 *              `context` too, because an event routine has no clock to pretend fired and is
 *              usually tested while still disabled — `event` mode would call that stale.
 *  - `event` — the bus: proceed while the routine is still enabled, and append `context`.
 */
export type FireMode =
  | { readonly _tag: 'due' }
  | { readonly _tag: 'force'; readonly context?: string | undefined }
  | { readonly _tag: 'event'; readonly context: string }

export type FireOutcome =
  | { readonly _tag: 'fired'; readonly task: Task }
  | { readonly _tag: 'skipped'; readonly reason: string }
  | { readonly _tag: 'failed'; readonly reason: string }
  /** Deleted, disabled or already fired between `due` and taking the lock. */
  | { readonly _tag: 'stale' }

/** Why a fire could not post; becomes `lastStatus: 'failed'` and a log line, never a crash. */
class FireFailed extends Schema.TaggedError<FireFailed>()('FireFailed', {
  reason: Schema.String
}) {}

export class RoutineRunner extends Effect.Service<RoutineRunner>()('RoutineRunner', {
  scoped: Effect.gen(function* () {
    const routines = yield* Routines
    const agents = yield* Agents
    const channels = yield* Channels
    const messages = yield* Messages
    const tasks = yield* Tasks
    const users = yield* Users
    const scheduler = yield* Scheduler
    /** The tick and `runNow` must not fire the same routine twice; a fire is a few queries. */
    const firing = yield* Effect.makeSemaphore(1)

    /** The previous run, if it is still on the agent's queue (D6). */
    const liveTask = (routine: Routine): Effect.Effect<Option.Option<Task>> =>
      routine.lastTaskId === undefined
        ? Effect.succeedNone
        : tasks
            .byId(routine.companyId, routine.lastTaskId)
            .pipe(Effect.option, Effect.map(Option.filter((t) => LIVE.has(t.status))))

    /** The owner as a session, for `Channels.dm`; `None` once they have left the company. */
    const ownerSession = (routine: Routine): Effect.Effect<Option.Option<CurrentUserShape>> =>
      users.roleIn(routine.companyId, routine.ownerUserId).pipe(
        Effect.map(
          Option.map((role) => ({
            userId: routine.ownerUserId,
            activeCompanyId: routine.companyId,
            role
          }))
        )
      )

    /** D7: the chosen channel (the agent must still sit in it), else the owner↔agent DM. */
    const targetChannel = (routine: Routine, agent: Agent): Effect.Effect<ChannelId, FireFailed> =>
      Effect.gen(function* () {
        if (routine.channelId !== undefined) {
          const member = yield* channels.isMember(routine.channelId, {
            memberKind: 'agent',
            memberId: agent.id
          })
          if (!member) {
            return yield* new FireFailed({
              reason: `@${agent.handle} is no longer a member of ${routine.channelId}`
            })
          }
          return routine.channelId
        }
        const owner = yield* ownerSession(routine)
        if (Option.isNone(owner)) {
          return yield* new FireFailed({ reason: 'the owner is no longer a member of the company' })
        }
        const dm = yield* channels
          .dm(owner.value, { memberKind: 'agent', memberId: agent.id })
          .pipe(Effect.mapError((e) => new FireFailed({ reason: e.message })))
        return dm.id
      })

    const skip = (
      routine: Routine,
      now: DateTime.Utc,
      reason: string
    ): Effect.Effect<FireOutcome> =>
      routines
        .markSkipped(routine.companyId, routine.id, now)
        .pipe(
          Effect.zipLeft(Effect.logInfo(`routines: ${routine.id} skipped — ${reason}`)),
          Effect.as({ _tag: 'skipped', reason })
        )

    const fail = (
      routine: Routine,
      now: DateTime.Utc,
      reason: string
    ): Effect.Effect<FireOutcome> =>
      routines
        .markFailed(routine.companyId, routine.id, now)
        .pipe(
          Effect.zipLeft(Effect.logWarning(`routines: ${routine.id} failed — ${reason}`)),
          Effect.as({ _tag: 'failed', reason })
        )

    /** One routine, holding the lock. What "still worth firing" means depends on the mode. */
    const fireLocked = (
      companyId: CompanyId,
      routineId: RoutineId,
      now: DateTime.Utc,
      mode: FireMode
    ): Effect.Effect<FireOutcome> =>
      Effect.gen(function* () {
        const fresh = yield* routines.byId(companyId, routineId)
        if (Option.isNone(fresh)) return { _tag: 'stale' } as const
        const routine = fresh.value
        // An event routine has no `nextRunAt` at all (D9), so the slot test would refuse every
        // one of them; being still enabled is the whole staleness question for the bus arm.
        const worthFiring =
          mode._tag === 'force'
            ? true
            : mode._tag === 'event'
              ? routine.enabled
              : routine.enabled &&
                routine.nextRunAt !== undefined &&
                DateTime.lessThanOrEqualTo(routine.nextRunAt, now)
        if (!worthFiring) return { _tag: 'stale' } as const

        const agent = yield* agents.byId(companyId, routine.agentId).pipe(Effect.option)
        if (Option.isNone(agent)) return yield* fail(routine, now, 'the agent no longer exists')
        if (agent.value.archivedAt !== undefined) {
          return yield* skip(routine, now, `@${agent.value.handle} is archived`)
        }
        if (agent.value.status !== 'active') {
          return yield* skip(routine, now, `@${agent.value.handle} is paused`)
        }
        const live = yield* liveTask(routine)
        if (Option.isSome(live)) {
          return yield* skip(
            routine,
            now,
            `previous run ${live.value.id} is still ${live.value.status}`
          )
        }

        const outcome: Effect.Effect<FireOutcome, FireFailed> = Effect.gen(function* () {
          const channelId = yield* targetChannel(routine, agent.value)
          // D5: the clock arms say nothing extra; the bus arm appends the rendered context
          // block, because `call.ended` alone would wake the agent with no idea what ended.
          const context = mode._tag === 'due' ? '' : (mode.context ?? '')
          const post = messages
            .postAsUser(companyId, {
              userId: routine.ownerUserId,
              channelId,
              body: `@${agent.value.handle} ${routine.prompt}${context}`
            })
            .pipe(Effect.mapError((e) => new FireFailed({ reason: e.message })))
          const created = yield* scheduler.postAndDispatch(post, {
            mentions: [
              { memberKind: 'agent', memberId: agent.value.id, handle: agent.value.handle }
            ],
            routineId: routine.id
          })
          const task = created.find((t) => t.task.agentId === agent.value.id)?.task
          if (task === undefined) {
            // The mention landed but the scheduler refused it (turn cap, membership …) and
            // already posted the reason in the thread.
            return yield* new FireFailed({ reason: 'the scheduler did not start a task' })
          }
          yield* routines.markFired(companyId, routineId, now, task.id)
          yield* Effect.logInfo(`routines: ${routine.id} fired task ${task.id}`)
          return { _tag: 'fired', task } as const
        })
        return yield* outcome.pipe(Effect.catchAll((e) => fail(routine, now, e.reason)))
      }).pipe(
        // A defect (a query that died, a bug) must not stop the tick — or hide.
        Effect.catchAllCause((cause) =>
          Effect.logError(`routines: ${routineId} crashed`, cause).pipe(
            Effect.zipRight(
              routines
                .markFailed(companyId, routineId, now)
                .pipe(Effect.catchAllCause(() => Effect.void))
            ),
            Effect.as<FireOutcome>({ _tag: 'failed', reason: 'internal error (see the log)' })
          )
        )
      )

    /**
     * The one entry point every fire goes through — the tick, "Run now", and the bus. The
     * semaphore is here and nowhere else, so two arms can never fire one routine at once.
     */
    const fire = (
      companyId: CompanyId,
      routineId: RoutineId,
      now: DateTime.Utc,
      mode: FireMode
    ): Effect.Effect<FireOutcome> =>
      firing.withPermits(1)(fireLocked(companyId, routineId, now, mode))

    /** Everything due at `now`, in slot order. Sequential: one agent's routines stay ordered. */
    const tick = (now: DateTime.Utc): Effect.Effect<ReadonlyArray<FireOutcome>> =>
      Effect.gen(function* () {
        const due = yield* routines.due(now)
        const out: Array<FireOutcome> = []
        for (const routine of due) {
          out.push(yield* fire(routine.companyId, routine.id, now, { _tag: 'due' }))
        }
        return out
      })

    /** "Run now" (D8 permission, D6 `Conflict`): fires whatever the schedule or `enabled` say. */
    const runNow = (
      me: CurrentUserShape,
      routineId: RoutineId
    ): Effect.Effect<Task, Unauthorized | NotFound | Forbidden | Conflict> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const found = yield* routines.byId(who.companyId, routineId)
        if (Option.isNone(found)) return yield* new NotFound({ entity: 'Routine', id: routineId })
        yield* routines.requireManage(who, found.value.agentId)
        const live = yield* liveTask(found.value)
        if (Option.isSome(live)) {
          return yield* new Conflict({
            reason: `The previous run is still ${live.value.status}; cancel it or wait for it`
          })
        }
        const now = yield* DateTime.now
        // D12: an event trigger has to be testable without starting a real huddle, so the
        // manual run renders its own context block instead of pretending an event happened.
        const outcome = yield* fire(who.companyId, routineId, now, {
          _tag: 'force',
          context: found.value.trigger._tag === 'event' ? MANUAL_CONTEXT : undefined
        })
        switch (outcome._tag) {
          case 'fired':
            return outcome.task
          case 'stale':
            return yield* new NotFound({ entity: 'Routine', id: routineId })
          case 'skipped':
          case 'failed':
            return yield* new Conflict({ reason: `Could not run: ${outcome.reason}` })
        }
      })

    // ── the daemon ───────────────────────────────────────────────────────────

    const loop = DateTime.now.pipe(
      Effect.flatMap(tick),
      Effect.catchAllCause((cause) => Effect.logError('routines: tick failed', cause)),
      Effect.repeat(Schedule.fixed(TICK_INTERVAL))
    )
    yield* Effect.forkScoped(loop)
    yield* Effect.logInfo(`routines: ticking every ${Duration.format(TICK_INTERVAL)}`)

    return { tick, runNow, fire } as const
  })
}) {}
