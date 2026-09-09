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
  readonly emitFrame: (data: string) => void
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

    const emitFrame = (data: string): void => {
      frameSeq += 1
      emitted.push(data)
      const event = JSON.stringify({
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
      })
      for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(event)
    }

    const answer = (
      ws: WebSocket,
      id: number,
      call: CdpCall
    ): { result: Record<string, unknown> } | { error: { message: string } } => {
      switch (call.method) {
        case 'Target.setDiscoverTargets':
        case 'Page.screencastFrameAck':
        case 'Target.detachFromTarget':
        case 'Input.dispatchMouseEvent':
        case 'Input.dispatchKeyEvent':
          return { result: {} }
        case 'Target.getTargets':
          return {
            result: {
              targetInfos: [
                { targetId: TARGET_ID, type: 'page', url: 'https://example.com/', attached: false }
              ]
            }
          }
        case 'Target.attachToTarget':
          return { result: { sessionId: ATTACHED_SESSION } }
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
      ws.on('close', () => sockets.delete(ws))
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
