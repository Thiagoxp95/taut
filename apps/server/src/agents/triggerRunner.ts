/**
 * The bus half of a routine's fire condition (docs/build-plan-triggers.md D1, D10). Shaped like
 * `Scheduler`'s consumer, and deliberately *not* a second execution path:
 *
 *   `Bus.streamAll()`
 *     ├─ keep only `Event`s whose `type` is a `TriggerEventType` (the six of D4/D17)
 *     ├─ `Routines.byEvent(companyId, type)` — one indexed lookup on `trigger_event` (D9)
 *     └─ per routine, sequentially:
 *          ├─ `matchesEvent(trigger, event, facts)` — the contract's, the same function the
 *          │   web previews with, so the two can never disagree
 *          ├─ D6: never fire on the routine's own agent's action (a `message.created` trigger
 *          │   would otherwise fire on the agent's own reply, forever). D27 exempts signals:
 *          │   an agent waking itself is the whole point of one.
 *          ├─ D7: at most `TAUT_TRIGGER_MAX_FIRES_PER_HOUR` per routine per rolling hour,
 *          │   kept in memory — a safety valve, not accounting, so a restart clearing it is
 *          │   correct. Over the cap the occurrence is dropped and logged once per hour.
 *          ├─ `TriggerContext.render` — the prose block the agent is woken with (D5)
 *          └─ `RoutineRunner.fire(..., { _tag: 'event', context })` — the *same* `fire` the
 *              30-second clock calls, behind the same semaphore, so the clock and the bus can
 *              never fire one routine twice at once.
 *
 * The `call.ended` seam is the reason `EventFacts` exists: that event carries only
 * `{ callId, channelId, endedAt }`, so `CallEndedTrigger.minSeconds` cannot be answered from the
 * payload. The call is loaded **once** per occurrence, before the per-routine loop, and the
 * duration is handed to every `matchesEvent` — without it every `minSeconds` filter fails closed
 * and no `call.ended` trigger ever fires.
 *
 * Events are at-most-once and in-process (D10): nothing that happened while the server was down
 * is replayed, for the same reason routines D5 skips missed slots. Delivery is immediate with no
 * debounce (D11) — LiveKit re-join churn is absorbed by the no-overlap rule (D8), which lives in
 * `RoutineRunner`, not by a settle timer that would need its own persistence.
 *
 * Every routine is wrapped in `Effect.catchAllCause` plus a log line: one bad trigger never stops
 * the stream. `handle(...)` is exposed so tests drive an event through without racing the bus.
 */
import type { EventFacts, Routine } from '@taut/contract/domain'
import { TriggerEventType, matchesEvent } from '@taut/contract/domain'
import type { Event } from '@taut/contract/events'
import type { CompanyId, MemberId, RoutineId } from '@taut/contract/ids'
import { DateTime, Duration, Effect, Option, Schema, Stream } from 'effect'
import { AppConfig } from '../config.js'
import { Bus } from '../realtime/bus.js'
import { Calls } from '../services/calls.js'
import { Routines } from '../services/routines.js'
import { RoutineRunner } from './routineRunner.js'
import { TriggerContext } from './triggerContext.js'

const HOUR = Duration.toMillis(Duration.hours(1))

const isTriggerEvent = Schema.is(TriggerEventType)

/**
 * Who *did* the thing, when the event has an actor at all (D6). A failed task has none — it is
 * an outcome, not an action — which is why `TaskFailedTrigger` may legitimately watch its own
 * agent. A signal has an emitter but is exempt by D27, so it is not listed here either.
 */
const actorOf = (
  event: Event
): Option.Option<{ readonly kind: 'user' | 'agent'; readonly id: MemberId }> => {
  switch (event.type) {
    case 'message.created':
      return Option.some({
        kind: event.payload.message.authorKind,
        id: event.payload.message.authorId
      })
    case 'call.started':
      return Option.some({
        kind: event.payload.call.startedByKind,
        id: event.payload.call.startedById
      })
    default:
      return Option.none()
  }
}

/** What a fire was, for the log line and the tests. */
export type TriggerOutcome =
  | { readonly _tag: 'fired'; readonly routineId: RoutineId }
  | { readonly _tag: 'skipped'; readonly routineId: RoutineId; readonly reason: string }

