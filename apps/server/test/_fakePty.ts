/**
 * A scripted `Pty` for the terminal socket tests (docs/build-plan-workspace.md D10),
 * plugged into `_fakeRuntime.ts`'s `openPty` option. No process anywhere:
 *
 *   any bytes           → echoed back verbatim
 *   line `burst <n>`    → `n` bytes of `x` in one chunk (the throttle test)
 *   line `exit <code>`  → output ends, `exit` settles with `<code>`
 *   `kill()` / scope end → output ends, `exit` settles with -1, `killed` is set
 */
import type { Pty, PtyOptions } from '@taut/runtime'
import { Deferred, Effect, Queue, type Scope, Stream } from 'effect'

export interface FakePtyHandle {
  readonly pty: Pty
  readonly options: PtyOptions
  readonly resizes: Array<{ cols: number; rows: number }>
  /** Everything written to the PTY, decoded as UTF-8. */
  readonly input: () => string
  killed: boolean
}

let ptyCounter = 0

export const makeFakePty = (
  options: PtyOptions
): Effect.Effect<FakePtyHandle, never, Scope.Scope> =>
  Effect.gen(function* () {
    const output = yield* Queue.unbounded<Uint8Array | null>()
    const exited = yield* Deferred.make<number>()
    const written: Array<Uint8Array> = []
    const resizes: Array<{ cols: number; rows: number }> = []
    let pending = ''
    let ended = false

    const end = (code: number) =>
      Effect.gen(function* () {
        if (ended) return
        ended = true
        yield* Queue.offer(output, null)
        yield* Deferred.succeed(exited, code)
      })

    const handle: FakePtyHandle = {
      options,
      resizes,
      killed: false,
      input: () => Buffer.concat(written.map((w) => Buffer.from(w))).toString('utf8'),
      pty: {
        id: `fake-pty-${++ptyCounter}`,
        shell: '/bin/fake-sh',
        write: (bytes) =>
          Effect.gen(function* () {
            if (ended) return
            written.push(bytes)
            yield* Queue.offer(output, bytes)
            pending += Buffer.from(bytes).toString('utf8')
            let nl = pending.indexOf('\n')
            while (nl !== -1) {
              const line = pending.slice(0, nl).trim()
              pending = pending.slice(nl + 1)
              const burst = /^burst (\d+)$/.exec(line)
              const exit = /^exit (\d+)$/.exec(line)
              if (burst !== null) {
                yield* Queue.offer(output, new Uint8Array(Buffer.alloc(Number(burst[1]), 'x')))
              } else if (exit !== null) {
                yield* end(Number(exit[1]))
              }
              nl = pending.indexOf('\n')
            }
          }),
        resize: (cols, rows) =>
          Effect.sync(() => {
            resizes.push({ cols, rows })
          }),
        output: Stream.fromQueue(output).pipe(
          Stream.takeWhile((chunk): chunk is Uint8Array => chunk !== null)
        ),
        exit: Deferred.await(exited),
        kill: () =>
          Effect.gen(function* () {
            handle.killed = true
            yield* end(-1)
          })
      }
    }
    yield* Effect.addFinalizer(() => handle.pty.kill())
    return handle
  })
