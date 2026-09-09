import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import { type Task, TaskStatus } from '@taut/contract/domain'
import { Conflict, Forbidden, NotFound, type Unauthorized } from '@taut/contract/errors'
import {
  AgentId,
  ChannelId,
  CompanyId,
  MessageId,
  RoutineId,
  SignalId,
  SubscriptionId,
  TaskId,
  UserId,
  newTaskId
} from '@taut/contract/ids'
import { DateTime, Effect, Option, Schema } from 'effect'
import { Count, findAll, findOne, nowIso, run, single } from '../db/sql.js'
import { TaskRow, toTask } from '../domain/rows.js'
import { type Actor, actor, isAdmin } from './access.js'
import { EventPublisher } from './publisher.js'

/** Every task query reads `FROM tasks t`; `channel_kind` is joined so `Task.channelKind` is free. */
const COLUMNS =
  't.id, t.company_id, t.agent_id, t.channel_id, t.thread_id, t.message_id, t.subscription_id, t.status, t.started_at, t.ended_at, t.error, t.parent_task_id, t.handoff_depth, t.trigger_message_id, t.trigger_user_id, t.routine_id, t.signal_id, ' +
  '(SELECT c.kind FROM channels c WHERE c.id = t.channel_id) AS channel_kind'

const ENDED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'failed', 'cancelled'])
const MAX_LIMIT = 100

