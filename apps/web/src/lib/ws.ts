/**
 * Realtime client for the Taut event stream (`docs/agent-model.md` §8).
 *
 * The server replays every event with `seq > since` on connect, so the only
 * state we must survive a reload with is `lastSeq` — kept per company, because
 * the sequence is per company and switching resets it. With no `lastSeq` to send
 * the server answers `resync` instead: a first login takes the head and refetches
 * over HTTP rather than reliving the whole log one event at a time.
 */
import type { ClientSocketMessage, CompanyId, Event, EventSeq } from '@taut/contract'
import { ServerSocketMessage } from '@taut/contract'
import { Either, Schema } from 'effect'

export type ConnectionStatus = 'connecting' | 'open' | 'reconnecting' | 'offline'

type EventListener = (event: Event) => void
type StatusListener = (status: ConnectionStatus) => void
type ResyncListener = (head: EventSeq) => void

const LAST_SEQ_PREFIX = 'taut.lastSeq.'
const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 30_000
/** After this many failed attempts we stop calling it a blip. */
const OFFLINE_AFTER_ATTEMPTS = 4

const decodeFrame = Schema.decodeUnknownEither(ServerSocketMessage)

function readLastSeq(companyId: string): number {
  try {
    const raw = localStorage.getItem(LAST_SEQ_PREFIX + companyId)
    if (raw === null) return 0
    const parsed = Number.parseInt(raw, 10)
    return Number.isFinite(parsed) && parsed > 0 ? parsed : 0
  } catch {
    return 0
  }
}

function writeLastSeq(companyId: string, seq: number): void {
  try {
    localStorage.setItem(LAST_SEQ_PREFIX + companyId, String(seq))
  } catch {
    /* private mode — resume degrades to "from now on" */
  }
}

export class RealtimeClient {
  #socket: WebSocket | null = null
  #listeners = new Set<EventListener>()
  #statusListeners = new Set<StatusListener>()
  #resyncListeners = new Set<ResyncListener>()
  #status: ConnectionStatus = 'offline'
  #attempt = 0
  #timer: ReturnType<typeof setTimeout> | null = null
  #stopped = true
  #companyId: string | null = null
  #lastSeq = 0
  #snapshotListeners = new Set<() => void>()

  constructor() {
    this.subscribeSnapshot = this.subscribeSnapshot.bind(this)
    this.getStatus = this.getStatus.bind(this)
    this.getLastSeq = this.getLastSeq.bind(this)
  }

  /** `useSyncExternalStore` bridge: status and seq both live outside React. */
  subscribeSnapshot(listener: () => void): () => void {
    this.#snapshotListeners.add(listener)
    return () => {
      this.#snapshotListeners.delete(listener)
    }
  }

  getStatus(): ConnectionStatus {
    return this.#status
  }

  getLastSeq(): number {
    return this.#lastSeq
  }

  #notifySnapshot(): void {
    for (const listener of this.#snapshotListeners) listener()
  }

  get status(): ConnectionStatus {
    return this.#status
  }

  get lastSeq(): number {
    return this.#lastSeq
  }

  get companyId(): string | null {
    return this.#companyId
  }

