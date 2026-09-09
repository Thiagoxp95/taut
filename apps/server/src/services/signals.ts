/**
 * Signals: a named event an agent emits, optionally in the future, that wakes an agent — usually
 * itself, in the same thread, with the same context (docs/build-plan-triggers.md Part II).
 *
 * This service owns the rows and the budgets. It does **not** deliver: `agents/signalRunner.ts`
 * does that, because a wake goes through `Scheduler`, which is built above this tier — the same
 * split `Routines` and `RoutineRunner` already have.
 *
 * Three gates live here, and only here:
 *
 *   D28 — the name is `[a-z0-9][a-z0-9._-]{0,63}`, company-scoped and never namespaced by agent.
 *         A broadcast signal is worthless if only its author can name it, so a collision between
 *         two agents is the coordination mechanism, not a bug.
 *   D25 — an agent may hold at most `TAUT_MAX_PENDING_SIGNALS` undelivered signals. Emitting past
 *         that fails the tool call with something the agent can act on ("cancel one first"),
 *         rather than silently dropping the promise it just made to a human.
 *   D23 — chain depth is **time-scoped**. A signal emitted by a task that was itself woken by a
 *         signal *within* `TAUT_SIGNAL_CHAIN_WINDOW` inherits `depth + 1` and is refused past
 *         `TAUT_MAX_SIGNAL_DEPTH`; emitted later, it starts at 0. A runaway is a tight loop, not
 *         a slow one — a watcher that re-arms itself every three minutes is a legitimate pattern
 *         and must never be capped out.
 *
 * D19 decides who announces a signal on the bus. An **immediate** emit publishes `signal.emitted`
 * inside its own `publisher.transact`, so a broadcast listener wakes now rather than up to a tick
 * later; a **delayed** one stays a silent `pending` row until the tick delivers it, which is what
 * lets "in three minutes" survive a deploy. The two are told apart by the row itself — an
 * immediate emit sets `deliverAt` to the emit time — so there is no third column and no way for
 * one signal to be announced twice.
 */
