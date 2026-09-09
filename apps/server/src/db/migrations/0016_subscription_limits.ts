import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Per-seat quota snapshots (docs/build-plan-usage-limits.md).
 *
 * `cooldown_until` used to be a guess — `now + 5h` for Claude, `now + 1h`
 * otherwise — which left a seat parked for hours after its rolling window had
 * already rolled over. These columns cache what the provider actually says:
 * one row's worth of windows as JSON, when it was read, and why it could not
 * be read. The cooldown is then derived from a real `resets_at`.
 *
 * JSON rather than a child table because the snapshot is a cache replaced
 * wholesale on every probe; nothing ever queries one window in isolation.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE subscriptions ADD COLUMN limits_json TEXT`
  yield* sql`ALTER TABLE subscriptions ADD COLUMN limits_checked_at TEXT`
  yield* sql`ALTER TABLE subscriptions ADD COLUMN limits_error TEXT`
})
