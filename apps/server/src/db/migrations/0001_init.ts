import { SqlClient } from '@effect/sql'
import { Effect } from 'effect'

/**
 * Initial schema — every table from the "Domain" section of docs/build-plan.md.
 * Conventions: TEXT ids (`cmp_…`, `usr_…`), ISO-8601 TEXT timestamps, INTEGER seq,
 * BLOB ciphertext, JSON columns suffixed `_json`. Every company-scoped row carries
 * `company_id`; services must always filter by it.
 */
const statements: ReadonlyArray<string> = [
  // ── identity ──────────────────────────────────────────────────────────────
  `CREATE TABLE users (
    id            TEXT PRIMARY KEY,
    email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    avatar_json   TEXT,
    created_at    TEXT NOT NULL
  )`,
  `CREATE TABLE sessions (
    id         TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX sessions_user_id ON sessions(user_id)`,

  // ── company ───────────────────────────────────────────────────────────────
  `CREATE TABLE companies (
    id          TEXT PRIMARY KEY,
    slug        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    avatar_json TEXT,
    created_at  TEXT NOT NULL
  )`,
  `CREATE TABLE memberships (
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role       TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at TEXT NOT NULL,
    PRIMARY KEY (company_id, user_id)
  )`,
  `CREATE INDEX memberships_user_id ON memberships(user_id)`,
  `CREATE TABLE invites (
    id          TEXT PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email       TEXT NOT NULL COLLATE NOCASE,
    role        TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    token       TEXT NOT NULL UNIQUE,
    invited_by  TEXT NOT NULL REFERENCES users(id),
    expires_at  TEXT NOT NULL,
    accepted_at TEXT,
    created_at  TEXT NOT NULL
  )`,
  `CREATE INDEX invites_company_id ON invites(company_id)`,

  // ── departments ───────────────────────────────────────────────────────────
  `CREATE TABLE departments (
    id           TEXT PRIMARY KEY,
    company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name         TEXT NOT NULL,
    slug         TEXT NOT NULL,
    head_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at   TEXT NOT NULL,
    UNIQUE (company_id, slug)
  )`,
  `CREATE TABLE department_members (
    department_id TEXT NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
    member_kind   TEXT NOT NULL CHECK (member_kind IN ('user', 'agent')),
    member_id     TEXT NOT NULL,
    PRIMARY KEY (department_id, member_kind, member_id)
  )`,
  `CREATE INDEX department_members_member ON department_members(member_kind, member_id)`,

  // ── channels & messages ───────────────────────────────────────────────────
  `CREATE TABLE channels (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    department_id TEXT REFERENCES departments(id) ON DELETE SET NULL,
    name          TEXT NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('channel', 'dm')),
    created_at    TEXT NOT NULL
  )`,
  `CREATE INDEX channels_company_id ON channels(company_id, kind)`,
  `CREATE INDEX channels_department_id ON channels(department_id)`,
  `CREATE TABLE channel_members (
    channel_id    TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    member_kind   TEXT NOT NULL CHECK (member_kind IN ('user', 'agent')),
    member_id     TEXT NOT NULL,
    last_read_seq INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (channel_id, member_kind, member_id)
  )`,
  `CREATE INDEX channel_members_member ON channel_members(member_kind, member_id)`,
  `CREATE TABLE messages (
    id          TEXT PRIMARY KEY,
    company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    channel_id  TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    thread_id   TEXT REFERENCES messages(id) ON DELETE CASCADE,
    author_kind TEXT NOT NULL CHECK (author_kind IN ('user', 'agent')),
    author_id   TEXT NOT NULL,
    body        TEXT NOT NULL,
    status      TEXT NOT NULL CHECK (status IN ('sent', 'streaming', 'failed')),
    created_at  TEXT NOT NULL,
    edited_at   TEXT
  )`,
  `CREATE INDEX messages_channel_created ON messages(channel_id, created_at)`,
  `CREATE INDEX messages_thread_id ON messages(thread_id)`,

  // ── realtime (agent-model.md §6) ──────────────────────────────────────────
  // (company_id, seq) is the primary key, which is the index §8 asks for.
  `CREATE TABLE events (
    seq          INTEGER NOT NULL,
    company_id   TEXT NOT NULL,
    at           TEXT NOT NULL,
    type         TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    PRIMARY KEY (company_id, seq)
  )`,
  `CREATE TABLE notifications (
    id         TEXT PRIMARY KEY,
    company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_seq  INTEGER NOT NULL,
    kind       TEXT NOT NULL,
    read_at    TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX notifications_user_unread ON notifications(company_id, user_id, read_at)`,

  // ── vault & subscriptions (agent-model.md §2, §3) ─────────────────────────
  `CREATE TABLE vault_items (
    id           TEXT PRIMARY KEY,
    company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kind         TEXT NOT NULL,
    label        TEXT NOT NULL,
    ciphertext   BLOB NOT NULL,
    hint         TEXT NOT NULL,
    created_at   TEXT NOT NULL,
    last_used_at TEXT,
    last_used_by TEXT
  )`,
  `CREATE INDEX vault_items_company_id ON vault_items(company_id)`,
  `CREATE TABLE subscriptions (
    id              TEXT PRIMARY KEY,
    company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    runtime         TEXT NOT NULL,
    label           TEXT NOT NULL,
    credential_id   TEXT NOT NULL REFERENCES vault_items(id),
    default_model   TEXT,
    status          TEXT NOT NULL DEFAULT 'unchecked',
    weight          INTEGER NOT NULL DEFAULT 1,
    cooldown_until  TEXT,
    tasks_today     INTEGER NOT NULL DEFAULT 0,
    last_checked_at TEXT,
    created_at      TEXT NOT NULL
  )`,
  `CREATE INDEX subscriptions_company_runtime ON subscriptions(company_id, runtime)`,

  // ── agents (agent-model.md §4) ────────────────────────────────────────────
  `CREATE TABLE agents (
    id                     TEXT PRIMARY KEY,
    company_id             TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    handle                 TEXT NOT NULL,
    name                   TEXT NOT NULL,
    avatar_json            TEXT NOT NULL,
    role                   TEXT NOT NULL,
    mandate                TEXT NOT NULL,
    runtime_kind           TEXT NOT NULL,
    pinned_subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
    model                  TEXT,
    permission_mode        TEXT NOT NULL CHECK (permission_mode IN ('plan', 'auto-edit')),
    status                 TEXT NOT NULL CHECK (status IN ('active', 'paused')),
    created_at             TEXT NOT NULL,
    updated_at             TEXT NOT NULL,
    UNIQUE (company_id, handle)
  )`,
  `CREATE TABLE agent_skills (
    agent_id    TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name        TEXT NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (agent_id, name)
  )`,
  `CREATE TABLE agent_file_grants (
    agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    path     TEXT NOT NULL,
    mode     TEXT NOT NULL CHECK (mode IN ('ro', 'rw')),
    PRIMARY KEY (agent_id, path)
  )`,
  `CREATE TABLE agent_vault_grants (
    agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    vault_item_id TEXT NOT NULL REFERENCES vault_items(id) ON DELETE CASCADE,
    PRIMARY KEY (agent_id, vault_item_id)
  )`,

  // ── tasks & audit (agent-model.md §7, §8) ─────────────────────────────────
  `CREATE TABLE tasks (
    id              TEXT PRIMARY KEY,
    company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id        TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
    thread_id       TEXT REFERENCES messages(id) ON DELETE SET NULL,
    message_id      TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    subscription_id TEXT REFERENCES subscriptions(id) ON DELETE SET NULL,
    status          TEXT NOT NULL,
    started_at      TEXT NOT NULL,
    ended_at        TEXT,
    error           TEXT
  )`,
  `CREATE INDEX tasks_company_status ON tasks(company_id, status)`,
  `CREATE INDEX tasks_agent_id ON tasks(agent_id, started_at)`,
  `CREATE TABLE audit_log (
    id            TEXT PRIMARY KEY,
    company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    agent_id      TEXT,
    task_id       TEXT,
    vault_item_id TEXT,
    purpose       TEXT NOT NULL,
    at            TEXT NOT NULL
  )`,
  `CREATE INDEX audit_log_company_at ON audit_log(company_id, at)`
]

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  for (const statement of statements) {
    yield* sql.unsafe(statement)
  }
})
