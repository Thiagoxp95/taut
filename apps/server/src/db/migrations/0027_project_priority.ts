import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * The rest of what a Linear board card says (docs/build-plan-projects.md D14):
 * priority, health, the issue count, and which milestone a project is working
 * towards.
 *
 * `priority` defaults to `0` — Linear's "no priority" — so every row that
 * predates this migration reads as a project nobody has prioritised, which is
 * what it was. `issue_count` defaults to `0` for the same reason: a card that
 * says "0 issues" before the next sync is telling the truth about the mirror.
 *
 * `priority_sort_order` is Linear's own tie-break inside a priority level — the
 * board's card order is that pair and nothing else, so mirroring the number is
 * what makes a column read top to bottom the way Linear's does.
 *
 * `status` on a milestone is what lets a card name *one* of them. Nullable, and
 * a null is treated as unfinished: a mirror synced before this migration still
 * picks the first milestone rather than none.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE projects ADD COLUMN priority INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE projects ADD COLUMN priority_label TEXT`
  yield* sql`ALTER TABLE projects ADD COLUMN priority_sort_order REAL NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE projects ADD COLUMN health TEXT`
  yield* sql`ALTER TABLE projects ADD COLUMN issue_count INTEGER NOT NULL DEFAULT 0`

  yield* sql`ALTER TABLE project_milestones ADD COLUMN status TEXT`
})
