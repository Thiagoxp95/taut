import { SqlClient } from '@effect/sql'
import type { PushDevice, PushSubscriptionPayload } from '@taut/contract/domain'
import { type PushDeviceId, type UserId, newPushDeviceId } from '@taut/contract/ids'
import { Effect, Schema } from 'effect'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import { PushDeviceRow, toPushDevice } from '../domain/rows.js'

const COLUMNS = 'id, user_id, endpoint, p256dh, auth, label, created_at, last_seen_at'

/** A registered endpoint with its encryption keys — server-internal, never serialised to a client. */
export interface PushTarget {
  readonly id: PushDeviceId
  readonly endpoint: string
  readonly keys: { readonly p256dh: string; readonly auth: string }
}

/**
 * The `push_devices` table. Registration is keyed by `endpoint` so a browser that
 * re-subscribes (key rotation, permission re-grant) updates its row in place.
 */
export class PushDevices extends Effect.Service<PushDevices>()('PushDevices', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const upsert = run({
      Request: Schema.Struct({
        id: Schema.String,
        userId: Schema.String,
        endpoint: Schema.String,
        p256dh: Schema.String,
        auth: Schema.String,
        label: Schema.NullOr(Schema.String),
        at: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO push_devices (id, user_id, endpoint, p256dh, auth, label, created_at, last_seen_at)
        VALUES (${r.id}, ${r.userId}, ${r.endpoint}, ${r.p256dh}, ${r.auth}, ${r.label}, ${r.at}, ${r.at})
        ON CONFLICT (endpoint) DO UPDATE SET
          user_id      = excluded.user_id,
          p256dh       = excluded.p256dh,
          auth         = excluded.auth,
          label        = COALESCE(excluded.label, push_devices.label),
          last_seen_at = excluded.last_seen_at
      `
    })

    const byEndpoint = findOne({
      Request: Schema.String,
      Result: PushDeviceRow,
      execute: (endpoint) =>
        sql`SELECT ${sql.literal(COLUMNS)} FROM push_devices WHERE endpoint = ${endpoint}`
    })

    const rowsOfUser = findAll({
      Request: Schema.String,
      Result: PushDeviceRow,
      execute: (userId) =>
        sql`SELECT ${sql.literal(COLUMNS)} FROM push_devices WHERE user_id = ${userId} ORDER BY created_at`
    })

    const targetsOfUser = findAll({
      Request: Schema.String,
      Result: Schema.Struct({
        id: Schema.String,
        endpoint: Schema.String,
        p256dh: Schema.String,
        auth: Schema.String
      }),
      execute: (userId) =>
        sql`SELECT id, endpoint, p256dh, auth FROM push_devices WHERE user_id = ${userId}`
    })

    const deleteByEndpoint = run({
      Request: Schema.Struct({ userId: Schema.NullOr(Schema.String), endpoint: Schema.String }),
      execute: (r) =>
        r.userId === null
          ? sql`DELETE FROM push_devices WHERE endpoint = ${r.endpoint}`
          : sql`DELETE FROM push_devices WHERE endpoint = ${r.endpoint} AND user_id = ${r.userId}`
    })

    /** Registers (or refreshes) one browser's endpoint for `userId`. */
    const register = (
      userId: UserId,
      payload: PushSubscriptionPayload
    ): Effect.Effect<PushDevice> =>
      Effect.gen(function* () {
        yield* upsert({
          id: newPushDeviceId(),
          userId,
          endpoint: payload.endpoint,
          p256dh: payload.keys.p256dh,
          auth: payload.keys.auth,
          label: payload.label ?? null,
          at: nowIso()
        })
        const row = yield* byEndpoint(payload.endpoint).pipe(Effect.flatMap(Effect.orDie))
        return toPushDevice(row)
      })

    /** Silent when the endpoint is unknown or belongs to somebody else. */
    const unregister = (userId: UserId, endpoint: string): Effect.Effect<void> =>
      deleteByEndpoint({ userId, endpoint })

    /** Used by the notifier when a push service reports the subscription is gone (404/410). */
    const forget = (endpoint: string): Effect.Effect<void> =>
      deleteByEndpoint({ userId: null, endpoint })

    const list = (userId: UserId): Effect.Effect<ReadonlyArray<PushDevice>> =>
      rowsOfUser(userId).pipe(Effect.map((rows) => rows.map(toPushDevice)))

    const targets = (userId: UserId): Effect.Effect<ReadonlyArray<PushTarget>> =>
      targetsOfUser(userId).pipe(
        Effect.map((rows) =>
          rows.map((r) => ({
            id: r.id as PushDeviceId,
            endpoint: r.endpoint,
            keys: { p256dh: r.p256dh, auth: r.auth }
          }))
        )
      )

    return { register, unregister, forget, list, targets } as const
  })
}) {}