  /** Open (or re-point) the socket at a company. Idempotent per company. */
  connect(companyId: CompanyId | string): void {
    if (this.#companyId === companyId && !this.#stopped) return
    this.#companyId = companyId
    this.#lastSeq = readLastSeq(companyId)
    this.#notifySnapshot()
    this.#restart()
  }

  /** After a company switch: forget the old company's cursor and open at that one's head. */
  reset(companyId: CompanyId | string): void {
    this.#companyId = companyId
    this.#lastSeq = 0
    writeLastSeq(companyId, 0)
    this.#notifySnapshot()
    this.#restart()
  }

  close(): void {
    this.#stopped = true
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const socket = this.#socket
    this.#socket = null
    socket?.close()
    this.#setStatus('offline')
  }

  subscribe(fn: EventListener): () => void {
    this.#listeners.add(fn)
    return () => {
      this.#listeners.delete(fn)
    }
  }

  onStatus(fn: StatusListener): () => void {
    this.#statusListeners.add(fn)
    fn(this.#status)
    return () => {
      this.#statusListeners.delete(fn)
    }
  }

  /** The client's `since` predates the retained log: the caller must reload. */
  onResync(fn: ResyncListener): () => void {
    this.#resyncListeners.add(fn)
    return () => {
      this.#resyncListeners.delete(fn)
    }
  }

  /** Client → server frames. Dropped while disconnected. */
  send(frame: ClientSocketMessage): void {
    if (this.#socket?.readyState === WebSocket.OPEN) {
      this.#socket.send(JSON.stringify(frame))
    }
  }

  #restart(): void {
    if (this.#timer !== null) {
      clearTimeout(this.#timer)
      this.#timer = null
    }
    const socket = this.#socket
    this.#socket = null
    socket?.close()
    this.#attempt = 0
    this.#stopped = false
    this.#open()
  }

  #url(): string {
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    // No stored cursor means there is nothing to catch up on. Omitting `since` asks for a
    // `resync` (head + refetch) rather than a replay of the company's whole log.
    const query = this.#lastSeq > 0 ? `?since=${this.#lastSeq}` : ''
    return `${protocol}//${window.location.host}/ws${query}`
  }

  #open(): void {
    if (this.#stopped || this.#companyId === null) return
    this.#setStatus(this.#attempt === 0 ? 'connecting' : 'reconnecting')

    let socket: WebSocket
    try {
      socket = new WebSocket(this.#url())
    } catch {
      this.#scheduleReconnect()
      return
    }
    this.#socket = socket

    socket.addEventListener('open', () => {
      this.#attempt = 0
      this.#setStatus('open')
    })

    socket.addEventListener('message', (message: MessageEvent<string>) => {
      this.#receive(message.data)
    })

    socket.addEventListener('close', () => {
      if (this.#socket === socket) this.#socket = null
      this.#scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      socket.close()
    })
  }

  #receive(data: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(data) as unknown
    } catch {
      return
    }

    const decoded = decodeFrame(parsed)
    if (Either.isLeft(decoded)) {
      // An unknown frame must never take the socket down.
      console.warn('[taut] dropped an unreadable /ws frame', decoded.left.message)
      return
    }
    const frame = decoded.right

    if (frame.type === 'pong') return

    if (frame.type === 'resync') {
      // A cursor we had is now known to be stale, so the caches built from it must go.
      // A cold connect gets the same frame with nothing to throw away.
      const hadCursor = this.#lastSeq > 0
      this.#lastSeq = frame.head
      if (this.#companyId !== null) writeLastSeq(this.#companyId, frame.head)
      this.#notifySnapshot()
      if (hadCursor) for (const listener of this.#resyncListeners) listener(frame.head)
      return
    }

    const event = frame.event
    // `typing` is ephemeral and carries the current head, not its own seq.
    if (event.type !== 'typing' && event.seq > this.#lastSeq) {
      this.#lastSeq = event.seq
      if (this.#companyId !== null) writeLastSeq(this.#companyId, event.seq)
      this.#notifySnapshot()
    }
    for (const listener of this.#listeners) listener(event)
  }

  #scheduleReconnect(): void {
    if (this.#stopped) return
    this.#attempt += 1
    this.#setStatus(this.#attempt >= OFFLINE_AFTER_ATTEMPTS ? 'offline' : 'reconnecting')

    const exponential = Math.min(BASE_DELAY_MS * 2 ** (this.#attempt - 1), MAX_DELAY_MS)
    const jitter = Math.random() * exponential * 0.3
    this.#timer = setTimeout(() => {
      this.#timer = null
      this.#open()
    }, exponential + jitter)
  }

  #setStatus(status: ConnectionStatus): void {
    if (this.#status === status) return
    this.#status = status
    for (const listener of this.#statusListeners) listener(status)
    this.#notifySnapshot()
  }
}

/** One socket per tab. */
export const realtime = new RealtimeClient()
