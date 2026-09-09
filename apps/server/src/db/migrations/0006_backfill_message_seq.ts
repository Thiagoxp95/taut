import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Repairs event payloads written before `Message.seq` existed (0004 added the column to
 * `messages` but left the event log alone), so `/ws?since=0` can replay them again.
 *
 * Every payload embedding a `message` object without `seq` (`message.created`,
 * `message.updated`, `agent.task.*`) gets `message.seq` = the `seq` of that message's
 * `message.created` event — for a `message.created` row that is the row's own `seq`.
 * `Message.error` is optional in the contract, so it is left absent. Nothing else is
 * touched; rows that already carry `seq` are not rewritten.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    UPDATE events SET payload_json = json_set(payload_json, '$.message.seq', COALESCE((
      SELECT c.seq FROM events c
      WHERE c.company_id = events.company_id AND c.type = 'message.created'
        AND json_extract(c.payload_json, '$.message.id') = json_extract(events.payload_json, '$.message.id')
      LIMIT 1), events.seq))
    WHERE json_type(payload_json, '$.message') = 'object'
      AND json_type(payload_json, '$.message.seq') IS NULL`
})
