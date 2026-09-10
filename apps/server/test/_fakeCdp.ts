/**
 * A fake Chromium debug endpoint for the live-view tests (docs/build-plan-workspace.md
 * D11, D12): `/json/version` over HTTP plus a CDP WebSocket that understands exactly
 * the handful of methods `services/browserLive.ts` sends, records every call, and
 * emits a scripted burst of `Page.screencastFrame` events when the screencast starts.
 * The fake runtime's `openTunnel` hands the server a plain TCP socket to it — the
 * same shape the docker relay produces.
 */
import * as http from 'node:http'
import { type AddressInfo, connect } from 'node:net'
import { WebSocket, WebSocketServer } from 'ws'

export interface CdpCall {
  readonly method: string
  readonly params: Record<string, unknown>
  readonly sessionId?: string
}

export interface FakeCdp {
  readonly port: number
  /** Every method call, in order. */
  readonly calls: Array<CdpCall>
  /** Base64 payloads emitted as frames, in order. */
  readonly emitted: Array<string>
  /** Sockets (`/json/version` + CDP) accepted so far. */
  connections: number
  /** Push one more frame to the attached page right now. */
  readonly emitFrame: (data: string, targetId?: string) => void
  readonly createPage: (id: string, title: string, url: string) => void
  readonly updatePage: (id: string, title: string, url: string) => void
  readonly closePage: (id: string) => void
  readonly selectPage: (id: string) => void
  /** A `net.Socket` to the fake, for `openTunnel`. */
  readonly tunnel: () => import('node:net').Socket
  readonly close: () => Promise<void>
}

export interface FakeCdpOptions {
  /** Frames emitted back to back as soon as `Page.startScreencast` arrives. */
  readonly burst?: number
}

const TARGET_ID = 'page-1'
const ATTACHED_SESSION = 'session-1'

export const startFakeCdp = (options: FakeCdpOptions = {}): Promise<FakeCdp> =>
  new Promise((resolve) => {
    const calls: Array<CdpCall> = []
    const emitted: Array<string> = []
    const sockets = new Set<WebSocket>()
    let frameSeq = 0
    let activeTargetId = TARGET_ID
    const pages = new Map([
      [
        TARGET_ID,
        {
          targetId: TARGET_ID,
          type: 'page',
          title: 'Example',
          url: 'https://example.com/',
          attached: false
        }
      ]
    ])
    const sessions = new Map<WebSocket, Map<string, string>>()
    const emitTarget = (method: string, params: Record<string, unknown>) => {
      for (const ws of sockets)
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ method, params }))
    }

    const server = http.createServer((req, res) => {
      if (req.url === '/json/version') {
        const { port } = server.address() as AddressInfo
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            Browser: 'Chrome/fake',
            webSocketDebuggerUrl: `ws://127.0.0.1:${port}/devtools/browser/fake`
          })
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    const wss = new WebSocketServer({ noServer: true })

    const emitFrame = (data: string, targetId = TARGET_ID): void => {
      frameSeq += 1
      emitted.push(data)
      const event = {
        method: 'Page.screencastFrame',
        sessionId: ATTACHED_SESSION,
        params: {
          data,
          metadata: {
            deviceWidth: 1280,
            deviceHeight: 720,
            pageScaleFactor: 1,
            offsetTop: 0,
            scrollOffsetX: 0,
            scrollOffsetY: 0,
            timestamp: Date.now() / 1000
          },
          sessionId: frameSeq
        }
      }
      for (const ws of sockets) {
        const sessionId = [...(sessions.get(ws)?.entries() ?? [])].find(
          ([, id]) => id === targetId
        )?.[0]
        if (ws.readyState === WebSocket.OPEN && sessionId)
          ws.send(JSON.stringify({ ...event, sessionId }))
      }
    }

    const answer = (
      ws: WebSocket,
      id: number,
      call: CdpCall
    ): { result: Record<string, unknown> } | { error: { message: string } } => {
      switch (call.method) {
        case 'Runtime.evaluate':
          return {
            result: {
              result: {
                type: 'boolean',
                value: sessions.get(ws)?.get(call.sessionId ?? '') === activeTargetId
              }
            }
          }
        case 'Target.setDiscoverTargets':
        case 'Page.screencastFrameAck':
        case 'Input.dispatchMouseEvent':
        case 'Input.dispatchKeyEvent':
          return { result: {} }
        case 'Target.getTargets':
          return {
            result: {
              targetInfos: [...pages.values()]
            }
          }
        case 'Target.attachToTarget': {
          const targetId = String(call.params['targetId'])
          if (!pages.has(targetId)) return { error: { message: 'No such target' } }
          const sessionId = targetId === TARGET_ID ? ATTACHED_SESSION : `session-${targetId}`
          sessions.get(ws)!.set(sessionId, targetId)
          return { result: { sessionId } }
        }
        case 'Target.detachFromTarget':
          sessions.get(ws)!.delete(String(call.params['sessionId']))
          return { result: {} }
        case 'Page.startScreencast': {
          setTimeout(() => {
            for (let i = 0; i < (options.burst ?? 0); i++) {
              emitFrame(Buffer.from(`jpeg-${i + 1}`).toString('base64'))
            }
          }, 10)
          void ws
          void id
          return { result: {} }
        }
        default:
          return { error: { message: `fake CDP: unknown method ${call.method}` } }
      }
    }

    wss.on('connection', (ws) => {
      sockets.add(ws)
      sessions.set(ws, new Map())
      ws.on('close', () => {
        sockets.delete(ws)
        sessions.delete(ws)
      })
      ws.on('message', (raw) => {
        const message = JSON.parse(raw.toString()) as {
          id: number
          method: string
          params?: Record<string, unknown>
          sessionId?: string
        }
        const call: CdpCall = {
          method: message.method,
          params: message.params ?? {},
          ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId })
        }
        calls.push(call)
        ws.send(JSON.stringify({ id: message.id, ...answer(ws, message.id, call) }))
      })
    })
    server.on('upgrade', (req, socket, head) => {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req))
    })

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo
      const fake: FakeCdp = {
        port,
        calls,
        emitted,
        connections: 0,
        emitFrame,
        selectPage: (id) => {
          const previous = activeTargetId
          activeTargetId = id
          for (const ws of sockets) {
            for (const [sessionId, targetId] of sessions.get(ws) ?? []) {
              if (targetId === previous || targetId === id)
                ws.send(
                  JSON.stringify({
                    method: 'Page.screencastVisibilityChanged',
                    sessionId,
                    params: { visible: targetId === id }
                  })
                )
            }
          }
        },
        createPage: (id, title, url) => {
          activeTargetId = id
          const targetInfo = { targetId: id, type: 'page', title, url, attached: false }
          pages.set(id, targetInfo)
          emitTarget('Target.targetCreated', { targetInfo })
        },
        updatePage: (id, title, url) => {
          const targetInfo = { targetId: id, type: 'page', title, url, attached: false }
          pages.set(id, targetInfo)
          emitTarget('Target.targetInfoChanged', { targetInfo })
        },
        closePage: (id) => {
          pages.delete(id)
          if (activeTargetId === id) activeTargetId = [...pages.keys()].at(-1) ?? ''
          emitTarget('Target.targetDestroyed', { targetId: id })
        },
        tunnel: () => {
          fake.connections += 1
          return connect(port, '127.0.0.1')
        },
        close: () =>
          new Promise((done) => {
            for (const ws of sockets) ws.terminate()
            wss.close(() => server.close(() => done()))
          })
      }
      resolve(fake)
    })
  })
