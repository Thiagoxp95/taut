/**
 * `AgentMemory` — one agent's tier-2 memory: a single SQLite file with FTS5
 * (docs/agent-model.md §10). Opened on ONE path; there is no `WHERE agent_id`
 * because there is nothing to scope — isolation is the file.
 *
 * ```ts
 * const program = Effect.gen(function* () {
 *   const mem = yield* AgentMemory
 *   yield* mem.upsertMessage({ sourceId: 'msg_1', channelId: 'chn_1', at, body: 'hello', … })
 *   return yield* mem.search('hello')
 * }).pipe(Effect.provide(AgentMemory.layer('/data/…/memory/memory.db')))
 * ```
 */
import { SqlClient, SqlError } from '@effect/sql'
import type { Migrator } from '@effect/sql'
import { SqliteClient } from '@effect/sql-sqlite-node'
import { Context, Data, Effect, Layer } from 'effect'
import type { ConfigError, Scope } from 'effect'
import { migrate } from './schema.js'

// --- public types ----------------------------------------------------------

export const MemoryKinds = ['message', 'note', 'task', 'file'] as const
export type MemoryKind = (typeof MemoryKinds)[number]
export type AuthorKind = 'user' | 'agent'

/** What gets written. `at` is an ISO-8601 UTC timestamp. */
export interface MemoryItemInput {
  readonly kind: MemoryKind
  /** The upstream id (message id, task id, file path…). `(kind, sourceId)` is unique — writing it again replaces. */
  readonly sourceId: string
  readonly channelId?: string | undefined
  /** Human name used in the contextual prefix (`#backend`); falls back to the id. */
  readonly channelName?: string | undefined
  readonly threadId?: string | undefined
  readonly authorKind?: AuthorKind | undefined
  readonly authorId?: string | undefined
  /** Handle used in the contextual prefix (`@bruno`); falls back to the id. */
  readonly authorHandle?: string | undefined
  readonly at: string
  readonly body: string
  readonly meta?: Readonly<Record<string, unknown>> | undefined
}

export type MessageInput = Omit<MemoryItemInput, 'kind'>

/** A stored item. `text` is what FTS indexed (prefix + body); `body` is the raw content. */
export interface MemoryItem {
  readonly id: string
  readonly kind: MemoryKind
  readonly sourceId: string
  readonly channelId: string | null
  readonly threadId: string | null
  readonly authorKind: AuthorKind | null
  readonly authorId: string | null
  readonly authorHandle: string | null
  readonly at: string
  readonly body: string
  readonly text: string
  readonly meta: Readonly<Record<string, unknown>>
}

export interface SearchHit extends MemoryItem {
  /** FTS5 `snippet()` over the indexed text, matches wrapped in `[` `]`. */
  readonly snippet: string
  /** Higher is better: `-bm25 + 0.1 · 0.995^ageDays`. */
  readonly score: number
}

export interface SearchOptions {
  readonly limit?: number | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
  readonly channelId?: string | undefined
  readonly kind?: MemoryKind | undefined
  readonly authorId?: string | undefined
}

export interface GrepOptions {
  readonly limit?: number | undefined
  readonly since?: string | undefined
  readonly until?: string | undefined
  readonly channelId?: string | undefined
  readonly kind?: MemoryKind | undefined
  /** RegExp flags; default `i`. */
  readonly flags?: string | undefined
}

export interface TimelineOptions {
  readonly from: string
  readonly to: string
  readonly channelId?: string | undefined
  readonly limit?: number | undefined
}

export interface MemoryStats {
  readonly total: number
  readonly byKind: Readonly<Record<MemoryKind, number>>
  readonly oldestAt: string | null
  readonly newestAt: string | null
  readonly cursors: Readonly<Record<string, number>>
}

/** What the ingest loop applies (see `ingest.ts`). */
export type MemoryOp =
  | { readonly _tag: 'upsert'; readonly item: MemoryItemInput }
  | { readonly _tag: 'delete'; readonly kind: MemoryKind; readonly sourceId: string }

export class MemoryError extends Data.TaggedError('MemoryError')<{
  readonly reason: 'bad-regex' | 'bad-query'
  readonly message: string
}> {}

// --- helpers --------------------------------------------------------------

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 200
const GREP_CANDIDATES = 5000
const RECENCY_WEIGHT = 0.1
const RECENCY_DECAY = 0.995
const DAY_MS = 86_400_000

const itemId = (kind: MemoryKind, sourceId: string) => `${kind}:${sourceId}`

