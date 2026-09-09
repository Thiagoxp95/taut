/**
 * The D10 limits of docs/build-plan-workspace.md as plain values and two pure
 * pieces of bookkeeping, so each limit has a unit test that never opens a socket:
 *
 * - `TerminalLimits`: the numbers (one PTY per viewer per agent, 4 per agent,
 *   15 min idle, 2 h hard cap, 1 MB/s of output per socket).
 * - `makeTerminalRegistry`: who holds a terminal on which agent right now. In
 *   memory on purpose (D4) — a restart drops every socket anyway.
 * - `makeOutputThrottle`: a one-second window per socket; bytes over the budget
 *   are dropped and the viewer sees a single `[output truncated]` marker per
 *   episode, so `yes` or `cat /dev/urandom` cannot push the server (or the
 *   browser) over.
 *
 * `realtime/terminalWs.ts` wires these to real sockets and PTYs.
 */
import { Context, Either, Layer } from 'effect'

export interface TerminalLimitsShape {
  /** No stdin and no output for this long → close with a visible notice. */
  readonly idleMs: number
  /** Hard cap on one session, active or not. */
  readonly maxMs: number
  /** Open terminals per agent, across every viewer. One per viewer per agent is fixed. */
  readonly maxPerAgent: number
  /** Output budget per socket per second; the rest is dropped. */
  readonly outputBytesPerSecond: number
}

export const DEFAULT_TERMINAL_LIMITS: TerminalLimitsShape = {
  idleMs: 15 * 60_000,
  maxMs: 2 * 60 * 60_000,
  maxPerAgent: 4,
  outputBytesPerSecond: 1024 * 1024
}

/** The limits the terminal server enforces; tests shrink them, production keeps the defaults. */
export class TerminalLimits extends Context.Tag('TerminalLimits')<
  TerminalLimits,
  TerminalLimitsShape
>() {
  static readonly Default = Layer.succeed(this, DEFAULT_TERMINAL_LIMITS)
  static readonly layer = (overrides: Partial<TerminalLimitsShape>) =>
    Layer.succeed(this, { ...DEFAULT_TERMINAL_LIMITS, ...overrides })
}

// ── registry ────────────────────────────────────────────────────────────────

export type TerminalRefusal = 'viewer-busy' | 'agent-full'

export interface TerminalRegistry {
  /** Reserve a slot; `Left` says why not. `sessionId` is the caller's, for `release`. */
  readonly claim: (
    agentId: string,
    viewerId: string,
    sessionId: string
  ) => Either.Either<void, TerminalRefusal>
  readonly release: (agentId: string, sessionId: string) => void
  readonly count: (agentId: string) => number
}

export const makeTerminalRegistry = (maxPerAgent: number): TerminalRegistry => {
  /** agentId → sessionId → viewerId */
  const open = new Map<string, Map<string, string>>()
  return {
    claim: (agentId, viewerId, sessionId) => {
      const sessions = open.get(agentId) ?? new Map<string, string>()
      for (const holder of sessions.values()) {
        if (holder === viewerId) return Either.left('viewer-busy')
      }
      if (sessions.size >= maxPerAgent) return Either.left('agent-full')
      sessions.set(sessionId, viewerId)
      open.set(agentId, sessions)
      return Either.void
    },
    release: (agentId, sessionId) => {
      const sessions = open.get(agentId)
      if (sessions === undefined) return
      sessions.delete(sessionId)
      if (sessions.size === 0) open.delete(agentId)
    },
    count: (agentId) => open.get(agentId)?.size ?? 0
  }
}

// ── output throttle ─────────────────────────────────────────────────────────

export interface ThrottleVerdict {
  /** How many leading bytes of the chunk may be sent (0 = drop it whole). */
  readonly allow: number
  /** `true` exactly once per truncation episode: send the marker after the bytes. */
  readonly marker: boolean
}

export interface OutputThrottle {
  readonly admit: (bytes: number, now: number) => ThrottleVerdict
}

/**
 * Fixed one-second windows starting at the first byte. Partial admission keeps
 * the last bytes before the cut visible; the marker fires when dropping starts
 * and re-arms only once a chunk went through untouched.
 */
export const makeOutputThrottle = (bytesPerSecond: number): OutputThrottle => {
  let windowStart = -1
  let used = 0
  let truncating = false
  return {
    admit: (bytes, now) => {
      if (windowStart < 0 || now - windowStart >= 1000) {
        windowStart = now
        used = 0
      }
      const room = Math.max(0, bytesPerSecond - used)
      const allow = Math.min(bytes, room)
      used += allow
      if (allow === bytes) {
        truncating = false
        return { allow, marker: false }
      }
      const marker = !truncating
      truncating = true
      return { allow, marker }
    }
  }
}
