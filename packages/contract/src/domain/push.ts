import { Schema } from 'effect'

import { PushDeviceId, UserId } from '../ids.js'

/**
 * One Web Push endpoint, registered by one installed client (one browser profile on
 * one device). Endpoints are user-scoped, not company-scoped: the same phone follows
 * the user across companies, and the payload carries the company it came from.
 *
 * The `p256dh`/`auth` keys never leave the server — they are the encryption keys for
 * that endpoint, so `PushDevice` (what the API returns) deliberately omits them.
 */
export class PushDevice extends Schema.Class<PushDevice>('PushDevice')({
  id: PushDeviceId,
  userId: UserId,
  /** Opaque push-service URL issued by the browser; unique per install. */
  endpoint: Schema.String,
  /** Free-form, shown in settings ("iPhone · Safari"). Set by the client. */
  label: Schema.optional(Schema.String),
  createdAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc
}) {}

/** Exactly the shape of a browser `PushSubscription.toJSON()`, plus a label. */
export const PushSubscriptionPayload = Schema.Struct({
  endpoint: Schema.NonEmptyString,
  keys: Schema.Struct({
    p256dh: Schema.NonEmptyString,
    auth: Schema.NonEmptyString
  }),
  label: Schema.optional(Schema.String)
})
export type PushSubscriptionPayload = typeof PushSubscriptionPayload.Type

export const PushEndpointPayload = Schema.Struct({ endpoint: Schema.NonEmptyString })

/**
 * `publicKey` is the VAPID application server key the client passes to
 * `pushManager.subscribe`. Unset when the server has no VAPID keys configured —
 * the client then hides the whole notification affordance instead of failing.
 */
export const PushKey = Schema.Struct({
  publicKey: Schema.optional(Schema.String)
})
export type PushKey = typeof PushKey.Type
