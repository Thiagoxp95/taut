import { Effect, Redacted } from 'effect'
import webpush from 'web-push'
import { AppConfig } from '../config.js'
import type { PushTarget } from '../services/pushDevices.js'

/** What a service worker receives in `event.data.json()`. Keep it small: 4 KB is the safe ceiling. */
export interface PushPayload {
  readonly title: string
  readonly body: string
  /** Collapses repeat notifications for the same conversation on the device. */
  readonly tag: string
  /** In-app path the notification opens, e.g. `/c/chn_…`. */
  readonly url: string
}

export type SendOutcome =
  /** Delivered (or queued by the push service). */
  | { readonly _tag: 'Sent' }
  /** 404/410: the browser threw the subscription away — the row must go too. */
  | { readonly _tag: 'Gone' }
  /** Anything else (429, 5xx, network). Logged and dropped; the client will retry naturally. */
  | { readonly _tag: 'Failed'; readonly reason: string }

export interface PushTransport {
  /** False when no VAPID keys are configured: `send` always answers `Failed`. */
  readonly enabled: boolean
  /** The VAPID application server key clients subscribe with, when enabled. */
  readonly publicKey: string | undefined
  readonly send: (target: PushTarget, payload: PushPayload) => Effect.Effect<SendOutcome>
}

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' && error !== null && 'statusCode' in error
    ? (error as { statusCode?: number }).statusCode
    : undefined

/**
 * Web Push transport (RFC 8291 aes128gcm + RFC 8292 VAPID), delegated to `web-push`.
 *
 * Disabled — `enabled: false`, `send` a no-op — when `TAUT_VAPID_PUBLIC_KEY` /
 * `TAUT_VAPID_PRIVATE_KEY` are unset, so a dev server without keys runs unchanged.
 */
export class PushSender extends Effect.Service<PushSender>()('PushSender', {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig
    const vapid = config.vapid

    if (vapid === undefined) {
      yield* Effect.logDebug('push: no VAPID keys configured, web push disabled')
      const disabled: PushTransport = {
        enabled: false,
        publicKey: undefined,
        send: () => Effect.succeed<SendOutcome>({ _tag: 'Failed', reason: 'push disabled' })
      }
      return disabled
    }

    // A typo'd key must not take the whole server down: web-push validates eagerly
    // and throws, so a bad pair degrades to "push disabled" with a loud warning.
    const configured = yield* Effect.try(() =>
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, Redacted.value(vapid.privateKey))
    ).pipe(
      Effect.as(true),
      Effect.catchAll((error) =>
        Effect.logError(
          `push: invalid VAPID configuration, web push disabled — ${error instanceof Error ? error.message : String(error)}`
        ).pipe(Effect.as(false))
      )
    )
    if (!configured) {
      const broken: PushTransport = {
        enabled: false,
        publicKey: undefined,
        send: () => Effect.succeed<SendOutcome>({ _tag: 'Failed', reason: 'push misconfigured' })
      }
      return broken
    }
    yield* Effect.logInfo('push: web push enabled')

    const send = (target: PushTarget, payload: PushPayload): Effect.Effect<SendOutcome> =>
      Effect.tryPromise({
        try: () =>
          webpush.sendNotification(
            { endpoint: target.endpoint, keys: { ...target.keys } },
            JSON.stringify(payload),
            // A chat ping is worthless an hour later; let the push service drop it.
            { TTL: 600, urgency: 'high' }
          ),
        catch: (error) => error
      }).pipe(
        Effect.as<SendOutcome>({ _tag: 'Sent' }),
        Effect.catchAll((error) => {
          const status = statusOf(error)
          if (status === 404 || status === 410) {
            return Effect.succeed<SendOutcome>({ _tag: 'Gone' })
          }
          return Effect.succeed<SendOutcome>({
            _tag: 'Failed',
            reason: status === undefined ? String(error) : `HTTP ${status}`
          })
        })
      )

    const transport: PushTransport = { enabled: true, publicKey: vapid.publicKey, send }
    return transport
  })
}) {}
