/**
 * The machine seam (docs/agent-model.md §7). A `MachineProvider` gives every
 * agent one long-lived box; a `Machine` runs commands in it and streams their
 * output line by line. Adapters (src/adapters) never spawn anything — they only
 * produce `{ cmd, env, stdin }` for `Machine.exec` and parse the lines it yields.
 *
 * The streaming `exec(cmd, { onLine, stdin })` contract follows Sandcastle
 * (MIT, see ../../NOTICE).
 */
import type { Effect, Option, Scope, Stream } from 'effect'
import { Schema } from 'effect'
import type { Duplex } from 'node:stream'

// ---------------------------------------------------------------------------
// Spec
// ---------------------------------------------------------------------------

export const MachineRuntime = Schema.Literal('runc', 'runsc', 'sysbox-runc')
export type MachineRuntime = typeof MachineRuntime.Type

/** `missing → (ensure) → running → (idle) → stopped → (start) → running`. */
export const MachineStatus = Schema.Literal('missing', 'creating', 'running', 'stopped')
export type MachineStatus = typeof MachineStatus.Type

export interface MachineLimits {
  readonly cpus: number
  readonly memoryMb: number
  /** Defaults to 512. */
  readonly pidsLimit?: number
}

export type MachineEgress = 'allow-all' | { readonly allowDomains: ReadonlyArray<string> }

export interface MachineSpec {
  readonly agentId: string
  readonly companyId: string
  /** Company slug; names the docker network `taut-<slug>` and container `taut-<slug>-<handle>`. */
  readonly companySlug: string
  readonly handle: string
  /** Image for the docker provider. Defaults to `taut/agent:latest`. Ignored by `local`. */
  readonly image?: string
  /** Host path of the agent home (docs/agent-model.md §5). Mounted at `/home/agent` on docker. */
  readonly homeDir: string
  readonly limits: MachineLimits
  /** `allowDomains` is recorded but not enforced in the MVP. */
  readonly network: { readonly egress: MachineEgress }
  readonly runtime?: MachineRuntime
}

// ---------------------------------------------------------------------------
// Exec
// ---------------------------------------------------------------------------

export interface ExecOptions {
  readonly cmd: ReadonlyArray<string>
  /** Machine-visible working directory. Defaults to the machine home. */
  readonly cwd?: string
  /** Per-exec env (vault output, adapter env). Merged over the machine's base env; wins on conflict. */
  readonly env?: Readonly<Record<string, string>>
  /** Written to the child's stdin, then stdin is closed. Without it stdin is closed immediately. */
  readonly stdin?: string
  /** Called for every complete stdout line, in order. */
  readonly onLine?: (line: string) => void
  /** Called for every complete stderr line, in order. */
  readonly onStderr?: (line: string) => void
  /** No stdout/stderr output for this long → the process is killed (`killedBy: "idle"`). */
  readonly idleTimeoutMs?: number
  /** Hard wall-clock limit → killed (`killedBy: "timeout"`). */
  readonly timeoutMs?: number
}

export type KilledBy = 'idle' | 'timeout' | 'interrupt'

export interface ExecResult {
  /** Exit code; `-1` when the process died from a signal without a code. */
  readonly exitCode: number
  readonly signal?: string
  readonly killedBy?: KilledBy
  readonly durationMs: number
}

/** One element of `Machine.execStream`. The `exit` element is always last. */
export type ExecOutput =
  | { readonly _tag: 'stdout'; readonly line: string }
  | { readonly _tag: 'stderr'; readonly line: string }
  | { readonly _tag: 'exit'; readonly result: ExecResult }

// ---------------------------------------------------------------------------
// PTY (docs/build-plan-workspace.md D8)
// ---------------------------------------------------------------------------

export interface PtyOptions {
  readonly cols: number
  readonly rows: number
  /** Defaults to a login shell, `['/bin/bash', '-l']`. */
  readonly cmd?: ReadonlyArray<string>
  /** Machine-visible working directory. Defaults to the machine home. */
  readonly cwd?: string
  /**
   * Per-PTY env, merged over the machine's base env. `TERM` is forced to
   * `xterm-256color` by the provider (D9): the image sets `TERM=dumb` for the
   * runtimes, which is wrong for an interactive shell.
   */
  readonly env?: Readonly<Record<string, string>>
}

/**
 * An interactive shell inside the box. Raw bytes both ways — no line splitting,
 * no stdout/stderr distinction (a TTY has neither). Obtained from
 * `Machine.openPty`, whose `Scope` owns the child: closing the scope kills it.
 */
export interface Pty {
  /** Provider-specific id of the child (the docker exec id). */
  readonly id: string
  /** `cmd[0]` as started, for the `ready` frame. */
  readonly shell: string
  /** Keystrokes / pasted bytes. Silently dropped once the child is gone. */
  write(bytes: Uint8Array): Effect.Effect<void>
  resize(cols: number, rows: number): Effect.Effect<void>
  /** Everything the terminal emits, as it is emitted; ends when the child exits. */
  readonly output: Stream.Stream<Uint8Array>
  /** Settles once the child is gone; `-1` when docker never reported a code. */
  readonly exit: Effect.Effect<number>
  /** Hang up, then SIGKILL after a grace period. Idempotent. */
  kill(): Effect.Effect<void>
}

/** `STOP` freezes every task exec in the box, `CONT` resumes it (docs/build-plan-workspace.md D15). */
export type TaskSignal = 'STOP' | 'CONT'

