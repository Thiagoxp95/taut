import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * A reaction-only turn withdraws its message. That must not cascade into deleting
 * the task, its pending asks, or its trigger idempotency record. message_id remains
 * a historical identifier, just like trigger_message_id and parent_task_id.
 *
 * Replace only the inline-FK column so references TO tasks (asks, tokens, routines,
 * signals) and every other task column/index survive untouched. The migrator wraps
 * this whole operation in one transaction.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TEMP TABLE task_reply_ids AS SELECT id, message_id FROM tasks`
  yield* sql`ALTER TABLE tasks DROP COLUMN message_id`
  yield* sql`ALTER TABLE tasks ADD COLUMN message_id TEXT NOT NULL DEFAULT ''`
  yield* sql`UPDATE tasks SET message_id = (SELECT message_id FROM task_reply_ids WHERE task_reply_ids.id = tasks.id)`
  yield* sql`DROP TABLE task_reply_ids`
})