export class TriggerRunner extends Effect.Service<TriggerRunner>()('TriggerRunner', {
  scoped: Effect.gen(function* () {
    const config = yield* AppConfig
    const bus = yield* Bus
    const calls = yield* Calls
    const routines = yield* Routines
    const runner = yield* RoutineRunner
    const context = yield* TriggerContext

    /**
     * D7's rolling hour, in memory: the timestamps of this process's fires per routine, pruned
     * on read. `warned` keeps the "over the cap" line to one per hour per routine rather than
     * one per dropped occurrence, which is the difference between a signal and a flood.
     */
    const fires = new Map<RoutineId, Array<number>>()
    const warned = new Map<RoutineId, number>()

    /** `true` when this routine still has room in the hour, and records the fire when it does. */
    const takeFireSlot = (routineId: RoutineId, nowMs: number): boolean => {
      const recent = (fires.get(routineId) ?? []).filter((at) => nowMs - at < HOUR)
      if (recent.length >= config.triggerMaxFiresPerHour) {
        fires.set(routineId, recent)
        return false
      }
      recent.push(nowMs)
      fires.set(routineId, recent)
      return true
    }

    const warnOncePerHour = (routine: Routine, nowMs: number): Effect.Effect<void> => {
      const last = warned.get(routine.id)
      if (last !== undefined && nowMs - last < HOUR) return Effect.void
      warned.set(routine.id, nowMs)
      return Effect.logWarning(
        `triggers: ${routine.id} is over ${config.triggerMaxFiresPerHour} fires/hour; dropping occurrences`
      )
    }

    /**
     * D5: the facts a filter needs that the payload does not carry. Exactly one today, and it
     * is loaded once per occurrence rather than once per routine — the same read the context
     * block makes, so a channel with ten listeners still costs one query.
     */
    const factsOf = (companyId: CompanyId, event: Event): Effect.Effect<EventFacts> => {
      if (event.type !== 'call.ended') return Effect.succeed({})
      const endedAt = event.payload.endedAt
      return calls.find(companyId, event.payload.callId).pipe(
        Effect.map(
          Option.match({
            onNone: (): EventFacts => ({}),
            onSome: (call): EventFacts => ({
              callDurationSeconds: Math.max(
                0,
                Math.round(
                  (DateTime.toEpochMillis(endedAt) - DateTime.toEpochMillis(call.startedAt)) / 1000
                )
              )
            })
          })
        ),
        Effect.catchAllCause(() => Effect.succeed<EventFacts>({}))
      )
    }

    /** D6, with D27's exemption: a signal wake is an explicit, budgeted request to be woken. */
    const isSelfTrigger = (routine: Routine, event: Event): boolean => {
      if (event.type === 'signal.emitted') return false
      const actor = actorOf(event)
      return (
        Option.isSome(actor) && actor.value.kind === 'agent' && actor.value.id === routine.agentId
      )
    }

    const one = (
      routine: Routine,
      event: Event,
      facts: EventFacts,
      now: DateTime.Utc
    ): Effect.Effect<Option.Option<TriggerOutcome>> =>
      Effect.gen(function* () {
        if (routine.trigger._tag !== 'event') return Option.none<TriggerOutcome>()
        if (!matchesEvent(routine.trigger.event, event, facts)) return Option.none<TriggerOutcome>()
        if (isSelfTrigger(routine, event)) {
          return Option.some<TriggerOutcome>({
            _tag: 'skipped',
            routineId: routine.id,
            reason: 'the actor is the routine’s own agent (D6)'
          })
        }
        const nowMs = DateTime.toEpochMillis(now)
        if (!takeFireSlot(routine.id, nowMs)) {
          yield* warnOncePerHour(routine, nowMs)
          // D7: the occurrence is dropped, and the row says so — a silent drop would look
          // like a trigger that simply never matched.
          yield* routines.markSkipped(routine.companyId, routine.id, now)
          return Option.some<TriggerOutcome>({
            _tag: 'skipped',
            routineId: routine.id,
            reason: 'over the hourly fire cap (D7)'
          })
        }
        const rendered = yield* context.render(routine.companyId, event)
        const outcome = yield* runner.fire(routine.companyId, routine.id, now, {
          _tag: 'event',
          context: rendered
        })
        return Option.some<TriggerOutcome>(
          outcome._tag === 'fired'
            ? { _tag: 'fired', routineId: routine.id }
            : { _tag: 'skipped', routineId: routine.id, reason: outcome._tag }
        )
      }).pipe(
        // One bad trigger never stops the stream, and never wedges the ones behind it.
        Effect.catchAllCause((cause) =>
          Effect.logError(`triggers: ${routine.id} crashed`, cause).pipe(
            Effect.as(
              Option.some<TriggerOutcome>({
                _tag: 'skipped',
                routineId: routine.id,
                reason: 'internal error (see the log)'
              })
            )
          )
        )
      )

    /**
     * One event against every routine listening for it. Sequential on purpose: one agent's
     * triggers stay ordered, and `RoutineRunner`'s semaphore is never contended from two
     * directions at once.
     */
    const handle = (
      companyId: CompanyId,
      event: Event
    ): Effect.Effect<ReadonlyArray<TriggerOutcome>> =>
      Effect.gen(function* () {
        if (!isTriggerEvent(event.type)) return []
        const listening = yield* routines.byEvent(companyId, event.type)
        if (listening.length === 0) return []
        const facts = yield* factsOf(companyId, event)
        const now = yield* DateTime.now
        const out: Array<TriggerOutcome> = []
        for (const routine of listening) {
          const outcome = yield* one(routine, event, facts, now)
          if (Option.isSome(outcome)) out.push(outcome.value)
        }
        return out
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError(`triggers: ${event.type} failed`, cause).pipe(Effect.as([]))
        )
      )

    // ── the daemon ───────────────────────────────────────────────────────────

    const consume = bus.streamAll().pipe(
      Stream.runForEach((m) =>
        m._tag === 'Event' ? handle(m.companyId, m.event).pipe(Effect.asVoid) : Effect.void
      ),
      Effect.catchAllCause((cause) => Effect.logError('triggers: bus consumer died', cause))
    )
    yield* Effect.forkScoped(consume)
    yield* Effect.logInfo(
      `triggers: listening (max ${config.triggerMaxFiresPerHour} fires/hour per routine)`
    )

    return { handle } as const
  })
}) {}
