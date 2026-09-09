import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * The company a session is scoped to (`CurrentUser.activeCompanyId`). Set on
 * `companies.create` / `companies.switch` / `invites.accept`; `Sessions.resolve`
 * falls back to the user's oldest membership when it is NULL.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE sessions ADD COLUMN active_company_id TEXT REFERENCES companies(id) ON DELETE SET NULL`
})
