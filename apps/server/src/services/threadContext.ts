import { SqlClient } from '@effect/sql'
import { ThreadContext } from '@taut/contract/domain'
import type { RuntimeKind } from '@taut/contract/domain'
import type { AgentId, ChannelId, CompanyId, MessageId } from '@taut/contract/ids'
import {
  AgentId as AgentIdSchema,
  ChannelId as ChannelIdSchema,
  MessageId as MessageIdSchema
} from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'

import { findAll, findOne, nowIso, run } from '../db/sql.js'
import { EventPublisher } from './publisher.js'

/**
 * The context meter's store (docs/build-plan-context-meter.md D7).
 *
 * One row per `(agent, thread)`, which is one row per context window, because a thread is a
 * session (docs/build-plan-sessions.md D1). `record` is called from the run loop with the last
 * sample of a turn and both writes and broadcasts, so the ring moves while the agent works.
 *
 * Nothing here fails: a meter is an ornament on the conversation, and a conversation must never
 * fail because its ornament could not be written.
 */

/** What `runTask` hands over once a turn's last sample is known. */
export interface RecordContext {
  readonly companyId: CompanyId
  readonly agentId: AgentId
  readonly threadId: MessageId
  readonly channelId: ChannelId
  readonly runtime: RuntimeKind
  readonly usedTokens: number
  readonly maxTokens?: number | undefined
  readonly totalTokens?: number | undefined
  readonly model?: string | undefined
  readonly compactsAutomatically: boolean
  readonly autoCompactThreshold?: number | undefined
  readonly compactedAt?: string | undefined
  readonly compacting?: boolean | undefined
}

const Row = Schema.Struct({
  agent_id: AgentIdSchema,
  thread_id: MessageIdSchema,
  runtime: Schema.String,
  model: Schema.NullOr(Schema.String),
  used_tokens: Schema.Number,
  max_tokens: Schema.NullOr(Schema.Number),
  total_tokens: Schema.NullOr(Schema.Number),
  compacts_auto: Schema.Number,
  compact_at: Schema.NullOr(Schema.Number),
  compacted_at: Schema.NullOr(Schema.String),
  updated_at: Schema.String
})

const toDomain = (r: typeof Row.Type): ThreadContext =>
  new ThreadContext({
    agentId: r.agent_id,
    threadId: r.thread_id,
    runtime: r.runtime as RuntimeKind,
    usedTokens: r.used_tokens,
    ...(r.max_tokens === null ? {} : { maxTokens: r.max_tokens }),
    ...(r.total_tokens === null ? {} : { totalTokens: r.total_tokens }),
    ...(r.model === null ? {} : { model: r.model }),
    compactsAutomatically: r.compacts_auto === 1,
    ...(r.compact_at === null ? {} : { autoCompactThreshold: r.compact_at }),
    ...(r.compacted_at === null ? {} : { compactedAt: r.compacted_at }),
    updatedAt: r.updated_at
  })

