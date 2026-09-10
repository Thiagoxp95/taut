/**
 * The browser live view (docs/build-plan-workspace.md D11, D12, D17, D18): a small
 * CDP client that talks to the Chromium Taut started inside the agent's box, over
 * `Machine.openTunnel` — a byte relay through `docker exec` to the debug port bound
 * on the container's own loopback. The port never leaves the container (D18).
 *
 * Why the relay and not the bridge address (the plan's option "a"): in dev the server
 * runs on the owner's macOS host, where docker bridge IPs are not routable at all; and
 * a debug port bound to `taut-<slug>` would be reachable by every other agent of the
 * company — a full remote control of another agent's profile and cookies. Loopback +
 * relay keeps it reachable only from inside the box and from the server that owns the
 * docker socket. `node` is already in the image, so no `socat` (option "b") is needed.
 *
 * One `BrowserSession` = one CDP WebSocket + one attached page:
 *
 *   /json/version (tunnel 1) → ws://…/devtools/browser/<id> (tunnel 2)
 *   → Target.getTargets → attach to the newest page (flatten) → Page.startScreencast
 *   (JPEG, quality 60, max 1280) → frames acked at once, forwarded at ≤ `fps`
 *
 * The session follows the agent: a new page target becomes the one on screen, a
 * destroyed one is replaced by a survivor; tab selection follows page visibility.
 * `dispatch` is the *only* way input reaches the page and it forwards the contract's whitelisted event shapes
 * as `Input.dispatchMouseEvent` / `Input.dispatchKeyEvent` — never a raw CDP
 * command from a client. Nothing about an input event is ever logged (D17).
 */
import type {
  BrowserInputEvent,
  BrowserViewport,
  TerminalBrowserTabs
} from '@taut/contract/terminal'
import type { ExecFailed, Machine, MachineUnavailable } from '@taut/runtime'
import { BROWSER_PATHS, ExecFailed as ExecFailedError } from '@taut/runtime'
import { Deferred, Effect, Exit, Queue, Schedule, Scope, Stream } from 'effect'
import * as http from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { WebSocket } from 'ws'

/** D11: JPEG, quality 60, at most 1280 px wide, 8 frames per second. */
export const SCREENCAST = {
  format: 'jpeg',
  quality: 60,
  maxWidth: 1280,
  maxHeight: 1280,
  fps: 8
} as const

/** A CDP message is at most a screencast frame; 32 MB is far past any 1280-wide JPEG. */
const CDP_MAX_PAYLOAD = 32 * 1024 * 1024
const CDP_CALL_TIMEOUT_MS = 10_000

export interface LiveFrame {
  /** Base64 JPEG. */
  readonly data: string
  /** The page's CSS viewport, for mapping the viewer's clicks back (D12). */
  readonly width: number
  readonly height: number
}

export interface BrowserSession {
  /** Frames at ≤ `fps`, the latest one winning when the page repaints faster. */
  readonly frames: Stream.Stream<LiveFrame>
  /** Latest page titles, URLs and the page being streamed. */
  readonly tabs: Stream.Stream<TerminalBrowserTabs>
  /** Forward one whitelisted event to the page. Failures are swallowed (and never logged with the event). */
  readonly dispatch: (event: BrowserInputEvent) => Effect.Effect<void>
  /** Reflow the current page to the viewer's available space; retained across tab changes. */
  readonly resize: (size: BrowserViewport) => Effect.Effect<void>
  /** Observe a page without changing browser focus; null resumes following the agent. */
  readonly selectTab: (tabId: string | null) => Effect.Effect<void>
  /** Settles when the CDP socket is gone (Chromium exited, box stopped). */
  readonly closed: Effect.Effect<void>
}

export interface BrowserSessionOptions {
  readonly port: number
  readonly fps?: number
}

// ── a minimal CDP client ──────────────────────────────────────────────────

interface CdpEvent {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly sessionId?: string
}

interface TargetInfo {
  readonly targetId: string
  readonly type: string
  readonly url: string
  readonly attached: boolean
  readonly title: string
}

interface ScreencastMetadata {
  readonly deviceWidth: number
  readonly deviceHeight: number
}

class CdpClient {
  private nextId = 1
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >()
  readonly events: Array<(event: CdpEvent) => void> = []

