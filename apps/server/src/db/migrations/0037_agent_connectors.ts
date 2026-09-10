import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE agent_connectors (
      id                 TEXT PRIMARY KEY,
      agent_id           TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      name               TEXT NOT NULL,
      url                TEXT NOT NULL,
      header_names_json  TEXT NOT NULL,
      headers_ciphertext BLOB NOT NULL,
      created_at         TEXT NOT NULL
    )`
  yield* sql`CREATE INDEX agent_connectors_agent ON agent_connectors(agent_id)`
})
