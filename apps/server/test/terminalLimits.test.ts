/**
 * The D10 bookkeeping of docs/build-plan-workspace.md, isolated from sockets and
 * PTYs: the per-agent/per-viewer registry, the 1 MB/s output throttle with its
 * single `[output truncated]` marker, and the `ps` line parser behind D13.
 * `workspace.test.ts` exercises the same limits end to end over `/ws/terminal`.
 */
import { Either } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_TERMINAL_LIMITS,
  makeOutputThrottle,
  makeTerminalRegistry
} from '../src/realtime/terminalLimits.js'
import { PS_COMMAND, parsePsLine } from '../src/services/workspace.js'

describe('terminal limits (D10)', () => {
  it('defaults are the plan: 15 min idle, 2 h cap, 4 per agent, 1 MB/s', () => {
    expect(DEFAULT_TERMINAL_LIMITS).toEqual({
      idleMs: 15 * 60_000,
      maxMs: 2 * 60 * 60_000,
      maxPerAgent: 4,
      outputBytesPerSecond: 1024 * 1024
    })
  })

  it('registry: one terminal per (agent, viewer), then at most maxPerAgent per agent', () => {
    const registry = makeTerminalRegistry(2)
    expect(Either.isRight(registry.claim('agt_a', 'usr_1', 's1'))).toBe(true)
    // the same viewer again on the same agent
    expect(registry.claim('agt_a', 'usr_1', 's2')).toEqual(Either.left('viewer-busy'))
    // the same viewer on another agent is fine
    expect(Either.isRight(registry.claim('agt_b', 'usr_1', 's3'))).toBe(true)
    // a second viewer fills the agent
    expect(Either.isRight(registry.claim('agt_a', 'usr_2', 's4'))).toBe(true)
    expect(registry.claim('agt_a', 'usr_3', 's5')).toEqual(Either.left('agent-full'))
    expect(registry.count('agt_a')).toBe(2)
    // releasing frees the slot; releasing twice is harmless
    registry.release('agt_a', 's1')
    registry.release('agt_a', 's1')
    expect(registry.count('agt_a')).toBe(1)
    expect(Either.isRight(registry.claim('agt_a', 'usr_3', 's5'))).toBe(true)
    expect(Either.isRight(registry.claim('agt_a', 'usr_1', 's6'))).toBe(false)
    registry.release('agt_a', 's4')
    registry.release('agt_a', 's5')
    expect(registry.count('agt_a')).toBe(0)
  })

  it('throttle: admits a budget per second, drops the excess, marks once per episode', () => {
    const throttle = makeOutputThrottle(1000)
    const t0 = 1_000_000
    expect(throttle.admit(600, t0)).toEqual({ allow: 600, marker: false })
    // the chunk that crosses the budget is cut and gets the marker
    expect(throttle.admit(600, t0 + 10)).toEqual({ allow: 400, marker: true })
    // everything else in the same window is dropped silently
    expect(throttle.admit(50, t0 + 20)).toEqual({ allow: 0, marker: false })
    expect(throttle.admit(5000, t0 + 900)).toEqual({ allow: 0, marker: false })
    // a new window: budget back, and only a later overflow marks again
    expect(throttle.admit(300, t0 + 1000)).toEqual({ allow: 300, marker: false })
    expect(throttle.admit(900, t0 + 1100)).toEqual({ allow: 700, marker: true })
    expect(throttle.admit(1, t0 + 1200)).toEqual({ allow: 0, marker: false })
    // an episode that never let a chunk through stays one episode across windows
    expect(throttle.admit(2000, t0 + 2000)).toEqual({ allow: 1000, marker: false })
  })
})

describe('ps parsing (D13)', () => {
  it('parses the `ps -eo pid,ppid,etimes,pcpu,pmem,args` shape, args with spaces', () => {
    expect(parsePsLine('    1     0  86400  0.0  0.1 sleep infinity')).toEqual({
      pid: 1,
      ppid: 0,
      elapsedSeconds: 86400,
      cpuPercent: 0,
      memoryPercent: 0.1,
      command: 'sleep infinity'
    })
    expect(
      parsePsLine(' 4242 1 17 12.5 3.4 node /usr/local/bin/claude -p --output-format stream-json')
    ).toEqual({
      pid: 4242,
      ppid: 1,
      elapsedSeconds: 17,
      cpuPercent: 12.5,
      memoryPercent: 3.4,
      command: 'node /usr/local/bin/claude -p --output-format stream-json'
    })
  })

  it('rejects headers and garbage instead of failing the list', () => {
    expect(parsePsLine('  PID  PPID ELAPSED %CPU %MEM COMMAND')).toBeNull()
    expect(parsePsLine('')).toBeNull()
    expect(parsePsLine('error: unsupported option')).toBeNull()
    expect(PS_COMMAND).toEqual(['ps', '-eo', 'pid,ppid,etimes,pcpu,pmem,args', '--no-headers'])
  })
})
