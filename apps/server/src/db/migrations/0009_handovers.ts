import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Cross-department handovers (docs/agent-model.md §9).
 *
 * An agent cannot reach another department, so every refused `send` / `ask` / `handoff`
 * lands here as a row addressed to the *sending* agent's department head: the queue behind
 * the "Raise with @otherhead" button. Rows are history — `raise` and `dismiss` only move
 * `status`, they never delete — and nothing here grants an agent anything; resolving one
 * sends a DM between two humans.
 *
 * `text` is the body the agent tried to send (already capped at 4000 chars by the tool
 * schema), kept so the head can forward it without digging the thread out.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE handovers (
      id                  TEXT PRIMARY KEY,
      company_id          TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      from_agent_id       TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      from_department_id  TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      from_head_user_id   TEXT REFERENCES users(id) ON DELETE SET NULL,
      to_agent_id         TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      to_department_id    TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
      to_head_user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
      channel_id          TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      thread_id           TEXT,
      task_id             TEXT,
      text                TEXT NOT NULL,
      status              TEXT NOT NULL,
      raised_message_id   TEXT,
      created_at          TEXT NOT NULL,
      resolved_at         TEXT,
      resolved_by_user_id TEXT REFERENCES users(id) ON DELETE SET NULL
    )
  `
  yield* sql`CREATE INDEX handovers_open ON handovers(company_id, status, created_at)`
  yield* sql`CREATE INDEX handovers_head ON handovers(from_head_user_id, status)`
})
