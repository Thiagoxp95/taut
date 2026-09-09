/**
 * Embedded migrations for one agent's `memory.db` (docs/agent-model.md §10).
 *
 * `items` is the single content table; `items_fts` is an FTS5 external-content index over
 * `items.text` kept in sync by triggers (the pattern from the FTS5 docs, §4.4.3); `cursors`
 * remembers where each ingest loop got to (`last_seq` per consumer name).
 */
import { Migrator, SqlClient } from '@effect/sql'
import { Effect } from 'effect'

const init = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS items (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL CHECK (kind IN ('message', 'note', 'task', 'file')),
      source_id     TEXT NOT NULL,
      channel_id    TEXT,
      thread_id     TEXT,
      author_kind   TEXT,
      author_id     TEXT,
      author_handle TEXT,
      at            TEXT NOT NULL,
      text          TEXT NOT NULL,
      body          TEXT NOT NULL,
      meta          TEXT NOT NULL DEFAULT '{}'
    )
  `
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS items_kind_source ON items (kind, source_id)`
  yield* sql`CREATE INDEX IF NOT EXISTS items_at ON items (at)`
  yield* sql`CREATE INDEX IF NOT EXISTS items_channel_at ON items (channel_id, at)`
  yield* sql`CREATE INDEX IF NOT EXISTS items_thread_at ON items (thread_id, at)`

  yield* sql`
    CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
      text,
      content = 'items',
      content_rowid = 'rowid',
      tokenize = 'porter unicode61'
    )
  `
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
      INSERT INTO items_fts (rowid, text) VALUES (new.rowid, new.text);
    END
  `
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
      INSERT INTO items_fts (items_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
    END
  `
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
      INSERT INTO items_fts (items_fts, rowid, text) VALUES ('delete', old.rowid, old.text);
      INSERT INTO items_fts (rowid, text) VALUES (new.rowid, new.text);
    END
  `

  yield* sql`
    CREATE TABLE IF NOT EXISTS cursors (
      name TEXT PRIMARY KEY,
      seq  INTEGER NOT NULL
    )
  `
})

/** Ordered, append-only. Never edit an entry; add `0002_*` instead. */
export const migrations = {
  '0001_init': init
} as const

/** Runs pending migrations against the `SqlClient` in context (records them in `effect_sql_migrations`). */
export const migrate = Migrator.make({})({ loader: Migrator.fromRecord(migrations) })
