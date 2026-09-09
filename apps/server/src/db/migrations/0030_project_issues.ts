import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * The issues of a mirrored project (docs/build-plan-projects.md D18).
 *
 * Same shape of table as `project_milestones`: keyed on Linear's UUID, hanging
 * off `projects` and cascading with it, with no column a human could change. The
 * workflow state is stored flat rather than in a `workflow_states` table because
 * a state only matters here as the column an issue sits in — there is nothing
 * else in Taut that would join to it, and a flat copy means the Issues tab needs
 * one query and no second source of truth to stay in step (D19).
 *
 * `sort_order` is Linear's own tie-break inside a state, so a column reads top to
 * bottom the way Linear draws it. `identifier` (`ENG-4636`) is indexed because it
 * is the one thing a human quotes back at an agent.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE project_issues (
      id             TEXT PRIMARY KEY,
      project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      linear_id      TEXT NOT NULL,
      identifier     TEXT NOT NULL,
      title          TEXT NOT NULL,
      state_id       TEXT NOT NULL,
      state_name     TEXT NOT NULL,
      state_type     TEXT NOT NULL,
      state_color    TEXT,
      state_position REAL NOT NULL DEFAULT 0,
      priority       INTEGER NOT NULL DEFAULT 0,
      priority_label TEXT,
      assignee_id    TEXT,
      assignee_name  TEXT,
      assignee_avatar TEXT,
      labels         TEXT NOT NULL DEFAULT '[]',
      milestone_name TEXT,
      due_date       TEXT,
      url            TEXT NOT NULL,
      sort_order     REAL NOT NULL DEFAULT 0,
      created_at     TEXT,
      updated_at     TEXT,
      synced_at      TEXT NOT NULL,
      UNIQUE (project_id, linear_id)
    )
  `

  yield* sql`CREATE INDEX idx_project_issues_project ON project_issues(project_id)`
  yield* sql`CREATE INDEX idx_project_issues_identifier ON project_issues(identifier)`
})
