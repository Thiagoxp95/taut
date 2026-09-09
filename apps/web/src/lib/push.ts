/**
 * Web Push enrolment for this browser.
 *
 * The flow is: the server hands out its VAPID public key → we ask the browser for
 * notification permission (must be inside a user gesture, or Safari refuses) →
 * `pushManager.subscribe` mints an endpoint → we POST it. The server sends to every
 * endpoint a user has registered whenever they get a `notification` event.
 *
 * iOS/iPadOS only allow this in an app added to the Home Screen, and every browser
 * requires a secure context, so `pushSupport()` reports which of those is missing
 * instead of letting `subscribe` throw something unreadable.
 */
import { Data, Effect } from 'effect'

import { call, type Api } from '@/lib/api-client'
import { isDesktop } from '@/lib/desktop'

export type PushSupport =
  | { readonly _tag: 'Supported' }
  /** No Push API in this browser at all (or an http:// origin that is not localhost). */
  | { readonly _tag: 'Unsupported' }
  /** Safari on iOS: the tab has the API only once the app is installed to the Home Screen. */
  | { readonly _tag: 'NeedsInstall' }

const standalone = (): boolean =>
  window.matchMedia('(display-mode: standalone)').matches ||
  // Safari's own flag, still the only reliable signal on iOS.
  ('standalone' in navigator && navigator.standalone === true)

export const pushSupport = (): PushSupport => {
  // The Electron shell notifies through the OS already; a second channel would double up.
  if (isDesktop) return { _tag: 'Unsupported' }
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return { _tag: 'Unsupported' }
  if (!('PushManager' in window) || !('Notification' in window)) {
    // iOS exposes neither until the PWA is installed; other browsers simply lack them.
    return /iP(hone|ad|od)/.test(navigator.userAgent) && !standalone()
      ? { _tag: 'NeedsInstall' }
      : { _tag: 'Unsupported' }
  }
  return { _tag: 'Supported' }
}

export type PushState = 'unsupported' | 'needs-install' | 'denied' | 'off' | 'on'

/** What the UI shows, without asking for anything. */
export const readPushState = (): Effect.Effect<PushState> =>
  Effect.promise(async () => {
    const support = pushSupport()
    if (support._tag === 'NeedsInstall') return 'needs-install'
    if (support._tag === 'Unsupported') return 'unsupported'
    if (Notification.permission === 'denied') return 'denied'
    const registration = await navigator.serviceWorker.ready
    const existing = await registration.pushManager.getSubscription()
    return existing === null ? 'off' : 'on'
  })

/** base64url (what the API returns) → the `ArrayBuffer` `pushManager.subscribe` wants. */
const decodeKey = (base64Url: string): ArrayBuffer => {
  const padded = base64Url.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded.padEnd(padded.length + ((4 - (padded.length % 4)) % 4), '='))
  const buffer = new ArrayBuffer(raw.length)
  const bytes = new Uint8Array(buffer)
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return buffer
}

/** True when an existing subscription was minted for `publicKey` (base64url, unpadded). */
const sameKey = (subscription: PushSubscription, publicKey: string): boolean => {
  const applied = subscription.options.applicationServerKey
  if (applied === null || applied === undefined) return false
  const bytes = new Uint8Array(applied)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  const encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
  return encoded === publicKey.replace(/=+$/, '')
}

/** "iPhone · Safari"-ish, so a user can tell their devices apart in settings later. */
const deviceLabel = (): string => {
  const ua = navigator.userAgent
  const platform = /iPhone/.test(ua)
    ? 'iPhone'
    : /iPad/.test(ua)
      ? 'iPad'
      : /Android/.test(ua)
        ? 'Android'
        : /Macintosh/.test(ua)
          ? 'Mac'
          : /Windows/.test(ua)
            ? 'Windows'
            : 'Device'
  const browser = /EdgiOS|Edg\//.test(ua)
    ? 'Edge'
    : /CriOS|Chrome/.test(ua)
      ? 'Chrome'
      : /Firefox|FxiOS/.test(ua)
        ? 'Firefox'
        : /Safari/.test(ua)
          ? 'Safari'
          : 'Browser'
  return `${platform} · ${browser}`
}

