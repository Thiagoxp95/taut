import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`CREATE TABLE canvases (
    id TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    thread_id TEXT REFERENCES messages(id) ON DELETE CASCADE,
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    html TEXT NOT NULL,
    open INTEGER NOT NULL DEFAULT 1 CHECK (open IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
  )`
  yield* sql`CREATE INDEX canvases_conversation ON canvases(company_id, channel_id, thread_id)`
})
