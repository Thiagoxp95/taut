import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Routines: scheduled agent prompts (docs/build-plan-routines.md).
 *
 * A row is a named prompt owned by one agent and one human. When it comes due the runner
 * posts `@handle <prompt>` *as the owner* into `channel_id` — or, when that is NULL, into the
 * owner↔agent DM — and the ordinary `Scheduler` turns the mention into a task. Nothing here
 * is a second execution path; `tasks.routine_id` only records where a task came from (D9).
 *
 * `schedule_json` is the `Schedule` union encoded with `Schema.parseJson`; `timezone` is the
 * IANA zone its wall-clock times are read in (D4). `next_run_at` is recomputed from *now* on
 * every write and every tick, never from the missed slot (D5), so `routines_due` is the whole
 * query the 30-second tick makes. `last_*` is the only run history kept (D10): the tasks table
 * already has the rest.
 *
 * A deleted channel falls back to the DM (SET NULL) rather than failing the routine; a
 * deleted agent or owner takes its routines with it.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE routines (
      id              TEXT PRIMARY KEY,
      company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      owner_user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      prompt          TEXT NOT NULL,
      channel_id      TEXT REFERENCES channels(id) ON DELETE SET NULL,
      schedule_json   TEXT NOT NULL,
      timezone        TEXT NOT NULL,
      enabled         INTEGER NOT NULL DEFAULT 1,
      next_run_at     TEXT,
      last_run_at     TEXT,
      last_task_id    TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      last_status     TEXT,
      created_at      TEXT NOT NULL,
      updated_at      TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX routines_due ON routines(enabled, next_run_at)`
  yield* sql`CREATE INDEX routines_agent ON routines(company_id, agent_id, created_at)`
  yield* sql`ALTER TABLE tasks ADD COLUMN routine_id TEXT`
})
