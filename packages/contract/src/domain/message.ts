import { MessageComponent } from './component.js'
import { Schema } from 'effect'

import { ChannelId, CompanyId, EventSeq, MemberId, MessageId } from '../ids.js'
import { AuthorizationRequest } from './authorization.js'
import { Attachment } from './attachment.js'
import { AuthorKind, MemberKind, MessageStatus } from './enums.js'
import { RunOverride } from './run.js'

/** One member who added a reaction — a human today; `kind` is kept so agents can react later. */
export const ReactionMember = Schema.Struct({
  kind: MemberKind,
  id: MemberId
})
export type ReactionMember = typeof ReactionMember.Type

/**
 * One emoji under a message with everyone who used it (docs/build-plan-message-actions.md
 * D1). A message's reactions are ordered by when each emoji was first added.
 */
export class Reaction extends Schema.Class<Reaction>('Reaction')({
  emoji: Schema.String,
  count: Schema.Int.pipe(Schema.positive()),
  /** Everyone who added it, oldest first. */
  members: Schema.Array(ReactionMember)
}) {}

/** One member who has replied in a thread — the facepile on the root message. */
export const ThreadParticipant = Schema.Struct({
  kind: AuthorKind,
  id: MemberId
})
export type ThreadParticipant = typeof ThreadParticipant.Type

/**
 * What the channel shows under a message that has replies (Slack's
 * "3 replies · Last reply 2h ago"). Present only on a root message that has at
 * least one reply, so `thread === undefined` means "no thread here".
 */
export class ThreadSummary extends Schema.Class<ThreadSummary>('ThreadSummary')({
  replyCount: Schema.NonNegativeInt,
  lastReplyAt: Schema.DateTimeUtc,
  /** Most recent replier first, de-duplicated. */
  participants: Schema.Array(ThreadParticipant)
}) {}

export class Message extends Schema.Class<Message>('Message')({
  id: MessageId,
  companyId: CompanyId,
  channelId: ChannelId,
  /** Id of the root message when this is a thread reply. */
  threadId: Schema.optional(MessageId),
  authorKind: AuthorKind,
  authorId: MemberId,
  body: Schema.String,
  /** Server-created permission card; ordinary message writes cannot set this. */
  authorization: Schema.optional(AuthorizationRequest),
  component: Schema.optional(MessageComponent),
  /** `streaming` while an agent reply is still growing (docs/agent-model.md §6). */
  status: MessageStatus,
  /** `seq` of the `message.created` event — what `channels.markRead` takes. */
  seq: EventSeq,
  /** Why a `failed` agent message failed (mirrors `agent.task.failed.payload.error`). */
  error: Schema.optional(Schema.String),
  createdAt: Schema.DateTimeUtc,
  editedAt: Schema.optional(Schema.DateTimeUtc),
  /** Set on a root message that has replies; never set on a reply. */
  thread: Schema.optional(ThreadSummary),
  /**
   * Files sent with the message (docs/build-plan-attachments.md D1). Always an array in
   * memory; absent-or-array on the wire, so older payloads still decode.
   */
  attachments: Schema.optionalWith(Schema.Array(Attachment), { default: () => [] }),
  /**
   * Emoji reactions (docs/build-plan-message-actions.md D1), in the order each emoji was
   * first added. Same wire trick as `attachments`: absent-or-array, always an array here.
   */
  reactions: Schema.optionalWith(Schema.Array(Reaction), { default: () => [] }),
  /**
   * The runtime/seat/model/reasoning this message asked its run to use
   * (docs/build-plan-run-overrides.md D1). Set by the composer's settings popup
   * on a message that wakes an agent; absent on every other message, which is
   * almost all of them.
   */
  runOverride: Schema.optional(RunOverride)
}) {}