/**
 * Marker env every *workspace* exec (PTY, tunnel) carries next to its `TAUT_EXEC_ID`,
 * so `signalTasks` can tell a human's shell from the agent's runtime: both are execs
 * with an id, only the runtime's are tasks.
 */
export const WORKSPACE_EXEC_ENV = 'TAUT_WORKSPACE'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The provider cannot give this agent a box (daemon down, image missing, create failed…). */
export class MachineUnavailable extends Schema.TaggedError<MachineUnavailable>()(
  'MachineUnavailable',
  {
    provider: Schema.String,
    agentId: Schema.String,
    reason: Schema.String,
    cause: Schema.optional(Schema.Defect)
  }
) {
  override get message(): string {
    return `${this.provider}: machine for ${this.agentId} unavailable: ${this.reason}`
  }
}

/**
 * The exec itself broke (spawn error, stream I/O, file transfer). A non-zero
 * exit code is *not* an `ExecFailed` — it is a normal `ExecResult`.
 */
export class ExecFailed extends Schema.TaggedError<ExecFailed>()('ExecFailed', {
  agentId: Schema.String,
  cmd: Schema.Array(Schema.String),
  reason: Schema.String,
  exitCode: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect)
}) {
  override get message(): string {
    return `exec ${JSON.stringify(this.cmd[0] ?? '')} failed for ${this.agentId}: ${this.reason}`
  }
}

/** `cmd[0]` does not exist on the machine (ENOENT / exit 127 at spawn). */
export class BinaryMissing extends Schema.TaggedError<BinaryMissing>()('BinaryMissing', {
  agentId: Schema.String,
  binary: Schema.String
}) {
  override get message(): string {
    return `binary "${this.binary}" not found on machine of ${this.agentId}`
  }
}

export type MachineError = MachineUnavailable | ExecFailed | BinaryMissing

// ---------------------------------------------------------------------------
// Machine + provider
// ---------------------------------------------------------------------------

export interface MachinePaths {
  /** The agent home as the *machine* sees it (`/home/agent` on docker, the host path on local). */
  readonly home: string
  /** The same directory as the *host* sees it (== `spec.homeDir`). */
  readonly hostHome: string
}

export interface Machine {
  /** Provider-specific stable id (`local:<agentId>`, docker container name). */
  readonly id: string
  readonly provider: MachineProviderName
  readonly spec: MachineSpec
  readonly paths: MachinePaths

  status(): Effect.Effect<MachineStatus, MachineUnavailable>
  /** Idempotent. */
  start(): Effect.Effect<void, MachineUnavailable>
  /** Keeps the home dir. */
  stop(): Effect.Effect<void, MachineUnavailable>
  /** Removes the box, never the home dir. */
  destroy(): Effect.Effect<void, MachineUnavailable>

  /**
   * Run a command to completion, delivering lines through `onLine`/`onStderr`.
   * The child is scoped to the running fiber: interrupting it kills the child.
   */
  exec(options: ExecOptions): Effect.Effect<ExecResult, ExecFailed | BinaryMissing>
  /** Same, as a stream of lines that ends with one `exit` element. */
  execStream(options: ExecOptions): Stream.Stream<ExecOutput, ExecFailed | BinaryMissing>

  /**
   * Open an interactive shell in the box (docs/build-plan-workspace.md D8). The
   * child lives in the returned `Scope`: closing it (or interrupting the fiber)
   * kills the shell. `local` always fails with `MachineUnavailable` (D2): a PTY
   * there would be an unsandboxed shell on the host, not on an agent's box.
   */
  openPty(options: PtyOptions): Effect.Effect<Pty, MachineUnavailable | ExecFailed, Scope.Scope>

  /**
   * A byte stream to `127.0.0.1:<port>` *inside* the box (docs/build-plan-workspace.md
   * D11, D18): how the server reaches Chromium's debug port without that port ever
   * leaving the container's own network namespace. Lives in the `Scope`. `local`
   * refuses (D2).
   */
  openTunnel(port: number): Effect.Effect<Duplex, MachineUnavailable | ExecFailed, Scope.Scope>

  /**
   * `SIGSTOP` / `SIGCONT` every task exec in the box — every process carrying a
   * `TAUT_EXEC_ID` without the `WORKSPACE_EXEC_ENV` marker — so a human can drive the
   * agent's browser while its runtime is frozen (D15). Returns how many processes were
   * signalled. `local` refuses (D2).
   */
  signalTasks(signal: TaskSignal): Effect.Effect<number, MachineUnavailable | ExecFailed>

  /** `path` is machine-visible. Parent directories are created. */
  putFile(path: string, content: Uint8Array | string): Effect.Effect<void, ExecFailed>
  getFile(path: string): Effect.Effect<Uint8Array, ExecFailed>
}

export type MachineProviderName = 'local' | 'docker'

export interface MachineProvider {
  readonly name: MachineProviderName
  /** Create-or-reuse for this agent; also lays out the home dir. Idempotent; call before every task. */
  ensure(spec: MachineSpec): Effect.Effect<Machine, MachineUnavailable>
  get(agentId: string): Effect.Effect<Option.Option<Machine>, MachineUnavailable>
  list(companyId: string): Effect.Effect<ReadonlyArray<Machine>, MachineUnavailable>
  /** Remove the box for this agent (no-op when there is none). Keeps the home dir. */
  destroy(agentId: string): Effect.Effect<void, MachineUnavailable>
}
