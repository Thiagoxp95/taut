import { session } from 'electron'
import { ServerSocketMessage } from '@taut/contract/events'
import {
  Data,
  Deferred,
  Effect,
  Either,
  Exit,
  Fiber,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
  Stream
} from 'effect'
import { WebSocket } from 'ws'
import { socketUrl } from './instance'
import { Store } from './store'
const decodeFrame = Schema.decodeUnknownEither(Schema.parseJson(ServerSocketMessage))
const RECONNECT_BASE = '1 second'
const RECONNECT_CAP = '30 seconds'
class SocketClosed extends Data.TaggedError('SocketClosed') {}
class SocketFailed extends Data.TaggedError('SocketFailed') {}
const rawToString = (data) =>
  Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data).toString('utf8')
/**
 * The shell's own `/ws` connection — the same socket the web client opens
 * (docs/agent-model.md §8), but held by the main process so notifications and
 * the dock badge survive the window being hidden or the renderer being busy.
 *
 * Authentication is the instance's `taut_session` cookie, read out of the
 * window's `persist:taut` partition and replayed as a `Cookie` header. Before
 * the user logs in there is no cookie and the upgrade is refused with 401 —
 * which is not an error, just "not yet", so every failure retries on the same
 * capped, jittered backoff and the socket comes up on its own once login lands.
 */
export class Realtime extends Effect.Service()('Realtime', {
  scoped: Effect.gen(function* () {
    const store = yield* Store
    const scope = yield* Effect.scope
    const inbox = yield* Queue.unbounded()
    const running = yield* Ref.make(Option.none())
    const cookieHeader = (instanceUrl, partition) =>
      Effect.tryPromise(() =>
        session.fromPartition(partition).cookies.get({ url: instanceUrl })
      ).pipe(
        Effect.map((cookies) => cookies.map((c) => `${c.name}=${c.value}`).join('; ')),
        // No cookie jar yet (or a partition that does not exist) is "not logged in".
        Effect.orElseSucceed(() => '')
      )
    const handleFrame = (raw) =>
      Effect.suspend(() => {
        const decoded = decodeFrame(raw)
        if (Either.isLeft(decoded)) {
          // An unknown frame must never take the socket down (same rule as the web client).
          return Effect.logDebug('ws: dropped an unreadable frame')
        }
        const frame = decoded.right
        switch (frame.type) {
          case 'pong':
            return Effect.void
          case 'resync':
            return store.setLastSeq(frame.head)
          case 'event': {
            const event = frame.event
            // `typing` is ephemeral and carries the current head, not its own seq.
            const remember = event.type === 'typing' ? Effect.void : store.setLastSeq(event.seq)
            return remember.pipe(Effect.zipRight(Queue.offer(inbox, event)), Effect.asVoid)
          }
        }
      })
    /** One connection attempt; it fails when the socket goes away, which drives the retry. */
    const connectOnce = (instanceUrl, partition) =>
      Effect.gen(function* () {
        const [cookie, since] = yield* Effect.all([
          cookieHeader(instanceUrl, partition),
          store.lastSeq
        ])
        const target = socketUrl(instanceUrl, since)
        const closed = yield* Deferred.make()
        const opened = yield* Deferred.make()
        const socket = yield* Effect.acquireRelease(
          Effect.sync(
            () =>
              new WebSocket(target, {
                headers: { Cookie: cookie, Origin: new URL(instanceUrl).origin },
                followRedirects: false
              })
          ),
          (socket) => Effect.sync(() => socket.terminate())
        )
        socket.on('open', () => {
          Deferred.unsafeDone(opened, Exit.void)
        })
        const frames = yield* Queue.unbounded()
        socket.on('message', (data) => {
          Queue.unsafeOffer(frames, rawToString(data))
        })
        socket.on('close', (code, reason) => {
          Deferred.unsafeDone(
            closed,
            Exit.fail(new SocketClosed({ code, reason: reason.toString('utf8') }))
          )
        })
        socket.on('error', (cause) => {
          Deferred.unsafeDone(closed, Exit.fail(new SocketFailed({ cause })))
        })
        // Without this listener `ws` turns a 401 upgrade into a bare `error`;
        // with it we get the status, and we own destroying the request.
        socket.on('unexpected-response', (request, response) => {
          const code = response.statusCode ?? 0
          request.destroy()
          Deferred.unsafeDone(
            closed,
            Exit.fail(new SocketClosed({ code, reason: 'upgrade rejected' }))
          )
        })
        yield* Effect.forkScoped(
          Deferred.await(opened).pipe(Effect.zipRight(Effect.logInfo(`ws: connected ${target}`)))
        )
        yield* Effect.forkScoped(Stream.fromQueue(frames).pipe(Stream.runForEach(handleFrame)))
        return yield* Deferred.await(closed)
      }).pipe(Effect.scoped)
    const backoff = Schedule.exponential(RECONNECT_BASE).pipe(
      Schedule.union(Schedule.spaced(RECONNECT_CAP)),
      Schedule.jittered
    )
    const loop = (instanceUrl, partition) =>
      connectOnce(instanceUrl, partition).pipe(
        Effect.tapError((error) =>
          Effect.logDebug(
            error._tag === 'SocketClosed'
              ? `ws: closed (${error.code}) ${error.reason} — retrying`
              : 'ws: failed — retrying'
          )
        ),
        Effect.retry(backoff),
        Effect.catchAllCause((cause) => Effect.logError('ws: gave up', cause)),
        Effect.annotateLogs({ instance: instanceUrl })
      )
    const stop = Ref.getAndSet(running, Option.none()).pipe(
      Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Fiber.interrupt })),
      Effect.asVoid
    )
    const connect = (instanceUrl, partition) =>
      stop.pipe(
        Effect.zipRight(Effect.forkIn(loop(instanceUrl, partition), scope)),
        Effect.flatMap((fiber) => Ref.set(running, Option.some(fiber)))
      )
    yield* Effect.addFinalizer(() => stop)
    return {
      /** Every event the socket delivered, in order. Consumed once, by the shell. */
      events: Stream.fromQueue(inbox),
      connect,
      stop
    }
  }),
  dependencies: [Store.Default]
}) {}
