import { SqlClient } from '@effect/sql'
import type { ChannelId, MessageId, UserId } from '@taut/contract/ids'
import { Effect, Option, Schema, Stream } from 'effect'
import { findOne } from '../db/sql.js'
import { Bus } from '../realtime/bus.js'
import type { BusMessage } from '../realtime/events.js'
import { PushDevices } from '../services/pushDevices.js'
import { type PushPayload, PushSender } from './sender.js'

/** Push bodies are previews, not transcripts. */
const PREVIEW_CHARS = 140

const preview = (body: string): string => {
  const flat = body.replace(/\s+/g, ' ').trim()
  return flat.length <= PREVIEW_CHARS ? flat : `${flat.slice(0, PREVIEW_CHARS - 1)}…`
}

const Context = Schema.Struct({
  body: Schema.String,
  author_kind: Schema.Literal('user', 'agent'),
  author_name: Schema.NullOr(Schema.String),
  channel_name: Schema.String,
  channel_kind: Schema.Literal('channel', 'dm')
})

/**
 * Turns the per-user `notification` events of the event log into Web Push messages
 * (docs/build-plan.md → "PWA"). One subscriber for the whole process: it reads
 * `Bus.streamAll()`, so it sees every company.
 *
 * It deliberately reads the message with its own query rather than through `Messages`:
 * the recipient's membership was already checked when the notification row was written,
 * and a daemon has no session to act as.
 *
 * A `Gone` outcome (404/410 from the push service) deletes the endpoint, which is the
 * only way dead installs ever leave `push_devices`.
 */
export class PushNotifier extends Effect.Service<PushNotifier>()('PushNotifier', {
  scoped: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const bus = yield* Bus
    const sender = yield* PushSender
    const devices = yield* PushDevices

    if (!sender.enabled) {
      yield* Effect.logDebug('push: notifier idle (no VAPID keys)')
      return {} as const
    }

    const contextOf = findOne({
      Request: Schema.Struct({ messageId: Schema.String, channelId: Schema.String }),
      Result: Context,
      execute: (r) => sql`
        SELECT
          m.body          AS body,
          m.author_kind   AS author_kind,
          COALESCE(u.name, a.name) AS author_name,
          c.name          AS channel_name,
          c.kind          AS channel_kind
        FROM messages m
        JOIN channels c ON c.id = m.channel_id
        LEFT JOIN users  u ON m.author_kind = 'user'  AND u.id = m.author_id
        LEFT JOIN agents a ON m.author_kind = 'agent' AND a.id = m.author_id
        WHERE m.id = ${r.messageId} AND m.channel_id = ${r.channelId}
      `
    })

    /**
     * D8 huddles: a live call is state, not a message, so there is no `messages` row to
     * describe. The open call for the channel carries who started it, which is the only
     * thing worth putting on the notification.
     */
    const huddleContextOf = findOne({
      Request: Schema.String,
      Result: Schema.Struct({
        starter: Schema.NullOr(Schema.String),
        channel_name: Schema.String,
        channel_kind: Schema.Literal('channel', 'dm')
      }),
      execute: (channelId) => sql`
        SELECT
          COALESCE(u.name, a.name) AS starter,
          c.name                   AS channel_name,
          c.kind                   AS channel_kind
        FROM calls cl
        JOIN channels c ON c.id = cl.channel_id
        LEFT JOIN users  u ON cl.started_by_kind = 'user'  AND u.id = cl.started_by_id
        LEFT JOIN agents a ON cl.started_by_kind = 'agent' AND a.id = cl.started_by_id
        WHERE cl.channel_id = ${channelId} AND cl.ended_at IS NULL
      `
    })

    const huddlePayloadFor = (channelId: ChannelId): Effect.Effect<Option.Option<PushPayload>> =>
      huddleContextOf(channelId).pipe(
        Effect.map(
          Option.map((row) => {
            const starter = row.starter ?? 'Someone'
            return {
              title: row.channel_kind === 'dm' ? starter : `#${row.channel_name}`,
              body: `${starter} started a huddle`,
              // Its own tag: a huddle must not replace the conversation's last message.
              tag: `taut:huddle:${channelId}`,
              url: row.channel_kind === 'dm' ? `/dm/${channelId}` : `/c/${channelId}`
            } satisfies PushPayload
          })
        )
      )

    const payloadFor = (
      channelId: ChannelId,
      messageId: MessageId
    ): Effect.Effect<Option.Option<PushPayload>> =>
      contextOf({ messageId, channelId }).pipe(
        Effect.map(
          Option.map((row) => {
            const author = row.author_name ?? 'Someone'
            const title = row.channel_kind === 'dm' ? author : `${author} in #${row.channel_name}`
            return {
              title,
              body: preview(row.body),
              // One notification per conversation: a new message replaces the last.
              tag: `taut:${channelId}`,
              url: row.channel_kind === 'dm' ? `/dm/${channelId}` : `/c/${channelId}`
            } satisfies PushPayload
          })
        )
      )

    const deliver = (userId: UserId, payload: PushPayload): Effect.Effect<void> =>
      Effect.gen(function* () {
        const targets = yield* devices.targets(userId)
        if (targets.length === 0) return
        yield* Effect.forEach(
          targets,
          (target) =>
            sender.send(target, payload).pipe(
              Effect.flatMap((outcome) => {
                switch (outcome._tag) {
                  case 'Sent':
                    return Effect.void
                  case 'Gone':
                    return devices
                      .forget(target.endpoint)
                      .pipe(
                        Effect.zipRight(Effect.logDebug(`push: dropped dead endpoint ${target.id}`))
                      )
                  case 'Failed':
                    return Effect.logWarning(`push: send failed (${outcome.reason})`)
                }
              })
            ),
          { concurrency: 4, discard: true }
        )
      })

    const handle = (message: BusMessage): Effect.Effect<void> => {
      if (message._tag !== 'Event') return Effect.void
      const event = message.event
      if (event.type !== 'notification') return Effect.void
      const { channelId, messageId, notification } = event.payload
      if (channelId === undefined) return Effect.void
      const payload =
        notification.kind === 'huddle'
          ? huddlePayloadFor(channelId)
          : messageId === undefined
            ? undefined
            : payloadFor(channelId, messageId)
      if (payload === undefined) return Effect.void
      return payload.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (push) => deliver(event.payload.notification.userId, push)
          })
        ),
        Effect.annotateLogs({ companyId: message.companyId, channelId })
      )
    }

    // One failed send must never take the subscriber down with it.
    yield* bus
      .streamAll()
      .pipe(
        Stream.runForEach((message) =>
          handle(message).pipe(
            Effect.catchAllCause((cause) => Effect.logWarning('push: notifier error', cause))
          )
        )
      )
      .pipe(Effect.forkScoped)

    yield* Effect.logInfo('push: notifier watching the event bus')
    return {} as const
  })
}) {}
