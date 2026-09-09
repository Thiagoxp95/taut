import { SqlClient } from '@effect/sql'
import {
  AgentNoteHit,
  type CurrentUserShape,
  MessageHit,
  SNIPPET_CLOSE,
  SNIPPET_OPEN,
  type SearchResults
} from '@taut/contract/api'
import { ChannelKind, Message } from '@taut/contract/domain'
import type { Forbidden, NotFound, Unauthorized } from '@taut/contract/errors'
import { ChannelId, CompanyId, UserId } from '@taut/contract/ids'
import { toFtsQuery } from '@taut/memory'
import { DateTime, Effect, Option, Schema } from 'effect'
import { MemoryIngest } from '../agents/memoryIngest.js'
import { findAll } from '../db/sql.js'
import { MessageRow, toMessage } from '../domain/rows.js'
import { type Actor, actor, isAdmin } from './access.js'
import { makeAgentAccess } from './agentAccess.js'
import { Agents } from './agents.js'
import { Attachments } from './attachments.js'
import { Channels } from './channels.js'

const DEFAULT_LIMIT = 20
const MAX_LIMIT = 50
/** Tokens of the FTS `snippet()`; roughly one chat line. */
const SNIPPET_TOKENS = 24

const clampLimit = (n: number | undefined): number =>
  Math.max(1, Math.min(MAX_LIMIT, Math.trunc(n ?? DEFAULT_LIMIT)))

/** One typed string, two FTS queries — see `SearchQuery` and migration 0015. */
export interface SearchQuery {
  /** Whole tokens against `messages_fts` (porter): matches inflections of what was typed. */
  readonly stemmed: string
  /** Last token prefixed, against `messages_fts_prefix` (unicode61): matches while typing. */
  readonly prefix: string
}

/**
 * What the user typed → what FTS5 sees. `toFtsQuery` quotes every token (implicit AND, no raw
 * syntax).
 *
 * Two queries rather than one because no single query serves both halves of chat search. The
 * porter index stores stems, so `"deployed"` finds a message saying "deploying" — but a prefix
 * of a *word* (`deployi*`) matches no stem, which is what used to make results blink out
 * mid-word. The unstemmed index answers that one. Rows matched by either are merged, so a query
 * is never worse than it was under one index alone.
 */
export const toSearchQuery = (raw: string): SearchQuery => {
  const typed = raw.trim()
  if (typed.length === 0) return { stemmed: '', prefix: '' }
  const bare = typed.endsWith('*') ? typed.slice(0, -1) : typed
  return {
    stemmed: toFtsQuery(bare),
    // One character is too short to prefix-match usefully.
    prefix: toFtsQuery(typed.endsWith('*') || typed.length < 2 ? typed : `${typed}*`)
  }
}

export interface SearchInput {
  readonly q: string
  readonly channelId?: ChannelId | undefined
  readonly limit?: number | undefined
}

/**
 * ⌘K search over what the caller can see (docs/agent-model.md §2 visibility): messages through
 * `messages_fts` (migration 0010), then notes agents wrote to their own memory — the latter only
 * for admins and the agent's department head, who already see its vault and files.
 */
