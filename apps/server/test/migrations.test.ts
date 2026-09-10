import { SqlClient } from '@effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { it } from '@effect/vitest'
import { CompanyId } from '@taut/contract/ids'
import { Chunk, Effect, Layer, Schema, Stream } from 'effect'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect } from 'vitest'
import backfillMessageSeq from '../src/db/migrations/0006_backfill_message_seq.js'
import retainTaskHistory from '../src/db/migrations/0034_retain_task_history.js'
import { EventLog } from '../src/realtime/eventLog.js'
import { makeTempDir, removeDir, testDb } from './_harness.js'

const EXPECTED_TABLES = [
  'agent_connectors',
  'agent_file_grants',
  'agent_repos',
  'agent_sessions',
  'agent_skills',
  'agent_thread_context',
  'agents',
  'asks',
  'attachments',
  'audit_log',
  'call_participants',
  'calls',
  'canvases',
  'channel_members',
  'channels',
  'companies',
  'department_members',
  'departments',
  'events',
  'github_apps',
  'handovers',
  'invites',
  'linear_connections',
  'linear_users',
  'memberships',
  'message_reactions',
  'messages',
  'messages_fts',
  'messages_fts_config',
  'messages_fts_data',
  'messages_fts_docsize',
  'messages_fts_idx',
  'messages_fts_prefix',
  'messages_fts_prefix_config',
  'messages_fts_prefix_data',
  'messages_fts_prefix_docsize',
  'messages_fts_prefix_idx',
  'notifications',
  'project_issue_comments',
  'project_issues',
  'project_milestones',
  'projects',
  'push_devices',
  'repositories',
  'routines',
  'sessions',
  'signals',
  'subscriptions',
  'task_tokens',
  'tasks',
  'users',
  'vault_items'
]

const Name = Schema.Struct({ name: Schema.String })
const Count = Schema.Struct({ n: Schema.Number })

const inspect = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const tables = yield* sql`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`.pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.Array(Name)))
  )
  const applied = yield* sql`SELECT COUNT(*) AS n FROM effect_sql_migrations`.pipe(
    Effect.flatMap(Schema.decodeUnknown(Schema.Tuple(Count)))
  )
  const pragma = (name: string, column = name) =>
    sql
      .unsafe<Record<string, unknown>>(`PRAGMA ${name}`)
      .pipe(Effect.map((rows) => rows[0]?.[column]))
  return {
    tables: tables.map((t) => t.name).filter((n) => n !== 'effect_sql_migrations'),
    applied: applied[0].n,
    foreignKeys: yield* pragma('foreign_keys'),
    journalMode: yield* pragma('journal_mode'),
    busyTimeout: yield* pragma('busy_timeout', 'timeout')
  }
})

const dir = makeTempDir()
afterAll(() => removeDir(dir))

