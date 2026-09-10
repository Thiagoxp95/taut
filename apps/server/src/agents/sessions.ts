import { SqlClient } from '@effect/sql'
import { RuntimeKind } from '@taut/contract/domain'
import { AgentId, ChannelId, MessageId } from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { findOne, nowIso, run } from '../db/sql.js'

/**
 * The runtime session an agent used **in one thread** (`agent_sessions`), so the next turn of
 * that conversation resumes it (`claude -p --resume <sid>`, docs/agent-model.md §9).
 *
 * A thread is a session (docs/build-plan-sessions.md D1): every thread is its own copy of the
 * agent with its own context, and the working directory is the thread's too (D3) — without that
 * the resume can never find the session file. Keyed by runtime as well, so switching an agent
 * from claude-code to codex never resumes a foreign session id.
 *
 * `lastMessageId` is the last thread message the runtime has already seen; on a resume the
 * prompt carries only what came after it (D7).
 */
export interface ResumePoint {
  readonly sessionId: string
  readonly lastMessageId: MessageId | undefined
}

export class AgentSessions extends Effect.Service<AgentSessions>()('AgentSessions', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const Key = Schema.Struct({ agentId: AgentId, threadId: MessageId, runtime: RuntimeKind })

    const row = findOne({
      Request: Key,
      Result: Schema.Struct({
        session_id: Schema.String,
        last_message_id: Schema.NullOr(MessageId)
      }),
      execute: (r) => sql`
        SELECT session_id, last_message_id FROM agent_sessions
        WHERE agent_id = ${r.agentId} AND thread_id = ${r.threadId} AND runtime = ${r.runtime}`
    })

    const upsert = run({
      Request: Schema.Struct({
        ...Key.fields,
        channelId: ChannelId,
        sessionId: Schema.String,
        lastMessageId: Schema.NullOr(MessageId),
        at: Schema.String,
        mandate: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        INSERT INTO agent_sessions
          (agent_id, thread_id, channel_id, runtime, session_id, last_message_id, updated_at)
        SELECT ${r.agentId}, ${r.threadId}, ${r.channelId}, ${r.runtime}, ${r.sessionId},
               ${r.lastMessageId}, ${r.at}
        WHERE ${r.mandate} IS NULL OR EXISTS (
          SELECT 1 FROM agents WHERE id = ${r.agentId} AND mandate = ${r.mandate} AND archived_at IS NULL
        )
        ON CONFLICT (agent_id, thread_id) DO UPDATE SET
          channel_id = excluded.channel_id,
          runtime = excluded.runtime,
          session_id = excluded.session_id,
          last_message_id = excluded.last_message_id,
          updated_at = excluded.updated_at`
    })

    const remove = run({
      Request: Schema.Struct({ agentId: AgentId, threadId: MessageId }),
      execute: (r) =>
        sql`DELETE FROM agent_sessions WHERE agent_id = ${r.agentId} AND thread_id = ${r.threadId}`
    })

    /**
     * Clearing a session empties the window with it
     * (docs/build-plan-context-meter.md D8). The next run of this thread starts cold, so a
     * meter still reading 80% would be wrong from its first frame. Done in SQL here rather
     * than through `ThreadContexts` so that resuming stays free of the meter's dependencies.
     */
    const removeContext = run({
      Request: Schema.Struct({ agentId: AgentId, threadId: MessageId }),
      execute: (r) => sql`
        DELETE FROM agent_thread_context
        WHERE agent_id = ${r.agentId} AND thread_id = ${r.threadId}`
    })

    return {
      get: (agentId: AgentId, threadId: MessageId, runtime: RuntimeKind) =>
        row({ agentId, threadId, runtime }).pipe(
          Effect.map(
            Option.map((r): ResumePoint => ({
              sessionId: r.session_id,
              lastMessageId: r.last_message_id ?? undefined
            }))
          )
        ),
      set: (
        agentId: AgentId,
        threadId: MessageId,
        channelId: ChannelId,
        runtime: RuntimeKind,
        sessionId: string,
        lastMessageId: MessageId | undefined,
        /** Snapshot at run start: an approval during the reply must not resurrect the old session. */
        mandate?: string
      ) =>
        upsert({
          agentId,
          threadId,
          channelId,
          runtime,
          sessionId,
          lastMessageId: lastMessageId ?? null,
          at: nowIso(),
          mandate: mandate ?? null
        }),
      clear: (agentId: AgentId, threadId: MessageId) =>
        remove({ agentId, threadId }).pipe(Effect.zipRight(removeContext({ agentId, threadId })))
    } as const
  })
}) {}
