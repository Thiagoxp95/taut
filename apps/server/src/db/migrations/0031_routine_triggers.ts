import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Triggers: a routine's fire condition stops being a clock (docs/build-plan-triggers.md D1).
 * `schedule_json` + `timezone` collapse into one `trigger_json` holding the `Trigger` union,
 * whose `schedule` arm is exactly the two columns it replaces — so the backfill is a pure SQL
 * `json_object(...)` and no row is decoded in JS on the way through.
 *
 * Two denormalised columns ride alongside it because SQLite cannot index inside a JSON blob:
 * `trigger_kind` is the `All · Schedules · Triggers` filter, and `trigger_event` is the hot
 * path — "an event just landed, which routines want it" has to be one indexed lookup, not a
 * table scan that decodes every blob (D9). `trigger_event` is NULL for a schedule, which is
 * also why `next_run_at` stays NULL for an event trigger: `routines_due` then never returns
 * one and the 30-second tick never sees it.
 *
 * `DROP COLUMN` needs SQLite >= 3.35; `@effect/sql-sqlite-node` ships well past that.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE routines ADD COLUMN trigger_json TEXT`
  yield* sql`ALTER TABLE routines ADD COLUMN trigger_kind TEXT NOT NULL DEFAULT 'schedule'`
  yield* sql`ALTER TABLE routines ADD COLUMN trigger_event TEXT`
  // `json(schedule_json)` keeps the schedule an object rather than re-encoding it as a string.
  yield* sql`
    UPDATE routines
    SET trigger_json = json_object(
          '_tag', 'schedule',
          'schedule', json(schedule_json),
          'timezone', timezone
        ),
        trigger_kind = 'schedule',
        trigger_event = NULL`
  yield* sql`ALTER TABLE routines DROP COLUMN schedule_json`
  yield* sql`ALTER TABLE routines DROP COLUMN timezone`
  yield* sql`CREATE INDEX routines_event ON routines(trigger_event, enabled)`
})
