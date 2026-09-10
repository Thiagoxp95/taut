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
  let failures = 0
  let firstFrameTimer: ReturnType<typeof setTimeout> | undefined
  let disconnect = () => {}

  const retry = () => {
    if (disposed || timer !== undefined) return
    timer = setTimeout(() => {
      timer = undefined
      connect()
    }, delay)
    delay = Math.min(delay * 2, 10_000)
  }
  const unavailable = (reason: string, terminal = false) => {
    if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer)
    firstFrameTimer = undefined
    // Keep short startup races in the loading state. Persistent failures remain
    // visible with their reason and can also be retried explicitly by the viewer.
    if (timer === undefined) failures++
    receive({ _tag: 'control', holder: null, paused: false, owned: false })
    receive(
      terminal || failures >= 3
        ? { _tag: 'browser', state: 'unavailable', reason }
        : { _tag: 'browser', state: 'starting' }
    )
    if (terminal) {
      if (timer !== undefined) clearTimeout(timer)
      timer = undefined
    } else retry()
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
        if (frame.state === 'unavailable') {
          unavailable(frame.reason ?? 'The browser connection was lost.')
          return
        }
        receive(frame)
        if (frame.state === 'live') {
          if (viewport) socket.send({ _tag: 'viewport', ...viewport })
        }
        if (frame.state === 'off') {
          if (timer !== undefined) clearTimeout(timer)
          timer = undefined
          if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer)
          firstFrameTimer = undefined
        }
      }),
      socket.on('frame', (frame) => {
        delay = 1000
        failures = 0
        if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer)
        firstFrameTimer = undefined
        if (timer !== undefined) clearTimeout(timer)
        timer = undefined
        receive(frame)
      }),
      socket.onState((state, closed) => {
        if (state !== 'closed') return
        unavailable(
          closed?.reason || 'The browser connection was lost.',
          closed?.code === 4401 || closed?.code === 4403
        )
      })
    ]
    firstFrameTimer = setTimeout(() => unavailable('The browser did not send a picture.'), 30_000)
    disconnect = () => {
      if (firstFrameTimer !== undefined) clearTimeout(firstFrameTimer)
      firstFrameTimer = undefined
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
