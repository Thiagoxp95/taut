import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import {
  AuthorKind,
  Message,
  MessageStatus,
  NotificationKind,
  RunOverride,
  RuntimeKind,
  type ThreadParticipant,
  ThreadSummary
} from '@taut/contract/domain'
import { Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import type { Mention } from '@taut/contract/events'
import {
  AgentId,
  type AttachmentId,
  ChannelId,
  CompanyId,
  MemberId,
  MessageId,
  NotificationId,
  SubscriptionId,
  type TaskId,
  UserId,
  newMessageId,
  newNotificationId
} from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { Count, findAll, findOne, nowIso, run, single } from '../db/sql.js'
import {
  type ChannelRow,
  MessageRow,
  NotificationRow,
  toMessage,
  toNotification
} from '../domain/rows.js'
import { EventLog } from '../realtime/eventLog.js'
import { type Actor, actor, isAdmin, userHandle } from './access.js'
import { Attachments, type HostFile, type Uploader } from './attachments.js'
import { Channels } from './channels.js'
import { type Emit, EventPublisher } from './publisher.js'
import { Reactions } from './reactions.js'
import { Users } from './users.js'

/** `RunOverride` → the JSON stored in `messages.run_override` (docs/build-plan-run-overrides.md D1). */
const encodeOverride = Schema.encodeSync(RunOverride)

export const MAX_PAGE = 100
const DEFAULT_PAGE = 50
const MESSAGE_COLUMNS =
  'id, company_id, channel_id, thread_id, author_kind, author_id, body, status, seq, error, created_at, edited_at, run_override'

export interface Page<A> {
  readonly items: ReadonlyArray<A>
  /** The last item's id; pass it back as `before`. */
  readonly nextCursor?: MessageId | undefined
}

/** `@handle` tokens in a body, lower-cased, trailing punctuation stripped, de-duplicated. */
export const parseHandles = (body: string): ReadonlyArray<string> => {
  const out = new Set<string>()
  for (const match of body.matchAll(/(?:^|[^A-Za-z0-9_@])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g)) {
    const raw = match[1]
    if (raw === undefined) continue
    const handle = raw.toLowerCase().replace(/[._-]+$/, '')
    if (handle.length > 0) out.add(handle)
  }
  return [...out]
}

const BROADCAST = new Set(['channel', 'here', 'everyone'])
const isUserId = Schema.is(UserId)

/** Who wrote a message: a session user or an agent (the scheduler / agent-runtime API). */
export interface Author {
  readonly kind: AuthorKind
  readonly id: MemberId
}

export interface AgentPostInput {
  readonly agentId: AgentId
  readonly channelId: ChannelId
  /** Root message to reply under; `undefined` posts top-level. */
  readonly threadId?: MessageId | undefined
  readonly body: string
  /** Default `true`: the agent must be a channel member (docs/agent-model.md §2). */
  readonly requireMembership?: boolean | undefined
  /** Files to send with the message, already resolved inside the agent home (D4). */
  readonly attachments?: ReadonlyArray<HostFile> | undefined
}

/** A message the server posts on a human's behalf (a routine firing, docs/build-plan-routines.md D1). */
export interface UserPostInput {
  readonly userId: UserId
  readonly channelId: ChannelId
  /** Root message to reply under; `undefined` posts top-level. */
  readonly threadId?: MessageId | undefined
  readonly body: string
}

/** Messages, threads, mentions and the notification fan-out of §8. */
export class Messages extends Effect.Service<Messages>()('Messages', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const users = yield* Users
    const channels = yield* Channels
    const publisher = yield* EventPublisher
    const eventLog = yield* EventLog
    const attachments = yield* Attachments
    const reactions = yield* Reactions

    // ── queries ──────────────────────────────────────────────────────────────

    const byId = findOne({
      Request: Schema.Struct({ companyId: CompanyId, messageId: MessageId }),
      Result: MessageRow,
      execute: (r) => sql`
        SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages
        WHERE company_id = ${r.companyId} AND id = ${r.messageId}`
    })

    /** Raw ordering key of a message: `(created_at, rowid)`. */
    const cursorOf = findOne({
      Request: Schema.Struct({ companyId: CompanyId, channelId: ChannelId, messageId: MessageId }),
      Result: Schema.Struct({ created_at: Schema.String, rid: Schema.Number }),
      execute: (r) => sql`
        SELECT created_at, rowid AS rid FROM messages
        WHERE company_id = ${r.companyId} AND channel_id = ${r.channelId} AND id = ${r.messageId}`
    })

    const PageRequest = Schema.Struct({
      companyId: CompanyId,
      channelId: ChannelId,
      threadId: Schema.NullOr(MessageId),
      beforeAt: Schema.NullOr(Schema.String),
      beforeRid: Schema.NullOr(Schema.Number),
      limit: Schema.Number
    })

    /** Newest first; top-level (`threadId` null) or one thread. `before*` bounds are exclusive. */
    const pageDesc = findAll({
      Request: PageRequest,
      Result: MessageRow,
      execute: (r) => sql`
        SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages
        WHERE company_id = ${r.companyId} AND channel_id = ${r.channelId}
          AND (${r.threadId} IS NULL AND thread_id IS NULL OR thread_id = ${r.threadId})
          AND (${r.beforeAt} IS NULL
               OR created_at < ${r.beforeAt}
               OR (created_at = ${r.beforeAt} AND rowid < ${r.beforeRid}))
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${r.limit}`
    })

    /** Oldest first for threads, same exclusive `before*` bound. */
    const pageAsc = findAll({
      Request: PageRequest,
      Result: MessageRow,
      execute: (r) => sql`
        SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages
        WHERE company_id = ${r.companyId} AND channel_id = ${r.channelId} AND thread_id = ${r.threadId}
          AND (${r.beforeAt} IS NULL
               OR created_at < ${r.beforeAt}
               OR (created_at = ${r.beforeAt} AND rowid < ${r.beforeRid}))
        ORDER BY created_at ASC, rowid ASC
        LIMIT ${r.limit}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: MessageId,
        companyId: CompanyId,
        channelId: ChannelId,
        threadId: Schema.NullOr(MessageId),
        authorKind: AuthorKind,
        authorId: MemberId,
        body: Schema.String,
        status: MessageStatus,
        seq: Schema.Number,
        createdAt: Schema.String,
        /** `RunOverride` as JSON (docs/build-plan-run-overrides.md D1); NULL on almost every row. */
        runOverride: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        INSERT INTO messages (id, company_id, channel_id, thread_id, author_kind, author_id, body, status, seq, created_at, edited_at, run_override)
        VALUES (${r.id}, ${r.companyId}, ${r.channelId}, ${r.threadId}, ${r.authorKind}, ${r.authorId}, ${r.body}, ${r.status}, ${r.seq}, ${r.createdAt}, NULL, ${r.runOverride})`
    })

    /**
     * The runtime of one seat, read straight off `subscriptions`.
     *
     * `Subscriptions` and `Messages` are the same layer tier, so this cannot go
     * through that service without a cycle — and what is wanted is one column of
     * one row, checked before a message is written
     * (docs/build-plan-run-overrides.md D9).
     */
    const seatRuntime = findOne({
      Request: Schema.Struct({ companyId: CompanyId, subscriptionId: SubscriptionId }),
      Result: Schema.Struct({ runtime: RuntimeKind }),
      execute: (r) => sql`
        SELECT runtime FROM subscriptions
        WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    const appendBody = run({
      Request: Schema.Struct({ companyId: CompanyId, messageId: MessageId, delta: Schema.String }),
      execute: (r) => sql`
        UPDATE messages SET body = body || ${r.delta}
        WHERE company_id = ${r.companyId} AND id = ${r.messageId}`
    })

    const setFinal = run({
      Request: Schema.Struct({
        companyId: CompanyId,
        messageId: MessageId,
        status: MessageStatus,
        error: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        UPDATE messages SET status = ${r.status}, error = ${r.error}
        WHERE company_id = ${r.companyId} AND id = ${r.messageId}`
    })

    /** Agent-authored messages in a thread (root included) — the §9 turn cap counts these. */
    const agentTurns = single({
      Request: Schema.Struct({ companyId: CompanyId, threadId: MessageId }),
      Result: Count,
      execute: (r) => sql`
        SELECT COUNT(*) AS n FROM messages
        WHERE company_id = ${r.companyId} AND author_kind = 'agent'
          AND (id = ${r.threadId} OR thread_id = ${r.threadId})`
    })

    /** Newest `limit` messages of a thread, or of the channel's top level when `threadId` is null. */
    const recentDesc = findAll({
      Request: Schema.Struct({
        companyId: CompanyId,
        channelId: ChannelId,
        threadId: Schema.NullOr(MessageId),
        limit: Schema.Number
      }),
      Result: MessageRow,
      execute: (r) => sql`
        SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages
        WHERE company_id = ${r.companyId} AND channel_id = ${r.channelId}
          AND (${r.threadId} IS NULL AND thread_id IS NULL
               OR thread_id = ${r.threadId} OR id = ${r.threadId})
        ORDER BY created_at DESC, rowid DESC
        LIMIT ${r.limit}`
    })

    /**
     * Thread messages strictly after `afterId`, oldest first (docs/build-plan-sessions.md D7).
     * A resumed runtime already holds everything up to `afterId`, so re-injecting it would show
     * the model the same message twice under two different framings.
     */
    const sinceAsc = findAll({
      Request: Schema.Struct({
        companyId: CompanyId,
        threadId: MessageId,
        afterId: MessageId,
        limit: Schema.Number
      }),
      Result: MessageRow,
      execute: (r) => sql`
        SELECT ${sql.literal(MESSAGE_COLUMNS)} FROM messages
        WHERE company_id = ${r.companyId}
          AND (thread_id = ${r.threadId} OR id = ${r.threadId})
          AND (created_at, rowid) > (
            SELECT a.created_at, a.rowid FROM messages a WHERE a.id = ${r.afterId})
        ORDER BY created_at ASC, rowid ASC
        LIMIT ${r.limit}`
    })

    const agentMember = single({
      Request: Schema.Struct({ channelId: ChannelId, agentId: AgentId }),
      Result: Count,
      execute: (r) => sql`
        SELECT COUNT(*) AS n FROM channel_members
        WHERE channel_id = ${r.channelId} AND member_kind = 'agent' AND member_id = ${r.agentId}`
    })

    const setSeq = run({
      Request: Schema.Struct({ companyId: CompanyId, messageId: MessageId, seq: Schema.Number }),
      execute: (r) => sql`
        UPDATE messages SET seq = ${r.seq} WHERE company_id = ${r.companyId} AND id = ${r.messageId}`
    })

    const updateBody = run({
      Request: Schema.Struct({
        companyId: CompanyId,
        messageId: MessageId,
        body: Schema.String,
        editedAt: Schema.String
      }),
      execute: (r) => sql`
        UPDATE messages SET body = ${r.body}, edited_at = ${r.editedAt}
        WHERE company_id = ${r.companyId} AND id = ${r.messageId}`
    })

    const remove = run({
      Request: Schema.Struct({ companyId: CompanyId, messageId: MessageId }),
      execute: (r) =>
        sql`DELETE FROM messages WHERE company_id = ${r.companyId} AND id = ${r.messageId}`
    })

    const threadParticipants = findAll({
      Request: Schema.Struct({ companyId: CompanyId, threadId: MessageId }),
      Result: Schema.Struct({ author_id: UserId }),
      execute: (r) => sql`
        SELECT DISTINCT author_id FROM messages
        WHERE company_id = ${r.companyId} AND author_kind = 'user'
          AND (id = ${r.threadId} OR thread_id = ${r.threadId})`
    })

    /** Reply count and last-reply time for a batch of root messages. */
    const threadCounts = findAll({
      Request: Schema.Struct({ companyId: CompanyId, ids: Schema.Array(MessageId) }),
      Result: Schema.Struct({
        thread_id: MessageId,
        n: Schema.Number,
        last_at: Schema.DateTimeUtc
      }),
      execute: (r) => sql`
        SELECT thread_id, COUNT(*) AS n, MAX(created_at) AS last_at FROM messages
        WHERE company_id = ${r.companyId} AND ${sql.in('thread_id', r.ids)}
        GROUP BY thread_id`
    })

    /** One row per (thread, author): who replied, and when they last did. */
    const threadFacepile = findAll({
      Request: Schema.Struct({ companyId: CompanyId, ids: Schema.Array(MessageId) }),
      Result: Schema.Struct({
        thread_id: MessageId,
        author_kind: AuthorKind,
        author_id: MemberId,
        last_at: Schema.String
      }),
      execute: (r) => sql`
        SELECT thread_id, author_kind, author_id, MAX(created_at) AS last_at FROM messages
        WHERE company_id = ${r.companyId} AND ${sql.in('thread_id', r.ids)}
        GROUP BY thread_id, author_kind, author_id
        ORDER BY last_at DESC`
    })

    const insertNotification = run({
      Request: Schema.Struct({
        id: NotificationId,
        companyId: CompanyId,
        userId: UserId,
        eventSeq: Schema.Number,
        kind: NotificationKind,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO notifications (id, company_id, user_id, event_seq, kind, read_at, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.userId}, ${r.eventSeq}, ${r.kind}, NULL, ${r.createdAt})`
    })

    const notificationById = findOne({
      Request: NotificationId,
      Result: NotificationRow,
      execute: (id) =>
        sql`SELECT id, company_id, user_id, event_seq, kind, read_at FROM notifications WHERE id = ${id}`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    /**
     * Hydrate `attachments` on a page of messages: one query per page, none when the page
     * is empty (docs/build-plan-attachments.md). Every read path goes through here.
     */
    const withAttachments = (
      companyId: CompanyId,
      messages: ReadonlyArray<Message>
    ): Effect.Effect<ReadonlyArray<Message>> =>
      messages.length === 0
        ? Effect.succeed(messages)
        : attachments
            .listForMessages(
              companyId,
              messages.map((m) => m.id)
            )
            .pipe(
              Effect.map((byMessage) =>
                messages.map((message) => {
                  const list = byMessage.get(message.id)
                  return list === undefined
                    ? message
                    : new Message({ ...message, attachments: list })
                })
              )
            )

    /** Rows → hydrated messages, in row order. */
    const hydrate = (
      companyId: CompanyId,
      rows: ReadonlyArray<MessageRow>
    ): Effect.Effect<ReadonlyArray<Message>> =>
      withAttachments(companyId, rows.map(toMessage)).pipe(
        Effect.flatMap((messages) => reactions.withReactions(companyId, messages))
      )

    /**
     * Attach the thread summary (§ "N replies" under the root message) to every
     * root in `messages`. Two grouped queries per page, both on
     * `messages_thread_id`; replies are skipped — only a root carries a summary.
     */
    const withThreads = (
      companyId: CompanyId,
      messages: ReadonlyArray<Message>
    ): Effect.Effect<ReadonlyArray<Message>> =>
      Effect.gen(function* () {
        const ids = messages.filter((m) => m.threadId === undefined).map((m) => m.id)
        if (ids.length === 0) return messages

        const [counts, faces] = yield* Effect.all([
          threadCounts({ companyId, ids }),
          threadFacepile({ companyId, ids })
        ])
        if (counts.length === 0) return messages

        const participants = new Map<MessageId, Array<ThreadParticipant>>()
        for (const face of faces) {
          const list = participants.get(face.thread_id) ?? []
          list.push({ kind: face.author_kind, id: face.author_id })
          participants.set(face.thread_id, list)
        }

        const summaries = new Map<MessageId, ThreadSummary>()
        for (const row of counts) {
          summaries.set(
            row.thread_id,
            new ThreadSummary({
              replyCount: row.n,
              lastReplyAt: row.last_at,
              participants: participants.get(row.thread_id) ?? []
            })
          )
        }

        return messages.map((message) => {
          const thread = summaries.get(message.id)
          return thread === undefined ? message : new Message({ ...message, thread })
        })
      })

    /** The same, for a single message (a `message.created` / `message.updated` payload). */
    const withThread = (companyId: CompanyId, message: Message): Effect.Effect<Message> =>
      message.threadId !== undefined
        ? Effect.succeed(message)
        : withThreads(companyId, [message]).pipe(Effect.map(([only]) => only ?? message))

    const load = (who: Actor, messageId: MessageId) =>
      byId({ companyId: who.companyId, messageId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Message', id: messageId })),
            onSome: Effect.succeed
          })
        )
      )

    const loadMessage = (companyId: CompanyId, messageId: MessageId): Effect.Effect<Message> =>
      byId({ companyId, messageId }).pipe(
        Effect.flatMap(Effect.orDie),
        Effect.flatMap((row) =>
          hydrate(companyId, [row]).pipe(Effect.map(([message]) => message ?? toMessage(row)))
        ),
        Effect.flatMap((message) => withThread(companyId, message))
      )

    const clampLimit = (limit: number | undefined) =>
      Math.min(MAX_PAGE, Math.max(1, limit ?? DEFAULT_PAGE))

    /** Resolves `before` to its ordering key; an id from another channel is `NotFound`. */
    const bound = (who: Actor, channelId: ChannelId, before: MessageId | undefined) =>
      Effect.gen(function* () {
        if (before === undefined) return { beforeAt: null, beforeRid: null }
        const cursor = yield* cursorOf({ companyId: who.companyId, channelId, messageId: before })
        if (Option.isNone(cursor)) return yield* new NotFound({ entity: 'Message', id: before })
        return { beforeAt: cursor.value.created_at, beforeRid: cursor.value.rid }
      })

    const toPage = (
      companyId: CompanyId,
      rows: ReadonlyArray<MessageRow>,
      limit: number
    ): Effect.Effect<Page<Message>> =>
      hydrate(companyId, rows).pipe(
        Effect.map((items) => {
          const last = items[items.length - 1]
          return rows.length === limit && last ? { items, nextCursor: last.id } : { items }
        })
      )

    /**
     * Resolve `@handle`s against the company's agents and members (users: email local part),
     * keeping only those who belong to the channel the message lands in. Someone outside the
     * channel cannot be pinged into it: the scheduler already refuses to wake a non-member
     * agent, and a mention row for a stranger would promise a notification nobody gets.
     */
    const resolveMentions = (
      companyId: CompanyId,
      channelId: ChannelId,
      body: string
    ): Effect.Effect<{ mentions: ReadonlyArray<Mention>; broadcast: boolean }> =>
      Effect.gen(function* () {
        const handles = parseHandles(body)
        if (handles.length === 0) return { mentions: [], broadcast: false }
        const wanted = new Set(handles)
        const [agents, members, agentIds, humanIds] = yield* Effect.all([
          users.agentsOf(companyId),
          users.membersOf(companyId),
          channels.agentMembers(channelId),
          channels.humanMembers(channelId)
        ])
        const inChannel = new Set<string>([...agentIds, ...humanIds])
        const mentions: Array<Mention> = []
        for (const agent of agents) {
          if (wanted.has(agent.handle) && inChannel.has(agent.id)) {
            mentions.push({ memberKind: 'agent', memberId: agent.id, handle: agent.handle })
          }
        }
        for (const member of members) {
          const handle = userHandle(member.email)
          if (wanted.has(handle) && inChannel.has(member.id)) {
            mentions.push({ memberKind: 'user', memberId: member.id, handle })
          }
        }
        return { mentions, broadcast: handles.some((h) => BROADCAST.has(h)) }
      })

    /**
     * D9: an override may pick a different brain, never a wider hand, and never
     * somebody else's seat. A seat from another company reads as absent, and a
     * seat whose runtime the message also names is refused here rather than
     * silently ignored an hour later when the task runs.
     */
    const checkOverride = (
      companyId: CompanyId,
      override: RunOverride | undefined
    ): Effect.Effect<void, Validation> =>
      Effect.gen(function* () {
        if (override?.subscriptionId === undefined) return
        const seat = yield* seatRuntime({ companyId, subscriptionId: override.subscriptionId })
        if (Option.isNone(seat)) {
          return yield* new Validation({
            issues: [{ path: ['runOverride', 'subscriptionId'], message: 'No such subscription' }]
          })
        }
        if (override.runtimeKind !== undefined && seat.value.runtime !== override.runtimeKind) {
          return yield* new Validation({
            issues: [
              {
                path: ['runOverride', 'subscriptionId'],
                message: `That seat runs ${seat.value.runtime}, not ${override.runtimeKind}`
              }
            ]
          })
        }
      })

    /** §8 notifications table: mention / dm / thread_reply rows + per-user events. */
    const fanOut = (
      emit: Emit,
      companyId: CompanyId,
      author: Author,
      channel: ChannelRow,
      message: Message,
      eventSeq: number,
      mentions: ReadonlyArray<Mention>,
      broadcast: boolean
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const humans = (yield* channels.humanMembers(channel.id)).filter(
          (id) => !(author.kind === 'user' && id === author.id)
        )
        const humanSet = new Set(humans)
        const kinds = new Map<UserId, NotificationKind>()
        const mark = (userId: UserId, kind: NotificationKind) => {
          if (humanSet.has(userId) && !kinds.has(userId)) kinds.set(userId, kind)
        }
        for (const m of mentions) if (isUserId(m.memberId)) mark(m.memberId, 'mention')
        if (broadcast) for (const id of humans) mark(id, 'mention')
        if (channel.kind === 'dm') for (const id of humans) mark(id, 'dm')
        if (message.threadId !== undefined) {
          const participants = yield* threadParticipants({ companyId, threadId: message.threadId })
          for (const p of participants) mark(p.author_id, 'thread_reply')
        }

        for (const [userId, kind] of kinds) {
          yield* notifyUser(emit, companyId, userId, kind, eventSeq, channel.id, message.id)
        }
        yield* emitUnread(emit, companyId, humans, channel.id, message.threadId)
      })

    /** One `notifications` row + its per-user event. */
    const notifyUser = (
      emit: Emit,
      companyId: CompanyId,
      userId: UserId,
      kind: NotificationKind,
      eventSeq: number,
      channelId: ChannelId,
      messageId: MessageId
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const id = newNotificationId()
        yield* insertNotification({ id, companyId, userId, eventSeq, kind, createdAt: nowIso() })
        const row = yield* notificationById(id).pipe(Effect.flatMap(Effect.orDie))
        yield* emit({
          type: 'notification',
          payload: { notification: toNotification(row), channelId, messageId }
        })
      })

    const emitUnread = (
      emit: Emit,
      companyId: CompanyId,
      humans: ReadonlyArray<UserId>,
      channelId: ChannelId,
      threadId: MessageId | undefined
    ): Effect.Effect<void> =>
      Effect.forEach(
        humans,
        (userId) =>
          channels.unreadFor(companyId, userId, channelId).pipe(
            Effect.flatMap((counts) =>
              emit({
                type: 'unread.changed',
                payload: {
                  userId,
                  channelId,
                  ...(threadId === undefined ? {} : { threadId }),
                  ...counts
                }
              })
            )
          ),
        { discard: true }
      )

    /**
     * A reply landed (or went away): re-publish the root so every client's
     * "N replies" footer follows along. A reply whose root has been deleted is
     * a no-op rather than a failure.
     */
    const emitThreadSummary = (
      emit: Emit,
      companyId: CompanyId,
      threadId: MessageId
    ): Effect.Effect<void> =>
      byId({ companyId, messageId: threadId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: () =>
              loadMessage(companyId, threadId).pipe(
                Effect.flatMap((message) =>
                  emit({ type: 'message.updated', payload: { message } })
                ),
                Effect.asVoid
              )
          })
        )
      )

    /**
     * Insert + `message.created` (with the final `seq` on the row) inside the caller's
     * transaction. Shared by human posts, agent posts and the streaming placeholder.
     */
    const insertAndEmit = <E = never>(
      emit: Emit,
      input: {
        readonly companyId: CompanyId
        readonly channelId: ChannelId
        readonly threadId: MessageId | null
        readonly author: Author
        readonly body: string
        readonly status: MessageStatus
        readonly mentions: ReadonlyArray<Mention>
        /** Orphan uploads to link to the new row before it is loaded and announced (D2). */
        readonly attachmentIds?: ReadonlyArray<AttachmentId> | undefined
        /** What this message asks its run to use (docs/build-plan-run-overrides.md D1). */
        readonly runOverride?: RunOverride | undefined
      }
    ): Effect.Effect<{ readonly message: Message; readonly seq: number }, Forbidden | E> =>
      Effect.gen(function* () {
        const id = newMessageId()
        // The transaction serialises appends, so the creation event gets `head + 1`;
        // writing it up front lets the event payload carry the final `seq`.
        const seq = (yield* eventLog.latestSeq(input.companyId).pipe(Effect.orDie)) + 1
        yield* insert({
          id,
          companyId: input.companyId,
          channelId: input.channelId,
          threadId: input.threadId,
          authorKind: input.author.kind,
          authorId: input.author.id,
          body: input.body,
          status: input.status,
          seq,
          createdAt: nowIso(),
          runOverride:
            input.runOverride === undefined
              ? null
              : JSON.stringify(encodeOverride(input.runOverride))
        })
        if (input.attachmentIds !== undefined && input.attachmentIds.length > 0) {
          yield* attachments.link(
            input.companyId,
            input.author,
            input.channelId,
            id,
            input.attachmentIds
          )
        }
        let message = yield* loadMessage(input.companyId, id)
        const created = yield* emit({
          type: 'message.created',
          payload: { message, mentions: input.mentions }
        })
        if (created.seq !== seq) {
          yield* setSeq({ companyId: input.companyId, messageId: id, seq: created.seq })
          message = yield* loadMessage(input.companyId, id)
        }
        return { message, seq: created.seq }
      })

    // ── endpoints ────────────────────────────────────────────────────────────

    const list = (
      me: CurrentUserShape,
      query: {
        readonly channelId: ChannelId
        readonly before?: MessageId | undefined
        readonly limit?: number | undefined
      }
    ): Effect.Effect<Page<Message>, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const channel = yield* channels.load(who, query.channelId)
        yield* channels.requireView(who, channel)
        const limit = clampLimit(query.limit)
        const b = yield* bound(who, channel.id, query.before)
        const rows = yield* pageDesc({
          companyId: who.companyId,
          channelId: channel.id,
          threadId: null,
          ...b,
          limit
        })
        const page = yield* toPage(who.companyId, rows, limit)
        return { ...page, items: yield* withThreads(who.companyId, page.items) }
      })

    const create = (
      me: CurrentUserShape,
      input: {
        readonly channelId: ChannelId
        readonly threadId?: MessageId | undefined
        readonly body: string
        /** Orphans this user uploaded to `channelId` (`attachments.upload`), linked on create. */
        readonly attachmentIds?: ReadonlyArray<AttachmentId> | undefined
        /** Runtime/seat/model/reasoning for the run this message spawns (D1). */
        readonly runOverride?: RunOverride | undefined
      }
    ): Effect.Effect<Message, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const attachmentIds = input.attachmentIds ?? []
        // D2: text or at least one file — an empty message is a 422, not a blank bubble.
        if (input.body.trim() === '' && attachmentIds.length === 0) {
          return yield* new Validation({
            issues: [{ path: ['body'], message: 'A message needs text or at least one attachment' }]
          })
        }
        yield* checkOverride(who.companyId, input.runOverride)
        const channel = yield* channels.load(who, input.channelId)
        yield* channels.requirePost(who, channel)
        let threadId: MessageId | null = null
        if (input.threadId !== undefined) {
          const root = yield* load(who, input.threadId)
          if (root.channel_id !== channel.id) {
            return yield* new NotFound({ entity: 'Message', id: input.threadId })
          }
          // Replies to a reply land in the same thread.
          threadId = root.thread_id ?? root.id
        }
        const { mentions, broadcast } = yield* resolveMentions(
          who.companyId,
          channel.id,
          input.body
        )
        const author: Author = { kind: 'user', id: who.userId }

        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const { message, seq } = yield* insertAndEmit(emit, {
              companyId: who.companyId,
              channelId: channel.id,
              threadId,
              author,
              body: input.body,
              status: 'sent',
              mentions,
              attachmentIds,
              runOverride: input.runOverride
            })
            yield* fanOut(emit, who.companyId, author, channel, message, seq, mentions, broadcast)
            if (threadId !== null) yield* emitThreadSummary(emit, who.companyId, threadId)
            return message
          })
        )
      })

    const requireAuthorOrAdmin = (who: Actor, row: MessageRow): Effect.Effect<void, Forbidden> =>
      isAdmin(who.role) || (row.author_kind === 'user' && row.author_id === who.userId)
        ? Effect.void
        : Effect.fail(new Forbidden({ message: 'Only the author or an admin can do that' }))

    const edit = (
      me: CurrentUserShape,
      messageId: MessageId,
      body: string
    ): Effect.Effect<Message, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who, messageId)
        yield* requireAuthorOrAdmin(who, row)
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* updateBody({ companyId: who.companyId, messageId, body, editedAt: nowIso() })
            const message = yield* loadMessage(who.companyId, messageId)
            yield* emit({ type: 'message.updated', payload: { message } })
            return message
          })
        )
      })

    /**
     * A rewrite the server does on its own behalf: the huddle message becoming its summary
     * when the room closes (docs/build-plan-huddle-window.md D8). There is no actor to check
     * — nobody asked for it — so this deliberately skips `requireAuthorOrAdmin`; the caller
     * owns the id it passes because it stored it itself.
     */
    const editAsSystem = (
      companyId: CompanyId,
      messageId: MessageId,
      body: string
    ): Effect.Effect<Message> =>
      publisher.transact(companyId, (emit) =>
        Effect.gen(function* () {
          yield* updateBody({ companyId, messageId, body, editedAt: nowIso() })
          const message = yield* loadMessage(companyId, messageId)
          yield* emit({ type: 'message.updated', payload: { message } })
          return message
        })
      )

    const del = (
      me: CurrentUserShape,
      messageId: MessageId
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const row = yield* load(who, messageId)
        yield* requireAuthorOrAdmin(who, row)
        const threadId = row.thread_id
        yield* publisher.transact(who.companyId, (emit) =>
          // D7: files first — the FK cascades the rows, not the bytes.
          attachments.deleteForMessage(who.companyId, messageId).pipe(
            Effect.zipRight(remove({ companyId: who.companyId, messageId })),
            Effect.zipRight(
              emit({
                type: 'message.deleted',
                payload: {
                  messageId,
                  channelId: row.channel_id,
                  ...(threadId === null ? {} : { threadId })
                }
              })
            ),
            // The root's reply count just dropped.
            Effect.zipRight(
              threadId === null ? Effect.void : emitThreadSummary(emit, who.companyId, threadId)
            )
          )
        )
      })

    const thread = (
      me: CurrentUserShape,
      threadId: MessageId,
      query: { readonly before?: MessageId | undefined; readonly limit?: number | undefined }
    ): Effect.Effect<Page<Message>, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const root = yield* load(who, threadId)
        const channel = yield* channels.load(who, root.channel_id)
        yield* channels.requireView(who, channel)
        const limit = clampLimit(query.limit)
        const b = yield* bound(who, channel.id, query.before)
        const rows = yield* pageAsc({
          companyId: who.companyId,
          channelId: channel.id,
          threadId: root.id,
          ...b,
          limit
        })
        return yield* toPage(who.companyId, rows, limit)
      })

    // ── server-internal: agents (scheduler, task runner, agent-runtime API) ───

    const channelRow = (companyId: CompanyId, channelId: ChannelId) =>
      channels.find(companyId, channelId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Channel', id: channelId })),
            onSome: Effect.succeed
          })
        )
      )

    /** Root of the thread `threadId` belongs to (a reply's id resolves to its root). */
    const threadRoot = (
      companyId: CompanyId,
      channelId: ChannelId,
      threadId: MessageId
    ): Effect.Effect<MessageId, NotFound> =>
      byId({ companyId, messageId: threadId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Message', id: threadId })),
            onSome: (root) =>
              root.channel_id === channelId
                ? Effect.succeed(root.thread_id ?? root.id)
                : Effect.fail(new NotFound({ entity: 'Message', id: threadId }))
          })
        )
      )

    /** Copy agent files into the blob store as the agent's orphans; the ids are then linked. */
    const storeHostFiles = (
      companyId: CompanyId,
      channelId: ChannelId,
      agentId: AgentId,
      files: ReadonlyArray<HostFile>
    ): Effect.Effect<ReadonlyArray<AttachmentId>, Validation> =>
      Effect.forEach(files, (f) =>
        attachments
          .storeFromHost(companyId, channelId, agentId, f.hostPath, f.name)
          .pipe(Effect.map((a) => a.id))
      )

    /**
     * `taut_done(attachments)`: files for the agent's own reply (the task's streaming
     * message). Linked in one transaction and announced with `message.updated`; the later
     * finalize re-emits the message, attachments included.
     */
    const attachAsAgent = (
      companyId: CompanyId,
      agentId: AgentId,
      messageId: MessageId,
      files: ReadonlyArray<HostFile>
    ): Effect.Effect<Message, NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const row = yield* byId({ companyId, messageId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NotFound({ entity: 'Message', id: messageId })),
              onSome: Effect.succeed
            })
          )
        )
        if (row.author_kind !== 'agent' || row.author_id !== agentId) {
          return yield* new Forbidden({ message: 'Only the author can attach files to a message' })
        }
        const uploader: Uploader = { kind: 'agent', id: agentId }
        const ids = yield* storeHostFiles(companyId, row.channel_id, agentId, files)
        return yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            yield* attachments.link(companyId, uploader, row.channel_id, messageId, ids)
            const message = yield* loadMessage(companyId, messageId)
            yield* emit({ type: 'message.updated', payload: { message } })
            return message
          })
        )
      })

    /**
     * A message authored by an agent: `@handle`s resolve, humans get notified, the
     * `message.created` event carries `mentions` (which is what the scheduler keys off).
     */
    const postAsAgent = (
      companyId: CompanyId,
      input: AgentPostInput
    ): Effect.Effect<Message, NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const channel = yield* channelRow(companyId, input.channelId)
        if (input.requireMembership !== false) {
          const member = yield* agentMember({ channelId: channel.id, agentId: input.agentId })
          if (member.n === 0) {
            return yield* new Forbidden({
              message: `Agent ${input.agentId} is not a member of channel ${channel.id}`
            })
          }
        }
        const threadId =
          input.threadId === undefined
            ? null
            : yield* threadRoot(companyId, channel.id, input.threadId)
        const { mentions, broadcast } = yield* resolveMentions(companyId, channel.id, input.body)
        const author: Author = { kind: 'agent', id: input.agentId }
        // The bytes are copied before the transaction (a rolled-back post leaves orphans the
        // sweep removes); the rows are linked inside it, like a human's uploads.
        const attachmentIds = yield* storeHostFiles(
          companyId,
          channel.id,
          input.agentId,
          input.attachments ?? []
        )
        return yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            const { message, seq } = yield* insertAndEmit(emit, {
              companyId,
              channelId: channel.id,
              threadId,
              author,
              body: input.body,
              status: 'sent',
              mentions,
              attachmentIds
            })
            yield* fanOut(emit, companyId, author, channel, message, seq, mentions, broadcast)
            if (threadId !== null) yield* emitThreadSummary(emit, companyId, threadId)
            return message
          })
        )
      })

    /**
     * A message authored by a human without a session: a routine firing as its owner. Same
     * fan-out as `postAsAgent`; the user must be a member of the channel (the owner↔agent DM
     * the runner opens satisfies that), and admins may post anywhere `requirePost` lets them.
     */
    const postAsUser = (
      companyId: CompanyId,
      input: UserPostInput
    ): Effect.Effect<Message, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const channel = yield* channelRow(companyId, input.channelId)
        const role = yield* users.roleIn(companyId, input.userId)
        if (Option.isNone(role)) {
          return yield* new Forbidden({
            message: `User ${input.userId} is not a member of company ${companyId}`
          })
        }
        yield* channels.requirePost({ userId: input.userId, companyId, role: role.value }, channel)
        const threadId =
          input.threadId === undefined
            ? null
            : yield* threadRoot(companyId, channel.id, input.threadId)
        const { mentions, broadcast } = yield* resolveMentions(companyId, channel.id, input.body)
        const author: Author = { kind: 'user', id: input.userId }
        return yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            const { message, seq } = yield* insertAndEmit(emit, {
              companyId,
              channelId: channel.id,
              threadId,
              author,
              body: input.body,
              status: 'sent',
              mentions
            })
            yield* fanOut(emit, companyId, author, channel, message, seq, mentions, broadcast)
            if (threadId !== null) yield* emitThreadSummary(emit, companyId, threadId)
            return message
          })
        )
      })

    /**
     * The empty `streaming` message an agent's reply grows into (docs/agent-model.md §8).
     * Runs inside the caller's transaction (the task row references the message).
     * No notification rows — those come with `agent.task.done` — but unread counts move.
     */
    const createStreaming = (
      emit: Emit,
      input: {
        readonly companyId: CompanyId
        readonly agentId: AgentId
        readonly channelId: ChannelId
        readonly threadId: MessageId | null
      }
    ): Effect.Effect<Message> =>
      Effect.gen(function* () {
        // No `attachmentIds` → `link` never runs, so its `Forbidden` cannot happen here.
        const { message } = yield* insertAndEmit(emit, {
          companyId: input.companyId,
          channelId: input.channelId,
          threadId: input.threadId,
          author: { kind: 'agent', id: input.agentId },
          body: '',
          status: 'streaming',
          mentions: []
        }).pipe(Effect.orDie)
        const humans = yield* channels.humanMembers(input.channelId)
        yield* emitUnread(emit, input.companyId, humans, input.channelId, message.threadId)
        if (input.threadId !== null) {
          yield* emitThreadSummary(emit, input.companyId, input.threadId)
        }
        return message
      })

    /** Append redacted text to a streaming message and broadcast the delta. */
    const appendDelta = (
      companyId: CompanyId,
      taskId: TaskId,
      messageId: MessageId,
      delta: string
    ): Effect.Effect<void> =>
      delta.length === 0
        ? Effect.void
        : publisher.transact(companyId, (emit) =>
            appendBody({ companyId, messageId, delta }).pipe(
              Effect.zipRight(
                emit({ type: 'agent.task.delta', payload: { taskId, messageId, delta } })
              ),
              Effect.asVoid
            )
          )

    /**
     * Close a streaming message (`sent` or `failed`) inside the caller's transaction and
     * emit `message.updated`; the caller emits `agent.task.done/failed` with the result.
     */
    const finalizeAgentMessage = (
      emit: Emit,
      companyId: CompanyId,
      messageId: MessageId,
      outcome: {
        readonly status: 'sent' | 'failed'
        readonly error?: string | undefined
        readonly appendBody?: string | undefined
      }
    ): Effect.Effect<Message> =>
      Effect.gen(function* () {
        if (outcome.appendBody !== undefined && outcome.appendBody.length > 0) {
          yield* appendBody({ companyId, messageId, delta: outcome.appendBody })
        }
        yield* setFinal({
          companyId,
          messageId,
          status: outcome.status,
          error: outcome.error ?? null
        })
        const message = yield* loadMessage(companyId, messageId)
        yield* emit({ type: 'message.updated', payload: { message } })
        return message
      })

    /**
     * Take back the empty reply a task opened for itself, because the agent's whole answer was
     * a reaction (docs/build-plan-steering-reactions.md D4). Runs inside the same transaction
     * that finalized it, right after `agent.task.done` — so a client that just inserted the
     * finished message removes it in the next frame, and the shimmer stops either way.
     *
     * Refuses to touch a message that has a body: withdrawing text an agent actually wrote
     * would lose it. `false` means nothing was withdrawn and the caller keeps the message.
     */
    const withdrawAgentMessage = (
      emit: Emit,
      companyId: CompanyId,
      messageId: MessageId
    ): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        const row = yield* byId({ companyId, messageId })
        if (Option.isNone(row)) return false
        if (row.value.body.trim().length > 0) return false
        const threadId = row.value.thread_id
        yield* attachments.deleteForMessage(companyId, messageId)
        yield* remove({ companyId, messageId })
        yield* emit({
          type: 'message.deleted',
          payload: {
            messageId,
            channelId: row.value.channel_id,
            ...(threadId === null ? {} : { threadId })
          }
        })
        if (threadId !== null) yield* emitThreadSummary(emit, companyId, threadId)
        return true
      })

    /** Oldest-first: the last `limit` messages of a thread (root first) or of a channel's top level. */
    const recent = (
      companyId: CompanyId,
      channelId: ChannelId,
      threadId: MessageId | null,
      limit: number
    ): Effect.Effect<ReadonlyArray<Message>> =>
      recentDesc({ companyId, channelId, threadId, limit: clampLimit(limit) }).pipe(
        Effect.flatMap((rows) => hydrate(companyId, [...rows].reverse()))
      )

    /** Oldest-first: thread messages after `afterId` (D7 warm path). */
    const since = (
      companyId: CompanyId,
      threadId: MessageId,
      afterId: MessageId,
      limit: number
    ): Effect.Effect<ReadonlyArray<Message>> =>
      sinceAsc({ companyId, threadId, afterId, limit: clampLimit(limit) }).pipe(
        Effect.flatMap((rows) => hydrate(companyId, rows))
      )

    return {
      list,
      create,
      edit,
      delete: del,
      thread,
      // server-internal
      byId: (companyId: CompanyId, messageId: MessageId): Effect.Effect<Option.Option<Message>> =>
        byId({ companyId, messageId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeed(Option.none<Message>()),
              onSome: (row) => loadMessage(companyId, row.id).pipe(Effect.map(Option.some))
            })
          )
        ),
      threadRoot,
      recent,
      since,
      agentTurnCount: (companyId: CompanyId, threadId: MessageId): Effect.Effect<number> =>
        agentTurns({ companyId, threadId }).pipe(Effect.map((c) => c.n)),
      postAsAgent,
      postAsUser,
      editAsSystem,
      attachAsAgent,
      createStreaming,
      appendDelta,
      finalizeAgentMessage,
      withdrawAgentMessage,
      notifyUser
    } as const
  })
}) {}
