import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * How full each agent's context window is, per thread
 * (docs/build-plan-context-meter.md D7).
 *
 * A thread is a session (docs/build-plan-sessions.md D1), so a thread is a context window, and
 * two agents in one thread are two copies with two windows and two rows.
 *
 * Its own table rather than columns on `agent_sessions`, because the two have the same key and
 * different lifetimes: a runtime can report its occupancy without ever handing back a resumable
 * session id, and the first sample of a run lands long before the session row exists. What the
 * two do share is the reset — `AgentSessions.clear` deletes here too (D8), because a run that
 * could not resume starts with an empty window and a stale ring is the most misleading state
 * this feature can enter.
 *
 * `used_tokens` is an occupancy, never a running total: the last sample of a run wins and the
 * earlier ones are discarded (D2). `total_tokens` is the opposite — the cumulative billed tokens
 * of the thread — and exists only for the hover card, which shows the two side by side precisely
 * because they diverge.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE agent_thread_context (
      agent_id      TEXT NOT NULL REFERENCES agents(id)   ON DELETE CASCADE,
      thread_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      runtime       TEXT NOT NULL,
      model         TEXT,
      used_tokens   INTEGER NOT NULL,
      max_tokens    INTEGER,
      total_tokens  INTEGER,
      compacts_auto INTEGER NOT NULL DEFAULT 0,
      compact_at    INTEGER,
      compacted_at  TEXT,
      updated_at    TEXT NOT NULL,
      PRIMARY KEY (agent_id, thread_id)
    )`
  yield* sql`CREATE INDEX agent_thread_context_channel ON agent_thread_context(channel_id)`
})
