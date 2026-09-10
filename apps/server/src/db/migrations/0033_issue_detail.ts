import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * A mirrored issue becomes a whole ticket, with a page and a thread
 * (docs/build-plan-issues.md D6, D8, D9, D12).
 *
 * Three things happen here and they are one change, not three:
 *
 * 1. `project_issues` widens to everything the detail page draws. Every column is
 *    nullable or defaulted, because the mirror is already full of rows synced
 *    before this plan and an `ALTER TABLE` that could fail on them is an outage,
 *    not a migration. The next sync fills them in; until then the page renders
 *    what it has, exactly as it did yesterday.
 * 2. `channels` gains `hidden` and `project_id` (D9). A message needs a channel —
 *    that is the whole data model — so an issue's thread lives in a real channel
 *    that the sidebar simply does not draw. One column and one index is a smaller
 *    change than a second, channel-less home for messages, and everything else
 *    (search, mentions, notifications, unread, tasks) keeps treating it as the
 *    ordinary company channel it is.
 * 3. `project_issue_comments` is the ledger of what has crossed between Linear's
 *    comments and Taut's messages (D11, D12). It is keyed on Linear's comment id
 *    because that is the identity a reconcile has in hand, and `message_id` is
 *    uniquely indexed because a Taut message may be pushed out at most once —
 *    the index *is* the "not twice" rule, not a lookup convenience.
 *
 * `thread_message_id` is the one column here Linear knows nothing about (D8): it
 * is Taut's own answer to "does this ticket have a conversation", NULL on almost
 * every row, and indexed because the task runner asks it of every thread an agent
 * wakes in (D17) — one indexed read that answers nothing for an ordinary thread.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  // ── the ticket, whole (D6) ─────────────────────────────────────────────────
  yield* sql`ALTER TABLE project_issues ADD COLUMN description TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN parent_linear_id TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN parent_identifier TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN parent_title TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN sub_issue_count INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE project_issues ADD COLUMN team_id TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN team_key TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN milestone_id TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN estimate REAL`
  yield* sql`ALTER TABLE project_issues ADD COLUMN creator_id TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN creator_name TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN creator_avatar TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN completed_at TEXT`
  yield* sql`ALTER TABLE project_issues ADD COLUMN canceled_at TEXT`

  /**
   * No foreign key to `messages` on purpose (D5): a ticket that is trashed in
   * Linear loses its row and keeps its conversation, and a conversation whose
   * root somebody deleted must not take the ticket with it. The pointer is
   * allowed to dangle; the reader falls back to "no thread yet".
   */
  yield* sql`ALTER TABLE project_issues ADD COLUMN thread_message_id TEXT`

  // ── the channel an issue thread lives in (D9, D21) ─────────────────────────
  yield* sql`ALTER TABLE channels ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE channels ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`

  // ── what has crossed between Linear and Taut (D11, D12) ────────────────────
  yield* sql`
    CREATE TABLE project_issue_comments (
      linear_comment_id TEXT PRIMARY KEY,
      issue_id          TEXT NOT NULL REFERENCES project_issues(id) ON DELETE CASCADE,
      message_id        TEXT NOT NULL,
      -- 'in' = mirrored from Linear, 'out' = pushed to Linear from a Taut message
      direction         TEXT NOT NULL,
      synced_at         TEXT NOT NULL
    )
  `

  /** One Taut message is one Linear comment, in either direction, or the mirror doubles. */
  yield* sql`CREATE UNIQUE INDEX idx_issue_comment_message ON project_issue_comments(message_id)`
  yield* sql`CREATE INDEX idx_project_issues_thread ON project_issues(thread_message_id)`
  /** One hidden channel per project (D9) — the "ensure" in `ensureProjectChannel` is this. */
  yield* sql`CREATE UNIQUE INDEX idx_channels_project ON channels(project_id) WHERE project_id IS NOT NULL`
})
