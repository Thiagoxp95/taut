import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Phase 8 (PWA · Web Push).
 *
 * One row per installed client that has granted notification permission. Keyed by
 * `endpoint` (the push service's opaque URL) so a browser re-subscribing after a key
 * rotation updates in place instead of piling up dead rows.
 *
 * User-scoped, not company-scoped: a phone follows its user across companies, and the
 * push payload carries the company the notification came from. `ON DELETE CASCADE`
 * drops a user's endpoints with the user; the notifier also deletes rows whose push
 * service answers 404/410 (subscription gone).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE push_devices (
      id            TEXT PRIMARY KEY,
      user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint      TEXT NOT NULL UNIQUE,
      p256dh        TEXT NOT NULL,
      auth          TEXT NOT NULL,
      label         TEXT,
      created_at    TEXT NOT NULL,
      last_seen_at  TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX push_devices_user_id ON push_devices(user_id)`
})
