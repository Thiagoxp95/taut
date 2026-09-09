import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Huddles (docs/build-plan-calls.md).
 *
 * `calls` is one row per huddle, `call_participants` one row per member of it.
 * The partial unique index is D1: starting a huddle and joining one are the same
 * operation, so at most one row per channel may be open and two people pressing
 * the button together cannot make two rooms.
 *
 * `call_participants`' primary key is deliberately not time-scoped: a huddle only
 * ever needs "who is in the room now" (D2), so rejoining after leaving updates the
 * row (`left_at = NULL`, a fresh `joined_at`) instead of accumulating history.
 * `member_kind` exists from day one so agents join later without a migration (D5).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE calls (
      id                 TEXT PRIMARY KEY,
      company_id         TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      channel_id         TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      room               TEXT NOT NULL,
      started_by_kind    TEXT NOT NULL,
      started_by_id      TEXT NOT NULL,
      started_at         TEXT NOT NULL,
      ended_at           TEXT,
      summary_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL
    )
  `

  yield* sql`CREATE UNIQUE INDEX calls_open_per_channel ON calls(channel_id) WHERE ended_at IS NULL`
  yield* sql`CREATE INDEX calls_company_started ON calls(company_id, started_at DESC)`

  yield* sql`
    CREATE TABLE call_participants (
      call_id     TEXT NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
      member_kind TEXT NOT NULL,
      member_id   TEXT NOT NULL,
      joined_at   TEXT NOT NULL,
      left_at     TEXT,
      sharing     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (call_id, member_kind, member_id)
    )
  `

  yield* sql`CREATE INDEX call_participants_live ON call_participants(call_id) WHERE left_at IS NULL`
})
