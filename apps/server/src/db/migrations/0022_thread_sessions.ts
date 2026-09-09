import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Thread = session (docs/build-plan-sessions.md D1).
 *
 * `agent_sessions` was keyed `(agent_id, channel_id)`, so every thread in a channel shared one
 * runtime session and a DM was one endless session. It is now keyed `(agent_id, thread_id)`:
 * one thread, one session, one agent copy with its own context.
 *
 * The table is a cache, not a record, so it is dropped rather than migrated. There is no
 * meaningful way to map a channel-scoped session onto a thread, and every id in it is
 * unresumable anyway: the working directory used to be `<home>/work/<taskId>`, unique per task,
 * while claude-code stores sessions at `~/.claude/projects/<encoded-cwd>/<id>.jsonl` — so
 * `--resume` has never once found the session it was handed. Every agent starts its next thread
 * cold, which is the correct outcome.
 *
 * `last_message_id` is D7: on a resume the prompt injects only the thread messages after it,
 * because the resumed runtime already holds everything before it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`DROP TABLE IF EXISTS agent_sessions`
  yield* sql`
    CREATE TABLE agent_sessions (
      agent_id        TEXT NOT NULL REFERENCES agents(id)   ON DELETE CASCADE,
      thread_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      runtime         TEXT NOT NULL,
      session_id      TEXT NOT NULL,
      last_message_id TEXT,
      updated_at      TEXT NOT NULL,
      PRIMARY KEY (agent_id, thread_id)
    )`
  yield* sql`CREATE INDEX agent_sessions_channel ON agent_sessions(channel_id)`
})
