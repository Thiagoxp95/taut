import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * The silhouette a department's agents wear, picked rather than derived.
 *
 * Nullable, and every existing row stays null: null is "auto", the age-ordered
 * assignment the client has been computing on its own since blobatars shipped.
 * So this migration changes no face — it only gives a department somewhere to
 * record a choice once someone makes one.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE departments ADD COLUMN shape TEXT`
})
