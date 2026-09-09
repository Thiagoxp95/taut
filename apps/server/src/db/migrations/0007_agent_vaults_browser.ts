import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Phase 7 (browser access · agent vaults; docs/build-plan-browser-vaults.md).
 *
 * - `agents.browser_access`: per-agent toggle for the headless browser MCP server inside the
 *   agent's machine (D2). Off by default.
 * - `vault_items.agent_id`: NULL = company item (every agent of the company may use it);
 *   set = agent item, usable only by that agent and managed by admin+ or the head of its
 *   department (D3). Crypto is unchanged: the key is still HKDF(master, company_id).
 * - `agent_vault_grants` is retired (D4): company items are implicitly usable by every agent,
 *   agent items only by their agent, so there is nothing left to grant.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`ALTER TABLE agents ADD COLUMN browser_access INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE vault_items ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE`
  yield* sql`CREATE INDEX vault_items_agent_id ON vault_items(agent_id)`
  yield* sql`DROP TABLE agent_vault_grants`
})
