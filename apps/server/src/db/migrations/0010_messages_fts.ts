import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Company-wide message search (the ⌘K "Messages" group).
 *
 * `messages_fts` is an FTS5 external-content index over `messages.body`, kept in sync by
 * triggers — the same pattern `@taut/memory` uses for one agent's `items_fts`, with the same
 * `porter unicode61` tokenizer so a query behaves identically in both. The `rebuild` at the
 * end indexes every message that already exists.
 *
 * `messages` has a TEXT primary key, so its rowid is implicit; SQLite only renumbers those on
 * `VACUUM`, which Taut never runs. If that ever changes, run
 * `INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')` afterwards.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      body,
      content = 'messages',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    )
  `
  yield* sql`
    CREATE TRIGGER messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
    END
  `
  yield* sql`
    CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
    END
  `
  yield* sql`
    CREATE TRIGGER messages_fts_au AFTER UPDATE OF body ON messages BEGIN
      INSERT INTO messages_fts (messages_fts, rowid, body) VALUES ('delete', old.rowid, old.body);
      INSERT INTO messages_fts (rowid, body) VALUES (new.rowid, new.body);
    END
  `
  yield* sql`INSERT INTO messages_fts (messages_fts) VALUES ('rebuild')`
})
