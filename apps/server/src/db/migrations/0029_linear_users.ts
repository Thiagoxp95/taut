import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * The people in the company's Linear workspace, and who each of them is in Taut
 * (docs/build-plan-projects.md D15, D16).
 *
 * Every column except the mapping is a mirror, written only by the sync: name,
 * email, avatar and whether Linear still counts them as active. `user_id` is the
 * one thing here Taut owns — an admin picks it, and no sync may touch it. That is
 * why the upsert on `(company_id, linear_id)` lists every other column and leaves
 * this one alone: a rename in Linear must not silently unmap a person.
 *
 * `ON DELETE SET NULL` rather than cascade: a Taut member who leaves the company
 * should leave the Linear person unmapped and visible, not delete the row the
 * next sync would have to rebuild.
 *
 * The partial unique index is the "one human, one Linear identity" rule. Two
 * Linear accounts pointing at the same Taut member would make "who is this
 * ticket for" ambiguous the moment an agent writes back.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE linear_users (
      company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      linear_id    TEXT NOT NULL,
      name         TEXT NOT NULL,
      display_name TEXT,
      email        TEXT,
      avatar_url   TEXT,
      active       INTEGER NOT NULL DEFAULT 1,
      user_id      TEXT REFERENCES users(id) ON DELETE SET NULL,
      linked_by    TEXT,
      linked_at    TEXT,
      synced_at    TEXT NOT NULL,
      PRIMARY KEY (company_id, linear_id)
    )
  `

  yield* sql`
    CREATE UNIQUE INDEX idx_linear_users_member
      ON linear_users(company_id, user_id) WHERE user_id IS NOT NULL`
})