const clampLimit = (n: number | undefined, fallback = DEFAULT_LIMIT) =>
  Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n ?? fallback)))

/** `[#channel] [author] [YYYY-MM-DD] [thread:<root>]` — the contextual prefix indexed alongside the body (§10). */
export const contextualPrefix = (item: MemoryItemInput): string => {
  const parts: Array<string> = []
  if (item.kind !== 'message') parts.push(`[${item.kind}]`)
  const channel = item.channelName ?? item.channelId
  if (channel !== undefined) parts.push(`[${channel.startsWith('#') ? channel : `#${channel}`}]`)
  const author = item.authorHandle ?? item.authorId
  if (author !== undefined) parts.push(`[${author.startsWith('@') ? author : `@${author}`}]`)
  parts.push(`[${item.at.slice(0, 10)}]`)
  if (item.threadId !== undefined) parts.push(`[thread:${item.threadId}]`)
  const tags = item.meta?.['tags']
  if (Array.isArray(tags) && tags.length > 0) parts.push(`[tags:${tags.join(',')}]`)
  return parts.join(' ')
}

/**
 * Turns free text into a safe FTS5 query: every whitespace-separated token becomes a quoted
 * phrase (implicit AND); a trailing `*` keeps prefix matching. Raw FTS syntax is never passed through.
 */
export const toFtsQuery = (query: string): string =>
  query
    .split(/\s+/)
    .map((raw) => {
      const prefix = raw.endsWith('*')
      const token = raw.replace(/[*"]/g, '').trim()
      if (token.length === 0) return ''
      return prefix ? `"${token}"*` : `"${token}"`
    })
    .filter((s) => s.length > 0)
    .join(' ')

const recencyBonus = (at: string, now: number): number => {
  const ageDays = Math.max(0, (now - Date.parse(at)) / DAY_MS)
  return RECENCY_WEIGHT * Math.pow(RECENCY_DECAY, ageDays)
}

interface Row {
  readonly id: string
  readonly kind: MemoryKind
  readonly source_id: string
  readonly channel_id: string | null
  readonly thread_id: string | null
  readonly author_kind: AuthorKind | null
  readonly author_id: string | null
  readonly author_handle: string | null
  readonly at: string
  readonly text: string
  readonly body: string
  readonly meta: string
}

const parseMeta = (raw: string): Readonly<Record<string, unknown>> => {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

const rowToItem = (r: Row): MemoryItem => ({
  id: r.id,
  kind: r.kind,
  sourceId: r.source_id,
  channelId: r.channel_id,
  threadId: r.thread_id,
  authorKind: r.author_kind,
  authorId: r.author_id,
  authorHandle: r.author_handle,
  at: r.at,
  body: r.body,
  text: r.text,
  meta: parseMeta(r.meta)
})

// --- the service ----------------------------------------------------------

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  yield* sql`PRAGMA busy_timeout = 5000`
  yield* sql`PRAGMA synchronous = NORMAL`
  yield* migrate

  const filters = (opts: {
    readonly since?: string | undefined
    readonly until?: string | undefined
    readonly channelId?: string | undefined
    readonly kind?: MemoryKind | undefined
    readonly authorId?: string | undefined
  }) => {
    const clauses = [sql`1 = 1`]
    if (opts.since !== undefined) clauses.push(sql`i.at >= ${opts.since}`)
    if (opts.until !== undefined) clauses.push(sql`i.at <= ${opts.until}`)
    if (opts.channelId !== undefined) clauses.push(sql`i.channel_id = ${opts.channelId}`)
    if (opts.kind !== undefined) clauses.push(sql`i.kind = ${opts.kind}`)
    if (opts.authorId !== undefined) clauses.push(sql`i.author_id = ${opts.authorId}`)
    return sql.and(clauses)
  }

  const upsert = (item: MemoryItemInput): Effect.Effect<MemoryItem, SqlError.SqlError> =>
    Effect.gen(function* () {
      const id = itemId(item.kind, item.sourceId)
      const text = `${contextualPrefix(item)}\n${item.body}`
      const meta = JSON.stringify(item.meta ?? {})
      yield* sql`
        INSERT INTO items (id, kind, source_id, channel_id, thread_id, author_kind, author_id, author_handle, at, text, body, meta)
        VALUES (${id}, ${item.kind}, ${item.sourceId}, ${item.channelId ?? null}, ${item.threadId ?? null},
                ${item.authorKind ?? null}, ${item.authorId ?? null}, ${item.authorHandle ?? null},
                ${item.at}, ${text}, ${item.body}, ${meta})
        ON CONFLICT (id) DO UPDATE SET
          channel_id = excluded.channel_id, thread_id = excluded.thread_id,
          author_kind = excluded.author_kind, author_id = excluded.author_id, author_handle = excluded.author_handle,
          at = excluded.at, text = excluded.text, body = excluded.body, meta = excluded.meta
      `
      const rows = yield* sql<Row>`SELECT * FROM items WHERE id = ${id}`
      const row = rows[0]
      if (row === undefined) return yield* Effect.die(new Error(`upsert lost row ${id}`))
      return rowToItem(row)
    })

  const deleteBySource = (kind: MemoryKind, sourceId: string) =>
    sql<{ readonly n: number }>`
      DELETE FROM items WHERE id = ${itemId(kind, sourceId)} RETURNING 1 AS n
    `.pipe(Effect.map((rows) => rows.length > 0))

  const getById = (id: string) =>
    sql<Row>`SELECT * FROM items WHERE id = ${id}`.pipe(
      Effect.map((rows) => (rows[0] === undefined ? null : rowToItem(rows[0])))
    )

  const search = (
    query: string,
    opts: SearchOptions = {}
  ): Effect.Effect<ReadonlyArray<SearchHit>, SqlError.SqlError | MemoryError> =>
    Effect.gen(function* () {
      const fts = toFtsQuery(query)
      if (fts.length === 0) {
        return yield* new MemoryError({ reason: 'bad-query', message: 'empty search query' })
      }
      const limit = clampLimit(opts.limit)
      const candidates = Math.max(50, limit * 5)
      const rows = yield* sql<Row & { readonly rank: number; readonly snippet: string }>`
        SELECT i.*, bm25(items_fts) AS rank, snippet(items_fts, 0, '[', ']', '…', 16) AS snippet
        FROM items_fts
        JOIN items i ON i.rowid = items_fts.rowid
        WHERE items_fts MATCH ${fts} AND ${filters(opts)}
        ORDER BY rank
        LIMIT ${candidates}
      `
      const now = Date.now()
      return rows
        .map((r) => ({
          ...rowToItem(r),
          snippet: r.snippet,
          score: -r.rank + recencyBonus(r.at, now)
        }))
        .sort((a, b) => b.score - a.score || (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
        .slice(0, limit)
    })

  const grep = (
    pattern: string,
    opts: GrepOptions = {}
  ): Effect.Effect<ReadonlyArray<MemoryItem>, SqlError.SqlError | MemoryError> =>
    Effect.gen(function* () {
      const regex = yield* Effect.try({
        try: () => new RegExp(pattern, opts.flags ?? 'i'),
        catch: (e) =>
          new MemoryError({
            reason: 'bad-regex',
            message: e instanceof Error ? e.message : String(e)
          })
      })
      const limit = clampLimit(opts.limit, 20)
      const rows = yield* sql<Row>`
        SELECT i.* FROM items i WHERE ${filters(opts)} ORDER BY i.at DESC LIMIT ${GREP_CANDIDATES}
      `
      const out: Array<MemoryItem> = []
      for (const r of rows) {
        if (regex.test(r.body) || regex.test(r.text)) {
          out.push(rowToItem(r))
          if (out.length >= limit) break
        }
      }
      return out
    })

  /** Root message first, then replies in chronological order. `threadId` may be the root's message id. */
  const recallThread = (threadId: string, opts: { readonly limit?: number | undefined } = {}) =>
    sql<Row>`
      SELECT i.* FROM items i
      WHERE i.thread_id = ${threadId} OR (i.kind = 'message' AND i.source_id = ${threadId})
      ORDER BY CASE WHEN i.source_id = ${threadId} THEN 0 ELSE 1 END, i.at ASC
      LIMIT ${clampLimit(opts.limit, MAX_LIMIT)}
    `.pipe(Effect.map((rows) => rows.map(rowToItem)))

  const timeline = (opts: TimelineOptions) =>
    sql<Row>`
      SELECT i.* FROM items i
      WHERE ${filters({ since: opts.from, until: opts.to, channelId: opts.channelId })}
      ORDER BY i.at ASC
      LIMIT ${clampLimit(opts.limit, 100)}
    `.pipe(Effect.map((rows) => rows.map(rowToItem)))

  const note = (text: string, tags: ReadonlyArray<string> = []) =>
    upsert({
      kind: 'note',
      sourceId: `note_${globalThis.crypto.randomUUID()}`,
      at: new Date().toISOString(),
      body: text,
      meta: { tags: [...tags] }
    })

  const notes = {
    list: (opts: { readonly limit?: number | undefined } = {}) =>
      sql<Row>`
        SELECT i.* FROM items i WHERE i.kind = 'note' ORDER BY i.at DESC LIMIT ${clampLimit(opts.limit, 50)}
      `.pipe(Effect.map((rows) => rows.map(rowToItem))),
    get: (id: string) =>
      sql<Row>`SELECT * FROM items WHERE kind = 'note' AND (id = ${id} OR source_id = ${id})`.pipe(
        Effect.map((rows) => (rows[0] === undefined ? null : rowToItem(rows[0])))
      )
  }

  /** Only notes are agent-deletable (§10). Returns `false` when nothing matched. */
  const forget = (id: string) =>
    sql<{ readonly n: number }>`
      DELETE FROM items WHERE kind = 'note' AND (id = ${id} OR source_id = ${id}) RETURNING 1 AS n
    `.pipe(Effect.map((rows) => rows.length > 0))

  const getCursor = (name: string) =>
    sql<{ readonly seq: number }>`SELECT seq FROM cursors WHERE name = ${name}`.pipe(
      Effect.map((rows) => rows[0]?.seq ?? 0)
    )

  const setCursor = (name: string, seq: number) =>
    sql`
      INSERT INTO cursors (name, seq) VALUES (${name}, ${seq})
      ON CONFLICT (name) DO UPDATE SET seq = excluded.seq
    `.pipe(Effect.asVoid)

  /** Applies a batch of ops in one transaction, optionally advancing a cursor in the same commit. */
  const apply = (
    ops: ReadonlyArray<MemoryOp>,
    cursor?: { readonly name: string; readonly seq: number }
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        for (const op of ops) {
          if (op._tag === 'upsert') yield* upsert(op.item)
          else yield* deleteBySource(op.kind, op.sourceId)
        }
        if (cursor !== undefined) yield* setCursor(cursor.name, cursor.seq)
      })
    )

  const stats = (): Effect.Effect<MemoryStats, SqlError.SqlError> =>
    Effect.gen(function* () {
      const kinds = yield* sql<{ readonly kind: MemoryKind; readonly n: number }>`
        SELECT kind, COUNT(*) AS n FROM items GROUP BY kind
      `
      const range = yield* sql<{ readonly oldest: string | null; readonly newest: string | null }>`
        SELECT MIN(at) AS oldest, MAX(at) AS newest FROM items
      `
      const cursorRows = yield* sql<{ readonly name: string; readonly seq: number }>`
        SELECT name, seq FROM cursors
      `
      const byKind: Record<MemoryKind, number> = { message: 0, note: 0, task: 0, file: 0 }
      for (const k of kinds) byKind[k.kind] = k.n
      const cursors: Record<string, number> = {}
      for (const c of cursorRows) cursors[c.name] = c.seq
      return {
        total: kinds.reduce((acc, k) => acc + k.n, 0),
        byKind,
        oldestAt: range[0]?.oldest ?? null,
        newestAt: range[0]?.newest ?? null,
        cursors
      }
    })

  return {
    upsert,
    upsertMessage: (input: MessageInput) => upsert({ ...input, kind: 'message' }),
    deleteBySource,
    getById,
    search,
    grep,
    recallThread,
    timeline,
    note,
    notes,
    forget,
    getCursor,
    setCursor,
    apply,
    stats,
    /** Run `fn` inside one SQLite transaction (serialised per connection). */
    transaction: <A, E, R>(fx: Effect.Effect<A, E, R>) => sql.withTransaction(fx)
  }
})

export type AgentMemoryShape = Effect.Effect.Success<typeof make>

export class AgentMemory extends Effect.Service<AgentMemory>()('@taut/memory/AgentMemory', {
  effect: make
}) {
  /** Open (creating if needed) the memory database at `filename`. WAL is on. */
  static readonly layer = (
    filename: string
  ): Layer.Layer<
    AgentMemory,
    SqlError.SqlError | Migrator.MigrationError | ConfigError.ConfigError
  > => AgentMemory.Default.pipe(Layer.provide(SqliteClient.layer({ filename })))

  /** The same as `layer` but as a scoped value — handy when a loop opens many agents' files. */
  static readonly open = (
    filename: string
  ): Effect.Effect<
    AgentMemory,
    SqlError.SqlError | Migrator.MigrationError | ConfigError.ConfigError,
    Scope.Scope
  > =>
    Layer.build(AgentMemory.layer(filename)).pipe(
      Effect.map((context) => Context.get(context, AgentMemory))
    )
}
