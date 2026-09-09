import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Emoji reactions on messages (docs/build-plan-message-actions.md D2). One row per
 * (message, member, emoji); the primary key makes add/remove idempotent by construction and
 * deleting a message takes its reactions with it. `member_kind` is stored so agents can react
 * later without another migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE message_reactions (
      message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      member_kind TEXT NOT NULL,
      member_id   TEXT NOT NULL,
      emoji       TEXT NOT NULL,
      created_at  TEXT NOT NULL,
      PRIMARY KEY (message_id, member_kind, member_id, emoji)
    )
  `
  yield* sql`CREATE INDEX message_reactions_company_message ON message_reactions(company_id, message_id)`
})
