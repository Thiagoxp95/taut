import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Company repositories and per-agent grants (docs/build-plan-repositories.md).
 *
 * Three tables, one per fact. `github_apps` is the company's GitHub App: one row,
 * keyed by the company, holding the App's identity in the clear and every secret
 * (`pem`, client secret, webhook secret) as vault ciphertext with the company id
 * as AAD (D8) — nothing here is ever returned by an endpoint. `repositories` is
 * what the company actually uses of what the installation can see (D3), keyed on
 * GitHub's numeric id so a rename does not orphan a grant. `agent_repos` is the
 * grant itself, reusing `FileGrantMode` (D13) and cascading from both sides so a
 * detached repository or a deleted agent takes its grants with it.
 *
 * The plan called this `0017`. `0017_orphan_dms`, `0018_archive` and
 * `0019_subscription_usage_credential` were all taken by other sessions while
 * this was being written, so it is `0020` (D12) — nobody else was renumbered.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE github_apps (
      company_id        TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      app_id            INTEGER NOT NULL,
      app_slug          TEXT NOT NULL,
      client_id         TEXT NOT NULL,
      client_secret_ct  BLOB NOT NULL,
      private_key_ct    BLOB NOT NULL,
      webhook_secret_ct BLOB,
      installation_id   INTEGER,
      account_login     TEXT,
      created_at        TEXT NOT NULL,
      connected_at      TEXT
    )
  `

  yield* sql`
    CREATE TABLE repositories (
      id             TEXT PRIMARY KEY,
      company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      github_id      INTEGER NOT NULL,
      owner          TEXT NOT NULL,
      name           TEXT NOT NULL,
      full_name      TEXT NOT NULL,
      default_branch TEXT NOT NULL,
      private        INTEGER NOT NULL,
      clone_url      TEXT NOT NULL,
      attached_at    TEXT NOT NULL,
      UNIQUE (company_id, github_id)
    )
  `

  yield* sql`
    CREATE TABLE agent_repos (
      agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
      mode          TEXT NOT NULL,
      granted_at    TEXT NOT NULL,
      PRIMARY KEY (agent_id, repository_id)
    )
  `

  yield* sql`CREATE INDEX idx_agent_repos_repository ON agent_repos(repository_id)`
})
