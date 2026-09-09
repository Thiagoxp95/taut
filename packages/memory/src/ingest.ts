/**
 * Pure mapping from contract `Event`s to memory ops (docs/agent-model.md §10 "Ingestion").
 * The server owns the loop: read the company event log from `getCursor(name)`, call
 * `eventToMemoryOps` per event per agent, `apply(ops, { name, seq })` — cursor and rows commit
 * together, so a crash mid-batch replays instead of skipping.
 *
 * No server imports here; `visibility` is whatever the server knows about channel membership.
 */
import type { Event } from '@taut/contract/events'
import { DateTime } from 'effect'
import type { MemoryOp } from './AgentMemory.js'

/** `true` when the agent whose DB we're writing can see `channelId`. */
export type Visibility = (channelId: string) => boolean

/** Optional lookups that make the contextual prefix human (`#backend`, `@bruno`) instead of ids. */
export interface IngestNames {
  readonly channel?: ((channelId: string) => string | undefined) | undefined
  readonly member?: ((kind: 'user' | 'agent', id: string) => string | undefined) | undefined
}

/** Consumers are named per agent so several loops can share one log: `ingest:<agentId>`. */
export const cursorName = (agentId: string) => `ingest:${agentId}`

type MessageOf = Extract<Event, { readonly type: 'message.created' }>['payload']['message']

const messageToOp = (message: MessageOf, names: IngestNames, extraMeta = {}): MemoryOp => ({
  _tag: 'upsert',
  item: {
    kind: 'message',
    sourceId: message.id,
    channelId: message.channelId,
    channelName: names.channel?.(message.channelId),
    threadId: message.threadId,
    authorKind: message.authorKind,
    authorId: message.authorId,
    authorHandle: names.member?.(message.authorKind, message.authorId),
    at: DateTime.formatIso(message.createdAt),
    body: message.body,
    meta: { status: message.status, ...extraMeta }
  }
})

/**
 * Ops to apply to ONE agent's memory for `event`. Empty for events the memory does not track.
 *
 * - `message.created` / `message.updated` → upsert (replace on edit) when the channel is visible.
 * - `message.deleted` → hard delete regardless of visibility (a retracted message must not be recallable).
 * - `agent.task.done` → the final message is upserted and a `task` row keyed by the task id records
 *   the outcome, so "what did @bruno finish last week" is answerable by kind.
 * - Notes are never touched by ingestion.
 */
export const eventToMemoryOps = (
  event: Event,
  visibility: Visibility,
  names: IngestNames = {}
): ReadonlyArray<MemoryOp> => {
  switch (event.type) {
    case 'message.created':
    case 'message.updated': {
      const { message } = event.payload
      return visibility(message.channelId) ? [messageToOp(message, names)] : []
    }
    case 'message.deleted':
      return [{ _tag: 'delete', kind: 'message', sourceId: event.payload.messageId }]
    case 'agent.task.done': {
      const { task, message } = event.payload
      if (!visibility(message.channelId)) return []
      return [
        messageToOp(message, names, { taskId: task.id }),
        {
          _tag: 'upsert',
          item: {
            kind: 'task',
            sourceId: task.id,
            channelId: task.channelId,
            channelName: names.channel?.(task.channelId),
            threadId: task.threadId,
            authorKind: 'agent',
            authorId: task.agentId,
            authorHandle: names.member?.('agent', task.agentId),
            at: DateTime.formatIso(task.endedAt ?? task.startedAt),
            body: message.body,
            meta: { taskId: task.id, messageId: message.id, status: task.status }
          }
        }
      ]
    }
    default:
      return []
  }
}