export class ThreadContexts extends Effect.Service<ThreadContexts>()('ThreadContexts', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const publisher = yield* EventPublisher
    // Transient: a restarted server must never resurrect an interrupted compaction.
    const compacting = new Set<string>()
    const key = (agentId: AgentId, threadId: MessageId) => `${agentId}:${threadId}`
    const current = (row: typeof Row.Type) =>
      new ThreadContext({
        ...toDomain(row),
        compacting: compacting.has(key(row.agent_id, row.thread_id))
      })

    const one = findOne({
      Request: Schema.Struct({ agentId: AgentIdSchema, threadId: MessageIdSchema }),
      Result: Row,
      execute: (r) => sql`
        SELECT agent_id, thread_id, runtime, model, used_tokens, max_tokens, total_tokens,
               compacts_auto, compact_at, compacted_at, updated_at
        FROM agent_thread_context
        WHERE agent_id = ${r.agentId} AND thread_id = ${r.threadId}`
    })

    const byChannel = findAll({
      Request: Schema.Struct({ channelId: ChannelIdSchema }),
      Result: Row,
      execute: (r) => sql`
        SELECT agent_id, thread_id, runtime, model, used_tokens, max_tokens, total_tokens,
               compacts_auto, compact_at, compacted_at, updated_at
        FROM agent_thread_context
        WHERE channel_id = ${r.channelId}`
    })

    const upsert = run({
      Request: Schema.Struct({
        agentId: AgentIdSchema,
        threadId: MessageIdSchema,
        channelId: ChannelIdSchema,
        runtime: Schema.String,
        model: Schema.NullOr(Schema.String),
        usedTokens: Schema.Number,
        maxTokens: Schema.NullOr(Schema.Number),
        totalTokens: Schema.NullOr(Schema.Number),
        compactsAuto: Schema.Number,
        compactAt: Schema.NullOr(Schema.Number),
        compactedAt: Schema.NullOr(Schema.String),
        at: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO agent_thread_context
          (agent_id, thread_id, channel_id, runtime, model, used_tokens, max_tokens,
           total_tokens, compacts_auto, compact_at, compacted_at, updated_at)
        VALUES (${r.agentId}, ${r.threadId}, ${r.channelId}, ${r.runtime}, ${r.model},
                ${r.usedTokens}, ${r.maxTokens}, ${r.totalTokens}, ${r.compactsAuto},
                ${r.compactAt}, ${r.compactedAt}, ${r.at})
        ON CONFLICT (agent_id, thread_id) DO UPDATE SET
          channel_id    = excluded.channel_id,
          runtime       = excluded.runtime,
          model         = excluded.model,
          used_tokens   = excluded.used_tokens,
          max_tokens    = excluded.max_tokens,
          total_tokens  = excluded.total_tokens,
          compacts_auto = excluded.compacts_auto,
          compact_at    = excluded.compact_at,
          compacted_at  = excluded.compacted_at,
          updated_at    = excluded.updated_at`
    })

    const remove = run({
      Request: Schema.Struct({ agentId: AgentIdSchema, threadId: MessageIdSchema }),
      execute: (r) => sql`
        DELETE FROM agent_thread_context
        WHERE agent_id = ${r.agentId} AND thread_id = ${r.threadId}`
    })

    return {
      get: (agentId: AgentId, threadId: MessageId) =>
        one({ agentId, threadId }).pipe(Effect.map(Option.map(current))),

      /** Every open window in a channel — what the client seeds its rings from on boot. */
      list: (channelId: ChannelId) =>
        byChannel({ channelId }).pipe(Effect.map((rows) => rows.map(current))),

      /** Write the sample and tell everyone watching the channel. */
      record: (input: RecordContext): Effect.Effect<ThreadContext> =>
        Effect.gen(function* () {
          const context = new ThreadContext({
            agentId: input.agentId,
            threadId: input.threadId,
            runtime: input.runtime,
            usedTokens: input.usedTokens,
            ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }),
            ...(input.totalTokens === undefined ? {} : { totalTokens: input.totalTokens }),
            ...(input.model === undefined ? {} : { model: input.model }),
            compactsAutomatically: input.compactsAutomatically,
            ...(input.autoCompactThreshold === undefined
              ? {}
              : { autoCompactThreshold: input.autoCompactThreshold }),
            ...(input.compactedAt === undefined ? {} : { compactedAt: input.compactedAt }),
            compacting: input.compacting ?? false,
            updatedAt: nowIso()
          })
          yield* publisher.transact(input.companyId, (emit) =>
            upsert({
              agentId: context.agentId,
              threadId: context.threadId,
              channelId: input.channelId,
              runtime: context.runtime,
              model: context.model ?? null,
              usedTokens: context.usedTokens,
              maxTokens: context.maxTokens ?? null,
              totalTokens: context.totalTokens ?? null,
              compactsAuto: context.compactsAutomatically ? 1 : 0,
              compactAt: context.autoCompactThreshold ?? null,
              compactedAt: context.compactedAt ?? null,
              at: context.updatedAt
            }).pipe(
              Effect.zipRight(emit({ type: 'agent.context.updated', payload: context })),
              Effect.asVoid
            )
          )
          const id = key(input.agentId, input.threadId)
          if (context.compacting) compacting.add(id)
          else compacting.delete(id)
          return context
        }),

      /**
       * The window is empty again (D8). Called wherever a session is cleared, including the
       * resume-failure retry: that run starts cold, and a ring left at 80% would be a lie
       * told at exactly the moment the user is least able to check it.
       */
      clear: (agentId: AgentId, threadId: MessageId) =>
        remove({ agentId, threadId }).pipe(
          Effect.tap(() => Effect.sync(() => compacting.delete(key(agentId, threadId))))
        )
    } as const
  }),
  dependencies: [EventPublisher.Default]
}) {}
