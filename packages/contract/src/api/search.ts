import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { ChannelKind } from '../domain/enums.js'
import { Message } from '../domain/message.js'
import { Forbidden, NotFound } from '../errors.js'
import { AgentId, ChannelId } from '../ids.js'
import { Limit } from './common.js'
import { Authentication } from './middleware.js'

/** Free text; the server turns it into a safe FTS5 query (no raw syntax passes through). */
export const SearchQuery = Schema.Struct({
  q: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(200)),
  /** Restrict to one channel the caller can view. */
  channelId: Schema.optional(ChannelId),
  limit: Schema.optional(Limit)
})
export type SearchQuery = typeof SearchQuery.Type

/** Snippet markers: matched terms sit between these two control characters. */
export const SNIPPET_OPEN = '\u0001'
export const SNIPPET_CLOSE = '\u0002'

/** A message the caller may read, ranked by BM25, with the channel it lives in. */
export class MessageHit extends Schema.Class<MessageHit>('MessageHit')({
  message: Message,
  channel: Schema.Struct({ id: ChannelId, name: Schema.String, kind: ChannelKind }),
  /** FTS5 `snippet()` over the body; matches wrapped in `SNIPPET_OPEN`/`SNIPPET_CLOSE`. */
  snippet: Schema.String
}) {}

/**
 * A note an agent wrote to its own memory (`memory_note`), surfaced to admins and the
 * agent's department head — the same people who see that agent's vault and files.
 */
export class AgentNoteHit extends Schema.Class<AgentNoteHit>('AgentNoteHit')({
  agentId: AgentId,
  noteId: Schema.String,
  body: Schema.String,
  snippet: Schema.String,
  at: Schema.DateTimeUtc,
  tags: Schema.Array(Schema.String)
}) {}

export const SearchResults = Schema.Struct({
  messages: Schema.Array(MessageHit),
  notes: Schema.Array(AgentNoteHit)
})
export type SearchResults = typeof SearchResults.Type

export class SearchGroup extends HttpApiGroup.make('search')
  .add(
    /** Full-text search over what the caller can see: messages first, agent notes second. */
    HttpApiEndpoint.get('query', '/')
      .setUrlParams(SearchQuery)
      .addSuccess(SearchResults)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .middleware(Authentication)
  .prefix('/search') {}
