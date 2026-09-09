import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * A second index over `messages.body`, tokenized without stemming.
 *
 * `messages_fts` (migration 0010) uses `porter`, which stores stems: "deploying"
 * is indexed as `deploi`. That is what makes "deployed" find "deploying", and it
 * is also why a prefix query stops working the moment what was typed grows past
 * the stem — `deployi*` matches no stem, so results found at `deploy` vanish at
 * `deployi` and come back at `deploying`. Nothing about the query can fix that:
 * the prefix a live search needs is a prefix of the *word*, and the word is not
 * in the index.
 *
 * So the word goes in an index of its own. `unicode61` stores tokens verbatim,
 * the search asks both — stems for inflections, this one for the prefix — and
 * takes whichever ranks a message higher. Two indexes over the same column is
 * the cost; the alternative is choosing between "deployed finds deploying" and
 * "every keystroke returns something", and chat search wants both.
 *
 * Same external-content pattern and the same triggers as 0010, with `rebuild`
 * indexing every message that already exists.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE VIRTUAL TABLE messages_fts_prefix USING fts5(
      body,
      content = 'messages',
      content_rowid = 'rowid',
      tokenize = 'unicode61'
    )
  `
  yield* sql`
    CREATE TRIGGER messages_fts_prefix_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts_prefix (rowid, body) VALUES (new.rowid, new.body);
    END
  `
  yield* sql`
    CREATE TRIGGER messages_fts_prefix_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts_prefix (messages_fts_prefix, rowid, body)
      VALUES ('delete', old.rowid, old.body);
    END
  `
  yield* sql`
    CREATE TRIGGER messages_fts_prefix_au AFTER UPDATE OF body ON messages BEGIN
      INSERT INTO messages_fts_prefix (messages_fts_prefix, rowid, body)
      VALUES ('delete', old.rowid, old.body);
      INSERT INTO messages_fts_prefix (rowid, body) VALUES (new.rowid, new.body);
    END
  `
  yield* sql`INSERT INTO messages_fts_prefix (messages_fts_prefix) VALUES ('rebuild')`
})
