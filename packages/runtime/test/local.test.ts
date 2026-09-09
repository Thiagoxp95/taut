/* eslint-disable turbo/no-undeclared-env-vars -- tests read the host PATH on purpose */
import { Effect, Fiber, Option, Stream } from 'effect'
import { readFile, realpath, stat } from 'node:fs/promises'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { ensureHomeLayout } from '../src/machine/home.js'
import { LineBuffer } from '../src/machine/process.js'
import { makeLocalProvider } from '../src/machine/local.js'
import type { ExecOutput, Machine } from '../src/machine/types.js'
import { specFor, tempHome } from './helpers.js'

const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe('LocalProvider', () => {
  let home = ''
  let cleanup = async () => {}
  let machine: Machine
  const provider = makeLocalProvider({
    hostEnv: {
      PATH: process.env['PATH'],
      LANG: 'en_US.UTF-8',
      TERM: 'dumb',
      USER: 'tester',
      TAUT_CANARY: 'leak'
    }
  })

  beforeAll(async () => {
    ;({ home, cleanup } = await tempHome())
    machine = await Effect.runPromise(provider.ensure(specFor(home)))
  })
  afterAll(() => cleanup())

  it('openPty always fails with MachineUnavailable (docs/build-plan-workspace.md D2)', async () => {
    const failure = await Effect.runPromise(
      Effect.flip(machine.openPty({ cols: 80, rows: 24 }).pipe(Effect.scoped))
    )
    expect(failure._tag).toBe('MachineUnavailable')
    if (failure._tag === 'MachineUnavailable') {
      expect(failure.provider).toBe('local')
      expect(failure.reason).toContain('no terminal on the local provider')
    }
  })

  // D2 covers the shell, not the browser: the live view drives a Chromium Taut starts
  // on the agent's own profile, so `local` tunnels to it like any other provider.
  it('openTunnel relays bytes to a loopback port, and fails when nothing listens', async () => {
    const server = createServer((socket) => socket.pipe(socket))
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address !== null ? address.port : 0)
      })
    })
    const echoed = await Effect.runPromise(
      Effect.scoped(
        Effect.flatMap(machine.openTunnel(port), (tunnel) =>
          Effect.async<string>((resume) => {
            tunnel.once('data', (chunk: Buffer) => resume(Effect.succeed(chunk.toString('utf8'))))
            tunnel.write('ping')
          })
        )
      )
    )
    expect(echoed).toBe('ping')
    await new Promise<void>((resolve) => server.close(() => resolve()))

    const failure = await Effect.runPromise(
      Effect.flip(machine.openTunnel(port).pipe(Effect.scoped))
    )
    expect(failure._tag).toBe('MachineUnavailable')
  })

  it('signalTasks freezes and resumes the task execs it started, and only those', async () => {
    await Effect.runPromise(
      Effect.gen(function* () {
        // Nothing running: nothing to signal.
        expect(yield* machine.signalTasks('STOP')).toBe(0)

        // A workspace exec carries the marker and is never a task (D15).
        const workspace = yield* Effect.fork(
          machine.exec({
            cmd: ['sh', '-c', 'sleep 5'],
            env: { TAUT_EXEC_ID: 'ws-1', TAUT_WORKSPACE: '1' }
          })
        )
        const task = yield* Effect.fork(
          machine.exec({ cmd: ['sh', '-c', 'sleep 5'], env: { TAUT_EXEC_ID: 'task-1' } })
        )
        yield* Effect.sleep('400 millis')
        expect(yield* machine.signalTasks('STOP')).toBe(1)
        expect(yield* machine.signalTasks('CONT')).toBe(1)
        yield* Fiber.interrupt(task)
        yield* Fiber.interrupt(workspace)
      })
    )
  })

  it('ensure() creates the §5 home layout and is idempotent', async () => {
    for (const dir of [
      'skills',
      'memory',
      'inbox',
      'work',
      '.taut',
      '.taut/home',
      '.taut/claude'
    ]) {
      expect((await stat(join(home, dir))).isDirectory()).toBe(true)
    }
    expect(await readFile(join(home, 'AGENT.md'), 'utf8')).toContain('# AGENT.md')
    expect((await stat(join(home, '.taut/audit.log'))).isFile()).toBe(true)
    const again = await Effect.runPromise(provider.ensure(specFor(home)))
    expect(again).toBe(machine)
    await Effect.runPromise(ensureHomeLayout(home)) // no throw
    expect(Option.isSome(await Effect.runPromise(provider.get('agt_test')))).toBe(true)
    expect(await Effect.runPromise(provider.list('cmp_test'))).toHaveLength(1)
    expect(await Effect.runPromise(provider.list('cmp_other'))).toHaveLength(0)
  })

  it('exec runs echo and streams lines in order', async () => {
    const lines: Array<string> = []
    const result = await Effect.runPromise(
      machine.exec({
        cmd: ['sh', '-c', 'echo one; echo two; printf three'],
        onLine: (l) => lines.push(l)
      })
    )
    expect(result.exitCode).toBe(0)
    expect(result.killedBy).toBeUndefined()
    expect(lines).toEqual(['one', 'two', 'three'])
  })

  it('execStream ends with an exit element and separates stderr', async () => {
    const out = await Effect.runPromise(
      Stream.runCollect(
        machine.execStream({ cmd: ['sh', '-c', 'echo out; echo err 1>&2; exit 3'] })
      )
    )
    const items: Array<ExecOutput> = [...out]
    expect(items.at(-1)).toMatchObject({ _tag: 'exit', result: { exitCode: 3 } })
    expect(items).toContainEqual({ _tag: 'stdout', line: 'out' })
    expect(items).toContainEqual({ _tag: 'stderr', line: 'err' })
  })

  it('never inherits the host env: only PATH/LANG/TERM/USER + HOME + TMPDIR + per-exec env', async () => {
    const lines: Array<string> = []
    await Effect.runPromise(
      machine.exec({ cmd: ['env'], env: { TASK_SECRET: 'x' }, onLine: (l) => lines.push(l) })
    )
    const env = Object.fromEntries(lines.map((l) => l.split('=', 2) as [string, string]))
    expect(env['TAUT_CANARY']).toBeUndefined()
    expect(env['HOME']).toBe(join(home, '.taut/home'))
    expect(env['TMPDIR']).toBe(join(home, '.taut/home/tmp'))
    expect(env['LANG']).toBe('en_US.UTF-8')
    expect(env['TERM']).toBe('dumb')
    expect(env['TASK_SECRET']).toBe('x')
    expect(env['PATH']).toBe(process.env['PATH'])
    const keys = Object.keys(env).filter((k) => !['PWD', 'SHLVL', '_', 'OLDPWD'].includes(k))
    expect(env['USER']).toBe('tester')
    expect(keys.sort()).toEqual(['HOME', 'LANG', 'PATH', 'TASK_SECRET', 'TERM', 'TMPDIR', 'USER'])
  })

  it('cwd defaults to the home and accepts relative work dirs', async () => {
    const pwd = async (cwd?: string) => {
      const lines: Array<string> = []
      await Effect.runPromise(machine.exec({ cmd: ['pwd'], cwd, onLine: (l) => lines.push(l) }))
      return lines[0]
    }
    expect(await pwd()).toBe(await realpath(home))
    await Effect.runPromise(machine.putFile('work/tsk_1/.keep', ''))
    expect(await pwd('work/tsk_1')).toBe(await realpath(join(home, 'work/tsk_1')))
  })

  it('stdin is delivered then closed', async () => {
    const lines: Array<string> = []
    await Effect.runPromise(
      machine.exec({ cmd: ['cat'], stdin: 'a\nb', onLine: (l) => lines.push(l) })
    )
    expect(lines).toEqual(['a', 'b'])
  })

  it('interrupting the fiber kills the child process', async () => {
    const pids: Array<number> = []
    const fiber = Effect.runFork(
      machine.exec({
        cmd: ['sh', '-c', 'echo $$; sleep 30'],
        onLine: (l) => pids.push(Number(l))
      })
    )
    const deadline = Date.now() + 5_000
    while (pids.length === 0 && Date.now() < deadline) await sleep(20)
    const pid = pids[0] ?? -1
    expect(isAlive(pid)).toBe(true)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await sleep(200)
    expect(isAlive(pid)).toBe(false)
  })

  it('idle timeout kills a silent process and reports killedBy', async () => {
    const result = await Effect.runPromise(
      machine.exec({ cmd: ['sleep', '30'], idleTimeoutMs: 200 })
    )
    expect(result.killedBy).toBe('idle')
    expect(result.exitCode).not.toBe(0)
  })

  it('fails with BinaryMissing for an unknown executable', async () => {
    const exit = await Effect.runPromiseExit(machine.exec({ cmd: ['definitely-not-a-binary-xyz'] }))
    expect(exit._tag).toBe('Failure')
    expect(JSON.stringify(exit)).toContain('BinaryMissing')
  })

  it('putFile/getFile round-trip', async () => {
    const bytes = await Effect.runPromise(
      machine
        .putFile('inbox/hello.txt', 'hi')
        .pipe(Effect.andThen(machine.getFile('inbox/hello.txt')))
    )
    expect(Buffer.from(bytes).toString()).toBe('hi')
  })
})

describe('LineBuffer', () => {
  it('splits across chunks and strips CR', () => {
    const b = new LineBuffer()
    expect(b.push('a\r\nb')).toEqual(['a'])
    expect(b.push('c\nd')).toEqual(['bc'])
    expect(b.flush()).toEqual(['d'])
    expect(b.flush()).toEqual([])
  })
})
