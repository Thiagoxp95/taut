import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Linear's project *statuses* — the board columns (docs/build-plan-projects.md D13).
 *
 * `state` (backlog, started, completed…) is Linear's fixed roll-up and stays; a
 * workspace's own columns live beside it, because two statuses can share one
 * state and a board grouped by state would merge `Exploration` into `Planning`.
 *
 * Every column is nullable: a workspace without custom statuses, or a Linear that
 * stops answering the field, keeps syncing and simply has no board columns.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE projects ADD COLUMN status_id TEXT`
  yield* sql`ALTER TABLE projects ADD COLUMN status_name TEXT`
  yield* sql`ALTER TABLE projects ADD COLUMN status_type TEXT`
  yield* sql`ALTER TABLE projects ADD COLUMN status_color TEXT`
  yield* sql`ALTER TABLE projects ADD COLUMN status_position REAL`
})
