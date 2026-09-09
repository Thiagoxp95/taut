import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * `messages.seq` — the `seq` of the message's `message.created` event, so clients can
 * `channels.markRead` at a message without holding the socket head. Backfilled from the
 * event log for rows that predate the column. `messages.error` — why a `failed` agent
 * message failed (Phase 4 writes it alongside `agent.task.failed`).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE messages ADD COLUMN error TEXT`
  yield* sql`
    UPDATE messages SET seq = COALESCE((
      SELECT e.seq FROM events e
      WHERE e.company_id = messages.company_id AND e.type = 'message.created'
        AND json_extract(e.payload_json, '$.message.id') = messages.id
      LIMIT 1), 0)`
})
