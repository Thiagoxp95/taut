import type { TerminalServerFrame } from '@taut/contract/terminal'
import { afterEach, expect, it, vi } from 'vitest'
import { connectBrowserPreview } from '../../web/src/lib/browser-preview-connection'

const makeSocket = () => {
  let state: (
    state: 'connecting' | 'open' | 'closed',
    closed?: { code: number; reason: string }
  ) => void = () => {}
  const listeners = new Map<string, (frame: never) => void>()
  return {
    on: (tag: string, listener: (frame: never) => void) => {
      listeners.set(tag, listener)
      return () => {
        listeners.delete(tag)
      }
    },
    onState: (listener: typeof state) => {
      state = listener
      return () => {
        state = () => {}
      }
    },
    send: () => {},
    close: () => state('closed', { code: 1000, reason: 'viewer left' }),
    emit: (tag: string, frame: TerminalServerFrame) => listeners.get(tag)?.(frame as never),
    disconnect: (code = 1006) => state('closed', { code, reason: '' })
  }
}
afterEach(() => vi.useRealTimers())
it('recovers from startup failure and lost sockets without a reconnect click; stops on disposal', () => {
  vi.useFakeTimers()
  const sockets: ReturnType<typeof makeSocket>[] = []
  const frames: unknown[] = []
  const connection = connectBrowserPreview(
    () => {
      const socket = makeSocket()
      sockets.push(socket)
      return socket
    },
    (frame) => frames.push(frame)
  )
  sockets[0]!.emit('browser', { _tag: 'browser', state: 'unavailable', reason: 'Starting up' })
  vi.advanceTimersByTime(1000)
  expect(sockets).toHaveLength(2)
  sockets[1]!.emit('frame', { _tag: 'frame', data: 'new-page', width: 10, height: 10 })
  expect(frames).toContainEqual({ _tag: 'frame', data: 'new-page', width: 10, height: 10 })
  sockets[1]!.disconnect()
  vi.advanceTimersByTime(1000)
  expect(sockets).toHaveLength(3)
  sockets[2]!.disconnect()
  connection.close()
  vi.advanceTimersByTime(30000)
  expect(sockets).toHaveLength(3)
})
it('does not retry authorization failures', () => {
  vi.useFakeTimers()
  const sockets: ReturnType<typeof makeSocket>[] = []
  const connection = connectBrowserPreview(
    () => {
      const socket = makeSocket()
      sockets.push(socket)
      return socket
    },
    () => {}
  )
  sockets[0]!.disconnect(4403)
  vi.advanceTimersByTime(30000)
  expect(sockets).toHaveLength(1)
  connection.close()
})

it('keeps transient first-launch failures in connecting state and recovers a live socket with no picture', () => {
  vi.useFakeTimers()
  const sockets: ReturnType<typeof makeSocket>[] = []
  const frames: TerminalServerFrame[] = []
  const connection = connectBrowserPreview(
    () => {
      const socket = makeSocket()
      sockets.push(socket)
      return socket
    },
    (frame) => frames.push(frame)
  )
  sockets[0]!.emit('browser', { _tag: 'browser', state: 'unavailable', reason: 'Starting up' })
  expect(frames.at(-1)).toMatchObject({ _tag: 'browser', state: 'starting' })
  vi.advanceTimersByTime(1000)
  sockets[1]!.emit('browser', { _tag: 'browser', state: 'live' })
  vi.advanceTimersByTime(35000)
  expect(sockets.length).toBeGreaterThan(2)
  sockets.at(-1)!.emit('frame', { _tag: 'frame', data: 'page', width: 10, height: 10 })
  const connected = sockets.length
  vi.advanceTimersByTime(60000)
  expect(sockets).toHaveLength(connected)
  connection.close()
})

it('shows persistent failures and cancels an already scheduled retry when authorization is refused', () => {
  vi.useFakeTimers()
  const sockets: ReturnType<typeof makeSocket>[] = []
  const frames: TerminalServerFrame[] = []
  const connection = connectBrowserPreview(
    () => {
      const socket = makeSocket()
      sockets.push(socket)
      return socket
    },
    (frame) => frames.push(frame)
  )
  for (const delay of [1000, 2000]) {
    sockets
      .at(-1)!
      .emit('browser', { _tag: 'browser', state: 'unavailable', reason: 'Cannot launch' })
    vi.advanceTimersByTime(delay)
  }
  sockets
    .at(-1)!
    .emit('browser', { _tag: 'browser', state: 'unavailable', reason: 'Cannot launch' })
  expect(frames.at(-1)).toMatchObject({ state: 'unavailable', reason: 'Cannot launch' })
  sockets.at(-1)!.disconnect(4403)
  vi.advanceTimersByTime(60000)
  expect(sockets).toHaveLength(3)
  connection.close()
})
