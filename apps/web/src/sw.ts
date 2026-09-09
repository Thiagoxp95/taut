/// <reference lib="webworker" />
import {
  cleanupOutdatedCaches,
  createHandlerBoundToURL,
  precacheAndRoute
} from 'workbox-precaching'
import { NavigationRoute, registerRoute } from 'workbox-routing'

/**
 * Taut's service worker: the offline shell (Workbox precache, injected at build time)
 * plus the two Web Push handlers. Registered by `lib/pwa.ts`.
 *
 * Nothing here talks to the API. A push payload is self-contained (title/body/url), so
 * a notification renders with the app closed and no session available to the worker.
 */

declare const self: ServiceWorkerGlobalScope & {
  __WB_MANIFEST: Array<{ url: string; revision: string | null }>
}

/** Mirrors `PushPayload` in apps/server/src/push/sender.ts. */
interface PushPayload {
  title: string
  body: string
  tag: string
  url: string
}

precacheAndRoute(self.__WB_MANIFEST)
cleanupOutdatedCaches()

// SPA navigations fall back to the cached shell; the API and the socket never do.
registerRoute(
  new NavigationRoute(createHandlerBoundToURL('index.html'), {
    denylist: [/^\/api\//, /^\/ws$/]
  })
)

// A new build takes over as soon as it is installed: chat clients must not run a
// week-old bundle against a moved API.
self.addEventListener('install', () => {
  void self.skipWaiting()
})
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

const parse = (event: PushEvent): PushPayload => {
  const fallback: PushPayload = { title: 'Taut', body: 'New message', tag: 'taut', url: '/' }
  if (event.data === null) return fallback
  try {
    const data = event.data.json() as Partial<PushPayload>
    return {
      title: typeof data.title === 'string' ? data.title : fallback.title,
      body: typeof data.body === 'string' ? data.body : fallback.body,
      tag: typeof data.tag === 'string' ? data.tag : fallback.tag,
      url: typeof data.url === 'string' ? data.url : fallback.url
    }
  } catch {
    return fallback
  }
}

self.addEventListener('push', (event) => {
  const payload = parse(event)
  event.waitUntil(
    self.registration.showNotification(payload.title, {
      body: payload.body,
      // Same tag = the newest message replaces the previous one for that conversation;
      // `renotify` makes the replacement still buzz. (Not in TS's lib.dom yet.)
      tag: payload.tag,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-192.png',
      data: { url: payload.url },
      ...{ renotify: true }
    })
  )
})

/** Focus an open Taut window and route it, or open one at the target. */
self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data as { url?: string } | undefined
  const target = new URL(data?.url ?? '/', self.location.origin)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async (clients) => {
      for (const client of clients) {
        if (new URL(client.url).origin !== target.origin) continue
        await client.focus()
        // The app listens for this and navigates with the router, so the SPA never reloads.
        client.postMessage({ type: 'taut:navigate', url: target.pathname + target.search })
        return
      }
      await self.clients.openWindow(target.href)
    })
  )
})
