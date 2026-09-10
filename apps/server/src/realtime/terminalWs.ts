/**
 * `/ws/terminal?agentId=…&cols=…&rows=…` — the Workspace tab's socket
 * (docs/build-plan-workspace.md D6–D12, D15–D17). A second WebSocket endpoint next
 * to `/ws`, on the same Node server and the same `WsAuthenticator`, and nothing
 * else shared: `/ws` is tuned for events (64 KB frames, typing drops, a
 * slow-client close) and a PTY would trip every one of those.
 *
 * One connection = one PTY in the agent's box, plus — for an agent with
 * `browserAccess` (D16) — the live view of its browser and the take-control
 * hand-over, on the same socket (no third socket).
 *
 * `?pty=0` opens the same connection **without** the PTY: the live view and
 * take-control alone. That is the only mode the `local` provider allows, where a
 * shell would be a shell on the owner's own host (D2) but the browser is still a
 * Chromium Taut started on the agent's profile. `stdin` and `resize` frames are
 * dropped in that mode, and screencast frames count as activity so watching an
 * agent browse does not trip the idle close.
 *
 *   upgrade → cookie → principal → "may manage the agent" (D3; 403/404 before the
 *   handshake, like `/ws`) → handshake → D10 registry slot → `Workspace.openPty`
 *   → `ready` → relay until the shell exits, the viewer leaves, or a limit hits.
 *   ↳ `browser: starting` → Chromium up + CDP attached → `browser: live` → `frame`s
 *   ↳ `control` frames take / release the browser; `input` frames reach the page only
 *     from the holder (D12); a running task must be paused first (D15).
 *
 * Frames are the contract's `terminal.ts` schemas; every `data` is base64 (D7).
 * The PTY and the CDP session live in the connection fiber's scope, so any exit
 * path — shell exit, socket close, idle, cap, server shutdown — ends with the
 * child killed, the screencast stopped and control released (a paused runtime
 * resumed). Open, close and every server-initiated kill are logged with
 * `{ agentId, viewerId, sessionId }` (D10). `input` frames and screencast data
 * are never logged, persisted or echoed (D17).
 */
import { HttpServer } from '@effect/platform'
import type { AgentId, UserId } from '@taut/contract/ids'
import { AgentId as AgentIdSchema } from '@taut/contract/ids'
import {
  TERMINAL_CLOSE,
  TERMINAL_WS_PATH,
  TerminalClientFrame,
  TerminalDimension,
  TerminalServerFrame
} from '@taut/contract/terminal'
import type { Agent } from '@taut/contract/domain'
import type { Machine, Pty } from '@taut/runtime'
import { Deferred, Effect, Either, Exit, FiberSet, Queue, Schedule, Schema, Stream } from 'effect'
import { randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocket, WebSocketServer, type RawData } from 'ws'
import { WsAuthenticator, type Principal } from '../auth/wsAuthenticator.js'
import { HttpNodeServer } from '../http/server.js'
import type { BrowserSession } from '../services/browserLive.js'
import { Workspace } from '../services/workspace.js'
import { makeOutputThrottle, makeTerminalRegistry, TerminalLimits } from './terminalLimits.js'

export { TERMINAL_WS_PATH }

/** A paste is the largest client frame; 256 KB of base64 is ~190 KB of text. */
const MAX_PAYLOAD_BYTES = 256 * 1024
/** Past this much unsent output the viewer is gone or hopeless; the PTY must not wait for it. */
const SLOW_CLIENT_CLOSE_BYTES = 8 * 1024 * 1024
/** Screencast frames are dropped (not queued) while this much is still unsent. */
const FRAME_DROP_BYTES = 2 * 1024 * 1024
const HEARTBEAT_INTERVAL = '30 seconds'
const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24
/** What the viewer sees where output was dropped (D10). */
export const TRUNCATED_MARKER = '\r\n[output truncated]\r\n'

