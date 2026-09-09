import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Archiving instead of deleting. `agents.delete` used to drop the row, which left every
 * message the agent had ever posted rendering as "Unknown member" and its DMs stranded in the
 * sidebar. It now stamps `agents.archived_at`: the row, the home folder and the history stay,
 * the scheduler refuses to wake it, and `channels.archived_at` files its DMs away.
 *
 * A nullable timestamp rather than a new `status` value, because archiving is orthogonal to
 * active/paused — and widening the `status` CHECK would mean rebuilding a table half the
 * schema points at.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE agents ADD COLUMN archived_at TEXT`
  yield* sql`ALTER TABLE channels ADD COLUMN archived_at TEXT`
  yield* sql`CREATE INDEX channels_archived ON channels(company_id, archived_at)`
})
