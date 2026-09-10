import { Canvases } from '../services/canvases.js'
import { HttpServer } from '@effect/platform'
import { ClientSocketMessage, ServerSocketMessage, type Event } from '@taut/contract/events'
import {
  DateTime,
  Deferred,
  Effect,
  Either,
  Exit,
  FiberSet,
  Queue,
  Schedule,
  Schema,
  Stream
} from 'effect'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { TERMINAL_WS_PATH } from '@taut/contract/terminal'
import { WsAuthenticator, type Principal } from '../auth/wsAuthenticator.js'
import { HttpNodeServer } from '../http/server.js'
import { Bus } from './bus.js'
import { EventLog } from './eventLog.js'
import { isVisibleTo } from './events.js'

export const WS_PATH = '/ws'
/** Above this many buffered bytes, ephemeral typing frames are dropped for that socket. */
export const TYPING_DROP_BYTES = 1024 * 1024
/** Above this, the client is too slow: close and let it resume from `?since=`. */
export const SLOW_CLIENT_CLOSE_BYTES = 16 * 1024 * 1024
const MAX_PAYLOAD_BYTES = 64 * 1024
const HEARTBEAT_INTERVAL = '30 seconds'

const decodeClientFrame = Schema.decodeUnknownEither(Schema.parseJson(ClientSocketMessage))
const encodeFrame = Schema.encodeSync(ServerSocketMessage)

/** The wire shape of a server frame (`ServerSocketMessage` encoded: dates as ISO strings). */
export type ServerFrame = typeof ServerSocketMessage.Encoded

const rawToString = (data: RawData): string =>
  Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data).toString('utf8')

/**
 * Above this many missed events a replay stops being a catch-up: the client is better
 * served by `resync` (take the head, refetch over HTTP) than by thousands of frames whose
 * only visible effect is a toast and a sound per notification.
 */
const MAX_REPLAY_EVENTS = 500

/** `undefined` when the client has no cursor at all — a first connect, not a resume. */
const parseSince = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const send = (ws: WebSocket, frame: ServerSocketMessage) =>
  Effect.sync(() => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(encodeFrame(frame)))
  })

const close = (ws: WebSocket, code: number, reason: string) =>
  Effect.sync(() => {
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
      ws.close(code, reason)
    }
  })

/**
 * WebSocket endpoint at `/ws?since=<seq>` on the shared Node http server.
 * Connect → authenticate (`taut_session` cookie → session → active company) → subscribe
 * to `Bus` → replay `EventLog` events with `seq > since` → go live. A connect with no
 * `since` (or one more than `MAX_REPLAY_EVENTS` behind) skips the replay and gets a
 * `resync` frame carrying the head instead. Events addressed to
 * one user (`notification`, `unread.changed`) only reach that user's sockets. Client
 * frames: `{type:"ping"}`, `{type:"typing", channelId}` (rebroadcast, never logged).
 *
 * Depends on `HttpServer` only for ordering: it is released before the http server
 * closes, so open sockets never keep `server.close()` waiting.
 */
