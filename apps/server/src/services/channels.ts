import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import { DmInboxItem } from '@taut/contract/api'
import { type Channel, type ChannelMember, MemberKind } from '@taut/contract/domain'
import { Conflict, Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import {
  AgentId,
  ChannelId,
  CompanyId,
  DepartmentId,
  EventSeq,
  MemberId,
  ProjectId,
  UserId,
  newChannelId
} from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { Count, findAll, findOne, nowIso, run, single } from '../db/sql.js'
import {
  type ChannelRow,
  ChannelMemberRow,
  ChannelRow as ChannelRowSchema,
  toChannel,
  toChannelMember
} from '../domain/rows.js'
import { type Actor, actor, isAdmin } from './access.js'
import { type Emit, EventPublisher } from './publisher.js'
import { Users } from './users.js'

/**
 * `hidden` and `project_id` are listed here and nowhere else (docs/build-plan-issues.md
 * D9): every channel read goes through this string, and a read that omits them
 * decodes an issue thread's channel as an ordinary visible one.
 */
const CHANNEL_COLUMNS =
  'c.id, c.company_id, c.department_id, c.name, c.kind, c.archived_at, ' +
  'c.hidden, c.project_id, c.created_at'
const MEMBER_COLUMNS = 'channel_id, member_kind, member_id, last_read_seq'

export interface MemberRef {
  readonly memberKind: MemberKind
  readonly memberId: MemberId
}

export interface UnreadCounts {
  readonly unread: number
  readonly mentions: number
}

const isUserId = Schema.is(UserId)

/** Channels and DMs with their membership (agent-model.md §2; unread via `last_read_seq`, §8). */
export class Channels extends Effect.Service<Channels>()('Channels', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const users = yield* Users
    const publisher = yield* EventPublisher

    // ── queries ──────────────────────────────────────────────────────────────

    const byId = findOne({
      Request: Schema.Struct({ companyId: CompanyId, channelId: ChannelId }),
      Result: ChannelRowSchema,
      execute: (r) => sql`
        SELECT ${sql.literal(CHANNEL_COLUMNS)} FROM channels c
        WHERE c.company_id = ${r.companyId} AND c.id = ${r.channelId}`
    })

    const ListRequest = Schema.Struct({
      companyId: CompanyId,
      userId: UserId,
      departmentId: Schema.NullOr(DepartmentId)
    })

    /**
     * Admin+: every channel plus the DMs they are in — minus the hidden ones
     * (docs/build-plan-issues.md D9). A ticket's conversation has a home already,
     * which is the ticket; a sidebar row for it would be the same conversation in
     * two places. Only this list and its member-scoped twin filter: search,
     * mentions, notifications, unread and tasks all still see an ordinary channel.
     */
    const listAll = findAll({
      Request: ListRequest,
      Result: ChannelRowSchema,
      execute: (r) => sql`
        SELECT ${sql.literal(CHANNEL_COLUMNS)} FROM channels c
        WHERE c.company_id = ${r.companyId} AND c.hidden = 0
          AND (c.kind = 'channel' OR EXISTS (
            SELECT 1 FROM channel_members m
            WHERE m.channel_id = c.id AND m.member_kind = 'user' AND m.member_id = ${r.userId}))
          AND (${r.departmentId} IS NULL OR c.department_id = ${r.departmentId})
        ORDER BY c.created_at ASC, c.rowid ASC`
    })

    /** Member: only channels/DMs they belong to, hidden ones excluded as above (D9). */
    const listMine = findAll({
      Request: ListRequest,
      Result: ChannelRowSchema,
      execute: (r) => sql`
        SELECT ${sql.literal(CHANNEL_COLUMNS)} FROM channels c
        JOIN channel_members m ON m.channel_id = c.id AND m.member_kind = 'user' AND m.member_id = ${r.userId}
        WHERE c.company_id = ${r.companyId} AND c.hidden = 0
          AND (${r.departmentId} IS NULL OR c.department_id = ${r.departmentId})
        ORDER BY c.created_at ASC, c.rowid ASC`
    })

    const inboxRows = findAll({
      Request: Schema.Struct({ companyId: CompanyId, userId: UserId }),
      Result: DmInboxItem,
      execute: (r) => sql`
        SELECT c.id AS channelId, latest.id AS messageId, latest.thread_id AS threadId,
          latest.author_id AS authorId, latest.author_kind AS authorKind,
          latest.body, latest.created_at AS createdAt,
          (SELECT MAX(received.seq) FROM messages received
            WHERE received.company_id = ${r.companyId} AND received.channel_id = c.id
              AND received.author_id <> ${r.userId} AND received.status = 'sent') AS seq,
          c.archived_at AS archivedAt,
          (SELECT COUNT(*) FROM messages unread
            WHERE unread.company_id = ${r.companyId} AND unread.channel_id = c.id
              AND unread.author_id <> ${r.userId} AND unread.status = 'sent'
              AND unread.seq > member.last_read_seq) AS unread
        FROM channels c
        JOIN channel_members member ON member.channel_id = c.id
          AND member.member_kind = 'user' AND member.member_id = ${r.userId}
        JOIN messages latest ON latest.id = (
          SELECT m.id FROM messages m
          WHERE m.company_id = ${r.companyId} AND m.channel_id = c.id
            AND m.author_id <> ${r.userId} AND m.status = 'sent'
          ORDER BY m.created_at DESC, m.rowid DESC LIMIT 1)
        WHERE c.company_id = ${r.companyId} AND c.kind = 'dm' AND c.hidden = 0
        ORDER BY latest.created_at DESC, latest.rowid DESC`
    })

    const ofDepartment = findAll({
      Request: Schema.Struct({ companyId: CompanyId, departmentId: DepartmentId }),
      Result: ChannelRowSchema,
      execute: (r) => sql`
        SELECT ${sql.literal(CHANNEL_COLUMNS)} FROM channels c
        WHERE c.company_id = ${r.companyId} AND c.department_id = ${r.departmentId}`
    })

    const nameTaken = findOne({
      Request: Schema.Struct({
        companyId: CompanyId,
        departmentId: DepartmentId,
        name: Schema.String
      }),
      Result: Schema.Struct({ id: ChannelId }),
      execute: (r) => sql`
        SELECT id FROM channels
        WHERE company_id = ${r.companyId} AND department_id = ${r.departmentId} AND name = ${r.name}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: ChannelId,
        companyId: CompanyId,
        departmentId: Schema.NullOr(DepartmentId),
        name: Schema.String,
        kind: Schema.Literal('channel', 'dm'),
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO channels (id, company_id, department_id, name, kind, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.departmentId}, ${r.name}, ${r.kind}, ${r.createdAt})`
    })

    /**
     * The hidden channel an issue thread lives in (docs/build-plan-issues.md D9,
     * D21). Its own statement rather than a flag on `insert`, because everything
     * about it is the opposite of an ordinary channel: no department (like a DM,
     * which already proves the column is nullable), no members at creation, and
     * `hidden = 1` so the sidebar never draws it.
     */
    const insertHidden = run({
      Request: Schema.Struct({
        id: ChannelId,
        companyId: CompanyId,
        projectId: ProjectId,
        name: Schema.String,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO channels (id, company_id, department_id, name, kind, hidden, project_id, created_at)
        VALUES (${r.id}, ${r.companyId}, NULL, ${r.name}, 'channel', 1, ${r.projectId}, ${r.createdAt})`
    })

    const byProject = findOne({
      Request: Schema.Struct({ companyId: CompanyId, projectId: ProjectId }),
      Result: ChannelRowSchema,
      execute: (r) => sql`
        SELECT ${sql.literal(CHANNEL_COLUMNS)} FROM channels c
        WHERE c.company_id = ${r.companyId} AND c.project_id = ${r.projectId}`
    })

    const rename = run({
      Request: Schema.Struct({ companyId: CompanyId, channelId: ChannelId, name: Schema.String }),
      execute: (r) => sql`
        UPDATE channels SET name = ${r.name}
        WHERE company_id = ${r.companyId} AND id = ${r.channelId}`
    })

    const remove = run({
      Request: Schema.Struct({ companyId: CompanyId, channelId: ChannelId }),
      execute: (r) =>
        sql`DELETE FROM channels WHERE company_id = ${r.companyId} AND id = ${r.channelId}`
    })

    /**
     * The FK cascades messages when their channel goes, but SQLite fires the `messages_fts`
     * delete triggers only for rows deleted directly (`recursive_triggers` is off), so a
     * cascade leaves search quoting a channel nobody can open. Delete them by hand instead.
     */
    const removeMessages = run({
      Request: ChannelId,
      execute: (channelId) => sql`DELETE FROM messages WHERE channel_id = ${channelId}`
    })

    const headOf = findOne({
      Request: Schema.Struct({ companyId: CompanyId, departmentId: DepartmentId }),
      Result: Schema.Struct({ head_user_id: UserId }),
      execute: (r) => sql`
        SELECT head_user_id FROM departments
        WHERE company_id = ${r.companyId} AND id = ${r.departmentId}`
    })

    const MemberKey = Schema.Struct({
      channelId: ChannelId,
      memberKind: MemberKind,
      memberId: MemberId
    })

    const memberRow = findOne({
      Request: MemberKey,
      Result: ChannelMemberRow,
      execute: (r) => sql`
        SELECT ${sql.literal(MEMBER_COLUMNS)} FROM channel_members
        WHERE channel_id = ${r.channelId} AND member_kind = ${r.memberKind} AND member_id = ${r.memberId}`
    })

    const membersOf = findAll({
      Request: ChannelId,
      Result: ChannelMemberRow,
      execute: (channelId) => sql`
        SELECT ${sql.literal(MEMBER_COLUMNS)} FROM channel_members
        WHERE channel_id = ${channelId} ORDER BY rowid ASC`
    })

    const agentMemberIds = findAll({
      Request: ChannelId,
      Result: Schema.Struct({ member_id: AgentId }),
      execute: (channelId) => sql`
        SELECT member_id FROM channel_members
        WHERE channel_id = ${channelId} AND member_kind = 'agent' ORDER BY rowid ASC`
    })

    const channelsOfMember = findAll({
      Request: Schema.Struct({ memberKind: MemberKind, memberId: MemberId }),
      Result: Schema.Struct({ channel_id: ChannelId }),
      execute: (r) => sql`
        SELECT channel_id FROM channel_members
        WHERE member_kind = ${r.memberKind} AND member_id = ${r.memberId}`
    })

    /** Every DM `ref` takes part in: those die with the member, they have no one else left. */
    const dmsOfMember = findAll({
      Request: Schema.Struct({
        companyId: CompanyId,
        memberKind: MemberKind,
        memberId: MemberId
      }),
      Result: Schema.Struct({ id: ChannelId }),
      execute: (r) => sql`
        SELECT c.id FROM channels c
        JOIN channel_members m ON m.channel_id = c.id
        WHERE c.company_id = ${r.companyId} AND c.kind = 'dm'
          AND m.member_kind = ${r.memberKind} AND m.member_id = ${r.memberId}`
    })

    const humanMemberIds = findAll({
      Request: ChannelId,
      Result: Schema.Struct({ member_id: UserId }),
      execute: (channelId) => sql`
        SELECT member_id FROM channel_members
        WHERE channel_id = ${channelId} AND member_kind = 'user' ORDER BY rowid ASC`
    })

    const insertMember = run({
      Request: MemberKey,
      execute: (r) => sql`
        INSERT OR IGNORE INTO channel_members (channel_id, member_kind, member_id, last_read_seq)
        VALUES (${r.channelId}, ${r.memberKind}, ${r.memberId}, 0)`
    })

    const deleteMember = run({
      Request: MemberKey,
      execute: (r) => sql`
        DELETE FROM channel_members
        WHERE channel_id = ${r.channelId} AND member_kind = ${r.memberKind} AND member_id = ${r.memberId}`
    })

    const setLastRead = run({
      Request: Schema.Struct({ channelId: ChannelId, userId: UserId, seq: EventSeq }),
      execute: (r) => sql`
        UPDATE channel_members SET last_read_seq = MAX(last_read_seq, ${r.seq})
        WHERE channel_id = ${r.channelId} AND member_kind = 'user' AND member_id = ${r.userId}`
    })

    const findDm = findOne({
      Request: Schema.Struct({
        companyId: CompanyId,
        userId: UserId,
        memberKind: MemberKind,
        memberId: MemberId
      }),
      Result: Schema.Struct({ id: ChannelId }),
      execute: (r) => sql`
        SELECT c.id FROM channels c
        JOIN channel_members a ON a.channel_id = c.id AND a.member_kind = 'user' AND a.member_id = ${r.userId}
        JOIN channel_members b ON b.channel_id = c.id AND b.member_kind = ${r.memberKind} AND b.member_id = ${r.memberId}
        WHERE c.company_id = ${r.companyId} AND c.kind = 'dm'
          AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) = 2
        LIMIT 1`
    })

    /**
     * The two-member DM between any two members, in either order. `findDm` above is the
     * user-anchored form; this one also finds an agent↔agent DM (docs/agent-model.md §9).
     */
    const findDmBetween = findOne({
      Request: Schema.Struct({
        companyId: CompanyId,
        aKind: MemberKind,
        aId: MemberId,
        bKind: MemberKind,
        bId: MemberId
      }),
      Result: Schema.Struct({ id: ChannelId }),
      execute: (r) => sql`
        SELECT c.id FROM channels c
        JOIN channel_members a ON a.channel_id = c.id AND a.member_kind = ${r.aKind} AND a.member_id = ${r.aId}
        JOIN channel_members b ON b.channel_id = c.id AND b.member_kind = ${r.bKind} AND b.member_id = ${r.bId}
        WHERE c.company_id = ${r.companyId} AND c.kind = 'dm'
          AND (SELECT COUNT(*) FROM channel_members m WHERE m.channel_id = c.id) = 2
        LIMIT 1`
    })

    const UnreadRequest = Schema.Struct({
      companyId: CompanyId,
      userId: UserId,
      channelId: ChannelId,
      since: EventSeq
    })

    /** Top-level messages by others in the channel, logged after the member's `last_read_seq`. */
    const unreadCount = single({
      Request: UnreadRequest,
      Result: Count,
      execute: (r) => sql`
        SELECT COUNT(*) AS n FROM events e
        WHERE e.company_id = ${r.companyId} AND e.type = 'message.created' AND e.seq > ${r.since}
          AND json_extract(e.payload_json, '$.message.channelId') = ${r.channelId}
          AND json_extract(e.payload_json, '$.message.threadId') IS NULL
          AND json_extract(e.payload_json, '$.message.authorId') <> ${r.userId}`
    })

    const mentionCount = single({
      Request: UnreadRequest,
      Result: Count,
      execute: (r) => sql`
        SELECT COUNT(*) AS n FROM notifications n
        JOIN events e ON e.company_id = n.company_id AND e.seq = n.event_seq
        WHERE n.company_id = ${r.companyId} AND n.user_id = ${r.userId} AND n.read_at IS NULL
          AND n.kind = 'mention' AND n.event_seq > ${r.since}
          AND json_extract(e.payload_json, '$.message.channelId') = ${r.channelId}`
    })

    const markNotificationsRead = run({
      Request: Schema.Struct({ ...UnreadRequest.fields, at: Schema.String }),
      execute: (r) => sql`
        UPDATE notifications SET read_at = ${r.at}
        WHERE company_id = ${r.companyId} AND user_id = ${r.userId} AND read_at IS NULL
          AND event_seq <= ${r.since}
          AND event_seq IN (
            SELECT seq FROM events
            WHERE company_id = ${r.companyId}
              AND json_extract(payload_json, '$.message.channelId') = ${r.channelId})`
    })

    // ── authorization ────────────────────────────────────────────────────────

    const load = (who: Actor, channelId: ChannelId): Effect.Effect<ChannelRow, NotFound> =>
      byId({ companyId: who.companyId, channelId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Channel', id: channelId })),
            onSome: Effect.succeed
          })
        )
      )

    const isUserMember = (channelId: ChannelId, userId: UserId): Effect.Effect<boolean> =>
      memberRow({ channelId, memberKind: 'user', memberId: userId }).pipe(Effect.map(Option.isSome))

    /**
     * A hidden project channel is readable by every member of the company
     * (docs/build-plan-issues.md D22), joined or not.
     *
     * It is the one channel whose *contents* are already public to them by another
     * route: they can open the ticket, and a ticket is exactly as private as the
     * project it hangs under (docs/build-plan-projects.md D9). Membership stays
     * deferred (D21) — this is a read exemption, not a join, so nobody gets an
     * unread badge for a ticket they have never spoken on. Without it the first
     * message of somebody else's thread is invisible until they reply to it.
     */
    const isOpenProjectThread = (ch: ChannelRow): boolean =>
      ch.kind === 'channel' && ch.hidden !== 0 && ch.project_id !== null

    /** Admin+ read every channel; DMs are only ever visible to their two members. */
    const canView = (who: Actor, ch: ChannelRow): Effect.Effect<boolean> =>
      isOpenProjectThread(ch)
        ? Effect.succeed(true)
        : ch.kind === 'dm' || !isAdmin(who.role)
          ? isUserMember(ch.id, who.userId)
          : Effect.succeed(true)

    const requireView = (who: Actor, ch: ChannelRow): Effect.Effect<void, Forbidden> =>
      canView(who, ch).pipe(
        Effect.flatMap((ok) =>
          ok ? Effect.void : Effect.fail(new Forbidden({ message: 'Not a member of this channel' }))
        )
      )

    /**
     * Posting = viewing, minus one rule: reading an archived channel is fine, adding to it
     * is not — the agent on the other side of an archived DM never answers again.
     */
    const requirePost = (who: Actor, ch: ChannelRow): Effect.Effect<void, Forbidden> =>
      requireView(who, ch).pipe(
        Effect.zipRight(
          ch.archived_at === null
            ? Effect.void
            : Effect.fail(new Forbidden({ message: 'This conversation is archived' }))
        )
      )

    /** Admin+ or the head of the channel's department; nobody manages a DM. */
    const canManage = (who: Actor, ch: ChannelRow): Effect.Effect<boolean> =>
      Effect.gen(function* () {
        if (ch.kind === 'dm' || ch.department_id === null) return isAdmin(who.role)
        if (isAdmin(who.role)) return true
        const head = yield* headOf({ companyId: who.companyId, departmentId: ch.department_id })
        return Option.isSome(head) && head.value.head_user_id === who.userId
      })

    const requireManage = (who: Actor, ch: ChannelRow): Effect.Effect<void, Forbidden> =>
      canManage(who, ch).pipe(
        Effect.flatMap((ok) =>
          ok
            ? Effect.void
            : Effect.fail(
                new Forbidden({ message: 'Requires admin or the head of this department' })
              )
        )
      )

    /** A user must be a company member, an agent must belong to the company. */
    const validateRef = (companyId: CompanyId, ref: MemberRef): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        if (ref.memberKind === 'user') {
          const ok = isUserId(ref.memberId)
            ? Option.isSome(yield* users.roleIn(companyId, ref.memberId))
            : false
          if (!ok) return yield* new NotFound({ entity: 'User', id: ref.memberId })
        } else {
          const ok = !isUserId(ref.memberId)
            ? Option.isSome(yield* users.agentIn(companyId, ref.memberId))
            : false
          if (!ok) return yield* new NotFound({ entity: 'Agent', id: ref.memberId })
        }
      })

    const loadChannel = (companyId: CompanyId, channelId: ChannelId): Effect.Effect<Channel> =>
      byId({ companyId, channelId }).pipe(Effect.flatMap(Effect.orDie), Effect.map(toChannel))

    /**
     * Find-or-create the DM between two members, with no session: the agent API opens the
     * DM the first time teammates or an agent and its head talk directly. `dm` is the
     * human-facing endpoint and still checks the actor; this one is only reachable from code
     * that has already enforced the department boundary.
     */
    const ensureDm = (companyId: CompanyId, a: MemberRef, b: MemberRef): Effect.Effect<ChannelId> =>
      Effect.gen(function* () {
        const existing = yield* findDmBetween({
          companyId,
          aKind: a.memberKind,
          aId: a.memberId,
          bKind: b.memberKind,
          bId: b.memberId
        })
        if (Option.isSome(existing)) return existing.value.id
        return yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            const id = newChannelId()
            yield* insert({
              id,
              companyId,
              departmentId: null,
              name: 'dm',
              kind: 'dm',
              createdAt: nowIso()
            })
            yield* insertMember({ channelId: id, ...a })
            yield* insertMember({ channelId: id, ...b })
            const channel = yield* loadChannel(companyId, id)
            yield* emit({ type: 'channel.created', payload: { channel } })
            return id
          })
        )
      })

    /**
     * Find-or-create the one hidden channel a project's issue threads talk in
     * (docs/build-plan-issues.md D9). Created lazily by the first thread in the
     * project and never in bulk (D8): a workspace of 4 000 tickets gets at most
     * one channel per project, and only for the projects somebody actually talked
     * about.
     *
     * No session, like `ensureDm` above: the caller — `Projects.openIssueThread` —
     * has already decided that this actor may post about this ticket, and there is
     * no channel to be a member of yet at the moment it decides.
     *
     * `channel.created` is emitted like any other channel's, because that is what
     * it is: a client needs the row to render the thread, and the `hidden` flag on
     * it is precisely how the sidebar knows to leave it out.
     */
    const ensureProjectChannel = (
      companyId: CompanyId,
      projectId: ProjectId,
      name: string
    ): Effect.Effect<ChannelId> =>
      Effect.gen(function* () {
        const existing = yield* byProject({ companyId, projectId })
        if (Option.isSome(existing)) return existing.value.id
        return yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            const id = newChannelId()
            yield* insertHidden({ id, companyId, projectId, name, createdAt: nowIso() })
            const channel = yield* loadChannel(companyId, id)
            yield* emit({ type: 'channel.created', payload: { channel } })
            return id
          })
        )
      })

    const emitUpdated = (emit: Emit, companyId: CompanyId, channelId: ChannelId) =>
      loadChannel(companyId, channelId).pipe(
        Effect.flatMap((channel) => emit({ type: 'channel.updated', payload: { channel } }))
      )

    // ── internals shared with Departments / Messages ─────────────────────────

    const unreadFor = (
      companyId: CompanyId,
      userId: UserId,
      channelId: ChannelId
    ): Effect.Effect<UnreadCounts> =>
      Effect.gen(function* () {
        const member = yield* memberRow({ channelId, memberKind: 'user', memberId: userId })
        const since = Option.isSome(member) ? member.value.last_read_seq : 0
        const request = { companyId, userId, channelId, since }
        const [unread, mentions] = yield* Effect.all([unreadCount(request), mentionCount(request)])
        return { unread: unread.n, mentions: mentions.n }
      })

    const createDefault = (
      emit: Emit,
      input: {
        readonly companyId: CompanyId
        readonly departmentId: DepartmentId
        readonly name: string
        readonly headUserId: UserId
      }
    ): Effect.Effect<Channel> =>
      Effect.gen(function* () {
        const id = newChannelId()
        yield* insert({
          id,
          companyId: input.companyId,
          departmentId: input.departmentId,
          name: input.name,
          kind: 'channel',
          createdAt: nowIso()
        })
        yield* insertMember({ channelId: id, memberKind: 'user', memberId: input.headUserId })
        const channel = yield* loadChannel(input.companyId, id)
        yield* emit({ type: 'channel.created', payload: { channel } })
        return channel
      })

    const addToDepartmentChannels = (
      emit: Emit,
      companyId: CompanyId,
      departmentId: DepartmentId,
      ref: MemberRef
    ): Effect.Effect<void> =>
      ofDepartment({ companyId, departmentId }).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) =>
              insertMember({ channelId: row.id, ...ref }).pipe(
                Effect.zipRight(emitUpdated(emit, companyId, row.id))
              ),
            { discard: true }
          )
        )
      )

    const setArchived = run({
      Request: Schema.Struct({
        companyId: CompanyId,
        channelId: ChannelId,
        at: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        UPDATE channels SET archived_at = ${r.at}
        WHERE company_id = ${r.companyId} AND id = ${r.channelId}`
    })

    /**
     * Archive (or bring back) every DM one member takes part in. A DM has exactly two members,
     * so when one of them is archived the conversation has no one left to answer: it keeps its
     * history and moves out of the sidebar rather than being deleted.
     */
    const setDmsArchived = (
      emit: Emit,
      companyId: CompanyId,
      ref: MemberRef,
      at: string | null
    ): Effect.Effect<void> =>
      dmsOfMember({ companyId, ...ref }).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) =>
              setArchived({ companyId, channelId: row.id, at }).pipe(
                Effect.zipRight(emitUpdated(emit, companyId, row.id))
              ),
            { discard: true }
          )
        )
      )

    /**
     * A channel and everything hanging off it, as one event. Attachment *bytes* are the
     * caller's job: the FK cascades their rows, not the files (`messages.del` does the same).
     */
    const purge = (emit: Emit, companyId: CompanyId, channelId: ChannelId): Effect.Effect<void> =>
      removeMessages(channelId).pipe(
        Effect.zipRight(remove({ companyId, channelId })),
        Effect.zipRight(emit({ type: 'channel.deleted', payload: { channelId } }))
      )

    const deleteDepartmentChannels = (
      emit: Emit,
      companyId: CompanyId,
      departmentId: DepartmentId
    ): Effect.Effect<void> =>
      ofDepartment({ companyId, departmentId }).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(rows, (row) => purge(emit, companyId, row.id), { discard: true })
        )
      )

    // ── endpoints ────────────────────────────────────────────────────────────

    const list = (
      me: CurrentUserShape,
      query: { readonly departmentId?: DepartmentId | undefined }
    ): Effect.Effect<ReadonlyArray<Channel>, Unauthorized> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const request = {
          companyId: who.companyId,
          userId: who.userId,
          departmentId: query.departmentId ?? null
        }
        const rows = yield* isAdmin(who.role) ? listAll(request) : listMine(request)
        return rows.map(toChannel)
      })

    const create = (
      me: CurrentUserShape,
      input: {
        readonly name: string
        readonly departmentId?: DepartmentId | undefined
        readonly members?: ReadonlyArray<MemberRef> | undefined
      }
    ): Effect.Effect<Channel, Unauthorized | Forbidden | NotFound | Conflict | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const departmentId = input.departmentId
        if (departmentId === undefined) {
          return yield* new Validation({
            issues: [{ path: ['departmentId'], message: 'channels belong to a department' }]
          })
        }
        const head = yield* headOf({ companyId: who.companyId, departmentId })
        if (Option.isNone(head)) {
          return yield* new NotFound({ entity: 'Department', id: departmentId })
        }
        if (!isAdmin(who.role) && head.value.head_user_id !== who.userId) {
          return yield* new Forbidden({ message: 'Requires admin or the head of this department' })
        }
        if (
          Option.isSome(
            yield* nameTaken({ companyId: who.companyId, departmentId, name: input.name })
          )
        ) {
          return yield* new Conflict({ reason: `Channel "${input.name}" already exists` })
        }
        const extra = input.members ?? []
        yield* Effect.forEach(extra, (ref) => validateRef(who.companyId, ref), { discard: true })

        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const id = newChannelId()
            yield* insert({
              id,
              companyId: who.companyId,
              departmentId,
              name: input.name,
              kind: 'channel',
              createdAt: nowIso()
            })
            const members: ReadonlyArray<MemberRef> = [
              { memberKind: 'user', memberId: who.userId },
              { memberKind: 'user', memberId: head.value.head_user_id },
              ...extra
            ]
            yield* Effect.forEach(members, (ref) => insertMember({ channelId: id, ...ref }), {
              discard: true
            })
            const channel = yield* loadChannel(who.companyId, id)
            yield* emit({ type: 'channel.created', payload: { channel } })
            return channel
          })
        )
      })

    const dm = (
      me: CurrentUserShape,
      target: MemberRef
    ): Effect.Effect<Channel, Unauthorized | NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        if (target.memberKind === 'user' && target.memberId === who.userId) {
          return yield* new Validation({
            issues: [{ path: ['memberId'], message: 'cannot open a DM with yourself' }]
          })
        }
        yield* validateRef(who.companyId, target)
        const existing = yield* findDm({ companyId: who.companyId, userId: who.userId, ...target })
        if (Option.isSome(existing)) return yield* loadChannel(who.companyId, existing.value.id)

        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const id = newChannelId()
            yield* insert({
              id,
              companyId: who.companyId,
              departmentId: null,
              name: 'dm',
              kind: 'dm',
              createdAt: nowIso()
            })
            yield* insertMember({ channelId: id, memberKind: 'user', memberId: who.userId })
            yield* insertMember({ channelId: id, ...target })
            const channel = yield* loadChannel(who.companyId, id)
            yield* emit({ type: 'channel.created', payload: { channel } })
            return channel
          })
        )
      })

    const get = (
      me: CurrentUserShape,
      channelId: ChannelId
    ): Effect.Effect<Channel, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const ch = yield* load(who, channelId)
        yield* requireView(who, ch)
        return toChannel(ch)
      })

    const update = (
      me: CurrentUserShape,
      channelId: ChannelId,
      input: { readonly name?: string | undefined }
    ): Effect.Effect<Channel, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const ch = yield* load(who, channelId)
        yield* requireManage(who, ch)
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            if (input.name !== undefined) {
              yield* rename({ companyId: who.companyId, channelId, name: input.name })
            }
            const channel = yield* loadChannel(who.companyId, channelId)
            yield* emit({ type: 'channel.updated', payload: { channel } })
            return channel
          })
        )
      })

    const del = (
      me: CurrentUserShape,
      channelId: ChannelId
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const ch = yield* load(who, channelId)
        yield* requireManage(who, ch)
        yield* publisher.transact(who.companyId, (emit) => purge(emit, who.companyId, channelId))
      })

    const members = (
      me: CurrentUserShape,
      channelId: ChannelId
    ): Effect.Effect<ReadonlyArray<ChannelMember>, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const ch = yield* load(who, channelId)
        yield* requireView(who, ch)
        return (yield* membersOf(channelId)).map(toChannelMember)
      })

    const addMember = (
      me: CurrentUserShape,
      channelId: ChannelId,
      ref: MemberRef
    ): Effect.Effect<ChannelMember, Unauthorized | NotFound | Forbidden | Conflict> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const ch = yield* load(who, channelId)
        yield* requireManage(who, ch)
        yield* validateRef(who.companyId, ref)
        if (Option.isSome(yield* memberRow({ channelId, ...ref }))) {
          return yield* new Conflict({ reason: 'Already a member of this channel' })
        }
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* insertMember({ channelId, ...ref })
            yield* emitUpdated(emit, who.companyId, channelId)
            const row = yield* memberRow({ channelId, ...ref }).pipe(Effect.flatMap(Effect.orDie))
            return toChannelMember(row)
          })
        )
      })

    const removeMember = (
      me: CurrentUserShape,
      channelId: ChannelId,
      ref: MemberRef
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const ch = yield* load(who, channelId)
        yield* requireManage(who, ch)
        if (Option.isNone(yield* memberRow({ channelId, ...ref }))) {
          return yield* new NotFound({ entity: 'ChannelMember', id: ref.memberId })
        }
        yield* publisher.transact(who.companyId, (emit) =>
          deleteMember({ channelId, ...ref }).pipe(
            Effect.zipRight(emitUpdated(emit, who.companyId, channelId))
          )
        )
      })

    const markRead = (
      me: CurrentUserShape,
      channelId: ChannelId,
      lastReadSeq: number
    ): Effect.Effect<ChannelMember, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const ch = yield* load(who, channelId)
        if (!(yield* isUserMember(ch.id, who.userId))) {
          return yield* new Forbidden({ message: 'Not a member of this channel' })
        }
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* setLastRead({ channelId, userId: who.userId, seq: lastReadSeq })
            yield* markNotificationsRead({
              companyId: who.companyId,
              userId: who.userId,
              channelId,
              since: lastReadSeq,
              at: nowIso()
            })
            const counts = yield* unreadFor(who.companyId, who.userId, channelId)
            yield* emit({
              type: 'unread.changed',
              payload: { userId: who.userId, channelId, ...counts }
            })
            const row = yield* memberRow({
              channelId,
              memberKind: 'user',
              memberId: who.userId
            }).pipe(Effect.flatMap(Effect.orDie))
            return toChannelMember(row)
          })
        )
      })

    return {
      inbox: (me: CurrentUserShape) => actor(me).pipe(Effect.flatMap(inboxRows)),
      // shared
      load,
      requireView,
      requirePost,
      unreadFor,
      humanMembers: (channelId: ChannelId) =>
        humanMemberIds(channelId).pipe(Effect.map((rows) => rows.map((r) => r.member_id))),
      agentMembers: (channelId: ChannelId) =>
        agentMemberIds(channelId).pipe(Effect.map((rows) => rows.map((r) => r.member_id))),
      /** Raw row by id, no session (scheduler / memory ingest). */
      find: (companyId: CompanyId, channelId: ChannelId) => byId({ companyId, channelId }),
      isMember: (channelId: ChannelId, ref: MemberRef): Effect.Effect<boolean> =>
        memberRow({ channelId, ...ref }).pipe(Effect.map(Option.isSome)),
      /**
       * The two-member DM between `userId` and `ref`, if one was ever opened. No session: the
       * agent API uses it to send an answer home to the person who asked (agentApi.ts `route`).
       */
      dmOf: (
        companyId: CompanyId,
        userId: UserId,
        ref: MemberRef
      ): Effect.Effect<Option.Option<ChannelId>> =>
        findDm({ companyId, userId, ...ref }).pipe(Effect.map(Option.map((r) => r.id))),
      ensureDm,
      ensureProjectChannel,
      /** Whether this is an issue thread's channel (D21, D22): read by all, joined by posting. */
      isProjectThread: isOpenProjectThread,
      /**
       * Membership on demand (docs/build-plan-issues.md D21): posting into an
       * issue thread puts the poster — and any agent they mentioned — in the
       * project's hidden channel. `INSERT OR IGNORE`, so joining twice is free and
       * the caller does not have to ask first. Deliberately not `addMember`: there
       * is nobody to be the manager of a channel with no department, and pre-
       * seeding every company member into every project's channel would put a read
       * cursor per person per project behind a conversation that may never happen.
       */
      join: (channelId: ChannelId, ref: MemberRef): Effect.Effect<void> =>
        insertMember({ channelId, ...ref }),
      channelIdsOf: (ref: MemberRef): Effect.Effect<ReadonlyArray<ChannelId>> =>
        channelsOfMember(ref).pipe(Effect.map((rows) => rows.map((r) => r.channel_id))),
      setDmsArchived,
      createDefault,
      addToDepartmentChannels,
      deleteDepartmentChannels,
      purge,
      // endpoints
      list,
      create,
      dm,
      get,
      update,
      delete: del,
      members,
      addMember,
      removeMember,
      markRead
    } as const
  })
}) {}
