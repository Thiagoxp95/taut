import { Cookies, HttpApiClient, HttpClient, HttpServer } from '@effect/platform'
import { NodeHttpClient } from '@effect/platform-node'
import { TautApi } from '@taut/contract/api'
import { Effect, Ref } from 'effect'
import { WebSocket } from 'ws'
import type { ServerFrame } from '../src/realtime/ws.js'

/** `http://` + `ws://` base urls of the running test server. */
export const baseUrl = Effect.map(HttpServer.HttpServer, ({ address }) => {
  if (address._tag !== 'TcpAddress') throw new Error('expected tcp address')
  return { http: `http://127.0.0.1:${address.port}`, ws: `ws://127.0.0.1:${address.port}` }
})

/**
 * A typed `HttpApiClient` for the contract with its own cookie jar, so `signup`/`login`
 * set `taut_session` and every later call carries it — one client per simulated user.
 */
export const makeClient = Effect.gen(function* () {
  const { http } = yield* baseUrl
  const jar = yield* Ref.make(Cookies.empty)
  const api = yield* HttpApiClient.make(TautApi, {
    baseUrl: http,
    transformClient: HttpClient.withCookiesRef(jar)
  }).pipe(Effect.provide(NodeHttpClient.layer))
  const cookieHeader = Ref.get(jar).pipe(Effect.map(Cookies.toCookieHeader))
  return { api, cookieHeader } as const
})

export type TestClient = Effect.Effect.Success<typeof makeClient>

export interface SocketClient {
  readonly ws: WebSocket
  readonly next: () => Promise<ServerFrame>
  readonly close: () => Promise<void>
}

/** Minimal ws client: buffered frames + promise-based `next()` with a timeout. */
export const connect = (url: string, cookie?: string) =>
  Effect.promise(
    () =>
      new Promise<SocketClient>((resolve, reject) => {
        const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {})
        const buffer: Array<ServerFrame> = []
        const waiters: Array<(f: ServerFrame) => void> = []
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as ServerFrame
          const waiter = waiters.shift()
          if (waiter) waiter(frame)
          else buffer.push(frame)
        })
        ws.on('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)))
        ws.on('error', reject)
        ws.on('open', () =>
          resolve({
            ws,
            next: () =>
              new Promise<ServerFrame>((res, rej) => {
                const buffered = buffer.shift()
                if (buffered) return res(buffered)
                const timer = setTimeout(() => rej(new Error('timed out waiting for frame')), 5000)
                waiters.push((f) => {
                  clearTimeout(timer)
                  res(f)
                })
              }),
            close: () =>
              new Promise<void>((res) => {
                ws.once('close', () => res())
                ws.close()
              })
          })
        )
      })
  )

export const eventFrame = (frame: ServerFrame) => {
  if (frame.type !== 'event') throw new Error(`expected event frame, got ${frame.type}`)
  return frame.event
}

export const sleep = (ms: number) => Effect.promise(() => new Promise((r) => setTimeout(r, ms)))
