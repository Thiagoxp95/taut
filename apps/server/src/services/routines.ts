/**
 * Routines: named prompts that fire on a condition (docs/build-plan-routines.md, generalised by
 * docs/build-plan-triggers.md D1). This service owns the rows and nothing about firing them —
 * `agents/routineRunner.ts` does that, because a fire needs the `Scheduler`, which is built
 * above this tier.
 *
 * The condition is a `Trigger`: a clock in one arm, a bus event in the other. Only the clock
 * arm has a next run, so `nextRunAt` is written for it alone (triggers D9) — an event routine
 * stores NULL and `due` therefore never returns one, which is how the 30-second tick and the
 * bus consumer stay strictly disjoint without either knowing about the other. Event routines
 * are found instead through `byEvent`, one indexed lookup on the denormalised `trigger_event`
 * column, because SQLite cannot index inside `trigger_json`.
 *
 * `nextRunAt` is recomputed from *now* on every write and every `mark*` (routines D5): a routine
 * that was disabled, edited, or missed for a day never carries a stale slot forward. Disabled
 * rows store no `nextRunAt` at all, so `due` is a single indexed range scan. `interval`
 * schedules are anchored on `createdAt` so "every 90 minutes" lands on the same grid across
 * restarts.
 *
 * Permission is the agent's (D8/D13): anyone in the company may list, `requireManageAgent`
 * writes. The D7 fire cap is deliberately *not* here — it is a safety valve, not accounting, and
 * `TriggerRunner` keeps it in memory where a restart clearing it is the correct behaviour.
 */