const decodeClientFrame = Schema.decodeUnknownEither(Schema.parseJson(TerminalClientFrame))
const encodeFrame = Schema.encodeSync(TerminalServerFrame)
const decodeAgentId = Schema.decodeUnknownEither(AgentIdSchema)
const decodeDimension = Schema.decodeUnknownEither(
  Schema.compose(Schema.NumberFromString, TerminalDimension)
)

const rawToString = (data: RawData): string =>
  Buffer.isBuffer(data)
    ? data.toString('utf8')
    : Array.isArray(data)
      ? Buffer.concat(data).toString('utf8')
      : Buffer.from(data).toString('utf8')

const dimension = (raw: string | null, fallback: number): number => {
  if (raw === null) return fallback
  const parsed = decodeDimension(raw)
  return Either.isRight(parsed) ? parsed.right : fallback
}

const minutes = (ms: number): string => {
  const m = Math.round(ms / 60_000)
  return m >= 60
    ? `${Math.round(m / 60)} hour${m >= 120 ? 's' : ''}`
    : `${m} minute${m === 1 ? '' : 's'}`
}

/** Who drives an agent's browser right now (D12, D15). In memory, like every session (D4). */
interface ControlHold {
  readonly holder: UserId
  readonly sessionId: string
  /** The agent's runtime is `SIGSTOP`ped for the duration of the hold. */
  readonly paused: boolean
}

type Send = (frame: TerminalServerFrame) => void

