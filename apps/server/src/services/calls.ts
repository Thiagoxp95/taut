import { SqlClient } from '@effect/sql'
import {
  Call,
  CallCredentials,
  huddleRoom,
  type MemberKind,
  participantIdentity
} from '@taut/contract/domain'
import { Forbidden, NotFound, Unauthorized, Validation } from '@taut/contract/errors'
import {
  type CallId,
  CallId as CallIdSchema,
  type ChannelId,
  ChannelId as ChannelIdSchema,
  type CompanyId,
  makeId,
  MemberId,
  MessageId,
  newNotificationId,
  NotificationId,
  type UserId
} from '@taut/contract/ids'
import { DateTime, Effect, Option, Redacted, Schema } from 'effect'
import { AccessToken, WebhookReceiver } from 'livekit-server-sdk'
import { AppConfig } from '../config.js'
import { findAll, findOne, nowIso, run, single } from '../db/sql.js'
import {
  CallParticipantRow,
  CallRow,
  NotificationRow,
  toCall,
  toNotification
} from '../domain/rows.js'
import { type Actor } from './access.js'
import { Channels } from './channels.js'
import { Messages } from './messages.js'
import { type Emit, EventPublisher } from './publisher.js'
import { Users } from './users.js'

const CALL_COLUMNS =
  'id, company_id, channel_id, room, started_by_kind, started_by_id, started_at, ended_at, summary_message_id'
const PARTICIPANT_COLUMNS = 'call_id, member_kind, member_id, joined_at, left_at, sharing'

/** The contract has no `newCallId` yet (`packages/contract` is owned elsewhere). */
const newCallId = (): CallId => CallIdSchema.make(makeId('cal'))

const decodeMemberId = Schema.decodeUnknownOption(MemberId)

/** `user:usr_…` → the two halves, or `none` for anything LiveKit invented on its own. */
const parseIdentity = (
  identity: string
): Option.Option<{ readonly kind: MemberKind; readonly id: MemberId }> => {
  const colon = identity.indexOf(':')
  if (colon === -1) return Option.none()
  const kind = identity.slice(0, colon)
  if (kind !== 'user' && kind !== 'agent') return Option.none()
  return Option.map(decodeMemberId(identity.slice(colon + 1)), (id) => ({ kind, id }))
}

/** `12 min`; anything under a minute is not worth rounding up to one. */
export const huddleDuration = (startedAt: Date, endedAt: Date): string => {
  const minutes = Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000)
  return minutes < 1 ? '<1 min' : `${minutes} min`
}

/**
 * Huddles: one live LiveKit room per channel (docs/build-plan-calls.md).
 *
 * Two things decide everything else here. First, D1: `join` is start-or-join, so the
 * `calls` row is created by whoever gets there first and the partial unique index makes
 * that safe under a race. Second, D2: the SFU's webhooks — not the browser — decide who
 * is in the room, so every webhook handler is idempotent with the endpoint that races it
 * (`leave` vs `participant_left` is the pair that always happens).
 *
 * The service is inert unless LiveKit is configured (D3): `config` answers
 * `{ enabled: false }`, `join` is a 422 and the webhook has no secret to verify with, so
 * it is a 401.
 */