export interface ListTasksInput {
  readonly agentId?: AgentId | undefined
  readonly channelId?: ChannelId | undefined
  readonly status?: TaskStatus | undefined
  /** Only runs that have not ended — what the client shimmers (docs/build-plan-shimmer.md D9). */
  readonly live?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

export interface CreateTaskInput {
  readonly agentId: AgentId
  readonly channelId: ChannelId
  readonly threadId: MessageId
  readonly messageId: MessageId
  readonly subscriptionId?: SubscriptionId | undefined
  readonly status?: TaskStatus | undefined
  /** §9 handoffs: the task this one was spawned from and its depth (root = 0). */
  readonly parentTaskId?: TaskId | undefined
  readonly handoffDepth?: number | undefined
  /** The mention/DM that spawned the task; one task per (agent, trigger). */
  readonly triggerMessageId?: MessageId | undefined
  /** The human to notify on done/failed (unset when an agent triggered it). */
  readonly triggerUserId?: UserId | undefined
  /** The routine whose fire posted the trigger (docs/build-plan-routines.md D9). */
  readonly routineId?: RoutineId | undefined
  /** The signal whose delivery posted the trigger (docs/build-plan-triggers.md D21). */
  readonly signalId?: SignalId | undefined
}

/** The row plus the Phase 4 columns the public `Task` does not carry. */
export interface TaskInternal {
  readonly task: Task
  readonly parentTaskId: TaskId | undefined
  readonly handoffDepth: number
  readonly triggerMessageId: MessageId | undefined
  readonly triggerUserId: UserId | undefined
  /** `true` when the reply is a thread reply; DM replies are top-level. */
  readonly repliesInThread: boolean
}

export interface UpdateTaskInput {
  readonly status?: TaskStatus | undefined
  readonly subscriptionId?: SubscriptionId | null | undefined
  readonly endedAt?: string | undefined
  readonly error?: string | null | undefined
}

/**
 * Agent runs (docs/agent-model.md §11). Phase 3 ships the read side + `cancel`; the Phase 4
 * scheduler creates and drives rows through `create`/`update` inside its own
 * `EventPublisher.transact` (it emits `agent.task.*` with the streaming message itself).
 * Visibility follows the task's channel: admin+ see everything, members what they belong to.
 */
export class Tasks extends Effect.Service<Tasks>()('Tasks', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const publisher = yield* EventPublisher

    const Key = Schema.Struct({ companyId: CompanyId, taskId: TaskId })

    const byId = findOne({
      Request: Key,
      Result: TaskRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM tasks t WHERE t.company_id = ${r.companyId} AND t.id = ${r.taskId}`
    })

    const page = findAll({
      Request: Schema.Struct({
        companyId: CompanyId,
        userId: UserId,
        /** 1 = admin+ (sees every channel); SQLite binds no booleans. */
        admin: Schema.Number,
        agentId: Schema.NullOr(AgentId),
        channelId: Schema.NullOr(ChannelId),
        status: Schema.NullOr(TaskStatus),
        /** 1 = only runs that have not ended; SQLite binds no booleans. */
        live: Schema.Number,
        before: Schema.NullOr(TaskId),
        limit: Schema.Number
      }),
      Result: TaskRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM tasks t
        WHERE t.company_id = ${r.companyId}
          AND (${r.agentId} IS NULL OR t.agent_id = ${r.agentId})
          AND (${r.channelId} IS NULL OR t.channel_id = ${r.channelId})
          AND (${r.status} IS NULL OR t.status = ${r.status})
          AND (${r.live} = 0 OR t.status NOT IN ('done', 'failed', 'cancelled'))
          AND (${r.admin} = 1 OR EXISTS (
            SELECT 1 FROM channel_members m
            WHERE m.channel_id = t.channel_id AND m.member_kind = 'user' AND m.member_id = ${r.userId}))
          AND (${r.before} IS NULL OR (t.started_at, t.rowid) < (
            SELECT b.started_at, b.rowid FROM tasks b WHERE b.id = ${r.before}))
        ORDER BY t.started_at DESC, t.rowid DESC
        LIMIT ${r.limit}`
    })

    const memberOfChannel = single({
      Request: Schema.Struct({ channelId: ChannelId, userId: UserId }),
      Result: Count,
      execute: (r) => sql`
        SELECT COUNT(*) AS n FROM channel_members
        WHERE channel_id = ${r.channelId} AND member_kind = 'user' AND member_id = ${r.userId}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: TaskId,
        companyId: CompanyId,
        agentId: AgentId,
        channelId: ChannelId,
        threadId: MessageId,
        messageId: MessageId,
        subscriptionId: Schema.NullOr(SubscriptionId),
        status: TaskStatus,
        startedAt: Schema.String,
        parentTaskId: Schema.NullOr(TaskId),
        handoffDepth: Schema.Number,
        triggerMessageId: Schema.NullOr(MessageId),
        triggerUserId: Schema.NullOr(UserId),
        routineId: Schema.NullOr(RoutineId),
        signalId: Schema.NullOr(SignalId)
      }),
      execute: (r) => sql`
        INSERT INTO tasks (id, company_id, agent_id, channel_id, thread_id, message_id, subscription_id, status, started_at,
                           parent_task_id, handoff_depth, trigger_message_id, trigger_user_id, routine_id, signal_id)
        VALUES (${r.id}, ${r.companyId}, ${r.agentId}, ${r.channelId}, ${r.threadId}, ${r.messageId},
                ${r.subscriptionId}, ${r.status}, ${r.startedAt},
                ${r.parentTaskId}, ${r.handoffDepth}, ${r.triggerMessageId}, ${r.triggerUserId}, ${r.routineId}, ${r.signalId})`
    })

    const byTriggerRow = findOne({
      Request: Schema.Struct({
        companyId: CompanyId,
        agentId: AgentId,
        triggerMessageId: MessageId
      }),
      Result: TaskRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM tasks t
        WHERE t.company_id = ${r.companyId} AND t.agent_id = ${r.agentId} AND t.trigger_message_id = ${r.triggerMessageId}
        ORDER BY t.rowid DESC LIMIT 1`
    })

    /** The agent's live (queued/running) task in a thread — the parent of anything it spawns there. */
    const liveInThread = findOne({
      Request: Schema.Struct({ companyId: CompanyId, agentId: AgentId, threadId: MessageId }),
      Result: TaskRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM tasks t
        WHERE t.company_id = ${r.companyId} AND t.agent_id = ${r.agentId} AND t.thread_id = ${r.threadId}
          AND t.status IN ('queued', 'running')
        ORDER BY t.started_at DESC, t.rowid DESC LIMIT 1`
    })

    /** The agent's live task anywhere — the parent when it posts outside its own task thread. */
    const liveOfAgent = findOne({
      Request: Schema.Struct({ companyId: CompanyId, agentId: AgentId }),
      Result: TaskRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM tasks t
        WHERE t.company_id = ${r.companyId} AND t.agent_id = ${r.agentId}
          AND t.status IN ('queued', 'running')
        ORDER BY (t.status = 'running') DESC, t.started_at DESC, t.rowid DESC LIMIT 1`
    })

    /**
     * The task that wrote a message. `message_id` is the task's own streaming reply, so this is
     * exact and — unlike `liveOf` — still true after the task ends. It is what keeps the handoff
     * depth honest for an agent→agent exchange: without it a fast-finishing task looks like no
     * parent at all, the depth resets to 0 on every hop, and two agents can talk forever.
     */
    const byMessageRow = findOne({
      Request: Schema.Struct({ companyId: CompanyId, messageId: MessageId }),
      Result: TaskRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM tasks t
        WHERE t.company_id = ${r.companyId} AND t.message_id = ${r.messageId} LIMIT 1`
    })

    const liveRows = findAll({
      Request: Schema.Void,
      Result: TaskRow,
      execute: () => sql`
        SELECT ${sql.literal(COLUMNS)} FROM tasks t WHERE t.status IN ('queued', 'running')
        ORDER BY t.started_at ASC, t.rowid ASC`
    })

    const streamingReplyRow = findOne({
      Request: Schema.Struct({ companyId: CompanyId, messageId: MessageId }),
      Result: Schema.Struct({ thread_id: Schema.NullOr(MessageId) }),
      execute: (r) =>
        sql`SELECT thread_id FROM messages WHERE company_id = ${r.companyId} AND id = ${r.messageId}`
    })

    const updateRow = run({
      Request: Schema.Struct({
        ...Key.fields,
        status: TaskStatus,
        subscriptionId: Schema.NullOr(SubscriptionId),
        endedAt: Schema.NullOr(Schema.String),
        error: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        UPDATE tasks SET status = ${r.status}, subscription_id = ${r.subscriptionId},
          ended_at = ${r.endedAt}, error = ${r.error}
        WHERE company_id = ${r.companyId} AND id = ${r.taskId}`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    const load = (companyId: CompanyId, taskId: TaskId): Effect.Effect<TaskRow, NotFound> =>
      byId({ companyId, taskId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Task', id: taskId })),
            onSome: Effect.succeed
          })
        )
      )

    const requireView = (who: Actor, row: TaskRow): Effect.Effect<void, Forbidden> =>
      isAdmin(who.role)
        ? Effect.void
        : memberOfChannel({ channelId: row.channel_id, userId: who.userId }).pipe(
            Effect.flatMap((c) =>
              c.n > 0
                ? Effect.void
                : Effect.fail(new Forbidden({ message: "Not a member of the task's channel" }))
            )
          )

    // ── endpoints ────────────────────────────────────────────────────────────

    const list = (
      me: CurrentUserShape,
      input: ListTasksInput
    ): Effect.Effect<
      { readonly items: ReadonlyArray<Task>; readonly nextCursor?: string },
      Unauthorized
    > =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const limit = Math.min(Math.max(input.limit ?? 50, 1), MAX_LIMIT)
        const before = Schema.decodeUnknownOption(TaskId)(input.cursor)
        const rows = yield* page({
          companyId: who.companyId,
          userId: who.userId,
          admin: isAdmin(who.role) ? 1 : 0,
          agentId: input.agentId ?? null,
          channelId: input.channelId ?? null,
          status: input.status ?? null,
          live: input.live === true ? 1 : 0,
          before: Option.getOrNull(before),
          limit: limit + 1
        })
        const items = rows.slice(0, limit).map(toTask)
        const last = items[items.length - 1]
        return rows.length > limit && last !== undefined
          ? { items, nextCursor: last.id }
          : { items }
      })

    const get = (
      me: CurrentUserShape,
      taskId: TaskId
    ): Effect.Effect<Task, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, taskId)
        yield* requireView(who, row)
        return toTask(row)
      })

    /** Marks the task `cancelled`. Phase 4 additionally kills the process. */
    const cancel = (
      me: CurrentUserShape,
      taskId: TaskId
    ): Effect.Effect<Task, Unauthorized | NotFound | Forbidden | Conflict> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who.companyId, taskId)
        yield* requireView(who, row)
        if (ENDED.has(row.status)) {
          return yield* new Conflict({ reason: `Task already ${row.status}` })
        }
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* updateRow({
              companyId: who.companyId,
              taskId,
              status: 'cancelled',
              subscriptionId: row.subscription_id,
              endedAt: nowIso(),
              error: row.error
            })
            const task = toTask(yield* load(who.companyId, taskId).pipe(Effect.orDie))
            yield* emit({ type: 'task.updated', payload: { task } })
            return task
          })
        )
      })

    // ── scheduler hooks (Phase 4): no events — the caller emits `agent.task.*` ──

    const create = (companyId: CompanyId, input: CreateTaskInput): Effect.Effect<Task> =>
      Effect.gen(function* () {
        const id = newTaskId()
        yield* insert({
          id,
          companyId,
          agentId: input.agentId,
          channelId: input.channelId,
          threadId: input.threadId,
          messageId: input.messageId,
          subscriptionId: input.subscriptionId ?? null,
          status: input.status ?? 'queued',
          startedAt: nowIso(),
          parentTaskId: input.parentTaskId ?? null,
          handoffDepth: input.handoffDepth ?? 0,
          triggerMessageId: input.triggerMessageId ?? null,
          triggerUserId: input.triggerUserId ?? null,
          routineId: input.routineId ?? null,
          signalId: input.signalId ?? null
        })
        return toTask(yield* load(companyId, id).pipe(Effect.orDie))
      })

    const toInternal = (row: TaskRow): Effect.Effect<TaskInternal> =>
      streamingReplyRow({ companyId: row.company_id, messageId: row.message_id }).pipe(
        Effect.map((reply) => ({
          task: toTask(row),
          parentTaskId: row.parent_task_id ?? undefined,
          handoffDepth: row.handoff_depth,
          triggerMessageId: row.trigger_message_id ?? undefined,
          triggerUserId: row.trigger_user_id ?? undefined,
          repliesInThread: Option.isSome(reply) && reply.value.thread_id !== null
        }))
      )

    const update = (
      companyId: CompanyId,
      taskId: TaskId,
      input: UpdateTaskInput
    ): Effect.Effect<Task, NotFound> =>
      Effect.gen(function* () {
        const row = yield* load(companyId, taskId)
        yield* updateRow({
          companyId,
          taskId,
          status: input.status ?? row.status,
          subscriptionId:
            input.subscriptionId === undefined ? row.subscription_id : input.subscriptionId,
          endedAt:
            input.endedAt ?? (row.ended_at === null ? null : DateTime.formatIso(row.ended_at)),
          error: input.error === undefined ? row.error : input.error
        })
        return toTask(yield* load(companyId, taskId).pipe(Effect.orDie))
      })

    return {
      list,
      get,
      cancel,
      create,
      update,
      byId: (companyId: CompanyId, taskId: TaskId) =>
        load(companyId, taskId).pipe(Effect.map(toTask)),
      internal: (companyId: CompanyId, taskId: TaskId): Effect.Effect<TaskInternal, NotFound> =>
        load(companyId, taskId).pipe(Effect.flatMap(toInternal)),
      byTrigger: (
        companyId: CompanyId,
        agentId: AgentId,
        triggerMessageId: MessageId
      ): Effect.Effect<Option.Option<Task>> =>
        byTriggerRow({ companyId, agentId, triggerMessageId }).pipe(Effect.map(Option.map(toTask))),
      liveInThread: (
        companyId: CompanyId,
        agentId: AgentId,
        threadId: MessageId
      ): Effect.Effect<Option.Option<TaskInternal>> =>
        liveInThread({ companyId, agentId, threadId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (r) => toInternal(r).pipe(Effect.map(Option.some))
            })
          )
        ),
      /** The task whose reply is `messageId` (running or long finished). */
      byMessage: (
        companyId: CompanyId,
        messageId: MessageId
      ): Effect.Effect<Option.Option<TaskInternal>> =>
        byMessageRow({ companyId, messageId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (r) => toInternal(r).pipe(Effect.map(Option.some))
            })
          )
        ),
      liveOf: (
        companyId: CompanyId,
        agentId: AgentId
      ): Effect.Effect<Option.Option<TaskInternal>> =>
        liveOfAgent({ companyId, agentId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (r) => toInternal(r).pipe(Effect.map(Option.some))
            })
          )
        ),
      /** Every queued/running task across companies (startup recovery). */
      live: (): Effect.Effect<ReadonlyArray<Task>> =>
        liveRows(undefined).pipe(Effect.map((rows) => rows.map(toTask)))
    } as const
  })
}) {}
