import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * The Linear connection and the projects mirrored through it
 * (docs/build-plan-projects.md).
 *
 * Three tables, one per fact. `linear_connections` is the company's key: one row,
 * the key itself as vault ciphertext with the company id as AAD (D2), plus the
 * workspace it resolved to and how the last sync went. `projects` is the mirror,
 * keyed on Linear's UUID so a rename does not orphan the row the sidebar links to
 * (D6). `project_milestones` hangs off it and cascades with it (D10).
 *
 * Nothing here has a "created by" or an ordering column a human could change:
 * every row is a copy, and the only writer is the sync (D1).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE linear_connections (
      company_id        TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
      api_key_ct        BLOB NOT NULL,
      key_hint          TEXT NOT NULL,
      workspace_id      TEXT,
      workspace_name    TEXT,
      workspace_url_key TEXT,
      connected_by      TEXT NOT NULL,
      connected_at      TEXT NOT NULL,
      last_synced_at    TEXT,
      last_sync_error   TEXT
    )
  `

  yield* sql`
    CREATE TABLE projects (
      id          TEXT PRIMARY KEY,
      company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      linear_id   TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      state       TEXT NOT NULL,
      progress    REAL NOT NULL,
      icon        TEXT,
      color       TEXT,
      url         TEXT NOT NULL,
      lead_name   TEXT,
      lead_email  TEXT,
      lead_avatar TEXT,
      teams       TEXT NOT NULL,
      start_date  TEXT,
      target_date TEXT,
      updated_at  TEXT,
      synced_at   TEXT NOT NULL,
      UNIQUE (company_id, linear_id)
    )
  `

  yield* sql`
    CREATE TABLE project_milestones (
      id          TEXT PRIMARY KEY,
      project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      linear_id   TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      target_date TEXT,
      sort_order  REAL NOT NULL,
      UNIQUE (project_id, linear_id)
    )
  `

  yield* sql`CREATE INDEX idx_projects_company ON projects(company_id)`
  yield* sql`CREATE INDEX idx_project_milestones_project ON project_milestones(project_id)`
})