export class WsServer extends Effect.Service<WsServer>()('WsServer', {
  scoped: Effect.gen(function* () {
    const { server } = yield* HttpNodeServer
    const http = yield* HttpServer.HttpServer
    const eventLog = yield* EventLog
    const bus = yield* Bus
    const canvases = yield* Canvases
    const { authenticate } = yield* WsAuthenticator

    const wss = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })),
      (wss) =>
        Effect.async<void>((resume) => {
          for (const client of wss.clients) client.terminate()
          wss.close(() => resume(Effect.void))
        })
    )
    // Created after `wss` so it is released first: connection fibers get interrupted
    // (closing their sockets gracefully) before the server terminates stragglers.
    const connections = yield* FiberSet.make<void>()
    const runConnection = yield* FiberSet.runtime(connections)<never>()

    const serveConnection = (ws: WebSocket, principal: Principal, since: number | undefined) =>
      Effect.gen(function* () {
        const closed = yield* Deferred.make<void>()
        ws.on('close', () => Deferred.unsafeDone(closed, Exit.void))
        ws.on('error', () => Deferred.unsafeDone(closed, Exit.void))
        yield* Effect.addFinalizer(() => close(ws, 1001, 'server shutting down'))

        // Subscribe before replaying so nothing published mid-replay is lost;
        // `cursor` de-duplicates anything seen both ways.
        const subscription = yield* bus.subscribe(principal.companyId)
        const head = yield* eventLog.latestSeq(principal.companyId)
        /*
         * A client with no cursor (a fresh login) or one too far behind has nothing to
         * catch up on: hand it the head and let `resync` refetch. Replaying the whole log
         * at it would re-fire every notification it already lived through.
         */
        const replayFrom = since !== undefined && head - since <= MAX_REPLAY_EVENTS ? since : head
        let cursor = replayFrom

        const deliver = (event: Event) => {
          if (!isVisibleTo(event, principal.userId)) return Effect.void
          if (event.type === 'canvas.changed')
            return canvases
              .visibleTo(principal.companyId, event.payload.canvas.channelId, principal.userId)
              .pipe(
                Effect.flatMap((visible) =>
                  visible ? send(ws, { type: 'event', event }) : Effect.void
                )
              )
          return send(ws, { type: 'event', event })
        }

        const outbound = Effect.gen(function* () {
          if (replayFrom !== since) yield* send(ws, { type: 'resync', head })
          yield* eventLog.since(principal.companyId, replayFrom).pipe(
            Stream.runForEach((event) => {
              cursor = event.seq
              /*
               * A `notification` is a "pop something now" signal, nothing more: the toast,
               * the sound and the OS banner all hang off it, and the unread counts come from
               * `unread.changed` instead. Replaying one re-fires an alert the user already
               * lived through, so a catch-up skips them and only live ones ring.
               */
              return event.type === 'notification' ? Effect.void : deliver(event)
            })
          )
          yield* Stream.fromQueue(subscription).pipe(
            Stream.runForEach((message) =>
              Effect.suspend(() => {
                switch (message._tag) {
                  case 'Event': {
                    if (message.event.seq <= cursor) return Effect.void
                    cursor = message.event.seq
                    if (ws.bufferedAmount > SLOW_CLIENT_CLOSE_BYTES) {
                      return close(ws, 1013, 'client too slow; reconnect with ?since=')
                    }
                    return deliver(message.event)
                  }
                  /*
                   * The running commentary under a streaming reply
                   * (docs/build-plan-activity.md D2). Dropped for a backed-up socket on the
                   * same rule as typing: it is worthless a second later, and the reply's own
                   * deltas must not queue behind it.
                   */
                  case 'Activity': {
                    if (ws.bufferedAmount > TYPING_DROP_BYTES) return Effect.void
                    return Effect.gen(function* () {
                      const visible = yield* canvases.visibleTo(
                        principal.companyId,
                        message.channelId,
                        principal.userId
                      )
                      if (!visible) return
                      yield* send(ws, {
                        type: 'event',
                        event: {
                          seq: cursor,
                          companyId: message.companyId,
                          at: DateTime.unsafeNow(),
                          type: 'agent.activity',
                          payload: {
                            taskId: message.taskId,
                            messageId: message.messageId,
                            channelId: message.channelId,
                            threadId: message.threadId,
                            agentId: message.agentId,
                            kind: message.kind,
                            text: message.text,
                            ...(message.browser === undefined ? {} : { browser: message.browser })
                          }
                        }
                      })
                    })
                  }
                  case 'Typing': {
                    if (message.userId === principal.userId) return Effect.void
                    if (ws.bufferedAmount > TYPING_DROP_BYTES) return Effect.void
                    return send(ws, {
                      type: 'event',
                      event: {
                        seq: cursor,
                        companyId: message.companyId,
                        at: DateTime.unsafeNow(),
                        type: 'typing',
                        payload: {
                          channelId: message.channelId,
                          ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
                          userId: message.userId
                        }
                      }
                    })
                  }
                }
              })
            )
          )
        }).pipe(
          Effect.catchAllCause((cause) =>
            Effect.logError('ws: outbound failed', cause).pipe(
              Effect.zipRight(close(ws, 1011, 'internal error'))
            )
          )
        )

        const inbox = yield* Queue.unbounded<RawData>()
        ws.on('message', (data) => {
          Queue.unsafeOffer(inbox, data)
        })
        const inbound = Queue.take(inbox).pipe(
          Effect.flatMap((data) => {
            const frame = decodeClientFrame(rawToString(data))
            if (Either.isLeft(frame)) {
              return Effect.logDebug('ws: ignoring invalid client frame')
            }
            switch (frame.right.type) {
              case 'ping':
                return send(ws, { type: 'pong' })
              case 'typing':
                // TODO(plan): verify the user is a member of channelId before rebroadcasting.
                return bus.publish({
                  _tag: 'Typing',
                  companyId: principal.companyId,
                  channelId: frame.right.channelId,
                  threadId: frame.right.threadId,
                  userId: principal.userId
                })
            }
          }),
          Effect.forever
        )

        let alive = true
        ws.on('pong', () => {
          alive = true
        })
        const heartbeat = Effect.sync(() => {
          if (!alive) {
            ws.terminate()
            return
          }
          alive = false
          ws.ping()
        }).pipe(Effect.schedule(Schedule.spaced(HEARTBEAT_INTERVAL)))

        yield* Effect.forkScoped(outbound)
        yield* Effect.forkScoped(inbound)
        yield* Effect.forkScoped(heartbeat)
        yield* Effect.logDebug('ws: connected')
        yield* Deferred.await(closed)
        yield* Effect.logDebug('ws: disconnected')
      }).pipe(
        Effect.scoped,
        Effect.annotateLogs({ userId: principal.userId, companyId: principal.companyId })
      )

    const rejectUpgrade = (socket: Duplex, status: number, text: string) =>
      Effect.sync(() => {
        socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
      })

    const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      Effect.gen(function* () {
        const url = new URL(req.url ?? '/', 'http://localhost')
        if (url.pathname !== WS_PATH) {
          // The terminal (`realtime/terminalWs.ts`) has its own listener on this server;
          // every other path is nobody's and gets the 404 here.
          if (url.pathname === TERMINAL_WS_PATH) return
          return yield* rejectUpgrade(socket, 404, 'Not Found')
        }
        const principal = yield* Effect.either(authenticate(req))
        if (Either.isLeft(principal)) {
          const { status } = principal.left
          return yield* rejectUpgrade(socket, status, status === 401 ? 'Unauthorized' : 'Forbidden')
        }
        const since = parseSince(url.searchParams.get('since'))
        const ws = yield* Effect.async<WebSocket>((resume) => {
          // `handleUpgrade` only calls back on success; on a bad handshake `ws` has
          // already answered and destroyed the socket, so end the fiber on close.
          socket.once('close', () => resume(Effect.interrupt))
          wss.handleUpgrade(req, socket, head, (ws) => resume(Effect.succeed(ws)))
        })
        yield* serveConnection(ws, principal.right, since)
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError('ws: upgrade failed', cause).pipe(
            Effect.zipRight(Effect.sync(() => socket.destroy()))
          )
        )
      )

    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      runConnection(handleUpgrade(req, socket, head))
    }
    // `NodeHttpServer` registers its own `upgrade` listener that runs every upgrade
    // through the HTTP router (for `HttpServerRequest.upgrade`), which would answer
    // `/ws` with a 404 before we could. All Taut realtime goes through `ws`, so that
    // listener is detached here; its own `server.off` at shutdown becomes a no-op.
    for (const listener of server.rawListeners('upgrade')) {
      server.off('upgrade', listener as (...args: Array<unknown>) => void)
    }
    server.on('upgrade', onUpgrade)
    yield* Effect.addFinalizer(() => Effect.sync(() => server.off('upgrade', onUpgrade)))

    if (http.address._tag === 'TcpAddress') {
      yield* Effect.logDebug(
        `ws: listening on ws://${http.address.hostname}:${http.address.port}${WS_PATH}`
      )
    }

    return {
      /** Open sockets right now (for tests and diagnostics). */
      clientCount: Effect.sync(() => wss.clients.size)
    } as const
  })
}) {}
