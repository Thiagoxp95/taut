/**
 * The head's side of the department boundary (docs/agent-model.md §9).
 *
 * An agent that tries to reach another department is refused outright — there is no gate to
 * approve — and the attempt is recorded here as a `handover` addressed to the **sending
 * agent's own head**. The head has exactly two moves: `raise` it, which opens a DM with the
 * other department's head as the caller, or `dismiss` it. Neither unblocks the agent: whatever
 * happens next is a human assigning work inside their own department.
 *
 * Repeated attempts collapse onto the first `open` row for the same (from, to, thread), so a
 * looping agent cannot flood its head; the thread itself carries every attempt.
 */
import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import type { Department, Handover, HandoverStatus } from '@taut/contract/domain'
import { Conflict, Forbidden, NotFound, Unauthorized, Validation } from '@taut/contract/errors'
import {
  type AgentId,
  type ChannelId,
  type CompanyId,
  type HandoverId,
  type MessageId,
  type TaskId,
  makeId
} from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import { HandoverRow, toHandover } from '../domain/rows.js'
import { type Actor, actor, isAdmin } from './access.js'
import { Agents } from './agents.js'
import { Channels } from './channels.js'
import { Messages } from './messages.js'

export interface RecordHandoverInput {
  readonly companyId: CompanyId
  readonly fromAgentId: AgentId
  readonly toAgentId: AgentId
  readonly channelId: ChannelId
  readonly threadId?: MessageId | undefined
  readonly taskId?: TaskId | undefined
  /** What the agent tried to say. */
  readonly text: string
}

const COLUMNS =
  'id, company_id, from_agent_id, from_department_id, from_head_user_id, to_agent_id, ' +
  'to_department_id, to_head_user_id, channel_id, thread_id, task_id, text, status, ' +
  'raised_message_id, created_at, resolved_at, resolved_by_user_id'

