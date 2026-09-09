import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Signals: a named event an agent emits, optionally in the future, that wakes an agent —
 * usually itself, in the same thread, with the same context (docs/build-plan-triggers.md
 * Part II, D19).
 *
 * The row is the whole point. An agent that promises "in three minutes" ends its turn and the
 * process exits; the promise survives here, and the 5-second tick delivers it. `deliver_at` is
 * ISO so `signals_due` is a chronological range scan on `(status, deliver_at)` — the one query
 * the tick makes. `signals_emitter` backs `list_signals`/`cancel_signal` and the D25 pending
 * cap, both of which ask "what has this agent armed".
 *
 * `thread_id` is where the wake lands (D20) and is a plain TEXT with no foreign key, matching
 * how thread ids are held everywhere else: a thread root is a message, but a deleted root must
 * not take the reminder with it. `company_id`, `target_agent_id` and `channel_id` do cascade —
 * a deleted agent's pending wakes are meaningless (D26).
 *
 * `tasks.signal_id` mirrors `tasks.routine_id` (D21): it records where a wake came from, so
 * the thread can render "scheduled by @handle" instead of letting the message read as words
 * the human typed.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE signals (
      id                 TEXT PRIMARY KEY,
      company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      payload_json       TEXT NOT NULL DEFAULT '{}',
      emitted_by_kind    TEXT NOT NULL,
      emitted_by_id      TEXT NOT NULL,
      emitted_by_task_id TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      target_agent_id    TEXT REFERENCES agents(id) ON DELETE CASCADE,
      channel_id         TEXT REFERENCES channels(id) ON DELETE CASCADE,
      thread_id          TEXT,
      note               TEXT NOT NULL,
      deliver_at         TEXT NOT NULL,
      depth              INTEGER NOT NULL DEFAULT 0,
      status             TEXT NOT NULL DEFAULT 'pending',
      delivered_task_id  TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      created_at         TEXT NOT NULL,
      updated_at         TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX signals_due ON signals(status, deliver_at)`
  yield* sql`CREATE INDEX signals_emitter ON signals(company_id, emitted_by_id, status)`
  yield* sql`ALTER TABLE tasks ADD COLUMN signal_id TEXT`
})
