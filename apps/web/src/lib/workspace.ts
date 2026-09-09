/**
 * The agent Workspace tab's data and its socket (docs/build-plan-workspace.md):
 *
 * - machine control and the process list over the typed client (D5, D13), as hooks
 *   in the shape of `lib/api.ts`;
 * - `WorkspaceSocket`, the one `/ws/terminal` connection a viewer holds per agent
 *   (D6). It carries the PTY, the browser live view and take-control on the same
 *   socket (D7, D11, D12); frames are the contract's `terminal.ts` schemas, decoded
 *   on arrival so a bad frame is dropped, never rendered.
 *
 * `data` travels as base64 both ways (D7) — helpers below convert without going
 * through a JS string, so a multi-byte sequence split across chunks survives.
 */
import { useQueryClient, type UseQueryResult } from '@tanstack/react-query'
import type { AgentId, MachineInfo, ProcessEntry } from '@taut/contract'
import {
  TERMINAL_WS_PATH,
  TerminalServerFrame,
  type TerminalClientFrame
} from '@taut/contract/terminal'
import { Either, Schema } from 'effect'

import { call, type ApiError } from '@/lib/api-client'
import { useEffectMutation, useEffectQuery } from '@/lib/runtime'

// --- query keys ------------------------------------------------------------

export const wk = {
  machine: (agentId: string) => ['agents', agentId, 'machine'] as const,
  processes: (agentId: string) => ['agents', agentId, 'processes'] as const
}

/** D13: the Processes pane polls this often, and only while it is on screen. */
export const PROCESS_POLL_MS = 3_000

// --- machine (D5) ----------------------------------------------------------

export function useMachineInfo(
  agentId: AgentId | undefined
): UseQueryResult<MachineInfo, ApiError> {
  return useEffectQuery<MachineInfo>(
    wk.machine(agentId ?? 'none'),
    call((api) => api.agents.getMachine({ path: { agentId: agentId as AgentId } })),
    { enabled: agentId !== undefined, staleTime: 5_000 }
  )
}

function useMachineInvalidation() {
  const queryClient = useQueryClient()
  return (agentId: AgentId) => {
    void queryClient.invalidateQueries({ queryKey: wk.machine(agentId) })
    void queryClient.invalidateQueries({ queryKey: wk.processes(agentId) })
  }
}

export function useStartMachine() {
  const invalidate = useMachineInvalidation()
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { agentId: AgentId }) =>
      call((api) => api.agents.startMachine({ path: { agentId: input.agentId } })),
    {
      onSuccess: (info, input) => {
        queryClient.setQueryData(wk.machine(input.agentId), info)
        invalidate(input.agentId)
      }
    }
  )
}

export function useStopMachine() {
  const invalidate = useMachineInvalidation()
  const queryClient = useQueryClient()
  return useEffectMutation(
    (input: { agentId: AgentId }) =>
      call((api) => api.agents.stopMachine({ path: { agentId: input.agentId } })),
    {
      onSuccess: (info, input) => {
        queryClient.setQueryData(wk.machine(input.agentId), info)
        invalidate(input.agentId)
      }
    }
  )
}

// --- processes (D13) -------------------------------------------------------

export function useProcesses(
  agentId: AgentId | undefined,
  enabled: boolean
): UseQueryResult<ReadonlyArray<ProcessEntry>, ApiError> {
  return useEffectQuery<ReadonlyArray<ProcessEntry>>(
    wk.processes(agentId ?? 'none'),
    call((api) => api.agents.listProcesses({ path: { agentId: agentId as AgentId } })),
    {
      enabled: agentId !== undefined && enabled,
      refetchInterval: enabled ? PROCESS_POLL_MS : false,
      refetchIntervalInBackground: false
    }
  )
}

// --- files (D12 gallery) ---------------------------------------------------

/** Where Playwright MCP drops screenshots and traces (`@taut/runtime` `BROWSER_PATHS.output`). */
export const BROWSER_OUTPUT_DIR = '.taut/browser/out'

