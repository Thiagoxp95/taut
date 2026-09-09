import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Files sent in chat (docs/build-plan-attachments.md D1). One row per file; the bytes live at
 * `<dataDir>/companies/<slug>/attachments/<id>` with no extension — the name is a column.
 *
 * `message_id` is NULL while the upload is an orphan (uploaded, not yet sent). Linking happens
 * inside the `messages.create` transaction; deleting a message cascades its rows (the service
 * removes the files first). Orphans older than 24 h are swept at server start on the partial
 * index below.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE attachments (
      id            TEXT PRIMARY KEY,
      company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      message_id    TEXT NULL REFERENCES messages(id) ON DELETE CASCADE,
      uploader_kind TEXT NOT NULL,
      uploader_id   TEXT NOT NULL,
      name          TEXT NOT NULL,
      mime_type     TEXT NOT NULL,
      size          INTEGER NOT NULL,
      created_at    TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX attachments_message ON attachments(message_id)`
  yield* sql`CREATE INDEX attachments_orphans ON attachments(created_at) WHERE message_id IS NULL`
})
