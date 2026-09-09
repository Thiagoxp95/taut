import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Phase 3 (vault · subscriptions · agents · tasks).
 *
 * `subscriptions.tasks_today_date` is the UTC day (`YYYY-MM-DD`) `tasks_today` counts
 * for; a row whose date is not today reads as 0 and is reset the next time the pool is
 * picked from (docs/agent-model.md §4 "reset at midnight").
 *
 * Agents keep no `department_id` column: they belong to departments through
 * `department_members (member_kind = 'agent')` only, like users do.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE subscriptions ADD COLUMN tasks_today_date TEXT`
  yield* sql`CREATE INDEX IF NOT EXISTS subscriptions_credential_id ON subscriptions(credential_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS audit_log_vault_item ON audit_log(vault_item_id, at)`
})