export class Search extends Effect.Service<Search>()('Search', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const agents = yield* Agents
    const attachments = yield* Attachments
    const channels = yield* Channels
    const ingest = yield* MemoryIngest
    const access = yield* makeAgentAccess

    const HitRow = Schema.Struct({
      ...MessageRow.fields,
      channel_name: Schema.String,
      channel_kind: ChannelKind,
      snippet: Schema.String
    })

    /**
     * BM25 order. Visibility mirrors `Channels.canView`: admin+ read every `channel`, everyone
     * reads the channels and DMs they are a member of; `streaming`/`failed` bodies never match.
     */
    const messageHits = findAll({
      Request: Schema.Struct({
        companyId: CompanyId,
        userId: UserId,
        admin: Schema.Number,
        channelId: Schema.NullOr(ChannelId),
        stemmed: Schema.String,
        prefix: Schema.String,
        limit: Schema.Number
      }),
      Result: HitRow,
      execute: (r) => sql`
        WITH matched AS (
          SELECT messages_fts.rowid AS rowid,
                 bm25(messages_fts) AS rank,
                 snippet(messages_fts, 0, ${SNIPPET_OPEN}, ${SNIPPET_CLOSE}, '…', ${SNIPPET_TOKENS}) AS snippet
          FROM messages_fts WHERE messages_fts MATCH ${r.stemmed}
          UNION ALL
          SELECT messages_fts_prefix.rowid AS rowid,
                 bm25(messages_fts_prefix) AS rank,
                 snippet(messages_fts_prefix, 0, ${SNIPPET_OPEN}, ${SNIPPET_CLOSE}, '…', ${SNIPPET_TOKENS}) AS snippet
          FROM messages_fts_prefix WHERE messages_fts_prefix MATCH ${r.prefix}
        ),
        -- A message the two indexes both matched keeps its better rank, and the snippet from
        -- that same row: SQLite takes bare columns from the row a lone min() selected.
        best AS (SELECT rowid, min(rank) AS rank, snippet FROM matched GROUP BY rowid)
        SELECT m.id, m.company_id, m.channel_id, m.thread_id, m.author_kind, m.author_id, m.body,
               m.status, m.seq, m.error, m.created_at, m.edited_at,
               c.name AS channel_name, c.kind AS channel_kind, best.snippet AS snippet
        FROM best
        JOIN messages m ON m.rowid = best.rowid
        JOIN channels c ON c.id = m.channel_id
        WHERE m.company_id = ${r.companyId}
          AND m.status = 'sent'
          AND (${r.channelId} IS NULL OR m.channel_id = ${r.channelId})
          AND ((${r.admin} = 1 AND c.kind = 'channel') OR EXISTS (
            SELECT 1 FROM channel_members cm
            WHERE cm.channel_id = c.id AND cm.member_kind = 'user' AND cm.member_id = ${r.userId}))
        ORDER BY best.rank, m.created_at DESC
        LIMIT ${r.limit}`
    })

    const searchMessages = (
      who: Actor,
      input: SearchInput,
      fts: SearchQuery,
      limit: number
    ): Effect.Effect<ReadonlyArray<MessageHit>, NotFound | Forbidden> =>
      Effect.gen(function* () {
        if (input.channelId !== undefined) {
          const channel = yield* channels.load(who, input.channelId)
          yield* channels.requireView(who, channel)
        }
        const rows = yield* messageHits({
          companyId: who.companyId,
          userId: who.userId,
          admin: isAdmin(who.role) ? 1 : 0,
          channelId: input.channelId ?? null,
          stemmed: fts.stemmed,
          prefix: fts.prefix,
          limit
        })
        // D9: attachments are not indexed, but a hit still carries them (one query per page).
        const byMessage = yield* attachments.listForMessages(
          who.companyId,
          rows.map((row) => row.id)
        )
        return rows.map((row) => {
          const message = toMessage(row)
          const list = byMessage.get(row.id)
          return new MessageHit({
            message: list === undefined ? message : new Message({ ...message, attachments: list }),
            channel: { id: row.channel_id, name: row.channel_name, kind: row.channel_kind },
            snippet: row.snippet
          })
        })
      })

    const tagsOf = (meta: Readonly<Record<string, unknown>>): ReadonlyArray<string> => {
      const tags = meta['tags']
      return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : []
    }

    /** Notes of every company agent the caller may manage, merged by the memory score. */
    const searchNotes = (
      who: Actor,
      me: CurrentUserShape,
      query: string,
      limit: number
    ): Effect.Effect<ReadonlyArray<AgentNoteHit>, Unauthorized> =>
      Effect.gen(function* () {
        const list = yield* agents.list(me)
        const scored: Array<{ readonly score: number; readonly hit: AgentNoteHit }> = []
        for (const agent of list) {
          if (!(yield* access.canManageAgent(who, agent.id))) continue
          const memory = yield* ingest.memoryOf(agent.id)
          if (Option.isNone(memory)) continue
          const hits = yield* memory.value.search(query, { kind: 'note', limit }).pipe(
            Effect.catchTag('MemoryError', () => Effect.succeed([])),
            Effect.orDie
          )
          for (const hit of hits) {
            scored.push({
              score: hit.score,
              hit: new AgentNoteHit({
                agentId: agent.id,
                noteId: hit.id,
                body: hit.body,
                snippet: hit.snippet,
                at: DateTime.unsafeMake(hit.at),
                tags: tagsOf(hit.meta)
              })
            })
          }
        }
        return scored
          .sort((a, b) => b.score - a.score)
          .slice(0, limit)
          .map((s) => s.hit)
      })

    const query = (
      me: CurrentUserShape,
      input: SearchInput
    ): Effect.Effect<SearchResults, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const fts = toSearchQuery(input.q)
        if (fts.prefix.length === 0) return { messages: [], notes: [] }
        const limit = clampLimit(input.limit)
        const [messages, notes] = yield* Effect.all([
          searchMessages(who, input, fts, limit),
          searchNotes(who, me, input.q.trim().endsWith('*') ? input.q : `${input.q.trim()}*`, limit)
        ])
        return { messages, notes }
      })

    return { query } as const
  })
}) {}