import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import {
  type Routine,
  RoutineRunStatus,
  Trigger,
  type TriggerEventType,
  type TriggerKind,
  nextRuns,
  validateTrigger
} from '@taut/contract/domain'
import { Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import {
  AgentId,
  ChannelId,
  CompanyId,
  RoutineId,
  TaskId,
  UserId,
  newRoutineId
} from '@taut/contract/ids'
import { DateTime, Effect, Option, Schema } from 'effect'
import { findAll, findOne, run } from '../db/sql.js'
import { RoutineRow, toRoutine } from '../domain/rows.js'
import { type Actor, actor } from './access.js'
import { makeAgentAccess } from './agentAccess.js'
import { Agents } from './agents.js'
import { Channels } from './channels.js'
import { type Emit, EventPublisher } from './publisher.js'

const COLUMNS =
  'id, company_id, agent_id, owner_user_id, name, prompt, channel_id, trigger_json, ' +
  'enabled, next_run_at, last_run_at, last_task_id, last_status, created_at, updated_at'

const MAX_LIMIT = 200

export interface CreateRoutineInput {
  readonly agentId: AgentId
  readonly name: string
  readonly prompt: string
  readonly channelId?: ChannelId | undefined
  readonly trigger: Trigger
  readonly enabled?: boolean | undefined
}

/** `channelId: null` clears the target back to the DM (D7). */
export interface UpdateRoutineInput {
  readonly name?: string | undefined
  readonly prompt?: string | undefined
  readonly channelId?: ChannelId | null | undefined
  /** Replaced whole, never merged: switching arms changes which filters exist at all. */
  readonly trigger?: Trigger | undefined
  readonly enabled?: boolean | undefined
}

export interface ListRoutinesInput {
  readonly agentId?: AgentId | undefined
  /** The *All · Schedules · Triggers* chip row (D14); absent = both kinds. */
  readonly kind?: TriggerKind | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/**
 * When a routine fires next, computed from `from` — never from the slot it missed (routines D5).
 * `undefined` while disabled, when the schedule can never fire again, and always for an event
 * trigger: an event has no next run, and a NULL here is what keeps it out of `due` (D9).
 */
export const nextRunOf = (
  routine: Pick<Routine, 'trigger' | 'enabled' | 'createdAt'>,
  from: DateTime.Utc
): DateTime.Utc | undefined =>
  routine.enabled && routine.trigger._tag === 'schedule'
    ? nextRuns(routine.trigger.schedule, routine.trigger.timezone, from, 1, routine.createdAt)[0]
    : undefined

/** The `trigger_event` column: the event a trigger listens for, NULL for a clock (D9). */
const eventOf = (trigger: Trigger): TriggerEventType | null =>
  trigger._tag === 'event' ? trigger.event._tag : null

const iso = (at: DateTime.Utc | undefined): string | null =>
  at === undefined ? null : DateTime.formatIso(at)

export class Routines extends Effect.Service<Routines>()('Routines', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const publisher = yield* EventPublisher
    const agents = yield* Agents
    const channels = yield* Channels
    const { requireManageAgent } = yield* makeAgentAccess

    // ── queries ──────────────────────────────────────────────────────────────

    const Key = Schema.Struct({ companyId: CompanyId, routineId: RoutineId })

    const byId = findOne({
      Request: Key,
      Result: RoutineRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM routines
        WHERE company_id = ${r.companyId} AND id = ${r.routineId}`
    })

    const page = findAll({
      Request: Schema.Struct({
        companyId: CompanyId,
        agentId: Schema.NullOr(AgentId),
        kind: Schema.NullOr(Schema.String),
        after: Schema.NullOr(RoutineId),
        limit: Schema.Number
      }),
      Result: RoutineRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM routines
        WHERE company_id = ${r.companyId}
          AND (${r.agentId} IS NULL OR agent_id = ${r.agentId})
          AND (${r.kind} IS NULL OR trigger_kind = ${r.kind})
          AND (${r.after} IS NULL OR (created_at, rowid) > (
            SELECT a.created_at, a.rowid FROM routines a WHERE a.id = ${r.after}))
        ORDER BY created_at ASC, rowid ASC
        LIMIT ${r.limit}`
    })

    /**
     * The hot path (D9): an event landed on the bus, which enabled routines asked for it.
     * `routines_event(trigger_event, enabled)` makes this one index seek — the reason the
     * column is denormalised out of `trigger_json` at all.
     */
    const eventRows = findAll({
      Request: Schema.Struct({ companyId: CompanyId, event: Schema.String }),
      Result: RoutineRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM routines
        WHERE company_id = ${r.companyId} AND trigger_event = ${r.event} AND enabled = 1
        ORDER BY created_at ASC, rowid ASC`
    })

    /** Enabled routines whose slot has passed. `now` is ISO, so the comparison is chronological. */
    const dueRows = findAll({
      Request: Schema.String,
      Result: RoutineRow,
      execute: (now) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM routines
        WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ${now}
        ORDER BY next_run_at ASC, rowid ASC`
    })

    const insert = run({
      Request: Schema.Struct({
        id: RoutineId,
        companyId: CompanyId,
        agentId: AgentId,
        ownerUserId: UserId,
        name: Schema.String,
        prompt: Schema.String,
        channelId: Schema.NullOr(ChannelId),
        triggerJson: Schema.String,
        triggerKind: Schema.String,
        triggerEvent: Schema.NullOr(Schema.String),
        enabled: Schema.Number,
        nextRunAt: Schema.NullOr(Schema.String),
        at: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO routines
          (id, company_id, agent_id, owner_user_id, name, prompt, channel_id,
           trigger_json, trigger_kind, trigger_event,
           enabled, next_run_at, created_at, updated_at)
        VALUES (${r.id}, ${r.companyId}, ${r.agentId}, ${r.ownerUserId}, ${r.name}, ${r.prompt},
                ${r.channelId}, ${r.triggerJson}, ${r.triggerKind}, ${r.triggerEvent},
                ${r.enabled}, ${r.nextRunAt}, ${r.at}, ${r.at})`
    })

    const updateRow = run({
      Request: Schema.Struct({
        ...Key.fields,
        name: Schema.String,
        prompt: Schema.String,
        channelId: Schema.NullOr(ChannelId),
        triggerJson: Schema.String,
        triggerKind: Schema.String,
        triggerEvent: Schema.NullOr(Schema.String),
        enabled: Schema.Number,
        nextRunAt: Schema.NullOr(Schema.String),
        at: Schema.String
      }),
      execute: (r) => sql`
        UPDATE routines
        SET name = ${r.name}, prompt = ${r.prompt}, channel_id = ${r.channelId},
            trigger_json = ${r.triggerJson}, trigger_kind = ${r.triggerKind},
            trigger_event = ${r.triggerEvent}, enabled = ${r.enabled},
            next_run_at = ${r.nextRunAt}, updated_at = ${r.at}
        WHERE company_id = ${r.companyId} AND id = ${r.routineId}`
    })

    /** What a tick writes: the outcome and the next slot. `updated_at` is for edits only. */
    const stamp = run({
      Request: Schema.Struct({
        ...Key.fields,
        lastRunAt: Schema.String,
        lastTaskId: Schema.NullOr(TaskId),
        lastStatus: RoutineRunStatus,
        nextRunAt: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        UPDATE routines
        SET last_run_at = ${r.lastRunAt}, last_task_id = ${r.lastTaskId}, last_status = ${r.lastStatus},
            next_run_at = ${r.nextRunAt}
        WHERE company_id = ${r.companyId} AND id = ${r.routineId}`
    })

    const remove = run({
      Request: Key,
      execute: (r) =>
        sql`DELETE FROM routines WHERE company_id = ${r.companyId} AND id = ${r.routineId}`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    /** The `trigger_json` column: the union through `Schema.parseJson`, as `RoutineRow` reads it. */
    const encodeTrigger = Schema.encodeSync(Schema.parseJson(Trigger))

    /** The three columns one `Trigger` writes: the blob, plus the two SQLite can index (D9). */
    const triggerColumns = (trigger: Trigger) =>
      ({
        triggerJson: encodeTrigger(trigger),
        triggerKind: trigger._tag,
        triggerEvent: eventOf(trigger)
      }) as const

    const find = (
      companyId: CompanyId,
      routineId: RoutineId
    ): Effect.Effect<Option.Option<Routine>> =>
      byId({ companyId, routineId }).pipe(Effect.map(Option.map(toRoutine)))

    const load = (companyId: CompanyId, routineId: RoutineId): Effect.Effect<Routine, NotFound> =>
      find(companyId, routineId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Routine', id: routineId })),
            onSome: Effect.succeed
          })
        )
      )

    /** Read a row back after a write; a row that vanished mid-request is a defect, not a 404. */
    const reload = (companyId: CompanyId, routineId: RoutineId): Effect.Effect<Routine> =>
      load(companyId, routineId).pipe(Effect.orDie)

    const emitUpdated = (emit: Emit, companyId: CompanyId, routineId: RoutineId) =>
      reload(companyId, routineId).pipe(
        Effect.tap((routine) => emit({ type: 'routine.updated', payload: { routine } }))
      )

    const checkTrigger = (trigger: Trigger): Effect.Effect<void, Validation> => {
      const issues = validateTrigger(trigger)
      return issues.length === 0 ? Effect.void : Effect.fail(new Validation({ issues }))
    }

    /**
     * A chosen target must be a channel the agent sits in and the owner may post to. The DM
     * default (D7) skips this: it is opened by the runner on first fire.
     */
    const checkChannel = (
      who: Actor,
      agentId: AgentId,
      channelId: ChannelId
    ): Effect.Effect<void, Forbidden | Validation> =>
      Effect.gen(function* () {
        const channel = yield* channels.find(who.companyId, channelId)
        if (Option.isNone(channel)) {
          return yield* new Validation({
            issues: [{ path: ['channelId'], message: 'channel not found' }]
          })
        }
        yield* channels.requirePost(who, channel.value)
        const member = yield* channels.isMember(channelId, {
          memberKind: 'agent',
          memberId: agentId
        })
        if (!member) {
          return yield* new Validation({
            issues: [{ path: ['channelId'], message: 'the agent is not a member of that channel' }]
          })
        }
      })

    // ── endpoints ────────────────────────────────────────────────────────────

    const list = (
      me: CurrentUserShape,
      input: ListRoutinesInput
    ): Effect.Effect<
      { readonly items: ReadonlyArray<Routine>; readonly nextCursor?: string },
      Unauthorized
    > =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_LIMIT)
        const after = Schema.decodeUnknownOption(RoutineId)(input.cursor)
        const rows = yield* page({
          companyId: who.companyId,
          agentId: input.agentId ?? null,
          kind: input.kind ?? null,
          after: Option.getOrNull(after),
          limit: limit + 1
        })
        const items = rows.slice(0, limit).map(toRoutine)
        const last = items[items.length - 1]
        return rows.length > limit && last !== undefined
          ? { items, nextCursor: last.id }
          : { items }
      })

    const create = (
      me: CurrentUserShape,
      input: CreateRoutineInput
    ): Effect.Effect<Routine, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* agents.byId(who.companyId, input.agentId)
        yield* requireManageAgent(who, input.agentId)
        yield* checkTrigger(input.trigger)
        if (input.channelId !== undefined) {
          yield* checkChannel(who, input.agentId, input.channelId)
        }
        const now = DateTime.unsafeNow()
        const enabled = input.enabled ?? true
        const nextRunAt = nextRunOf({ trigger: input.trigger, enabled, createdAt: now }, now)
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const id = newRoutineId()
            yield* insert({
              id,
              companyId: who.companyId,
              agentId: input.agentId,
              ownerUserId: who.userId,
              name: input.name,
              prompt: input.prompt,
              channelId: input.channelId ?? null,
              ...triggerColumns(input.trigger),
              enabled: enabled ? 1 : 0,
              nextRunAt: iso(nextRunAt),
              at: DateTime.formatIso(now)
            })
            const routine = yield* reload(who.companyId, id)
            yield* emit({ type: 'routine.created', payload: { routine } })
            return routine
          })
        )
      })

    const update = (
      me: CurrentUserShape,
      routineId: RoutineId,
      input: UpdateRoutineInput
    ): Effect.Effect<Routine, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const current = yield* load(who.companyId, routineId)
        yield* requireManageAgent(who, current.agentId)
        const next = {
          name: input.name ?? current.name,
          prompt: input.prompt ?? current.prompt,
          channelId: input.channelId === undefined ? (current.channelId ?? null) : input.channelId,
          trigger: input.trigger ?? current.trigger,
          enabled: input.enabled ?? current.enabled
        }
        if (input.trigger !== undefined) yield* checkTrigger(input.trigger)
        if (input.channelId !== undefined && input.channelId !== null) {
          yield* checkChannel(who, current.agentId, input.channelId)
        }
        const now = DateTime.unsafeNow()
        const nextRunAt = nextRunOf({ ...next, createdAt: current.createdAt }, now)
        return yield* publisher.transact(who.companyId, (emit) =>
          updateRow({
            companyId: who.companyId,
            routineId,
            name: next.name,
            prompt: next.prompt,
            channelId: next.channelId,
            ...triggerColumns(next.trigger),
            enabled: next.enabled ? 1 : 0,
            nextRunAt: iso(nextRunAt),
            at: DateTime.formatIso(now)
          }).pipe(Effect.zipRight(emitUpdated(emit, who.companyId, routineId)))
        )
      })

    const del = (
      me: CurrentUserShape,
      routineId: RoutineId
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const current = yield* load(who.companyId, routineId)
        yield* requireManageAgent(who, current.agentId)
        yield* publisher.transact(who.companyId, (emit) =>
          remove({ companyId: who.companyId, routineId }).pipe(
            Effect.zipRight(
              emit({
                type: 'routine.deleted',
                payload: { routineId, agentId: current.agentId }
              })
            )
          )
        )
      })

    // ── runner hooks ─────────────────────────────────────────────────────────

    const due = (now: DateTime.Utc): Effect.Effect<ReadonlyArray<Routine>> =>
      dueRows(DateTime.formatIso(now)).pipe(Effect.map((rows) => rows.map(toRoutine)))

    /**
     * Every enabled routine of one company listening for one event type (D9). The filters
     * inside the trigger are *not* applied here — `matchesEvent` in the contract does that,
     * because the web previews on the same function and the two must never disagree.
     */
    const byEvent = (
      companyId: CompanyId,
      type: TriggerEventType
    ): Effect.Effect<ReadonlyArray<Routine>> =>
      eventRows({ companyId, event: type }).pipe(Effect.map((rows) => rows.map(toRoutine)))

    /**
     * Record what the tick did and move `nextRunAt` past `at`. Skips and failures advance too:
     * a paused agent's routine must not fire a burst the moment it is unpaused (D11). A routine
     * deleted mid-fire is `None`, not an error.
     */
    const mark = (
      companyId: CompanyId,
      routineId: RoutineId,
      at: DateTime.Utc,
      status: RoutineRunStatus,
      taskId?: TaskId | undefined
    ): Effect.Effect<Option.Option<Routine>> =>
      Effect.gen(function* () {
        const current = yield* find(companyId, routineId)
        if (Option.isNone(current)) return Option.none()
        const routine = current.value
        const updated = yield* publisher.transact(companyId, (emit) =>
          stamp({
            companyId,
            routineId,
            lastRunAt: DateTime.formatIso(at),
            // A skip keeps the last task that actually ran: that is what "last run" links to.
            lastTaskId: status === 'fired' ? (taskId ?? null) : (routine.lastTaskId ?? null),
            lastStatus: status,
            nextRunAt: iso(nextRunOf(routine, at))
          }).pipe(Effect.zipRight(emitUpdated(emit, companyId, routineId)))
        )
        return Option.some(updated)
      })

    return {
      list,
      create,
      update,
      remove: del,
      // runner hooks
      byId: find,
      due,
      byEvent,
      markFired: (companyId: CompanyId, routineId: RoutineId, at: DateTime.Utc, taskId: TaskId) =>
        mark(companyId, routineId, at, 'fired', taskId),
      markSkipped: (companyId: CompanyId, routineId: RoutineId, at: DateTime.Utc) =>
        mark(companyId, routineId, at, 'skipped'),
      markFailed: (companyId: CompanyId, routineId: RoutineId, at: DateTime.Utc) =>
        mark(companyId, routineId, at, 'failed'),
      /** D8, shared with the runner's `runNow`. */
      requireManage: requireManageAgent
    } as const
  })
}) {}
