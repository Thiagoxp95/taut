import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Message } from '../domain/message.js'
import { RunOverride } from '../domain/run.js'
import { Conflict, Forbidden, NotFound, Validation } from '../errors.js'
import { AttachmentId, ChannelId, MessageId } from '../ids.js'
import { Limit } from './common.js'
import { Authentication } from './middleware.js'

/** Newest first; `before` is the id of the oldest message already loaded. */
export const ListMessagesQuery = Schema.Struct({
  channelId: ChannelId,
  before: Schema.optional(MessageId),
  limit: Schema.optional(Limit)
})

export const ThreadQuery = Schema.Struct({
  before: Schema.optional(MessageId),
  limit: Schema.optional(Limit)
})

/**
 * `body` may be blank when at least one attachment is sent (docs/build-plan-attachments.md D2);
 * the server answers `Validation` 422 when both are empty.
 */
export const CreateMessagePayload = Schema.Struct({
  channelId: ChannelId,
  threadId: Schema.optional(MessageId),
  body: Schema.String,
  /** Orphan uploads by the same user in `channelId` (`attachments.upload`), linked on create. */
  attachmentIds: Schema.optional(Schema.Array(AttachmentId).pipe(Schema.maxItems(10))),
  /**
   * Runtime/seat/model/reasoning for the run this message spawns
   * (docs/build-plan-run-overrides.md D1). Ignored when the message wakes no
   * agent; a `subscriptionId` that does not match the effective runtime is a
   * `Validation` 422 rather than a silent fallback (D9).
   */
  runOverride: Schema.optional(RunOverride)
})

export const EditMessagePayload = Schema.Struct({ body: Schema.NonEmptyString })

/** `Page(Message)` with `nextCursor` branded: feed it straight back as `before`. */
export const MessagePage = Schema.Struct({
  items: Schema.Array(Message),
  nextCursor: Schema.optional(MessageId)
})
export type MessagePage = typeof MessagePage.Type

/**
 * Shape only — the server enforces docs/build-plan-message-actions.md D4 (1–8 code points,
 * no whitespace, no ASCII letters/digits) and answers `Validation` 422 otherwise.
 */
export const Emoji = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32))
export type Emoji = typeof Emoji.Type

const MessagePath = Schema.Struct({ messageId: MessageId })
const ThreadPath = Schema.Struct({ threadId: MessageId })
/** `emoji` travels URL-encoded in the path. */
const ReactionPath = Schema.Struct({ messageId: MessageId, emoji: Emoji })

export class MessagesGroup extends HttpApiGroup.make('messages')
  .add(
    HttpApiEndpoint.get('list', '/')
      .setUrlParams(ListMessagesQuery)
      .addSuccess(MessagePage)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post('create', '/')
      .setPayload(CreateMessagePayload)
      .addSuccess(Message, { status: 201 })
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.patch('edit', '/:messageId')
      .setPath(MessagePath)
      .setPayload(EditMessagePayload)
      .addSuccess(Message)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
  )
  .add(
    HttpApiEndpoint.del('delete', '/:messageId')
      .setPath(MessagePath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /** Replies to `threadId`, oldest first. */
    HttpApiEndpoint.get('thread', '/:threadId/thread')
      .setPath(ThreadPath)
      .setUrlParams(ThreadQuery)
      .addSuccess(MessagePage)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /** Add the caller's reaction (idempotent); answers the hydrated message, emits `message.updated`. */
    HttpApiEndpoint.put('react', '/:messageId/reactions/:emoji')
      .setPath(ReactionPath)
      .addSuccess(Message)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    /** Remove the caller's reaction; a reaction that is not there is a no-op. */
    HttpApiEndpoint.del('unreact', '/:messageId/reactions/:emoji')
      .setPath(ReactionPath)
      .addSuccess(Message)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .middleware(Authentication)
  .prefix('/messages') {}