  constructor(readonly ws: WebSocket) {
    ws.on('message', (raw) => this.onMessage(raw.toString()))
    ws.on('close', () => this.failAll(new Error('CDP socket closed')))
    ws.on('error', (error) => this.failAll(error))
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<unknown> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('CDP socket is not open'))
    }
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP ${method} timed out`))
      }, CDP_CALL_TIMEOUT_MS)
      this.pending.set(id, { resolve, reject, timer })
      this.ws.send(
        JSON.stringify({ id, method, params, ...(sessionId === undefined ? {} : { sessionId }) })
      )
    })
  }

  private onMessage(text: string): void {
    let message: {
      id?: number
      result?: unknown
      error?: { message?: string }
      method?: string
      params?: Record<string, unknown>
      sessionId?: string
    }
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    if (message.id !== undefined) {
      const waiter = this.pending.get(message.id)
      if (waiter === undefined) return
      this.pending.delete(message.id)
      clearTimeout(waiter.timer)
      if (message.error !== undefined) {
        waiter.reject(new Error(message.error.message ?? 'CDP error'))
      } else {
        waiter.resolve(message.result)
      }
      return
    }
    if (message.method !== undefined) {
      const event: CdpEvent = {
        method: message.method,
        params: message.params ?? {},
        ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId })
      }
      for (const listener of this.events) listener(event)
    }
  }

  private failAll(error: Error): void {
    for (const [id, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.reject(error)
      this.pending.delete(id)
    }
  }
}

// ── discovery + connect over the tunnel ───────────────────────────────────

const failure = (machine: Machine, reason: string, cause?: unknown): ExecFailed =>
  new ExecFailedError({ agentId: machine.spec.agentId, cmd: ['cdp'], reason, cause })

/** `GET /json/version` over a tunnel of its own, closed right after. */
const discoverDebuggerUrl = (
  machine: Machine,
  port: number
): Effect.Effect<string, MachineUnavailable | ExecFailed> =>
  Effect.scoped(
    Effect.gen(function* () {
      const tunnel = yield* machine.openTunnel(port)
      const body = yield* Effect.tryPromise({
        try: () =>
          new Promise<string>((resolve, reject) => {
            const request = http.request(
              {
                method: 'GET',
                host: '127.0.0.1',
                port,
                path: '/json/version',
                agent: false,
                headers: { host: `127.0.0.1:${port}`, connection: 'close' },
                createConnection: () => tunnel as never
              },
              (response) => {
                let text = ''
                response.setEncoding('utf8')
                response.on('data', (chunk: string) => {
                  text += chunk
                })
                response.on('end', () =>
                  response.statusCode === 200
                    ? resolve(text)
                    : reject(new Error(`/json/version answered ${response.statusCode}`))
                )
                response.on('error', reject)
              }
            )
            request.on('error', reject)
            request.end()
          }),
        catch: (cause) =>
          failure(machine, `cannot read /json/version from Chromium: ${String(cause)}`, cause)
      })
      const parsed = yield* Effect.try({
        try: () => JSON.parse(body) as { webSocketDebuggerUrl?: unknown },
        catch: (cause) => failure(machine, '/json/version is not JSON', cause)
      })
      if (typeof parsed.webSocketDebuggerUrl !== 'string') {
        return yield* failure(machine, '/json/version has no webSocketDebuggerUrl')
      }
      return parsed.webSocketDebuggerUrl
    })
  )

/** The CDP WebSocket, over a tunnel that lives as long as the scope. */
const connectCdp = (
  machine: Machine,
  port: number,
  url: string
): Effect.Effect<CdpClient, MachineUnavailable | ExecFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const tunnel = yield* machine.openTunnel(port)
    const ws = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () =>
          new Promise<WebSocket>((resolve, reject) => {
            const socket = new WebSocket(url, {
              createConnection: () => tunnel as never,
              perMessageDeflate: false,
              maxPayload: CDP_MAX_PAYLOAD
            } as never)
            socket.once('open', () => resolve(socket))
            socket.once('error', reject)
            socket.once('unexpected-response', (_request, response) =>
              reject(new Error(`CDP handshake answered ${response.statusCode}`))
            )
          }),
        catch: (cause) => failure(machine, `cannot attach to Chromium: ${String(cause)}`, cause)
      }),
      (socket) =>
        Effect.sync(() => {
          socket.removeAllListeners('message')
          socket.terminate()
        })
    )
    return new CdpClient(ws)
  })

// ── the session ───────────────────────────────────────────────────────────

/**
 * A page a human would recognise as a tab. `chrome://` is excluded alongside
 * `devtools://`: headless Chromium keeps internal WebUI page targets around (the
 * omnibox popup, for one) that never paint, and attaching the screencast to one of
 * them hangs `Page.startScreencast` until it times out.
 */