export class TerminalWsServer extends Effect.Service<TerminalWsServer>()('TerminalWsServer', {
  scoped: Effect.gen(function* () {
    const { server } = yield* HttpNodeServer
    const http = yield* HttpServer.HttpServer
    const { authenticate } = yield* WsAuthenticator
    const workspace = yield* Workspace
    const limits = yield* TerminalLimits
    const registry = makeTerminalRegistry(limits.maxPerAgent)
    // Browser viewers do not own shells. Allow overlapping views (including a
    // reconnect before cleanup finishes), with a separate per-agent resource cap.
    const browserRegistry = makeTerminalRegistry(limits.maxPerAgent)
    /** agentId → the hold, while someone drives. */
    const controls = new Map<string, ControlHold>()
    /** agentId → every open socket's sender, so a hand-over reaches every viewer. */
    const viewers = new Map<string, Set<Send>>()
    const viewerSessions = new WeakMap<WebSocket, { agentId: string; sessionId: string }>()
    const controlLock = yield* Effect.makeSemaphore(1)

    const wss = yield* Effect.acquireRelease(
      Effect.sync(() => new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES })),
      (wss) =>
        Effect.async<void>((resume) => {
          for (const client of wss.clients) client.terminate()
          wss.close(() => resume(Effect.void))
        })
    )
    // After `wss`, so it is released first: connection fibers close their PTYs and
    // sockets gracefully before the server terminates whatever is left.
    const connections = yield* FiberSet.make<void>()
    const runConnection = yield* FiberSet.runtime(connections)<never>()

    const sendNow = (ws: WebSocket, frame: TerminalServerFrame): void => {
      if (ws.readyState !== WebSocket.OPEN) return
      const viewer = viewerSessions.get(ws)
      const output =
        frame._tag === 'control'
          ? {
              ...frame,
              owned:
                viewer !== undefined && controls.get(viewer.agentId)?.sessionId === viewer.sessionId
            }
          : frame
      ws.send(JSON.stringify(encodeFrame(output)))
    }
    const send = (ws: WebSocket, frame: TerminalServerFrame) =>
      Effect.sync(() => sendNow(ws, frame))

    const close = (ws: WebSocket, code: number, reason: string) =>
      Effect.sync(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(code, reason)
        }
      })

    /** An `error` frame the viewer can read, then the close. */
    const refuse = (ws: WebSocket, code: number, message: string) =>
      send(ws, { _tag: 'error', message }).pipe(Effect.zipRight(close(ws, code, message)))

    const controlState = (agentId: string, reason?: string): TerminalServerFrame => {
      const hold = controls.get(agentId)
      return {
        _tag: 'control',
        holder: hold?.holder ?? null,
        paused: hold?.paused ?? false,
        ...(reason === undefined ? {} : { reason })
      }
    }

    const broadcastControl = (agentId: string) =>
      Effect.sync(() => {
        const frame = controlState(agentId)
        for (const sender of viewers.get(agentId) ?? []) sender(frame)
      })

    const serveConnection = (
      ws: WebSocket,
      principal: Principal,
      agent: Agent,
      sessionId: string,
      cols: number,
      rows: number,
      /** `false` for a browser-only socket (`?pty=0`): no shell is opened. */
      wantsPty: boolean
    ) =>
      Effect.gen(function* () {
        viewerSessions.set(ws, { agentId: agent.id, sessionId })
        const closed = yield* Deferred.make<void>()
        ws.on('close', () => Deferred.unsafeDone(closed, Exit.void))
        ws.on('error', () => Deferred.unsafeDone(closed, Exit.void))
        yield* Effect.addFinalizer(() => close(ws, 1001, 'server shutting down'))

        // D10: one per (agent, viewer), at most `maxPerAgent` per agent.
        const slots = wantsPty ? registry : browserRegistry
        const slot = slots.claim(agent.id, wantsPty ? principal.userId : sessionId, sessionId)
        if (Either.isLeft(slot)) {
          const why = slot.left
          yield* Effect.logInfo(`terminal: refused (${why})`)
          return yield* why === 'viewer-busy'
            ? refuse(
                ws,
                TERMINAL_CLOSE.viewerBusy,
                'You already have a terminal open on this agent.'
              )
            : refuse(
                ws,
                TERMINAL_CLOSE.agentFull,
                `This agent already has ${limits.maxPerAgent} ${wantsPty ? 'terminals' : 'browser views'} open.`
              )
        }
        yield* Effect.addFinalizer(() => Effect.sync(() => slots.release(agent.id, sessionId)))

        // A browser-only socket still needs the box, just not a shell in it.
        const opened = yield* Effect.either(
          wantsPty
            ? workspace
                .openPty(agent, { cols, rows })
                .pipe(
                  Effect.map(
                    (open): { readonly pty: Pty | undefined; readonly machine: Machine } => open
                  )
                )
            : workspace.runningMachine(agent).pipe(
                Effect.map(
                  (machine): { readonly pty: Pty | undefined; readonly machine: Machine } => ({
                    pty: undefined,
                    machine
                  })
                )
              )
        )
        if (Either.isLeft(opened)) {
          yield* Effect.logInfo(`terminal: refused (${opened.left._tag}: ${opened.left.message})`)
          return yield* refuse(ws, TERMINAL_CLOSE.unavailable, opened.left.message)
        }
        const { pty, machine } = opened.right
        yield* Effect.logInfo(
          `terminal: open (${pty === undefined ? 'browser only' : 'pty'})`
        ).pipe(Effect.annotateLogs({ machineId: machine.id, shell: pty?.shell ?? '', cols, rows }))
        yield* send(ws, { _tag: 'ready', shell: pty?.shell ?? '', machineId: machine.id })

        let lastActivity = Date.now()
        const throttle = makeOutputThrottle(limits.outputBytesPerSecond)
        const marker = Buffer.from(TRUNCATED_MARKER, 'utf8').toString('base64')

        // ── control (D12, D15) ────────────────────────────────────────────────
        const sender: Send = (frame) => sendNow(ws, frame)
        const peers = viewers.get(agent.id) ?? new Set<Send>()
        peers.add(sender)
        viewers.set(agent.id, peers)
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            peers.delete(sender)
            if (peers.size === 0) viewers.delete(agent.id)
          })
        )

        const releaseControl = Effect.gen(function* () {
          const hold = controls.get(agent.id)
          if (hold === undefined || hold.sessionId !== sessionId) return
          controls.delete(agent.id)
          if (hold.paused) {
            yield* workspace.signalTasks(agent, 'CONT').pipe(
              Effect.tapError((e) =>
                Effect.logWarning(`terminal: could not resume the agent: ${e.message}`)
              ),
              Effect.ignore
            )
          }
          yield* Effect.logInfo(`terminal: control released (paused=${hold.paused})`)
          yield* broadcastControl(agent.id)
        }).pipe(controlLock.withPermits(1))
        // Disconnect, idle and the cap all end here: the agent is never left frozen.
        yield* Effect.addFinalizer(() => releaseControl)

        const takeControl = (pause: boolean) =>
          Effect.gen(function* () {
            const hold = controls.get(agent.id)
            if (hold !== undefined) {
              return yield* send(
                ws,
                hold.sessionId === sessionId
                  ? controlState(agent.id)
                  : controlState(agent.id, 'Someone else is driving this browser.')
              )
            }
            const running = yield* workspace.hasRunningTask(agent)
            if (running && !pause) {
              return yield* send(ws, {
                _tag: 'control',
                holder: null,
                paused: false,
                reason: 'The agent is running a task. Pause it to take control.'
              })
            }
            let paused = false
            if (running) {
              const frozen = yield* Effect.either(workspace.signalTasks(agent, 'STOP'))
              if (Either.isLeft(frozen)) {
                yield* Effect.logWarning(
                  `terminal: could not pause the agent: ${frozen.left.message}`
                )
                return yield* send(ws, {
                  _tag: 'control',
                  holder: null,
                  paused: false,
                  reason: `Could not pause the agent: ${frozen.left.message}`
                })
              }
              paused = true
            }
            controls.set(agent.id, { holder: principal.userId, sessionId, paused })
            yield* Effect.logInfo(`terminal: control taken (paused=${paused})`)
            yield* broadcastControl(agent.id)
          }).pipe(controlLock.withPermits(1))

        // Whoever is driving already is visible to a viewer that joins now.
        yield* send(ws, controlState(agent.id))

        // ── browser live view (D11, D16) ─────────────────────────────────────
        let live: BrowserSession | undefined
        const liveView = agent.browserAccess
          ? Effect.scoped(
              Effect.gen(function* () {
                yield* send(ws, { _tag: 'browser', state: 'starting' })
                const session = yield* Effect.either(workspace.openLiveView(agent))
                if (Either.isLeft(session)) {
                  yield* Effect.logInfo(
                    `terminal: live view unavailable (${session.left._tag}: ${session.left.message})`
                  )
                  return yield* send(ws, {
                    _tag: 'browser',
                    state: 'unavailable',
                    reason: session.left.message
                  })
                }
                live = session.right
                yield* Effect.logInfo('terminal: live view on')
                yield* send(ws, { _tag: 'browser', state: 'live' })
                yield* Stream.runForEach(session.right.tabs, (tabs) => send(ws, tabs)).pipe(
                  Effect.forkScoped
                )
                yield* Stream.runForEach(session.right.frames, (frame) => {
                  // Without a PTY the screencast is the only traffic there is; treating
                  // it as activity keeps a viewer watching an agent browse connected.
                  if (pty === undefined) lastActivity = Date.now()
                  return ws.bufferedAmount > FRAME_DROP_BYTES
                    ? Effect.void
                    : send(ws, { _tag: 'frame', ...frame })
                })
                live = undefined
                yield* Effect.logInfo('terminal: live view ended (Chromium closed)')
                yield* send(ws, {
                  _tag: 'browser',
                  state: 'unavailable',
                  reason: 'Chromium closed.'
                })
              })
            )
          : send(ws, { _tag: 'browser', state: 'off' })

        // Notice and close first, kill second: once the socket is closing, the outbound
        // fiber's `exit` frame is dropped, so the viewer sees the reason, not "exited".
        const endedBy = (reason: string, code: number, message: string) =>
          Effect.logInfo(`terminal: kill (${reason})`).pipe(
            Effect.zipRight(refuse(ws, code, message)),
            Effect.zipRight(pty?.kill() ?? Effect.void)
          )

        // PTY → viewer, throttled. The shell's exit ends the stream and the socket.
        // A browser-only socket has no shell, so it only ends when the viewer leaves.
        const outbound =
          pty === undefined
            ? Effect.never
            : Stream.runForEach(pty.output, (chunk) =>
                Effect.suspend(() => {
                  const now = Date.now()
                  lastActivity = now
                  if (ws.bufferedAmount > SLOW_CLIENT_CLOSE_BYTES) {
                    return close(ws, TERMINAL_CLOSE.slowClient, 'client too slow')
                  }
                  const verdict = throttle.admit(chunk.length, now)
                  const frames: Array<Effect.Effect<void>> = []
                  if (verdict.allow > 0) {
                    frames.push(
                      send(ws, {
                        _tag: 'data',
                        data: Buffer.from(chunk.subarray(0, verdict.allow)).toString('base64')
                      })
                    )
                  }
                  if (verdict.marker) frames.push(send(ws, { _tag: 'data', data: marker }))
                  return Effect.all(frames, { discard: true })
                })
              ).pipe(
                Effect.zipRight(pty === undefined ? Effect.never : pty.exit),
                Effect.flatMap((exitCode: number) =>
                  Effect.logInfo(`terminal: shell exited (${exitCode})`).pipe(
                    Effect.zipRight(send(ws, { _tag: 'exit', exitCode })),
                    Effect.zipRight(close(ws, TERMINAL_CLOSE.exited, 'shell exited'))
                  )
                )
              )

        // viewer → PTY / page. `input` is honoured only from the holder and never logged (D17).
        const inbox = yield* Queue.unbounded<RawData>()
        ws.on('message', (data) => {
          Queue.unsafeOffer(inbox, data)
        })
        const inbound = Queue.take(inbox).pipe(
          Effect.flatMap((data) => {
            const frame = decodeClientFrame(rawToString(data))
            if (Either.isLeft(frame)) return Effect.logDebug('terminal: ignoring invalid frame')
            lastActivity = Date.now()
            switch (frame.right._tag) {
              case 'stdin':
                // Dropped on a browser-only socket: there is nothing to type into.
                return (
                  pty?.write(new Uint8Array(Buffer.from(frame.right.data, 'base64'))) ?? Effect.void
                )
              case 'resize':
                return pty?.resize(frame.right.cols, frame.right.rows) ?? Effect.void
              case 'viewport':
                return live?.resize(frame.right) ?? Effect.void
              case 'input': {
                const session = live
                const hold = controls.get(agent.id)
                return session !== undefined && hold?.sessionId === sessionId
                  ? session.dispatch(frame.right.event)
                  : Effect.void
              }
              case 'control':
                return frame.right.hold ? takeControl(frame.right.pause === true) : releaseControl
            }
          }),
          Effect.forever
        )

        // D10: idle and hard cap. The idle check runs often enough to be exact to ~1/4 of the limit.
        const idleTick = Math.max(25, Math.min(1000, Math.floor(limits.idleMs / 4)))
        const idle = Effect.suspend(() =>
          Date.now() - lastActivity >= limits.idleMs
            ? endedBy(
                'idle',
                TERMINAL_CLOSE.idle,
                `Closed after ${minutes(limits.idleMs)} without activity.`
              )
            : Effect.void
        ).pipe(Effect.repeat(Schedule.spaced(`${idleTick} millis`)))
        const cap = Effect.sleep(`${limits.maxMs} millis`).pipe(
          Effect.zipRight(
            endedBy(
              'session cap',
              TERMINAL_CLOSE.sessionCap,
              `Closed: terminal sessions end after ${minutes(limits.maxMs)}.`
            )
          )
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

        const guarded = <A, E>(what: string, effect: Effect.Effect<A, E>) =>
          effect.pipe(
            Effect.catchAllCause((cause) =>
              Effect.logError(`terminal: ${what} failed`, cause).pipe(
                Effect.zipRight(close(ws, 1011, 'internal error'))
              )
            )
          )
        yield* Effect.forkScoped(guarded('outbound', outbound))
        yield* Effect.forkScoped(guarded('inbound', inbound))
        yield* Effect.forkScoped(guarded('idle', idle))
        yield* Effect.forkScoped(guarded('cap', cap))
        yield* Effect.forkScoped(guarded('live view', liveView))
        yield* Effect.forkScoped(heartbeat)
        yield* Deferred.await(closed)
        yield* Effect.logInfo('terminal: close')
      }).pipe(
        Effect.scoped,
        Effect.annotateLogs({
          agentId: agent.id,
          viewerId: principal.userId,
          companyId: principal.companyId,
          sessionId
        })
      )

    const rejectUpgrade = (socket: Duplex, status: number, text: string) =>
      Effect.sync(() => {
        socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`)
        socket.destroy()
      })

    const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) =>
      Effect.gen(function* () {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const agentId = decodeAgentId(url.searchParams.get('agentId'))
        if (Either.isLeft(agentId)) return yield* rejectUpgrade(socket, 400, 'Bad Request')
        const principal = yield* Effect.either(authenticate(req))
        if (Either.isLeft(principal)) {
          const { status } = principal.left
          return yield* rejectUpgrade(socket, status, status === 401 ? 'Unauthorized' : 'Forbidden')
        }
        const agent = yield* Effect.either(
          workspace.authorizePrincipal(principal.right, agentId.right as AgentId)
        )
        if (Either.isLeft(agent)) {
          return yield* agent.left._tag === 'NotFound'
            ? rejectUpgrade(socket, 404, 'Not Found')
            : rejectUpgrade(socket, 403, 'Forbidden')
        }
        const cols = dimension(url.searchParams.get('cols'), DEFAULT_COLS)
        const rows = dimension(url.searchParams.get('rows'), DEFAULT_ROWS)
        const wantsPty = url.searchParams.get('pty') !== '0'
        const ws = yield* Effect.async<WebSocket>((resume) => {
          socket.once('close', () => resume(Effect.interrupt))
          wss.handleUpgrade(req, socket, head, (ws) => resume(Effect.succeed(ws)))
        })
        yield* serveConnection(ws, principal.right, agent.right, randomUUID(), cols, rows, wantsPty)
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError('terminal: upgrade failed', cause).pipe(
            Effect.zipRight(Effect.sync(() => socket.destroy()))
          )
        )
      )

    // `realtime/ws.ts` owns the `upgrade` listener plumbing (it detaches the platform's
    // own) and leaves this path alone; this listener ignores every other path in turn.
    const onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (url.pathname !== TERMINAL_WS_PATH) return
      runConnection(handleUpgrade(req, socket, head))
    }
    server.on('upgrade', onUpgrade)
    yield* Effect.addFinalizer(() => Effect.sync(() => server.off('upgrade', onUpgrade)))

    if (http.address._tag === 'TcpAddress') {
      yield* Effect.logDebug(
        `terminal: listening on ws://${http.address.hostname}:${http.address.port}${TERMINAL_WS_PATH}`
      )
    }

    return {
      /** Open terminals on one agent right now (tests and diagnostics). */
      openCount: (agentId: AgentId) => Effect.sync(() => registry.count(agentId)),
      /** Who holds the browser of one agent right now, if anyone. */
      controlOf: (agentId: AgentId) =>
        Effect.sync(() => {
          const hold = controls.get(agentId)
          return hold === undefined ? undefined : { holder: hold.holder, paused: hold.paused }
        }),
      clientCount: Effect.sync(() => wss.clients.size)
    } as const
  })
}) {}