describe('migrations', () => {
  it.scoped(
    '0034 preserves populated task history and pending asks when a reply is withdrawn',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        yield* sql`PRAGMA foreign_keys = ON`
        yield* sql`CREATE TABLE messages (id TEXT PRIMARY KEY)`
        yield* sql`CREATE TABLE tasks (id TEXT PRIMARY KEY, status TEXT NOT NULL, message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE)`
        yield* sql`CREATE TABLE asks (id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE)`
        yield* sql`INSERT INTO messages VALUES ('reply1'), ('reply2')`
        yield* sql`INSERT INTO tasks VALUES ('task1', 'done', 'reply1'), ('task2', 'queued', 'reply2')`
        yield* sql`INSERT INTO asks VALUES ('ask1', 'task1')`
        yield* sql.withTransaction(retainTaskHistory)
        yield* sql`DELETE FROM messages WHERE id = 'reply1'`
        expect(yield* sql`SELECT id, status, message_id FROM tasks ORDER BY id`).toEqual([
          { id: 'task1', status: 'done', message_id: 'reply1' },
          { id: 'task2', status: 'queued', message_id: 'reply2' }
        ])
        expect(yield* sql`SELECT * FROM asks`).toEqual([{ id: 'ask1', task_id: 'task1' }])
        expect(yield* sql`PRAGMA foreign_key_check`).toEqual([])
        yield* sql`DELETE FROM tasks WHERE id = 'task1'`
        expect(yield* sql`SELECT * FROM asks`).toEqual([])
      }).pipe(Effect.provide(SqliteClient.layer({ filename: ':memory:' })))
  )
  it.scoped('create every domain table on a fresh database with the right pragmas', () =>
    Effect.gen(function* () {
      const result = yield* inspect.pipe(Effect.provide(testDb(dir)))
      expect(existsSync(join(dir, 'taut.db'))).toBe(true)
      expect(result.tables).toEqual(EXPECTED_TABLES)
      expect(result.applied).toBe(38)
      expect(result.foreignKeys).toBe(1)
      expect(result.journalMode).toBe('wal')
      expect(result.busyTimeout).toBe(5000)
    })
  )

  it.scoped('are idempotent: a second boot on the same file applies nothing', () =>
    Effect.gen(function* () {
      const result = yield* inspect.pipe(Effect.provide(testDb(dir)))
      expect(result.applied).toBe(38)
      expect(result.tables).toEqual(EXPECTED_TABLES)
    })
  )

  it.scoped(
    '0007: agents.browser_access defaults to 0, vault_items.agent_id cascades, grants are gone',
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        const now = new Date().toISOString()
        const Columns = Schema.Array(Schema.Struct({ name: Schema.String }))
        const columnsOf = (table: string) =>
          sql.unsafe<{ name: string }>(`PRAGMA table_info(${table})`).pipe(
            Effect.flatMap(Schema.decodeUnknown(Columns)),
            Effect.map((r) => r.map((c) => c.name))
          )
        expect(yield* columnsOf('agents')).toContain('browser_access')
        expect(yield* columnsOf('vault_items')).toContain('agent_id')
        expect(yield* columnsOf('agent_vault_grants')).toEqual([])

        yield* sql`INSERT INTO companies (id, slug, name, created_at) VALUES ('cmp_m7', 'm7', 'M7', ${now})`
        yield* sql`INSERT INTO agents (id, company_id, handle, name, avatar_json, role, mandate, runtime_kind, permission_mode, status, created_at, updated_at)
                 VALUES ('agt_m7', 'cmp_m7', 'seven', 'Seven', '{}', 'eng', 'x', 'claude-code', 'plan', 'active', ${now}, ${now})`
        const flags = yield* sql`SELECT browser_access AS n FROM agents WHERE id = 'agt_m7'`.pipe(
          Effect.flatMap(Schema.decodeUnknown(Schema.Tuple(Count)))
        )
        expect(flags[0].n).toBe(0)

        const item = (id: string, agent: string | null) =>
          sql`INSERT INTO vault_items (id, company_id, kind, label, ciphertext, hint, created_at, agent_id)
            VALUES (${id}, 'cmp_m7', 'generic.secret', ${id}, ${Buffer.from('x')}, 'xxxx', ${now}, ${agent})`
        yield* item('vlt_company', null)
        yield* item('vlt_agent', 'agt_m7')
        const orphan = yield* Effect.flip(item('vlt_orphan', 'agt_missing'))
        expect(orphan._tag).toBe('SqlError')

        yield* sql`DELETE FROM agents WHERE id = 'agt_m7'`
        const left =
          yield* sql`SELECT id FROM vault_items WHERE company_id = 'cmp_m7' ORDER BY id`.pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Array(Schema.Struct({ id: Schema.String }))))
          )
        expect(left.map((r) => r.id)).toEqual(['vlt_company'])
      }).pipe(Effect.provide(testDb(dir)))
  )

  it.scoped('enforce UNIQUE(company_id, handle) on agents and foreign keys', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const now = new Date().toISOString()
      yield* sql`INSERT INTO companies (id, slug, name, created_at) VALUES ('cmp_1', 'acme', 'Acme', ${now})`
      const agent = (id: string, company: string) =>
        sql`INSERT INTO agents (id, company_id, handle, name, avatar_json, role, mandate, runtime_kind, permission_mode, status, created_at, updated_at)
            VALUES (${id}, ${company}, 'bruno', 'Bruno', '{}', 'eng', 'do things', 'claude-code', 'plan', 'active', ${now}, ${now})`
      yield* agent('agt_1', 'cmp_1')
      const dup = yield* Effect.flip(agent('agt_2', 'cmp_1'))
      expect(dup._tag).toBe('SqlError')
      const orphan = yield* Effect.flip(agent('agt_3', 'cmp_missing'))
      expect(orphan._tag).toBe('SqlError')
    }).pipe(Effect.provide(testDb(dir)))
  )

  it.scoped('0006 backfills message.seq on legacy event payloads so they decode again', () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient
      const log = yield* EventLog
      const company = CompanyId.make('cmp_legacy')
      const at = new Date().toISOString()
      const message = {
        id: 'msg_1',
        companyId: company,
        channelId: 'chn_1',
        authorKind: 'user',
        authorId: 'usr_1',
        body: 'hi',
        status: 'sent',
        createdAt: at
      }
      const rows: ReadonlyArray<readonly [number, string, unknown]> = [
        [1, 'message.created', { message, mentions: [] }],
        [2, 'message.updated', { message: { ...message, body: 'hi (edited)', editedAt: at } }],
        [3, 'message.created', { message: { ...message, id: 'msg_2', seq: 3 } }]
      ]
      for (const [seq, type, payload] of rows) {
        yield* sql`INSERT INTO events (company_id, seq, at, type, payload_json)
                   VALUES (${company}, ${seq}, ${at}, ${type}, ${JSON.stringify(payload)})`
      }
      expect((yield* log.validate()).invalid).toBe(2)

      yield* backfillMessageSeq
      expect((yield* log.validate()).invalid).toBe(0)

      const seqs = () =>
        log.since(company, 0).pipe(
          Stream.runCollect,
          Effect.map((events) =>
            Chunk.toReadonlyArray(events).map((e) =>
              e.type === 'message.created' || e.type === 'message.updated'
                ? { seq: e.seq, messageSeq: e.payload.message.seq, error: e.payload.message.error }
                : { seq: e.seq }
            )
          )
        )
      const repaired = yield* seqs()
      // created → its own seq; updated → the seq of that message's `message.created`; untouched row kept
      expect(repaired).toEqual([
        { seq: 1, messageSeq: 1, error: undefined },
        { seq: 2, messageSeq: 1, error: undefined },
        { seq: 3, messageSeq: 3, error: undefined }
      ])
      // re-running is a no-op
      yield* backfillMessageSeq
      expect(yield* seqs()).toEqual(repaired)
    }).pipe(Effect.provide(EventLog.Default.pipe(Layer.provideMerge(testDb(dir)))))
  )
})
