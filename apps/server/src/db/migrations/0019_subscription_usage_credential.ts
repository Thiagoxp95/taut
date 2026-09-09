import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * The read-only half of a seat (docs/build-plan-usage-limits.md).
 *
 * A Claude seat stores the bare `claude setup-token` value because that is what
 * `CLAUDE_CODE_OAUTH_TOKEN` wants, and that token is `user:inference` — it
 * cannot read `/api/oauth/usage` at all, so Claude seats showed the probe's
 * refusal where Codex seats showed a limits strip. This column points at a
 * second vault item, a full `claude login` record, that the probe reads and the
 * runtime never sees.
 *
 * `ON DELETE SET NULL` rather than `CASCADE`: revoking the usage credential
 * costs a seat its stats, never the seat itself.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    ALTER TABLE subscriptions
    ADD COLUMN usage_credential_id TEXT
      REFERENCES vault_items(id) ON DELETE SET NULL`
})
