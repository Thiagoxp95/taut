/**
 * Provider-agnostic glue between "a spawned process with stdio" and
 * `Stream<ExecOutput>`. Both providers implement `SpawnedProcess`; this file
 * owns line splitting, idle/hard timeouts, stdin delivery and the
 * kill-on-interruption guarantee.
 */
import { Effect, Stream } from 'effect'
import type { Readable, Writable } from 'node:stream'

import type { ExecOptions, ExecOutput, ExecResult, KilledBy } from './types.js'
import { BinaryMissing, ExecFailed } from './types.js'

export interface ProcessExit {
  readonly exitCode: number | null
  readonly signal: string | null
}

export interface SpawnedProcess {
  readonly stdout: Readable
  readonly stderr: Readable | null
  readonly stdin: Writable | null
  /** Best-effort. Called at most once per signal. May be async (docker runs a second exec). */
  readonly kill: (signal: 'SIGTERM' | 'SIGKILL') => void | Promise<void>
  /** Resolves once the process has exited *and* its stdio has drained. */
  readonly exited: Promise<ProcessExit>
}

/** Splits arbitrary chunks into `\n`-terminated lines, keeping the remainder. */
export class LineBuffer {
  private rest = ''

  push(chunk: string): Array<string> {
    const data = this.rest + chunk
    const parts = data.split('\n')
    this.rest = parts.pop() ?? ''
    return parts.map(stripCr)
  }

  flush(): Array<string> {
    if (this.rest.length === 0) return []
    const line = stripCr(this.rest)
    this.rest = ''
    return [line]
  }
}

const stripCr = (s: string): string => (s.endsWith('\r') ? s.slice(0, -1) : s)

/** Grace between SIGTERM and SIGKILL. */
export const KILL_GRACE_MS = 3_000

const terminate = async (proc: SpawnedProcess): Promise<void> => {
  let done = false
  void proc.exited.then(() => {
    done = true
  })
  await proc.kill('SIGTERM')
  await Promise.race([proc.exited, sleep(KILL_GRACE_MS)])
  if (!done) {
    await proc.kill('SIGKILL')
    await Promise.race([proc.exited, sleep(KILL_GRACE_MS)])
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export interface ProcessMeta {
  readonly agentId: string
  readonly cmd: ReadonlyArray<string>
}

/**
 * Turn `acquire` (which spawns) into the `ExecOutput` stream. The process lives
 * in the stream's scope: when the consumer is interrupted or fails, the
 * finalizer kills the process (SIGTERM, then SIGKILL after `KILL_GRACE_MS`).
 */
export const processStream = (
  meta: ProcessMeta,
  options: ExecOptions,
  acquire: Effect.Effect<SpawnedProcess, ExecFailed | BinaryMissing>
): Stream.Stream<ExecOutput, ExecFailed | BinaryMissing> =>
  Stream.asyncScoped<ExecOutput, ExecFailed | BinaryMissing>((emit) =>
    Effect.gen(function* () {
      const startedAt = Date.now()
      let killedBy: KilledBy | undefined
      let finished = false

      const proc = yield* Effect.acquireRelease(acquire, (p) =>
        Effect.promise(async () => {
          if (finished) return
          killedBy ??= 'interrupt'
          await terminate(p)
        })
      )

      const timers: Array<NodeJS.Timeout> = []
      let idleTimer: NodeJS.Timeout | undefined
      const kill = (reason: KilledBy) => {
        if (finished || killedBy !== undefined) return
        killedBy = reason
        void terminate(proc)
      }
      const touch = () => {
        if (options.idleTimeoutMs === undefined) return
        if (idleTimer !== undefined) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => kill('idle'), options.idleTimeoutMs)
        timers.push(idleTimer)
      }
      touch()
      if (options.timeoutMs !== undefined) {
        timers.push(setTimeout(() => kill('timeout'), options.timeoutMs))
      }

      const out = new LineBuffer()
      const err = new LineBuffer()
      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => {
        touch()
        for (const line of out.push(chunk)) void emit.single({ _tag: 'stdout', line })
      })
      if (proc.stderr !== null) {
        proc.stderr.setEncoding('utf8')
        proc.stderr.on('data', (chunk: string) => {
          touch()
          for (const line of err.push(chunk)) void emit.single({ _tag: 'stderr', line })
        })
      }

      if (proc.stdin !== null) {
        const stdin = proc.stdin
        stdin.on('error', () => undefined) // EPIPE when the child exits early is not our problem
        if (options.stdin !== undefined) stdin.end(options.stdin)
        else stdin.end()
      }

      proc.exited.then(
        (exit) => {
          finished = true
          for (const t of timers) clearTimeout(t)
          for (const line of out.flush()) void emit.single({ _tag: 'stdout', line })
          for (const line of err.flush()) void emit.single({ _tag: 'stderr', line })
          const result: ExecResult = {
            exitCode: exit.exitCode ?? -1,
            ...(exit.signal !== null ? { signal: exit.signal } : {}),
            ...(killedBy !== undefined ? { killedBy } : {}),
            durationMs: Date.now() - startedAt
          }
          void emit.single({ _tag: 'exit', result })
          void emit.end()
        },
        (cause: unknown) => {
          finished = true
          for (const t of timers) clearTimeout(t)
          void emit.fail(
            new ExecFailed({
              agentId: meta.agentId,
              cmd: [...meta.cmd],
              reason: cause instanceof Error ? cause.message : String(cause),
              cause
            })
          )
        }
      )
    })
  )

/** Drive an `ExecOutput` stream to completion, routing lines to the callbacks. */
export const runExec = (
  meta: ProcessMeta,
  options: ExecOptions,
  stream: Stream.Stream<ExecOutput, ExecFailed | BinaryMissing>
): Effect.Effect<ExecResult, ExecFailed | BinaryMissing> =>
  Effect.gen(function* () {
    let result: ExecResult | undefined
    yield* Stream.runForEach(stream, (output) =>
      Effect.sync(() => {
        switch (output._tag) {
          case 'stdout':
            options.onLine?.(output.line)
            return
          case 'stderr':
            options.onStderr?.(output.line)
            return
          case 'exit':
            result = output.result
            return
        }
      })
    )
    if (result === undefined) {
      return yield* new ExecFailed({
        agentId: meta.agentId,
        cmd: [...meta.cmd],
        reason: 'process ended without an exit status'
      })
    }
    return result
  })

/** `true` for the errors a missing executable produces. */
export const looksLikeMissingBinary = (cause: unknown): boolean => {
  if (typeof cause !== 'object' || cause === null) return false
  const code = (cause as { code?: unknown }).code
  if (code === 'ENOENT') return true
  const message = (cause as { message?: unknown }).message
  return (
    typeof message === 'string' &&
    /executable file not found|no such file or directory|not found in \$PATH/i.test(message)
  )
}

export { BinaryMissing }