export class Handovers extends Effect.Service<Handovers>()('Handovers', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const agents = yield* Agents
    const channels = yield* Channels
    const messages = yield* Messages

    const byId = findOne({
      Request: Schema.Struct({ companyId: Schema.String, id: Schema.String }),
      Result: HandoverRow,
      execute: (r) =>
        sql`SELECT ${sql.unsafe(COLUMNS)} FROM handovers
            WHERE company_id = ${r.companyId} AND id = ${r.id}`
    })

    const openBetween = findOne({
      Request: Schema.Struct({
        companyId: Schema.String,
        fromAgentId: Schema.String,
        toAgentId: Schema.String,
        threadKey: Schema.String
      }),
      Result: HandoverRow,
      execute: (r) =>
        sql`SELECT ${sql.unsafe(COLUMNS)} FROM handovers
            WHERE company_id = ${r.companyId} AND status = 'open'
              AND from_agent_id = ${r.fromAgentId} AND to_agent_id = ${r.toAgentId}
              AND COALESCE(thread_id, channel_id) = ${r.threadKey}
            ORDER BY created_at DESC LIMIT 1`
    })

    const listRows = findAll({
      Request: Schema.Struct({
        companyId: Schema.String,
        status: Schema.String,
        /** NULL for an admin: every department's queue. */
        headUserId: Schema.NullOr(Schema.String)
      }),
      Result: HandoverRow,
      execute: (r) =>
        sql`SELECT ${sql.unsafe(COLUMNS)} FROM handovers
            WHERE company_id = ${r.companyId} AND status = ${r.status}
              AND (${r.headUserId} IS NULL OR from_head_user_id = ${r.headUserId})
            ORDER BY created_at DESC LIMIT 200`
    })

    const insert = run({
      Request: Schema.Struct({
        id: Schema.String,
        companyId: Schema.String,
        fromAgentId: Schema.String,
        fromDepartmentId: Schema.String,
        fromHeadUserId: Schema.NullOr(Schema.String),
        toAgentId: Schema.String,
        toDepartmentId: Schema.String,
        toHeadUserId: Schema.NullOr(Schema.String),
        channelId: Schema.String,
        threadId: Schema.NullOr(Schema.String),
        taskId: Schema.NullOr(Schema.String),
        text: Schema.String,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO handovers (id, company_id, from_agent_id, from_department_id, from_head_user_id,
          to_agent_id, to_department_id, to_head_user_id, channel_id, thread_id, task_id, text,
          status, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.fromAgentId}, ${r.fromDepartmentId}, ${r.fromHeadUserId},
          ${r.toAgentId}, ${r.toDepartmentId}, ${r.toHeadUserId}, ${r.channelId}, ${r.threadId},
          ${r.taskId}, ${r.text}, 'open', ${r.createdAt})`
    })

    const resolve = run({
      Request: Schema.Struct({
        id: Schema.String,
        status: Schema.String,
        raisedMessageId: Schema.NullOr(Schema.String),
        at: Schema.String,
        byUserId: Schema.String
      }),
      execute: (r) =>
        sql`UPDATE handovers
            SET status = ${r.status}, raised_message_id = ${r.raisedMessageId},
                resolved_at = ${r.at}, resolved_by_user_id = ${r.byUserId}
            WHERE id = ${r.id}`
    })

    /** An agent's primary department: the oldest one it belongs to (`departmentsOf` order). */
    const primaryDepartment = (agentId: AgentId): Effect.Effect<Option.Option<Department>> =>
      agents.departmentsOf(agentId).pipe(Effect.map((ds) => Option.fromNullable(ds[0])))

    const handleOf = (agentId: AgentId, companyId: CompanyId): Effect.Effect<string> =>
      agents.byId(companyId, agentId).pipe(
        Effect.map((a) => `@${a.handle}`),
        Effect.orElseSucceed(() => agentId)
      )

    /**
     * Record a refused attempt. Returns `None` when there is nothing a head could act on:
     * either agent outside a department, or an `open` row for the same pair already waiting.
     */
    const record = (input: RecordHandoverInput): Effect.Effect<Option.Option<Handover>> =>
      Effect.gen(function* () {
        const [from, to] = yield* Effect.all([
          primaryDepartment(input.fromAgentId),
          primaryDepartment(input.toAgentId)
        ])
        if (Option.isNone(from) || Option.isNone(to)) return Option.none()
        const existing = yield* openBetween({
          companyId: input.companyId,
          fromAgentId: input.fromAgentId,
          toAgentId: input.toAgentId,
          threadKey: input.threadId ?? input.channelId
        })
        if (Option.isSome(existing)) return Option.some(toHandover(existing.value))
        const id = makeId('hov')
        yield* insert({
          id,
          companyId: input.companyId,
          fromAgentId: input.fromAgentId,
          fromDepartmentId: from.value.id,
          fromHeadUserId: from.value.headUserId ?? null,
          toAgentId: input.toAgentId,
          toDepartmentId: to.value.id,
          toHeadUserId: to.value.headUserId ?? null,
          channelId: input.channelId,
          threadId: input.threadId ?? null,
          taskId: input.taskId ?? null,
          text: input.text,
          createdAt: nowIso()
        })
        return (yield* byId({ companyId: input.companyId, id })).pipe(Option.map(toHandover))
      }).pipe(
        // A handover is a courtesy to the head, never a precondition of the refusal: if it
        // cannot be written the agent is still blocked, and the note in the thread still lands.
        Effect.catchAllCause((cause) =>
          Effect.logWarning('handovers: could not record a refused attempt', cause).pipe(
            Effect.as(Option.none<Handover>())
          )
        )
      )

    /** Read a row back after a write; a row that vanished mid-request is a defect, not a 404. */
    const reload = (companyId: CompanyId, id: HandoverId): Effect.Effect<Handover> =>
      byId({ companyId, id }).pipe(
        Effect.map(Option.map(toHandover)),
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.die(`handover ${id} vanished`),
            onSome: Effect.succeed
          })
        )
      )

    const load = (
      who: Actor,
      handoverId: HandoverId
    ): Effect.Effect<HandoverRow, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const row = yield* byId({ companyId: who.companyId, id: handoverId })
        if (Option.isNone(row)) {
          return yield* new NotFound({ entity: 'Handover', id: handoverId })
        }
        if (!isAdmin(who.role) && row.value.from_head_user_id !== who.userId) {
          return yield* new Forbidden({
            message: 'Only the head of the department it came from (or an admin) can act on it'
          })
        }
        return row.value
      })

    const list = (
      me: CurrentUserShape,
      query: { readonly status?: HandoverStatus | undefined }
    ): Effect.Effect<ReadonlyArray<Handover>, Unauthorized> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const rows = yield* listRows({
          companyId: who.companyId,
          status: query.status ?? 'open',
          headUserId: isAdmin(who.role) ? null : who.userId
        })
        return rows.map(toHandover)
      })

    /** The DM the other head reads when nobody wrote their own note. */
    const defaultNote = (row: HandoverRow): Effect.Effect<string> =>
      Effect.gen(function* () {
        const [fromHandle, toHandle] = yield* Effect.all([
          handleOf(row.from_agent_id, row.company_id),
          handleOf(row.to_agent_id, row.company_id)
        ])
        const quoted = row.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')
        return [
          `**Handover** — ${fromHandle} tried to reach ${toHandle} in your department and was blocked at the boundary.`,
          '',
          quoted,
          '',
          'Can your side pick this up? If yes, assign it to one of your agents — mine cannot.'
        ].join('\n')
      })

    const raise = (
      me: CurrentUserShape,
      handoverId: HandoverId,
      input: { readonly text?: string | undefined }
    ): Effect.Effect<Handover, Unauthorized | NotFound | Forbidden | Conflict | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who, handoverId)
        if (row.status !== 'open') {
          return yield* new Conflict({ reason: `This handover is already ${row.status}` })
        }
        if (row.to_head_user_id === null) {
          return yield* new Conflict({
            reason: 'That department has no head yet — set one in its settings first'
          })
        }
        if (row.to_head_user_id === who.userId) {
          return yield* new Conflict({
            reason: 'You head both departments — assign the work yourself and dismiss this'
          })
        }
        const dm = yield* channels.dm(me, {
          memberKind: 'user',
          memberId: row.to_head_user_id
        })
        const body = input.text ?? (yield* defaultNote(row))
        const message = yield* messages.create(me, { channelId: dm.id, body })
        yield* resolve({
          id: row.id,
          status: 'raised',
          raisedMessageId: message.id,
          at: nowIso(),
          byUserId: who.userId
        })
        return yield* reload(who.companyId, row.id)
      })

    const dismiss = (
      me: CurrentUserShape,
      handoverId: HandoverId
    ): Effect.Effect<Handover, Unauthorized | NotFound | Forbidden | Conflict> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who, handoverId)
        if (row.status !== 'open') {
          return yield* new Conflict({ reason: `This handover is already ${row.status}` })
        }
        yield* resolve({
          id: row.id,
          status: 'dismissed',
          raisedMessageId: null,
          at: nowIso(),
          byUserId: who.userId
        })
        return yield* reload(who.companyId, row.id)
      })

    return { record, list, raise, dismiss } as const
  })
}) {}