const isPage = (t: TargetInfo): boolean =>
  t.type === 'page' && !t.url.startsWith('devtools://') && !t.url.startsWith('chrome://')

/**
 * Open the live view of `machine`'s browser. Requires the Chromium daemon to be up
 * (`ensureBrowserDaemon` in `@taut/runtime`). Everything — two tunnels, the socket,
 * the screencast — ends with the scope.
 */
export const openBrowserSession = (
  machine: Machine,
  options: BrowserSessionOptions
): Effect.Effect<BrowserSession, MachineUnavailable | ExecFailed, Scope.Scope> =>
  Effect.gen(function* () {
    const fps = options.fps ?? SCREENCAST.fps
    const interval = Math.max(1, Math.floor(1000 / fps))
    const url = yield* discoverDebuggerUrl(machine, options.port)
    const cdp = yield* connectCdp(machine, options.port, url)
    const closed = yield* Deferred.make<void>()
    const frames = yield* Queue.sliding<LiveFrame>(2)
    yield* Effect.addFinalizer(() => Queue.shutdown(frames))
    const tabs = yield* Queue.sliding<TerminalBrowserTabs>(1)
    yield* Effect.addFinalizer(() => Queue.shutdown(tabs))
    const pages = new Map<string, TargetInfo>()
    let agentTarget: string | undefined
    let viewerTarget: string | undefined
    const readAgentTarget = async () => {
      try {
        return (
          (
            await readFile(join(machine.paths.hostHome, BROWSER_PATHS.activeTarget), 'utf8')
          ).trim() || undefined
        )
      } catch {
        return undefined
      }
    }

    // ── the page on screen ────────────────────────────────────────────────
    let current: { targetId: string; sessionId: string } | undefined
    let viewport: ScreencastMetadata = { deviceWidth: 1280, deviceHeight: 720 }
    let switching: Promise<void> = Promise.resolve()
    let requestedViewport: BrowserViewport | undefined

    const call = (method: string, params?: Record<string, unknown>, sessionId?: string) =>
      cdp.send(method, params, sessionId)

    const applyViewport = async (sessionId: string) => {
      if (requestedViewport === undefined) return
      await call(
        'Emulation.setDeviceMetricsOverride',
        {
          ...requestedViewport,
          deviceScaleFactor: 1,
          mobile: false
        },
        sessionId
      )
    }

    const publishTabs = () =>
      Queue.unsafeOffer(tabs, {
        _tag: 'tabs',
        following: viewerTarget === undefined,
        tabs: [...pages.values()].map(({ targetId, title, url }) => ({
          id: targetId,
          title: title ?? '',
          url
        })),
        activeTabId: current?.targetId ?? null
      })

    const attachTo = async (targetId: string): Promise<void> => {
      const attached = (await call('Target.attachToTarget', { targetId, flatten: true })) as {
        sessionId: string
      }
      current = { targetId, sessionId: attached.sessionId }
      publishTabs()
      await applyViewport(attached.sessionId)
      // Observe the agent's page without activating it: a viewer must never change
      // browser focus or compete with the agent's tab selection.
      await call(
        'Page.startScreencast',
        {
          format: SCREENCAST.format,
          quality: SCREENCAST.quality,
          maxWidth: SCREENCAST.maxWidth,
          maxHeight: SCREENCAST.maxHeight,
          everyNthFrame: 1
        },
        attached.sessionId
      )
    }

    const pickPage = async (): Promise<string> => {
      const { targetInfos } = (await call('Target.getTargets')) as {
        targetInfos: Array<TargetInfo>
      }
      pages.clear()
      for (const info of targetInfos.filter(isPage)) pages.set(info.targetId, info)
      agentTarget = await readAgentTarget()
      if (agentTarget && pages.has(agentTarget)) return agentTarget
      // TargetInfo has no active-tab flag. Query visibility without changing focus;
      // temporary sessions are detached immediately and never start a screencast.
      for (const info of pages.values()) {
        let sessionId = current?.targetId === info.targetId ? current.sessionId : undefined
        const temporary = sessionId === undefined
        try {
          if (sessionId === undefined) {
            sessionId = (
              (await call('Target.attachToTarget', {
                targetId: info.targetId,
                flatten: true
              })) as { sessionId: string }
            ).sessionId
          }
          const result = (await call(
            'Runtime.evaluate',
            {
              expression: 'document.visibilityState === "visible"',
              returnByValue: true,
              silent: true
            },
            sessionId
          )) as { result?: { value?: unknown } }
          if (result.result?.value === true) return info.targetId
        } catch {
          // A page may navigate or close while its visibility is being queried.
        } finally {
          if (temporary && sessionId !== undefined) {
            await call('Target.detachFromTarget', { sessionId }).catch(() => {})
          }
        }
      }
      const last = [...pages.values()].at(-1)
      if (last !== undefined) return last.targetId
      const created = (await call('Target.createTarget', { url: 'about:blank' })) as {
        targetId: string
      }
      return created.targetId
    }

    /**
     * `Target.setDiscoverTargets` announces every target that already exists as a
     * `Target.targetCreated` before it answers. Those are not new pages, and treating
     * them as such made the session detach and re-attach once per existing tab —
     * headless Chromium keeps several — which orphaned the `Page.startScreencast`
     * still in flight on a session that had just been detached, so it never answered
     * and the live view died with a timeout. Events are only acted on once the burst
     * is over.
     */
    let discovering = true

    const switchTo = (targetId: string | undefined): void => {
      switching = switching
        .then(async () => {
          const id =
            viewerTarget && pages.has(viewerTarget)
              ? viewerTarget
              : agentTarget && pages.has(agentTarget)
                ? agentTarget
                : (targetId ?? (await pickPage()))
          if (current?.targetId === id) {
            publishTabs()
            return
          }
          if (current !== undefined) {
            await call('Target.detachFromTarget', { sessionId: current.sessionId }).catch(() => {})
            current = undefined
          }
          latest = undefined
          await attachTo(id)
        })
        .catch(() => {
          // the target vanished mid-switch; the next Target event picks another
        })
    }

    // ── frames: ack at once, forward at ≤ fps (latest wins) ───────────────
    let lastSent = 0
    let latest: LiveFrame | undefined
    let timer: NodeJS.Timeout | undefined
    const flush = () => {
      timer = undefined
      if (latest === undefined) return
      lastSent = Date.now()
      Queue.unsafeOffer(frames, latest)
      latest = undefined
    }
    const onFrame = (frame: LiveFrame) => {
      latest = frame
      const due = lastSent + interval - Date.now()
      if (due <= 0) flush()
      else if (timer === undefined) timer = setTimeout(flush, due)
    }
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (timer !== undefined) clearTimeout(timer)
      })
    )

    cdp.events.push((event) => {
      switch (event.method) {
        case 'Page.screencastVisibilityChanged': {
          // Chrome emits this when the agent selects another tab, even when neither
          // URL changes. Find the newly visible page instead of bringing ours forward.
          if (event.sessionId === current?.sessionId && event.params['visible'] === false) {
            switchTo(undefined)
          }
          return
        }
        case 'Page.screencastFrame': {
          if (event.sessionId !== current?.sessionId) return
          const params = event.params as {
            data: string
            metadata: ScreencastMetadata
            sessionId: number
          }
          void call(
            'Page.screencastFrameAck',
            { sessionId: params.sessionId },
            event.sessionId
          ).catch(() => {})
          viewport = params.metadata
          onFrame({
            data: params.data,
            width: Math.round(params.metadata.deviceWidth),
            height: Math.round(params.metadata.deviceHeight)
          })
          return
        }
        case 'Target.targetCreated': {
          const info = event.params['targetInfo'] as TargetInfo
          if (!isPage(info)) return
          pages.set(info.targetId, info)
          if (!discovering) {
            publishTabs()
            switchTo(info.targetId)
          }
          return
        }
        case 'Target.targetInfoChanged': {
          const info = event.params['targetInfo'] as TargetInfo
          if (!isPage(info)) return
          const previous = pages.get(info.targetId)
          pages.set(info.targetId, info)
          if (!discovering) {
            publishTabs()
            // A navigation on an existing tab means the agent returned to it.
            // Title/loading changes on a background page only refresh its label.
            if (previous !== undefined && previous.url !== info.url) switchTo(info.targetId)
          }
          return
        }
        case 'Target.targetDestroyed': {
          pages.delete(String(event.params['targetId']))
          if (viewerTarget === event.params['targetId']) viewerTarget = undefined
          if (event.params['targetId'] === current?.targetId) {
            current = undefined
            switchTo(undefined)
          }
          publishTabs()
          return
        }
        case 'Target.detachedFromTarget': {
          if (event.params['sessionId'] === current?.sessionId) {
            current = undefined
            switchTo(undefined)
          }
          return
        }
      }
    })

    yield* Effect.tryPromise({
      try: async () => {
        await call('Target.setDiscoverTargets', { discover: true })
        discovering = false
        await attachTo(await pickPage())
      },
      catch: (cause) => failure(machine, `cannot start the screencast: ${String(cause)}`, cause)
    })

    // Headless Chromium reports every page as visible and does not emit a tab
    // visibility event. The MCP bridge records the actual tool-selected target.
    yield* Effect.promise(async () => {
      const target = await readAgentTarget()
      if (target && target !== agentTarget) {
        agentTarget = target
        if (pages.has(target)) switchTo(target)
      }
    }).pipe(Effect.repeat({ schedule: Schedule.spaced('250 millis') }), Effect.forkScoped)

    // Chromium gone (or the box stopped) → the stream ends, the caller reports it.
    cdp.ws.once('close', () => {
      Deferred.unsafeDone(closed, Exit.void)
      Queue.unsafeOffer(frames, END)
    })

    const dispatch = (event: BrowserInputEvent): Effect.Effect<void> =>
      Effect.promise(async () => {
        const session = current?.sessionId
        if (session === undefined) return
        try {
          if (event._tag === 'mouse') {
            await call(
              'Input.dispatchMouseEvent',
              {
                type: event.type,
                x: Math.round(event.x * viewport.deviceWidth),
                y: Math.round(event.y * viewport.deviceHeight),
                button: event.button ?? 'none',
                clickCount: event.clickCount ?? 0,
                ...(event.deltaX === undefined ? {} : { deltaX: event.deltaX }),
                ...(event.deltaY === undefined ? {} : { deltaY: event.deltaY }),
                modifiers: event.modifiers ?? 0
              },
              session
            )
          } else {
            await call(
              'Input.dispatchKeyEvent',
              {
                type: event.type,
                key: event.key,
                code: event.code,
                ...(event.text === undefined ? {} : { text: event.text }),
                ...(event.keyCode === undefined
                  ? {}
                  : { windowsVirtualKeyCode: event.keyCode, nativeVirtualKeyCode: event.keyCode }),
                modifiers: event.modifiers ?? 0
              },
              session
            )
          }
        } catch {
          // D17: a refused event is dropped without a trace of what it was
        }
      })

    const resize = (size: BrowserViewport): Effect.Effect<void> =>
      Effect.promise(async () => {
        requestedViewport = { width: size.width, height: size.height }
        // Share the tab-switch queue so a resize cannot land on a detached page.
        switching = switching
          .then(async () => {
            if (current !== undefined) await applyViewport(current.sessionId)
          })
          .catch(() => {})
        await switching
      })

    const selectTab = (tabId: string | null): Effect.Effect<void> =>
      Effect.promise(async () => {
        if (tabId !== null && !pages.has(tabId)) return
        viewerTarget = tabId ?? undefined
        if (tabId === null) agentTarget = await readAgentTarget()
        switchTo(tabId ?? undefined)
        await switching
      })

    return {
      selectTab,
      resize,
      frames: Stream.fromQueue(frames).pipe(Stream.takeWhile((frame) => frame !== END)),
      tabs: Stream.fromQueue(tabs).pipe(Stream.interruptWhen(Deferred.await(closed))),
      dispatch,
      closed: Deferred.await(closed)
    }
  })

/** End-of-stream sentinel for the frame queue (a frame no page produces). */
const END: LiveFrame = { data: '', width: -1, height: -1 }
