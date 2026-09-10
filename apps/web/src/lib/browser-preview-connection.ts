import type {
  BrowserViewport,
  TerminalClientFrame,
  TerminalServerFrame
} from '@taut/contract/terminal'
interface PreviewSocket {
  on<T extends TerminalServerFrame['_tag']>(
    tag: T,
    listener: (frame: Extract<TerminalServerFrame, { _tag: T }>) => void
  ): () => void
  onState(
    listener: (
      state: 'connecting' | 'open' | 'closed',
      closed?: { code: number; reason: string }
    ) => void
  ): () => void
  send(frame: TerminalClientFrame): void
  close(): void
}

/** Owns just a visible conversation preview. Disposing it cancels every retry. */
export function connectBrowserPreview(
  createSocket: () => PreviewSocket,
  receive: (frame: TerminalServerFrame) => void
) {
  let current: PreviewSocket | undefined
  let viewport: BrowserViewport | undefined
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let delay = 1000
  let disconnect = () => {}

  const retry = () => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      connect()
    }, delay)
    delay = Math.min(delay * 2, 10_000)
  }
  const connect = () => {
    disconnect()
    if (disposed) return
    receive({ _tag: 'control', holder: null, paused: false, owned: false })
    receive({ _tag: 'browser', state: 'starting' })
    const socket = createSocket()
    current = socket
    const off = [
      socket.on('tabs', receive),
      socket.on('control', receive),
      socket.on('error', receive),
      socket.on('browser', (frame) => {
        receive(frame)
        if (frame.state === 'live' && viewport) socket.send({ _tag: 'viewport', ...viewport })
        if (frame.state === 'unavailable') retry()
        if (frame.state === 'off' && timer !== undefined) {
          clearTimeout(timer)
          timer = undefined
        }
      }),
      socket.on('frame', (frame) => {
        delay = 1000
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        receive(frame)
      }),
      socket.onState((state, closed) => {
        if (state !== 'closed') return
        receive({
          _tag: 'browser',
          state: 'unavailable',
          reason: closed?.reason || 'The browser connection was lost.'
        })
        // Authentication/authorization failures need user action, not a retry loop.
        if (closed?.code !== 4401 && closed?.code !== 4403) retry()
      })
    ]
    disconnect = () => {
      off.forEach((unsubscribe) => unsubscribe())
      current = undefined
      socket.close()
    }
  }
  connect()
  return {
    resize(size: BrowserViewport) {
      viewport = size
      if (!disposed) current?.send({ _tag: 'viewport', ...size })
    },
    send(frame: TerminalClientFrame) {
      if (!disposed) current?.send(frame)
    },
    close() {
      disposed = true
      if (timer !== undefined) clearTimeout(timer)
      disconnect()
    }
  }
}
