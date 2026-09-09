import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Deleting an agent used to leave its DMs behind: `agents.del` cleared the agent's membership
 * row but never the two-member channel, so every deleted agent kept a "dm" entry in the sidebar
 * whose history quoted an "Unknown member". The service now purges them; this clears the ones
 * already stranded — a DM with fewer than two members, or one still pointing at an agent row
 * that is gone. Both shapes are unreachable: a DM is opened with exactly two members and never
 * gains or loses one.
 *
 * Messages go first so the `messages_fts` triggers fire — a FK cascade does not run them
 * (`recursive_triggers` is off) and search would keep answering with dead channels. Attachment
 * rows cascade with the channel; their bytes stay in the blob store and are harmless there.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TEMP TABLE orphan_dms AS
    SELECT c.id FROM channels c
    WHERE c.kind = 'dm'
      AND ((SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) < 2
           OR EXISTS (SELECT 1 FROM channel_members m
                      WHERE m.channel_id = c.id AND m.member_kind = 'agent'
                        AND m.member_id NOT IN (SELECT id FROM agents)))`
  yield* sql`DELETE FROM messages WHERE channel_id IN (SELECT id FROM orphan_dms)`
  yield* sql`DELETE FROM channels WHERE id IN (SELECT id FROM orphan_dms)`
  yield* sql`DROP TABLE orphan_dms`
})
