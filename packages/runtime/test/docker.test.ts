/**
 * Docker provider smoke test. Needs a reachable daemon and an image with `sh`,
 * `sleep`, `env` and `cat`:
 *
 *   TAUT_TEST_DOCKER=1 [TAUT_TEST_DOCKER_IMAGE=taut/agent:latest] pnpm --filter @taut/runtime test -- docker
 */
import Dockerode from 'dockerode'
import { Effect, Exit, Fiber, Option, Scope, Stream } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { PTY_TERM, containerName, makeDockerProvider, networkName } from '../src/machine/docker.js'
import type { Machine, Pty } from '../src/machine/types.js'
import { specFor, tempHome } from './helpers.js'

/* eslint-disable turbo/no-undeclared-env-vars */
const enabled = process.env['TAUT_TEST_DOCKER'] === '1'
const image = process.env['TAUT_TEST_DOCKER_IMAGE'] ?? 'taut/agent:latest'
/* eslint-enable turbo/no-undeclared-env-vars */

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe.skipIf(!enabled)('DockerProvider (TAUT_TEST_DOCKER=1)', () => {
  const docker = new Dockerode()
  const provider = makeDockerProvider({ docker, image })
  let home = ''
  let cleanup = async () => {}
  let machine: Machine
  const spec = () =>
    specFor(home, { agentId: 'agt_dockertest', companySlug: 'tauttest', handle: 'probe', image })

  beforeAll(async () => {
    ;({ home, cleanup } = await tempHome())
    machine = await Effect.runPromise(provider.ensure(spec()))
  }, 300_000)

  afterAll(async () => {
    await Effect.runPromise(provider.destroy('agt_dockertest'))
    try {
      await docker.getNetwork(networkName('tauttest')).remove()
    } catch {
      // keep going
    }
    await cleanup()
  })

  it('creates a hardened, running container on the company network', async () => {
    const info = await docker.getContainer(containerName(spec())).inspect()
    expect(info.State.Running).toBe(true)
    expect(info.Config.User).toBe('1000:1000')
    expect(info.HostConfig.CapDrop).toEqual(['ALL'])
    expect(info.HostConfig.SecurityOpt).toEqual(['no-new-privileges'])
    expect(info.HostConfig.PidsLimit).toBe(512)
    expect(info.HostConfig.NetworkMode).toBe(networkName('tauttest'))
    expect(info.HostConfig.ReadonlyRootfs).toBe(true)
    expect(info.HostConfig.Binds?.[0]).toContain(':/home/agent')
    expect(await Effect.runPromise(machine.status())).toBe('running')
    expect(Option.isSome(await Effect.runPromise(provider.get('agt_dockertest')))).toBe(true)
  })

  it('exec streams stdout/stderr, honours cwd, env and stdin, and returns the exit code', async () => {
    const out: Array<string> = []
    const err: Array<string> = []
    const result = await Effect.runPromise(
      machine.exec({
        cmd: ['sh', '-c', 'echo "$TASK_SECRET"; pwd; cat; echo oops 1>&2; exit 4'],
        cwd: '/home/agent/work',
        env: { TASK_SECRET: 'shh' },
        stdin: 'from-stdin\n',
        onLine: (l) => out.push(l),
        onStderr: (l) => err.push(l)
      })
    )
    expect(result.exitCode).toBe(4)
    expect(out).toEqual(['shh', '/home/agent/work', 'from-stdin'])
    expect(err).toEqual(['oops'])
    const env = await docker.getContainer(containerName(spec())).inspect()
    expect(env.Config.Env?.some((e) => e.includes('TASK_SECRET'))).toBe(false)
  })

  it('putFile/getFile round-trip through the bind mount', async () => {
    const bytes = await Effect.runPromise(
      machine
        .putFile('work/tsk_1/CLAUDE.md', '# hi')
        .pipe(Effect.andThen(machine.getFile('work/tsk_1/CLAUDE.md')))
    )
    expect(Buffer.from(bytes).toString()).toBe('# hi')
  })

  it('interruption kills the exec inside the container', async () => {
    const fiber = Effect.runFork(machine.exec({ cmd: ['sh', '-c', 'echo started; sleep 300'] }))
    await sleep(1500)
    await Effect.runPromise(Fiber.interrupt(fiber))
    await sleep(1500)
    const lines: Array<string> = []
    await Effect.runPromise(
      machine.exec({ cmd: ['sh', '-c', 'ps -eo args || ls /proc'], onLine: (l) => lines.push(l) })
    )
    expect(lines.some((l) => l.includes('sleep 300'))).toBe(false)
  }, 60_000)

  // ── PTY (docs/build-plan-workspace.md D8, D9) ─────────────────────────────

  /**
   * One reader per PTY (the output queue is consumed once): everything printed lands
   * in `text`; `waitFor` polls it until `predicate` holds or `ms` elapse.
   */
  const tail = (pty: Pty) => {
    const buf = { text: '' }
    const reader = Effect.runFork(
      Stream.runForEach(pty.output, (chunk) =>
        Effect.sync(() => {
          buf.text += Buffer.from(chunk).toString('utf8')
        })
      )
    )
    const waitFor = async (predicate: (text: string) => boolean, ms = 10_000) => {
      const startedAt = Date.now()
      while (!predicate(buf.text) && Date.now() - startedAt < ms) await sleep(50)
      return buf.text
    }
    return { buf, waitFor, reader }
  }
  const type = (pty: Pty, text: string) =>
    Effect.runPromise(pty.write(new TextEncoder().encode(text)))

  it('openPty runs a login shell with TERM=xterm-256color, echoes stdin and honours resize', async () => {
    const scope = await Effect.runPromise(Scope.make())
    const pty = await Effect.runPromise(
      machine.openPty({ cols: 120, rows: 40 }).pipe(Scope.extend(scope))
    )
    expect(pty.shell).toBe('/bin/bash')
    const out = tail(pty)
    await type(pty, 'echo "T=$TERM C=$COLUMNS L=$LINES U=$(id -u)"; echo MARK1\n')
    const first = await out.waitFor((t) => t.includes('MARK1'))
    expect(first).toContain(`T=${PTY_TERM}`)
    expect(first).toContain('C=120 L=40')
    expect(first).toContain('U=1000')

    await Effect.runPromise(pty.resize(50, 20))
    await sleep(300)
    await type(pty, 'echo "C=$COLUMNS L=$LINES"; echo MARK2\n')
    const second = await out.waitFor((t) => t.includes('MARK2'))
    expect(second).toContain('C=50 L=20')

    // `exit` from the shell settles `exit` with the code and ends the output stream.
    await type(pty, 'exit 7\n')
    expect(await Effect.runPromise(pty.exit)).toBe(7)
    await Effect.runPromise(Fiber.join(out.reader))
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }, 60_000)

  it('closing the PTY scope kills the shell and everything it started', async () => {
    const scope = await Effect.runPromise(Scope.make())
    const pty = await Effect.runPromise(
      machine.openPty({ cols: 80, rows: 24 }).pipe(Scope.extend(scope))
    )
    const out = tail(pty)
    await type(pty, 'sleep 400 &\necho MARK\n')
    await out.waitFor((t) => t.includes('MARK'))
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await sleep(1500)
    const lines: Array<string> = []
    await Effect.runPromise(
      machine.exec({ cmd: ['sh', '-c', 'ps -eo args'], onLine: (l) => lines.push(l) })
    )
    expect(lines.some((l) => l.includes('sleep 400'))).toBe(false)
    expect(lines.some((l) => l.includes('bash -l'))).toBe(false)
  }, 60_000)

  // ── tunnel + task freeze (docs/build-plan-workspace.md D15, D18) ────────────

  it('openTunnel splices a loopback port in the box; a closed port fails with ExecFailed', async () => {
    // an echo server on loopback inside the box, detached from this exec
    await Effect.runPromise(
      machine.exec({
        cmd: [
          'bash',
          '-c',
          `env -u TAUT_EXEC_ID setsid nohup node -e "require('net').createServer((s)=>s.pipe(s)).listen(9333,'127.0.0.1')" >/dev/null 2>&1 </dev/null & ` +
            'for i in $(seq 1 50); do (exec 3<>/dev/tcp/127.0.0.1/9333) 2>/dev/null && exit 0; sleep 0.1; done; exit 1'
        ]
      })
    )
    const scope = await Effect.runPromise(Scope.make())
    const tunnel = await Effect.runPromise(machine.openTunnel(9333).pipe(Scope.extend(scope)))
    const echoed = new Promise<string>((resolve) => {
      let text = ''
      tunnel.on('data', (chunk: Buffer) => {
        text += chunk.toString()
        if (text.includes('\n')) resolve(text)
      })
    })
    tunnel.write('ping through the relay\n')
    expect(await echoed).toBe('ping through the relay\n')
    await Effect.runPromise(Scope.close(scope, Exit.void))

    const refused = await Effect.runPromise(
      Effect.flip(machine.openTunnel(9999).pipe(Effect.scoped))
    )
    expect(refused._tag).toBe('ExecFailed')
    expect(refused.message).toContain('9999')
  }, 60_000)

  it('signalTasks freezes task execs only: a PTY shell is left alone', async () => {
    const task = Effect.runFork(machine.exec({ cmd: ['sh', '-c', 'sleep 300'] }))
    await sleep(1000)
    const scope = await Effect.runPromise(Scope.make())
    const pty = await Effect.runPromise(
      machine.openPty({ cols: 80, rows: 24 }).pipe(Scope.extend(scope))
    )
    const out = tail(pty)

    const states = async () => {
      const lines: Array<string> = []
      await Effect.runPromise(
        machine.exec({
          cmd: ['sh', '-c', 'ps -o stat=,args= -C sleep'],
          onLine: (l) => lines.push(l)
        })
      )
      return lines.filter((l) => l.includes('sleep 300'))
    }
    const environs: Array<string> = []
    await Effect.runPromise(
      machine.exec({
        cmd: [
          'sh',
          '-c',
          'for p in /proc/[0-9]*; do echo "$p $(tr "\\0" " " < $p/environ 2>/dev/null | grep -o "TAUT[A-Z_]*=[^ ]*" | tr "\\n" " ")"; done'
        ],
        onLine: (l) => environs.push(l)
      })
    )
    expect(
      (await states()).length,
      `sleep 300 must be running; environs:\n${environs.join('\n')}`
    ).toBeGreaterThanOrEqual(1)
    const stopped = await Effect.runPromise(machine.signalTasks('STOP'))
    expect(stopped, `environs:\n${environs.join('\n')}`).toBeGreaterThanOrEqual(1)
    expect((await states()).every((l) => l.trim().startsWith('T'))).toBe(true)
    // the human's shell still answers: it carries the workspace marker
    await type(pty, 'echo STILL-ALIVE\n')
    expect(await out.waitFor((t) => t.includes('STILL-ALIVE'))).toContain('STILL-ALIVE')

    const resumed = await Effect.runPromise(machine.signalTasks('CONT'))
    expect(resumed).toBeGreaterThanOrEqual(1)
    expect((await states()).every((l) => !l.trim().startsWith('T'))).toBe(true)
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await Effect.runPromise(Fiber.interrupt(task))
  }, 60_000)

  it('openPty fails with MachineUnavailable while the container is stopped', async () => {
    await Effect.runPromise(machine.stop())
    const failure = await Effect.runPromise(
      Effect.flip(machine.openPty({ cols: 80, rows: 24 }).pipe(Effect.scoped))
    )
    expect(failure._tag).toBe('MachineUnavailable')
    await Effect.runPromise(machine.start())
  }, 60_000)

  it('stop/start round-trip and destroy keeps the home', async () => {
    await Effect.runPromise(machine.stop())
    expect(await Effect.runPromise(machine.status())).toBe('stopped')
    await Effect.runPromise(machine.start())
    expect(await Effect.runPromise(machine.status())).toBe('running')
    const again = await Effect.runPromise(provider.ensure(spec()))
    expect(again.id).toBe(machine.id)
  }, 60_000)
})
