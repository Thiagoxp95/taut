/**
 * What the Workspace tab needs to know about an agent's box
 * (docs/build-plan-workspace.md D5, D13). The box itself lives behind
 * `@taut/runtime`'s `MachineProvider` seam (docs/agent-model.md §7); these are the
 * wire shapes the server derives from it. Nothing here is persisted — workspace
 * state is ephemeral by decision (D4).
 */
import { Schema } from 'effect'

/** Mirrors `@taut/runtime`'s `MachineProviderName`; the contract cannot depend on the runtime. */
export const MachineProviderName = Schema.Literal('local', 'docker')
export type MachineProviderName = typeof MachineProviderName.Type

/** `missing → (start) → running → (stop) → stopped → (start) → running`; `creating` is transient. */
export const MachineStatus = Schema.Literal('missing', 'creating', 'running', 'stopped')
export type MachineStatus = typeof MachineStatus.Type

export const MachineInfo = Schema.Struct({
  provider: MachineProviderName,
  status: MachineStatus,
  /** Provider-specific id (the container name on docker) once the box exists. */
  machineId: Schema.optional(Schema.String),
  /** The agent home as the machine sees it (`/home/agent` on docker). */
  home: Schema.String,
  /**
   * `true` only on providers with an isolated box (D2). When `false` the Workspace
   * tab explains why instead of offering a terminal, and never opens a socket.
   */
  terminal: Schema.Boolean,
  /**
   * `true` when this provider can show (and hand over) the agent's browser. Unlike
   * `terminal` this holds on `local` too: the live view drives a headless Chromium
   * Taut starts on the agent's own profile, not a shell on the host, so D2's
   * rationale does not reach it. The Workspace tab opens a browser-only socket
   * (`pty=0`) when `terminal` is `false` and this is `true`.
   */
  liveView: Schema.Boolean,
  /** Image the box runs (docker only). */
  image: Schema.optional(Schema.String)
})
export type MachineInfo = typeof MachineInfo.Type

/**
 * One row of `ps -eo pid,ppid,etimes,pcpu,pmem,args --no-headers` inside the box,
 * parsed and validated by the server (D13).
 */
export const ProcessEntry = Schema.Struct({
  pid: Schema.NonNegativeInt,
  ppid: Schema.NonNegativeInt,
  /** Seconds since the process started (`etimes`). */
  elapsedSeconds: Schema.NonNegativeInt,
  cpuPercent: Schema.NonNegative,
  memoryPercent: Schema.NonNegative,
  /** The full command line (`args`). */
  command: Schema.String
})
export type ProcessEntry = typeof ProcessEntry.Type
