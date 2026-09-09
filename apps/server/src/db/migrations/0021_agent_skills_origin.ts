import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Skills an agent can absorb, author and keep current (docs/build-plan-skills.md).
 *
 * `agent_skills` already held the two facts a hand-written skill needs — its name and the one
 * line the runtime reads when choosing it. Everything added here answers a different question:
 * *where did this come from, may the agent use it yet, and has it changed upstream?* (D6)
 *
 * Every column is nullable or defaulted, so the rows that exist read as what they are: skills a
 * human wrote (`authored`), already in use (`active`), with nothing upstream to track. The
 * partial index is the updater's only query — installed skills that opted into checking, oldest
 * check first (D9) — and stays small because most rows never match it.
 *
 * `skills_agent_install_policy` on the company is the switch behind D7: `approve` (the default)
 * means an agent that installs a skill for itself gets a pending row a human has to accept.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  const columns = [
    // D6 — provenance
    `origin        TEXT NOT NULL DEFAULT 'authored'`,
    `state         TEXT NOT NULL DEFAULT 'active'`,
    `source        TEXT`,
    `source_kind   TEXT`,
    `source_ref    TEXT`,
    `source_path   TEXT`,
    `resolved_sha  TEXT`,
    `content_hash  TEXT`,
    // D9/D10 — staying current
    `upstream_hash TEXT`,
    `update_policy TEXT NOT NULL DEFAULT 'notify'`,
    `checked_at    TEXT`,
    // who asked for it: 'user:<id>' or 'agent'
    `installed_by  TEXT`,
    `created_at    TEXT`,
    `updated_at    TEXT`
  ]
  for (const column of columns) {
    yield* sql.unsafe(`ALTER TABLE agent_skills ADD COLUMN ${column}`)
  }

  yield* sql`
    CREATE INDEX agent_skills_due
      ON agent_skills(update_policy, checked_at)
      WHERE origin = 'installed'
  `

  yield* sql`
    ALTER TABLE companies
      ADD COLUMN skills_agent_install_policy TEXT NOT NULL DEFAULT 'approve'
  `
})
