import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * What one message asked its run to use (docs/build-plan-run-overrides.md D1).
 *
 * One nullable JSON column rather than four typed ones. The shape is a
 * contract schema (`RunOverride`) that is decoded on the way out, every field
 * in it is optional, and nothing ever queries by runtime or by model — so four
 * columns would buy an index nobody reads and a migration every time the popup
 * grows a row.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE messages ADD COLUMN run_override TEXT`
})