import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import {
  type MemberKind,
  type Signal,
  SignalName,
  SignalPayload,
  SignalStatus
} from '@taut/contract/domain'
import { type Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import {
  AgentId,
  ChannelId,
  CompanyId,
  MemberId,
  MessageId,
  SignalId,
  TaskId,
  newSignalId
} from '@taut/contract/ids'
import { DateTime, Effect, Option, Schema } from 'effect'
import { AppConfig } from '../config.js'
import { Count, findAll, findOne, run, single } from '../db/sql.js'
import { SignalRow, toSignal } from '../domain/rows.js'
import { actor } from './access.js'
import { EventPublisher } from './publisher.js'
import { Tasks } from './tasks.js'

const COLUMNS =
  'id, company_id, name, payload_json, emitted_by_kind, emitted_by_id, emitted_by_task_id, ' +
  'target_agent_id, channel_id, thread_id, note, deliver_at, depth, status, delivered_task_id, ' +
  'created_at, updated_at'

const MAX_LIMIT = 200

/** D22: a hint, not the context — and one that must not blow up a prompt. */
export const MAX_PAYLOAD_BYTES = 8 * 1024

export interface EmitSignalInput {
  readonly companyId: CompanyId
  /** Checked against `SignalName` here, so a bad name is a `Validation`, never a decode defect. */
  readonly name: string
  readonly note: string
  readonly payload?: SignalPayload | undefined
  readonly emittedByKind: MemberKind
  readonly emittedById: MemberId
  /** The task whose turn emitted it — the anchor for the D23 chain window. */
  readonly emittedByTaskId?: TaskId | undefined
  /** `to: 'self'` or an explicit agent. Absent = broadcast to matching triggers (D18). */
  readonly targetAgentId?: AgentId | undefined
  readonly channelId?: ChannelId | undefined
  /** The thread to resume (D20). Absent = a new thread in `channelId`. */
  readonly threadId?: MessageId | undefined
  /** Absent = now, which is what makes this an immediate emit (D19). */
  readonly deliverAt?: DateTime.Utc | undefined
}

export interface ListSignalsInput {
  /** The *emitting* member, not the target: "what has this agent armed". */
  readonly agentId?: AgentId | undefined
  readonly status?: SignalStatus | undefined
  /** The thread the signal will wake (D20) — what the composer's pending row asks for. */
  readonly threadId?: MessageId | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

const iso = (at: DateTime.Utc): string => DateTime.formatIso(at)

const validation = (path: ReadonlyArray<string>, message: string): Validation =>
  new Validation({ issues: [{ path, message }] })

export class Signals extends Effect.Service<Signals>()('Signals', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const config = yield* AppConfig
    const publisher = yield* EventPublisher
    const tasks = yield* Tasks

    // ── queries ──────────────────────────────────────────────────────────────

    const Key = Schema.Struct({ companyId: CompanyId, signalId: SignalId })

    const byId = findOne({
      Request: Key,
      Result: SignalRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM signals
        WHERE company_id = ${r.companyId} AND id = ${r.signalId}`
    })

    /** By id alone — the tick has the row's company from the row itself. */
    const rowById = findOne({
      Request: SignalId,
      Result: SignalRow,
      execute: (signalId) => sql`SELECT ${sql.literal(COLUMNS)} FROM signals WHERE id = ${signalId}`
    })

    const page = findAll({
      Request: Schema.Struct({
        companyId: CompanyId,
        emittedById: Schema.NullOr(MemberId),
        status: Schema.NullOr(SignalStatus),
        threadId: Schema.NullOr(MessageId),
        after: Schema.NullOr(SignalId),
        limit: Schema.Number
      }),
      Result: SignalRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM signals
        WHERE company_id = ${r.companyId}
          AND (${r.emittedById} IS NULL OR emitted_by_id = ${r.emittedById})
          AND (${r.status} IS NULL OR status = ${r.status})
          AND (${r.threadId} IS NULL OR thread_id = ${r.threadId})
          AND (${r.after} IS NULL OR (deliver_at, rowid) > (
            SELECT a.deliver_at, a.rowid FROM signals a WHERE a.id = ${r.after}))
        ORDER BY deliver_at ASC, rowid ASC
        LIMIT ${r.limit}`
    })

    /** The whole query the 5-second tick makes: one seek down `signals_due`. */
    const dueRows = findAll({
      Request: Schema.String,
      Result: SignalRow,
      execute: (now) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM signals
        WHERE status = 'pending' AND deliver_at <= ${now}
        ORDER BY deliver_at ASC, rowid ASC`
    })

    /** D25's valve: how many undelivered signals this member is already holding. */
    const pendingOf = single({
      Request: Schema.Struct({ companyId: CompanyId, emittedById: MemberId }),
      Result: Count,
      execute: (r) => sql`
        SELECT COUNT(*) AS n FROM signals
        WHERE company_id = ${r.companyId} AND emitted_by_id = ${r.emittedById}
          AND status = 'pending'`
    })

    const insert = run({
      Request: Schema.Struct({
        id: SignalId,
        companyId: CompanyId,
        name: Schema.String,
        payloadJson: Schema.String,
        emittedByKind: Schema.String,
        emittedById: MemberId,
        emittedByTaskId: Schema.NullOr(TaskId),
        targetAgentId: Schema.NullOr(AgentId),
        channelId: Schema.NullOr(ChannelId),
        threadId: Schema.NullOr(MessageId),
        note: Schema.String,
        deliverAt: Schema.String,
        depth: Schema.Number,
        at: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO signals
          (id, company_id, name, payload_json, emitted_by_kind, emitted_by_id, emitted_by_task_id,
           target_agent_id, channel_id, thread_id, note, deliver_at, depth, status,
           delivered_task_id, created_at, updated_at)
        VALUES (${r.id}, ${r.companyId}, ${r.name}, ${r.payloadJson}, ${r.emittedByKind},
                ${r.emittedById}, ${r.emittedByTaskId}, ${r.targetAgentId}, ${r.channelId},
                ${r.threadId}, ${r.note}, ${r.deliverAt}, ${r.depth}, 'pending', NULL,
                ${r.at}, ${r.at})`
    })

    /** Every status move is this one statement; `pending` in the WHERE makes it idempotent. */
    const settle = run({
      Request: Schema.Struct({
        signalId: SignalId,
        status: SignalStatus,
        deliveredTaskId: Schema.NullOr(TaskId),
        at: Schema.String
      }),
      execute: (r) => sql`
        UPDATE signals
        SET status = ${r.status}, delivered_task_id = ${r.deliveredTaskId}, updated_at = ${r.at}
        WHERE id = ${r.signalId} AND status = 'pending'`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    const encodePayload = Schema.encodeSync(Schema.parseJson(SignalPayload))
    const decodeName = Schema.decodeUnknownOption(SignalName)

    const find = (companyId: CompanyId, signalId: SignalId): Effect.Effect<Option.Option<Signal>> =>
      byId({ companyId, signalId }).pipe(Effect.map(Option.map(toSignal)))

    /** Read a row back after a write; a row that vanished mid-request is a defect, not a 404. */
    const reload = (companyId: CompanyId, signalId: SignalId): Effect.Effect<Signal> =>
      find(companyId, signalId).pipe(Effect.flatMap(Effect.orDie))

    /**
     * D23. The anchor is the task that emitted this signal: if that task was itself started by
     * a signal, and that signal went off less than `SIGNAL_CHAIN_WINDOW` ago, this is the next
     * hop of the same chain. Anything slower is a fresh chain at depth 0 — which is the whole
     * point of making the cap time-scoped rather than counting hops forever.
     */
    const depthFor = (
      companyId: CompanyId,
      emittedByTaskId: TaskId | undefined,
      now: DateTime.Utc
    ): Effect.Effect<number> =>
      Effect.gen(function* () {
        if (emittedByTaskId === undefined) return 0
        const task = yield* tasks.byId(companyId, emittedByTaskId).pipe(Effect.option)
        if (Option.isNone(task) || task.value.signalId === undefined) return 0
        const parent = yield* find(companyId, task.value.signalId)
        if (Option.isNone(parent)) return 0
        const elapsedMs =
          DateTime.toEpochMillis(now) - DateTime.toEpochMillis(parent.value.deliverAt)
        return elapsedMs < config.signalChainWindowSeconds * 1000 ? parent.value.depth + 1 : 0
      })

    // ── emit ─────────────────────────────────────────────────────────────────

    const emit = (input: EmitSignalInput): Effect.Effect<Signal, Validation> =>
      Effect.gen(function* () {
        const name = decodeName(input.name)
        if (Option.isNone(name)) {
          return yield* validation(
            ['name'],
            'expected lower-case letters, digits, ".", "_" or "-" (max 64)'
          )
        }
        const note = input.note.trim()
        if (note.length === 0) return yield* validation(['note'], 'say what to do when it goes off')
        if (note.length > 2000)
          return yield* validation(['note'], 'the note is capped at 2000 characters')

        const payload = input.payload ?? {}
        const payloadJson = encodePayload(payload)
        if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
          return yield* validation(
            ['payload'],
            `the payload is capped at ${MAX_PAYLOAD_BYTES} bytes`
          )
        }

        const pending = yield* pendingOf({
          companyId: input.companyId,
          emittedById: input.emittedById
        })
        if (pending.n >= config.maxPendingSignals) {
          return yield* validation(
            ['deliverAt'],
            `you already have ${pending.n} signals waiting (the cap is ${config.maxPendingSignals}); cancel one before setting another`
          )
        }

        const now = yield* DateTime.now
        const depth = yield* depthFor(input.companyId, input.emittedByTaskId, now)
        if (depth > config.maxSignalDepth) {
          return yield* validation(
            ['depth'],
            `this signal chain is ${depth} deep inside ${config.signalChainWindowSeconds}s (the cap is ${config.maxSignalDepth}); stop and tell the human instead`
          )
        }
        // Immediate emits set `deliverAt` to the emit time, which is exactly how the tick later
        // tells "already announced on the bus" from "still to announce" (D19).
        const deliverAt = input.deliverAt ?? now
        const at = iso(now)

        return yield* publisher.transact(input.companyId, (announce) =>
          Effect.gen(function* () {
            const id = newSignalId()
            yield* insert({
              id,
              companyId: input.companyId,
              name: name.value,
              payloadJson,
              emittedByKind: input.emittedByKind,
              emittedById: input.emittedById,
              emittedByTaskId: input.emittedByTaskId ?? null,
              targetAgentId: input.targetAgentId ?? null,
              channelId: input.channelId ?? null,
              threadId: input.threadId ?? null,
              note,
              deliverAt: iso(deliverAt),
              depth,
              at
            })
            const signal = yield* reload(input.companyId, id)
            // D19: a broadcast listener must not wait a tick for something that is due now.
            if (DateTime.lessThanOrEqualTo(deliverAt, now)) {
              yield* announce({ type: 'signal.emitted', payload: { signal } })
            }
            return signal
          })
        )
      })

    // ── status moves (the tick's, and a human's) ──────────────────────────────

    /**
     * `pending → status`, announcing nothing: the bus event belongs to delivery, not to the
     * bookkeeping around it. Returns the row as it now stands, or `None` if it is gone.
     */
    const move = (
      companyId: CompanyId,
      signalId: SignalId,
      status: SignalStatus,
      deliveredTaskId?: TaskId | undefined
    ): Effect.Effect<Option.Option<Signal>> =>
      publisher
        .transact(companyId, (_announce) =>
          settle({
            signalId,
            status,
            deliveredTaskId: deliveredTaskId ?? null,
            at: iso(DateTime.unsafeNow())
          })
        )
        .pipe(Effect.zipRight(find(companyId, signalId)))

    // ── endpoints (D26: a human can see and kill a pending reminder) ──────────

    const list = (
      me: CurrentUserShape,
      input: ListSignalsInput
    ): Effect.Effect<
      { readonly items: ReadonlyArray<Signal>; readonly nextCursor?: string },
      Unauthorized | Forbidden
    > =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_LIMIT)
        const after = Schema.decodeUnknownOption(SignalId)(input.cursor)
        const rows = yield* page({
          companyId: who.companyId,
          emittedById: input.agentId ?? null,
          status: input.status ?? null,
          threadId: input.threadId ?? null,
          after: Option.getOrNull(after),
          limit: limit + 1
        })
        const items = rows.slice(0, limit).map(toSignal)
        const last = items[items.length - 1]
        return rows.length > limit && last !== undefined
          ? { items, nextCursor: last.id }
          : { items }
      })

    /**
     * "Actually, never mind" is half of what a reminder is for (D26). Any member of the company
     * may cancel one: the reminder is visible in a thread they can already read, and refusing
     * unless they also manage the agent would make the common case the hard one. Already
     * delivered or already cancelled is a no-op, not an error.
     */
    const cancel = (
      me: CurrentUserShape,
      signalId: SignalId
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const found = yield* find(who.companyId, signalId)
        if (Option.isNone(found)) {
          return yield* new NotFound({ entity: 'Signal', id: signalId })
        }
        yield* move(who.companyId, signalId, 'cancelled')
      })

    return {
      emit,
      list,
      cancel,
      // ── runner hooks ───────────────────────────────────────────────────────
      byId: find,
      /** By id alone; the tick re-reads a row it already holds, so the company is on it. */
      fresh: (signalId: SignalId): Effect.Effect<Option.Option<Signal>> =>
        rowById(signalId).pipe(Effect.map(Option.map(toSignal))),
      due: (now: DateTime.Utc): Effect.Effect<ReadonlyArray<Signal>> =>
        dueRows(iso(now)).pipe(Effect.map((rows) => rows.map(toSignal))),
      /** `taskId` is absent for a broadcast: the bus event was the whole of its delivery. */
      markDelivered: (companyId: CompanyId, signalId: SignalId, taskId?: TaskId | undefined) =>
        move(companyId, signalId, 'delivered', taskId),
      /** Delivery gave up: the agent is gone, the channel archived, the post refused. */
      markExpired: (companyId: CompanyId, signalId: SignalId) =>
        move(companyId, signalId, 'expired'),
      /** D24: a turn cap is not a failure of delivery, it is the thread saying no. */
      markCancelled: (companyId: CompanyId, signalId: SignalId) =>
        move(companyId, signalId, 'cancelled'),
      /** The agent's own view (`list_signals`), scoped to what it emitted. */
      ofEmitter: (
        companyId: CompanyId,
        emittedById: MemberId,
        status: SignalStatus | undefined
      ): Effect.Effect<ReadonlyArray<Signal>> =>
        page({
          companyId,
          emittedById,
          status: status ?? null,
          threadId: null,
          after: null,
          limit: MAX_LIMIT
        }).pipe(Effect.map((rows) => rows.map(toSignal)))
    } as const
  })
}) {}
