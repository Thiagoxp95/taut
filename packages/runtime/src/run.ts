/**
 * `runTask`: the composition the server calls per task —
 * exec the built command on the machine → redact every line → parse → events.
 *
 * ```ts
 * const machine = yield* provider.ensure(spec)
 * const adapter = adapterFor(agent.runtimeKind)
 * const built = adapter.buildCommand({ prompt, cwd, home: machine.paths.home, permissionMode, credential })
 * yield* Stream.runForEach(runTask({ machine, adapter, command: built, cwd }), handleEvent)
 * ```
 */
import { Effect, Stream } from 'effect'

import type { AgentEvent, BuiltCommand, RuntimeAdapter } from './adapters/types.js'
import type { BinaryMissing, ExecFailed, Machine } from './machine/types.js'
import { makeRedactor, secretsOf, type Redactor } from './redact.js'

export interface RunTaskOptions {
  readonly machine: Machine
  readonly adapter: RuntimeAdapter
  readonly command: BuiltCommand
  /** Machine-visible work dir. */
  readonly cwd: string
  /**
   * Extra plaintext secrets to redact. Every value in `command.env` and every
   * `command.files[].content` is redacted automatically.
   */
  readonly secrets?: Iterable<string>
  /**
   * Caller-owned redactor (one per task on the server). The env/file secrets and
   * `secrets` are `add()`ed to it, so anything the caller registers later — e.g.
   * a `vault_get` result — is masked from that moment on. Default: a fresh one.
   */
  readonly redactor?: Redactor
  /** Redacted stderr lines (never turned into events). */
  readonly onStderr?: (line: string) => void
  readonly idleTimeoutMs?: number
  readonly timeoutMs?: number
}

/**
 * Stream of redacted `AgentEvent`s for one task. Ends after the process exits;
 * if the runtime never emitted `done`, one is synthesised from the exit code
 * (and an `error` when the exit was non-zero or the process was killed).
 * Interrupting the consumer kills the process.
 */
export const runTask = (o: RunTaskOptions): Stream.Stream<AgentEvent, ExecFailed | BinaryMissing> =>
  Stream.suspend(() => {
    const redactor: Redactor = o.redactor ?? makeRedactor()
    for (const secret of secretsOf(o.command.env, o.command.files)) redactor.add(secret)
    for (const secret of o.secrets ?? []) redactor.add(secret)
    let sawDone = false
    let sawError = false
    const stderr: Array<string> = []

    const writeFiles = Effect.forEach(
      o.command.files ?? [],
      (f) => o.machine.putFile(f.path, f.content),
      { discard: true }
    )

    const output = o.machine.execStream({
      cmd: o.command.cmd,
      cwd: o.cwd,
      env: o.command.env,
      ...(o.command.stdin !== undefined ? { stdin: o.command.stdin } : {}),
      ...(o.idleTimeoutMs !== undefined ? { idleTimeoutMs: o.idleTimeoutMs } : {}),
      ...(o.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {})
    })

    const events = Stream.mapConcat(output, (out): ReadonlyArray<AgentEvent> => {
      switch (out._tag) {
        case 'stdout': {
          const parsed = o.adapter.parseLine(redactor.redact(out.line))
          if (parsed.some((e) => e.type === 'done')) sawDone = true
          if (parsed.some((e) => e.type === 'error')) sawError = true
          return parsed
        }
        case 'stderr': {
          const line = redactor.redact(out.line)
          o.onStderr?.(line)
          if (line.trim() !== '') {
            stderr.push(line.slice(-2000))
            if (stderr.length > 5) stderr.shift()
          }
          return []
        }
        case 'exit': {
          if (sawDone) return []
          const r = out.result
          const reason = r.killedBy !== undefined ? `killed: ${r.killedBy}` : `exit ${r.exitCode}`
          const ok = r.exitCode === 0 && r.killedBy === undefined
          const done: AgentEvent = { type: 'done', ok, reason, durationMs: r.durationMs }
          const detail = stderr.join('\n').slice(-4000)
          return ok || sawError
            ? [done]
            : [
                {
                  type: 'error',
                  message: `runtime ended without a result (${reason})${detail === '' ? '' : `: ${detail}`}`
                },
                done
              ]
        }
      }
    })

    return Stream.unwrap(Effect.as(writeFiles, events))
  })