/** `GET /api/agents/:id/files/content?path=…` — the cookie rides along, so `<img src>` works. */
export const agentFileUrl = (agentId: AgentId, path: string): string =>
  `/api/agents/${agentId}/files/content?path=${encodeURIComponent(path)}`

// --- base64 ↔ bytes --------------------------------------------------------

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export const base64ToBytes = (data: string): Uint8Array => {
  const binary = atob(data)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

const encoder = new TextEncoder()
export const textToBase64 = (text: string): string => bytesToBase64(encoder.encode(text))

// --- the socket (D6, D7) ---------------------------------------------------

export type SocketState = 'connecting' | 'open' | 'closed'

export interface SocketClosed {
  readonly code: number
  readonly reason: string
}

type FrameOf<T extends TerminalServerFrame['_tag']> = Extract<TerminalServerFrame, { _tag: T }>
type Listener<T extends TerminalServerFrame['_tag']> = (frame: FrameOf<T>) => void

const decodeFrame = Schema.decodeUnknownEither(Schema.parseJson(TerminalServerFrame))

/**
 * `pty: false` asks for a browser-only socket (`pty=0`): the live view and
 * take-control, no shell. That is what the `local` provider allows, where
 * `MachineInfo.terminal` is `false` but `liveView` is `true`.
 */
export const terminalSocketUrl = (
  agentId: AgentId,
  cols: number,
  rows: number,
  options: { readonly pty?: boolean } = {}
): string => {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
  const params = new URLSearchParams({ agentId, cols: String(cols), rows: String(rows) })
  if (options.pty === false) params.set('pty', '0')
  return `${protocol}//${window.location.host}${TERMINAL_WS_PATH}?${params.toString()}`
}

/**
 * One `/ws/terminal` connection. Frames are decoded through the contract schema
 * and fanned out by tag; `send` encodes the client frames the same way. A closed
 * socket stays closed — the tab opens a fresh one on Connect.
 */
export class WorkspaceSocket {
  #ws: WebSocket
  #state: SocketState = 'connecting'
  readonly #listeners = new Map<string, Set<(frame: never) => void>>()
  readonly #stateListeners = new Set<(state: SocketState, closed?: SocketClosed) => void>()

  constructor(url: string) {
    this.#ws = new WebSocket(url)
    this.#ws.onopen = () => this.#setState('open')
    this.#ws.onclose = (event) =>
      this.#setState('closed', { code: event.code, reason: event.reason })
    this.#ws.onerror = () => undefined
    this.#ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      const frame = decodeFrame(event.data)
      if (Either.isLeft(frame)) return
      for (const listener of this.#listeners.get(frame.right._tag) ?? []) {
        ;(listener as (f: TerminalServerFrame) => void)(frame.right)
      }
    }
  }

  get state(): SocketState {
    return this.#state
  }

  /** Bytes still queued in the browser; a frame is skipped past a few MB. */
  get bufferedAmount(): number {
    return this.#ws.bufferedAmount
  }

  on<T extends TerminalServerFrame['_tag']>(tag: T, listener: Listener<T>): () => void {
    const set = this.#listeners.get(tag) ?? new Set()
    set.add(listener as never)
    this.#listeners.set(tag, set)
    return () => {
      set.delete(listener as never)
    }
  }

  onState(listener: (state: SocketState, closed?: SocketClosed) => void): () => void {
    this.#stateListeners.add(listener)
    return () => {
      this.#stateListeners.delete(listener)
    }
  }

  send(frame: TerminalClientFrame): void {
    if (this.#ws.readyState === WebSocket.OPEN) this.#ws.send(JSON.stringify(frame))
  }

  close(): void {
    if (this.#ws.readyState === WebSocket.OPEN || this.#ws.readyState === WebSocket.CONNECTING) {
      this.#ws.close(1000, 'viewer left')
    }
  }

  #setState(state: SocketState, closed?: SocketClosed): void {
    this.#state = state
    for (const listener of this.#stateListeners) listener(state, closed)
  }
}
