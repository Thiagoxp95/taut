import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Phase 4 (scheduler · task runs · agent-runtime API · memory ingest).
 *
 * - `agent_sessions`: the runtime session an agent last used per channel, so the next task in
 *   that channel resumes it (`claude -p --resume <sid>`; docs/agent-model.md §9).
 * - `task_tokens`: task-scoped bearer tokens for `/api/agent-runtime/*` (§9 "Per-task
 *   credentials"). Only the sha-256 of the token is stored; `expires_at` is NULL while the
 *   task runs and set to `ended_at + 10 min` when it ends.
 * - `asks`: `taut_ask` questions awaiting a reply in the task thread.
 * - `tasks.parent_task_id` / `handoff_depth` (§9 "Handoff depth 2"), `trigger_message_id`
 *   (the mention that spawned the task; one task per (agent, trigger)) and `trigger_user_id`
 *   (the human to notify on done/failed).
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`
    CREATE TABLE agent_sessions (
      agent_id   TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      runtime    TEXT NOT NULL,
      session_id TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (agent_id, channel_id)
    )`
  yield* sql`
    CREATE TABLE task_tokens (
      token_hash TEXT PRIMARY KEY,
      task_id    TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id   TEXT NOT NULL,
      company_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    )`
  yield* sql`CREATE INDEX task_tokens_task_id ON task_tokens(task_id)`
  yield* sql`
    CREATE TABLE asks (
      id               TEXT PRIMARY KEY,
      company_id       TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
      task_id          TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      agent_id         TEXT NOT NULL,
      to_kind          TEXT NOT NULL CHECK (to_kind IN ('user', 'agent')),
      to_id            TEXT NOT NULL,
      channel_id       TEXT NOT NULL,
      thread_id        TEXT,
      message_id       TEXT NOT NULL,
      status           TEXT NOT NULL CHECK (status IN ('pending', 'answered')),
      reply_message_id TEXT,
      created_at       TEXT NOT NULL,
      answered_at      TEXT
    )`
  yield* sql`CREATE INDEX asks_task_id ON asks(task_id, status)`
  yield* sql`ALTER TABLE tasks ADD COLUMN parent_task_id TEXT`
  yield* sql`ALTER TABLE tasks ADD COLUMN handoff_depth INTEGER NOT NULL DEFAULT 0`
  yield* sql`ALTER TABLE tasks ADD COLUMN trigger_message_id TEXT`
  yield* sql`ALTER TABLE tasks ADD COLUMN trigger_user_id TEXT`
  yield* sql`CREATE INDEX tasks_trigger ON tasks(agent_id, trigger_message_id)`
})