/** `state` is what the toggle should show afterwards; `message` is what the user reads. */
export class PushUnavailable extends Data.TaggedError('PushUnavailable')<{
  readonly state: PushState
  readonly message: string
}> {}

/**
 * Turns notifications on for this browser. MUST be called from a click handler:
 * `requestPermission` outside a user gesture is rejected outright on Safari.
 */
export const enablePush = (): Effect.Effect<PushState, PushUnavailable, Api> =>
  Effect.gen(function* () {
    const support = pushSupport()
    if (support._tag === 'NeedsInstall') {
      return yield* new PushUnavailable({
        state: 'needs-install',
        message:
          'On iPhone and iPad, add Taut to your Home Screen first — Safari only allows notifications for installed apps.'
      })
    }
    if (support._tag === 'Unsupported') {
      return yield* new PushUnavailable({
        state: 'unsupported',
        message: 'This browser cannot receive push notifications.'
      })
    }

    const { publicKey } = yield* call((api) => api.push.key()).pipe(
      Effect.mapError(
        () =>
          new PushUnavailable({
            state: 'unsupported',
            message: 'Could not reach the notification service.'
          })
      )
    )
    if (publicKey === undefined) {
      return yield* new PushUnavailable({
        state: 'unsupported',
        message: 'This server has no push keys configured (TAUT_VAPID_PUBLIC_KEY).'
      })
    }

    const permission = yield* Effect.promise(() => Notification.requestPermission())
    if (permission !== 'granted') {
      return yield* new PushUnavailable({
        state: permission === 'denied' ? 'denied' : 'off',
        message: 'Notification permission was not granted.'
      })
    }

    const subscription = yield* Effect.tryPromise({
      try: async () => {
        const registration = await navigator.serviceWorker.ready
        const existing = await registration.pushManager.getSubscription()
        // An endpoint minted for a different VAPID key can never be decrypted again.
        if (existing !== null && sameKey(existing, publicKey)) return existing
        if (existing !== null) await existing.unsubscribe()
        return await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: decodeKey(publicKey)
        })
      },
      catch: (error) =>
        new PushUnavailable({
          state: 'off',
          message: error instanceof Error ? error.message : 'Subscription failed.'
        })
    })

    const json = subscription.toJSON()
    const endpoint = json.endpoint
    const p256dh = json.keys?.p256dh
    const auth = json.keys?.auth
    if (endpoint === undefined || p256dh === undefined || auth === undefined) {
      return yield* new PushUnavailable({
        state: 'off',
        message: 'The browser returned an incomplete subscription.'
      })
    }

    yield* call((api) =>
      api.push.subscribe({ payload: { endpoint, keys: { p256dh, auth }, label: deviceLabel() } })
    ).pipe(
      Effect.mapError(
        () => new PushUnavailable({ state: 'off', message: 'Could not register this device.' })
      )
    )

    return 'on' as const
  })

/** Turns them off: drops the browser subscription and the server row. */
export const disablePush = (): Effect.Effect<PushState, never, Api> =>
  Effect.gen(function* () {
    if (!('serviceWorker' in navigator)) return 'unsupported' as const
    const subscription = yield* Effect.promise(async () => {
      const registration = await navigator.serviceWorker.ready
      return await registration.pushManager.getSubscription()
    })
    if (subscription === null) return 'off' as const
    const endpoint = subscription.endpoint
    yield* Effect.promise(() => subscription.unsubscribe())
    yield* call((api) => api.push.unsubscribe({ payload: { endpoint } })).pipe(Effect.ignore)
    return 'off' as const
  })