export class Calls extends Effect.Service<Calls>()('Calls', {
  effect: Effect.gen(function* () {
    const appConfig = yield* AppConfig
    const sql = yield* SqlClient.SqlClient
    const channels = yield* Channels
    const users = yield* Users
    const messages = yield* Messages
    const publisher = yield* EventPublisher

    const livekit = appConfig.livekit
    const receiver =
      livekit === undefined
        ? undefined
        : new WebhookReceiver(livekit.apiKey, Redacted.value(livekit.apiSecret))

    // ── queries ──────────────────────────────────────────────────────────────

    const openOfChannel = findOne({
      Request: ChannelIdSchema,
      Result: CallRow,
      execute: (channelId) => sql`
        SELECT ${sql.literal(CALL_COLUMNS)} FROM calls
        WHERE channel_id = ${channelId} AND ended_at IS NULL`
    })

    const openOfRoom = findOne({
      Request: Schema.String,
      Result: CallRow,
      execute: (room) => sql`
        SELECT ${sql.literal(CALL_COLUMNS)} FROM calls
        WHERE room = ${room} AND ended_at IS NULL`
    })

    const byId = findOne({
      Request: Schema.Struct({ companyId: Schema.String, callId: CallIdSchema }),
      Result: CallRow,
      execute: (r) => sql`
        SELECT ${sql.literal(CALL_COLUMNS)} FROM calls
        WHERE company_id = ${r.companyId} AND id = ${r.callId}`
    })

    const openOfCompany = findAll({
      Request: Schema.String,
      Result: CallRow,
      execute: (companyId) => sql`
        SELECT ${sql.literal(CALL_COLUMNS)} FROM calls
        WHERE company_id = ${companyId} AND ended_at IS NULL
        ORDER BY started_at DESC, rowid DESC`
    })

    /** Join order, which is what the participant strip renders. */
    const liveParticipants = findAll({
      Request: CallIdSchema,
      Result: CallParticipantRow,
      execute: (callId) => sql`
        SELECT ${sql.literal(PARTICIPANT_COLUMNS)} FROM call_participants
        WHERE call_id = ${callId} AND left_at IS NULL
        ORDER BY joined_at ASC, rowid ASC`
    })

    /** Everyone who was ever in it — the D7 summary names people who already left. */
    const allParticipants = findAll({
      Request: CallIdSchema,
      Result: CallParticipantRow,
      execute: (callId) => sql`
        SELECT ${sql.literal(PARTICIPANT_COLUMNS)} FROM call_participants
        WHERE call_id = ${callId} ORDER BY joined_at ASC, rowid ASC`
    })

    const participantRow = findOne({
      Request: Schema.Struct({ callId: CallIdSchema, kind: Schema.String, id: Schema.String }),
      Result: CallParticipantRow,
      execute: (r) => sql`
        SELECT ${sql.literal(PARTICIPANT_COLUMNS)} FROM call_participants
        WHERE call_id = ${r.callId} AND member_kind = ${r.kind} AND member_id = ${r.id}`
    })

    const liveCount = single({
      Request: CallIdSchema,
      Result: Schema.Struct({ n: Schema.Number }),
      execute: (callId) =>
        sql`SELECT COUNT(*) AS n FROM call_participants WHERE call_id = ${callId} AND left_at IS NULL`
    })

    /**
     * D1 as one statement: the row appears only when no open call exists for the channel,
     * so two people pressing "huddle" together produce one room and one `call.started`
     * without anyone catching a unique-constraint failure.
     */
    const insertUnlessOpen = run({
      Request: Schema.Struct({
        id: CallIdSchema,
        companyId: Schema.String,
        channelId: ChannelIdSchema,
        room: Schema.String,
        startedByKind: Schema.String,
        startedById: Schema.String,
        startedAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO calls (id, company_id, channel_id, room, started_by_kind, started_by_id, started_at, ended_at, summary_message_id)
        SELECT ${r.id}, ${r.companyId}, ${r.channelId}, ${r.room}, ${r.startedByKind}, ${r.startedById}, ${r.startedAt}, NULL, NULL
        WHERE NOT EXISTS (SELECT 1 FROM calls WHERE channel_id = ${r.channelId} AND ended_at IS NULL)`
    })

    const upsertParticipant = run({
      Request: Schema.Struct({
        callId: CallIdSchema,
        kind: Schema.String,
        id: Schema.String,
        joinedAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO call_participants (call_id, member_kind, member_id, joined_at, left_at, sharing)
        VALUES (${r.callId}, ${r.kind}, ${r.id}, ${r.joinedAt}, NULL, 0)
        ON CONFLICT (call_id, member_kind, member_id)
        DO UPDATE SET joined_at = ${r.joinedAt}, left_at = NULL, sharing = 0`
    })

    const markLeft = run({
      Request: Schema.Struct({
        callId: CallIdSchema,
        kind: Schema.String,
        id: Schema.String,
        leftAt: Schema.String
      }),
      execute: (r) => sql`
        UPDATE call_participants SET left_at = ${r.leftAt}, sharing = 0
        WHERE call_id = ${r.callId} AND member_kind = ${r.kind} AND member_id = ${r.id}
          AND left_at IS NULL`
    })

    const markAllLeft = run({
      Request: Schema.Struct({ callId: CallIdSchema, leftAt: Schema.String }),
      execute: (r) => sql`
        UPDATE call_participants SET left_at = ${r.leftAt}, sharing = 0
        WHERE call_id = ${r.callId} AND left_at IS NULL`
    })

    const setSharing = run({
      Request: Schema.Struct({
        callId: CallIdSchema,
        kind: Schema.String,
        id: Schema.String,
        sharing: Schema.Number
      }),
      execute: (r) => sql`
        UPDATE call_participants SET sharing = ${r.sharing}
        WHERE call_id = ${r.callId} AND member_kind = ${r.kind} AND member_id = ${r.id}
          AND left_at IS NULL`
    })

    const close = run({
      Request: Schema.Struct({ callId: CallIdSchema, endedAt: Schema.String }),
      execute: (r) =>
        sql`UPDATE calls SET ended_at = ${r.endedAt} WHERE id = ${r.callId} AND ended_at IS NULL`
    })

    const setSummaryMessage = run({
      Request: Schema.Struct({ callId: CallIdSchema, messageId: MessageId }),
      execute: (r) =>
        sql`UPDATE calls SET summary_message_id = ${r.messageId} WHERE id = ${r.callId}`
    })

    const insertNotification = run({
      Request: Schema.Struct({
        id: NotificationId,
        companyId: Schema.String,
        userId: Schema.String,
        eventSeq: Schema.Number,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO notifications (id, company_id, user_id, event_seq, kind, read_at, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.userId}, ${r.eventSeq}, 'huddle', NULL, ${r.createdAt})`
    })

    const notificationById = findOne({
      Request: NotificationId,
      Result: NotificationRow,
      execute: (id) =>
        sql`SELECT id, company_id, user_id, event_seq, kind, read_at FROM notifications WHERE id = ${id}`
    })

    // ── shared ───────────────────────────────────────────────────────────────

    const hydrate = (row: CallRow): Effect.Effect<Call> =>
      liveParticipants(row.id).pipe(Effect.map((rows) => toCall(row, rows)))

    const reload = (companyId: CompanyId, callId: CallId): Effect.Effect<CallRow> =>
      byId({ companyId, callId }).pipe(Effect.flatMap(Effect.orDie))

    const emitUpdated = (emit: Emit, row: CallRow): Effect.Effect<void> =>
      hydrate(row).pipe(
        Effect.flatMap((call) => emit({ type: 'call.updated', payload: { call } })),
        Effect.asVoid
      )

    /**
     * D5: identities are `<kind>:<memberId>` and `agent:` is reserved. Until the agent pass
     * lands the server refuses one rather than admitting a member nothing can drive.
     */
    // TODO(plan): let agents join a huddle (docs/build-plan-calls.md, "Out").
    const requireHuman = (kind: MemberKind): Effect.Effect<void, Validation> =>
      kind === 'user'
        ? Effect.void
        : Effect.fail(
            new Validation({
              issues: [{ path: ['memberKind'], message: 'Only people can join a huddle today' }]
            })
          )

    const disabled = (): Validation =>
      new Validation({
        issues: [
          {
            path: ['calls'],
            message: 'Huddles are not configured on this server (TAUT_LIVEKIT_URL)'
          }
        ]
      })

    // ── endpoints ────────────────────────────────────────────────────────────

    /** D3. The UI hides every huddle affordance on `false`. */
    const config = Effect.succeed({ enabled: livekit !== undefined } as const)

    /**
     * Start-or-join (D1). View rights on the channel are the whole access rule (D4); the
     * row, the participant and the `call.started` event all land in one transaction, and
     * the token is minted afterwards because it touches no state.
     */
    const join = (
      who: Actor,
      channelId: ChannelId
    ): Effect.Effect<CallCredentials, NotFound | Forbidden | Validation> =>
      Effect.gen(function* () {
        if (livekit === undefined) return yield* disabled()
        const channel = yield* channels.load(who, channelId)
        yield* channels.requireView(who, channel)
        // A session is always a person; `member` is the seam agents will come through (D5).
        const member = { kind: 'user' as MemberKind, id: who.userId as MemberId }
        yield* requireHuman(member.kind)

        const room = huddleRoom(channel.id)
        const opened = yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const id = newCallId()
            const at = new Date()
            yield* insertUnlessOpen({
              id,
              companyId: who.companyId,
              channelId: channel.id,
              room,
              startedByKind: member.kind,
              startedById: member.id,
              startedAt: at.toISOString()
            })
            const row = yield* openOfChannel(channel.id).pipe(Effect.flatMap(Effect.orDie))
            const started = row.id === id

            const existing = yield* participantRow({
              callId: row.id,
              kind: member.kind,
              id: member.id
            })
            // D6: a second device is a rejoin, not a new seat — it neither re-checks the
            // cap nor moves the member's place in the strip.
            const live = Option.isSome(existing) && existing.value.left_at === null
            if (!live) {
              const { n } = yield* liveCount(row.id)
              if (n >= livekit.maxParticipants) {
                return yield* new Validation({
                  issues: [
                    {
                      path: ['channelId'],
                      message: `This huddle is full (${livekit.maxParticipants} people)`
                    }
                  ]
                })
              }
              yield* upsertParticipant({
                callId: row.id,
                kind: member.kind,
                id: member.id,
                joinedAt: at.toISOString()
              })
            }

            const call = yield* hydrate(row)
            if (started) {
              const event = yield* emit({ type: 'call.started', payload: { call } })
              yield* notifyDm(emit, who, channel.kind, channel.id, event.seq)
            } else if (!live) {
              yield* emit({ type: 'call.updated', payload: { call } })
            }
            return { call, started } as const
          })
        )

        // D8 (docs/build-plan-huddle-window.md) amends calls D7: the huddle's message is
        // posted by whoever opened the room, not written at the end. It runs out here
        // because `postAsUser` is its own transaction with its own fan-out — the same
        // reason `summarise` sits outside `finish`'s.
        const call = opened.started
          ? yield* openMessage(opened.call, channel.kind, channel.name)
          : opened.call

        return yield* credentials(who, call, room, member)
      })

    /**
     * The message the huddle thread hangs off (D9). A channel that will not take it — the
     * starter is no longer a member, the channel was archived between the two statements —
     * costs the thread and nothing else: the call is already open and its credentials are
     * about to go back.
     */
    const openMessage = (
      call: Call,
      channelKind: string,
      channelName: string
    ): Effect.Effect<Call> =>
      messages
        .postAsUser(call.companyId, {
          userId: call.startedById as UserId,
          channelId: call.channelId,
          body: channelKind === 'dm' ? '🎧 Huddle' : `🎧 Huddle in #${channelName}`
        })
        .pipe(
          Effect.flatMap((message) =>
            setSummaryMessage({ callId: call.id, messageId: message.id }).pipe(
              Effect.zipRight(reload(call.companyId, call.id)),
              Effect.flatMap(hydrate)
            )
          ),
          Effect.catchAll((error) =>
            Effect.logWarning(`calls: no huddle message for ${call.id}: ${error.message}`).pipe(
              Effect.as(call)
            )
          )
        )

    /**
     * D8: a huddle in a DM rings the person on the other side. Channel huddles notify
     * nobody — they surface as a live indicator on the channel row.
     */
    const notifyDm = (
      emit: Emit,
      who: Actor,
      channelKind: string,
      channelId: ChannelId,
      eventSeq: number
    ): Effect.Effect<void> =>
      channelKind !== 'dm'
        ? Effect.void
        : Effect.gen(function* () {
            const humans = yield* channels.humanMembers(channelId)
            yield* Effect.forEach(
              humans.filter((userId) => userId !== who.userId),
              (userId) => notifyHuddle(emit, who.companyId, userId, channelId, eventSeq),
              { discard: true }
            )
          })

    /** One `notifications` row + its per-user event, the same shape `Messages` writes. */
    const notifyHuddle = (
      emit: Emit,
      companyId: CompanyId,
      userId: UserId,
      channelId: ChannelId,
      eventSeq: number
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const id = newNotificationId()
        yield* insertNotification({
          id,
          companyId,
          userId,
          eventSeq,
          createdAt: nowIso()
        })
        const row = yield* notificationById(id).pipe(Effect.flatMap(Effect.orDie))
        // No `messageId`: a live huddle is state, not a message (D7).
        yield* emit({
          type: 'notification',
          payload: { notification: toNotification(row), channelId }
        })
      })

    /** Room-scoped, short-lived, and the only place the API secret is ever used for a client. */
    const credentials = (
      who: Actor,
      call: Call,
      room: string,
      member: { readonly kind: MemberKind; readonly id: MemberId }
    ): Effect.Effect<CallCredentials> =>
      Effect.gen(function* () {
        if (livekit === undefined) return yield* Effect.dieMessage('calls: no LiveKit config')
        const user = yield* users.byId(who.userId)
        const token = new AccessToken(livekit.apiKey, Redacted.value(livekit.apiSecret), {
          identity: participantIdentity(member.kind, member.id),
          name: Option.match(user, { onNone: () => member.id, onSome: (u) => u.name }),
          ttl: livekit.tokenTtlSeconds,
          // The SFU echoes this to every other participant, which is how the web maps a
          // LiveKit participant back onto a Taut member without another round trip.
          metadata: JSON.stringify({ kind: member.kind, id: member.id })
        })
        token.addGrant({
          roomJoin: true,
          room,
          canPublish: true,
          canSubscribe: true,
          canPublishData: true
        })
        // `toJwt` is async since v2 of the SDK; signing cannot fail once identity is set.
        const jwt = yield* Effect.promise(() => token.toJwt())
        return new CallCredentials({
          call,
          url: livekit.url,
          token: jwt,
          expiresAt: DateTime.unsafeFromDate(new Date(Date.now() + livekit.tokenTtlSeconds * 1000))
        })
      })

    /**
     * The leaver's own UI, now rather than in a second (D2). `participant_left` says the
     * same thing a moment later, so this only writes — and only emits — when it is the one
     * that actually moved the row.
     */
    const leave = (who: Actor, callId: CallId): Effect.Effect<Call, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const row = yield* byId({ companyId: who.companyId, callId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NotFound({ entity: 'Call', id: callId })),
              onSome: Effect.succeed
            })
          )
        )
        const channel = yield* channels.load(who, row.channel_id)
        yield* channels.requireView(who, channel)
        return yield* publisher.transact(who.companyId, (emit) =>
          part(emit, row, 'user', who.userId)
        )
      })

    /** Mark one member gone; a no-op (and silent) when they already are. */
    const part = (emit: Emit, row: CallRow, kind: MemberKind, id: MemberId): Effect.Effect<Call> =>
      Effect.gen(function* () {
        const existing = yield* participantRow({ callId: row.id, kind, id })
        if (Option.isNone(existing) || existing.value.left_at !== null) return yield* hydrate(row)
        yield* markLeft({ callId: row.id, kind, id, leftAt: nowIso() })
        const call = yield* hydrate(row)
        yield* emit({ type: 'call.updated', payload: { call } })
        return call
      })

    /** Open huddles in channels the actor can see; the channel rules do all the filtering. */
    const active = (who: Actor): Effect.Effect<ReadonlyArray<Call>> =>
      Effect.gen(function* () {
        const rows = yield* openOfCompany(who.companyId)
        const visible = yield* Effect.forEach(rows, (row) =>
          channels.load(who, row.channel_id).pipe(
            Effect.flatMap((channel) => channels.requireView(who, channel)),
            Effect.as(Option.some(row)),
            Effect.catchAll(() => Effect.succeedNone)
          )
        )
        return yield* Effect.forEach(
          visible.flatMap((o) => (Option.isSome(o) ? [o.value] : [])),
          hydrate
        )
      })

    /** One call by id, for whoever can see its channel. */
    const get = (who: Actor, callId: CallId): Effect.Effect<Call, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const row = yield* byId({ companyId: who.companyId, callId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.fail(new NotFound({ entity: 'Call', id: callId })),
              onSome: Effect.succeed
            })
          )
        )
        const channel = yield* channels.load(who, row.channel_id)
        yield* channels.requireView(who, channel)
        return yield* hydrate(row)
      })

    // ── webhooks (D2) ────────────────────────────────────────────────────────

    /**
     * LiveKit signs the *raw* body and puts the JWT in `Authorization`, so the HTTP layer
     * hands both over untouched. Every handler is idempotent and an event about a room we
     * have no open call for is ignored: a webhook that arrives twice, out of order, or
     * after the call was closed must never be an error the SFU retries forever.
     */
    const handleWebhook = (body: string, authHeader: string): Effect.Effect<void, Unauthorized> =>
      Effect.gen(function* () {
        if (receiver === undefined) {
          return yield* new Unauthorized({ message: 'Huddles are not configured on this server' })
        }
        const event = yield* Effect.tryPromise({
          try: () => receiver.receive(body, authHeader),
          catch: () => new Unauthorized({ message: 'LiveKit webhook signature is not valid' })
        })
        const room = event.room?.name
        if (room === undefined) return
        const identity = event.participant?.identity
        yield* dispatch(event.event, room, identity, event.track?.source).pipe(
          Effect.annotateLogs({ livekitEvent: event.event, room })
        )
      })

    /** `TrackSource.SCREEN_SHARE`; the numeric enum keeps `@livekit/protocol` out of the seam. */
    const SCREEN_SHARE = 3

    const dispatch = (
      name: string,
      room: string,
      identity: string | undefined,
      trackSource: number | undefined
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const row = yield* openOfRoom(room)
        if (Option.isNone(row)) {
          // `room_started` for a room nobody has a `calls` row for, or anything after the
          // call was already closed. Nothing to reconcile.
          return
        }
        const call = row.value
        const member = identity === undefined ? Option.none() : parseIdentity(identity)

        switch (name) {
          case 'participant_joined':
            return yield* withMember(member, (m) =>
              publisher.transact(call.company_id, (emit) => admit(emit, call, m.kind, m.id))
            )
          case 'participant_left':
          case 'participant_connection_aborted':
            return yield* withMember(member, (m) =>
              publisher
                .transact(call.company_id, (emit) => part(emit, call, m.kind, m.id))
                .pipe(Effect.asVoid)
            )
          case 'track_published':
          case 'track_unpublished':
            if (trackSource !== SCREEN_SHARE) return
            return yield* withMember(member, (m) =>
              publisher.transact(call.company_id, (emit) =>
                share(emit, call, m.kind, m.id, name === 'track_published')
              )
            )
          case 'room_finished':
            return yield* finish(call)
          default:
            return yield* Effect.logDebug(`calls: ignoring LiveKit event ${name}`)
        }
      })

    const withMember = <A>(
      member: Option.Option<{ readonly kind: MemberKind; readonly id: MemberId }>,
      f: (m: { readonly kind: MemberKind; readonly id: MemberId }) => Effect.Effect<A>
    ): Effect.Effect<void> =>
      Option.match(member, {
        onNone: () => Effect.logWarning('calls: LiveKit event for an identity we do not own'),
        onSome: (m) => f(m).pipe(Effect.asVoid)
      })

    /**
     * The SFU says someone is in the room. Usually `join` already wrote the row, so this
     * confirms it and stays silent; it only speaks for a participant we did not know about
     * (a token minted before a reconnect, say).
     */
    const admit = (emit: Emit, row: CallRow, kind: MemberKind, id: MemberId): Effect.Effect<void> =>
      Effect.gen(function* () {
        // D5 again, from the other side: an `agent:` identity that talked its way into the
        // room is not written down, so it never appears in the strip.
        if (kind !== 'user') {
          return yield* Effect.logWarning(`calls: refusing an agent participant (${id})`)
        }
        const existing = yield* participantRow({ callId: row.id, kind, id })
        if (Option.isSome(existing) && existing.value.left_at === null) return
        yield* upsertParticipant({ callId: row.id, kind, id, joinedAt: nowIso() })
        yield* emitUpdated(emit, row)
      })

    /** D15: sharing is a track, so it is a flag on the participant, not a mode on the call. */
    const share = (
      emit: Emit,
      row: CallRow,
      kind: MemberKind,
      id: MemberId,
      sharing: boolean
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const existing = yield* participantRow({ callId: row.id, kind, id })
        if (Option.isNone(existing) || existing.value.left_at !== null) return
        if ((existing.value.sharing !== 0) === sharing) return
        yield* setSharing({ callId: row.id, kind, id, sharing: sharing ? 1 : 0 })
        yield* emitUpdated(emit, row)
      })

    /**
     * The room emptied. Closing it and emitting `call.ended` is one transaction; the summary
     * is written afterwards, through `Messages`, because a message is its own transaction
     * with its own fan-out. The `UPDATE … WHERE ended_at IS NULL` is what makes a repeated
     * `room_finished` summarise exactly once.
     */
    const finish = (row: CallRow): Effect.Effect<void> =>
      Effect.gen(function* () {
        const at = new Date()
        const closed = yield* publisher.transact(row.company_id, (emit) =>
          Effect.gen(function* () {
            const fresh = yield* reload(row.company_id, row.id)
            if (fresh.ended_at !== null) return false
            yield* close({ callId: row.id, endedAt: at.toISOString() })
            yield* markAllLeft({ callId: row.id, leftAt: at.toISOString() })
            yield* emit({
              type: 'call.ended',
              payload: {
                callId: row.id,
                channelId: row.channel_id,
                endedAt: DateTime.unsafeFromDate(at)
              }
            })
            return true
          })
        )
        if (!closed) return
        yield* summarise(row, at)
      })

    /**
     * `🎧 Huddle · 12 min · Ana, Bruno`, authored by whoever started it, so the channel's
     * history shows the huddle happened without a new message kind. D8
     * (docs/build-plan-huddle-window.md) amends calls D7: the message is already there, so
     * this *edits* it and the thread of replies stays attached to it. Only a huddle whose
     * opening post failed — or whose message was deleted, which the FK nulls the column for
     * — still posts one here, and a post that cannot be made (the starter left the company,
     * the channel was archived) is a warning: the call has already ended either way.
     *
     * Display names, not `@handles`: `postAsUser` resolves mentions, so handles here would
     * ping everyone who was in the huddle every time one ends. A summary is a record, not a
     * summons.
     */
    const summarise = (row: CallRow, endedAt: Date): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (row.started_by_kind !== 'user') return
        const [members, agents, participants] = yield* Effect.all([
          users.membersOf(row.company_id),
          users.agentsOf(row.company_id),
          allParticipants(row.id)
        ])
        const displayNames = new Map<string, string>([
          ...members.map((m) => [m.id, m.name] as const),
          ...agents.map((a) => [a.id, a.name] as const)
        ])
        const names = participants
          .map((p) => displayNames.get(p.member_id))
          .filter((name): name is string => name !== undefined)
        const duration = huddleDuration(new Date(DateTime.toEpochMillis(row.started_at)), endedAt)
        const body = `🎧 Huddle · ${duration}${names.length === 0 ? '' : ` · ${names.join(', ')}`}`

        // The opening post lands after `join`'s transaction, so the id is read fresh rather
        // than taken from the row the webhook was dispatched with.
        const fresh = yield* reload(row.company_id, row.id)
        if (fresh.summary_message_id !== null) {
          yield* messages.editAsSystem(row.company_id, fresh.summary_message_id, body)
          return
        }

        const posted = yield* messages
          .postAsUser(row.company_id, {
            userId: row.started_by_id as UserId,
            channelId: row.channel_id,
            body
          })
          .pipe(
            Effect.map(Option.some),
            Effect.catchAll((error) =>
              Effect.logWarning(`calls: no summary message for ${row.id}: ${error.message}`).pipe(
                Effect.as(Option.none<{ readonly id: MessageId }>())
              )
            )
          )
        if (Option.isSome(posted)) {
          yield* setSummaryMessage({ callId: row.id, messageId: posted.value.id })
        }
      })

    return {
      config,
      join,
      leave,
      active,
      get,
      /**
       * The call by id with **everyone who was ever in it**, and no `Actor` to check against:
       * `agents/triggerContext.ts` renders a `call.ended` context block for an agent that was
       * never in the room, and `agents/triggerRunner.ts` needs the duration to answer
       * `CallEndedTrigger.minSeconds` — which the event payload does not carry
       * (docs/build-plan-triggers.md D5, `EventFacts`). Both read, neither writes.
       */
      find: (companyId: CompanyId, callId: CallId): Effect.Effect<Option.Option<Call>> =>
        byId({ companyId, callId }).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () => Effect.succeedNone,
              onSome: (row) =>
                allParticipants(row.id).pipe(Effect.map((rows) => Option.some(toCall(row, rows))))
            })
          )
        ),
      handleWebhook
    } as const
  })
}) {}
