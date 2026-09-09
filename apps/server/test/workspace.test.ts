/**
 * Agent workspace, Phase 1b + 1c (docs/build-plan-workspace.md): the machine
 * endpoints and their D3 gate, the process list (D13), the home file read behind
 * the output gallery (D12), and `/ws/terminal` with every D10 limit — over the fake
 * runtime (`_fakeRuntime.ts`) and a scripted PTY (`_fakePty.ts`), so no docker and
 * no shell is involved. The real docker PTY is covered in
 * `packages/runtime/test/docker.test.ts` behind `TAUT_TEST_DOCKER=1`.
 */
import { layer } from '@effect/vitest'
import type { Agent, Company, Department } from '@taut/contract/domain'
import { AgentId } from '@taut/contract/ids'
import {
  TERMINAL_CLOSE,
  type TerminalClientFrame,
  type TerminalServerFrame
} from '@taut/contract/terminal'
import type { ExecOptions, MachineSpec, PtyOptions } from '@taut/runtime'
import { Effect, Layer } from 'effect'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebSocket } from 'ws'
import { afterAll, describe, expect } from 'vitest'
import { appLive } from '../src/layers.js'
import { TerminalWsServer } from '../src/realtime/terminalWs.js'
import { agentHomePath } from '../src/services/homes.js'
import { baseUrl, makeClient, sleep, type TestClient } from './_client.js'
import { makeFakePty, type FakePtyHandle } from './_fakePty.js'
import { makeFakeRuntime, type FakeRuntimeOptions } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testConfig } from './_harness.js'

const avatar = { kind: 'emoji', value: 'A' } as const

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const agentPayload = (handle: string, departmentId: Department['id']) => ({
  handle,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  avatar,
  role: 'x',
  mandate: 'x',
  runtimeKind: 'claude-code' as const,
  permissionMode: 'plan' as const,
  departmentId
})

const b64 = (text: string): string => Buffer.from(text, 'utf8').toString('base64')
const unb64 = (data: string): string => Buffer.from(data, 'base64').toString('utf8')

// ── a terminal socket client ────────────────────────────────────────────────

interface TerminalClient {
  readonly ws: WebSocket
  readonly frames: Array<TerminalServerFrame>
  readonly next: (ms?: number) => Promise<TerminalServerFrame>
  /** The next frame with this tag, skipping others (`control` / `browser` interleave). */
  readonly nextOf: <T extends TerminalServerFrame['_tag']>(
    tag: T,
    ms?: number
  ) => Promise<Extract<TerminalServerFrame, { _tag: T }>>
  readonly send: (frame: TerminalClientFrame) => void
  readonly closed: Promise<{ code: number; reason: string }>
  readonly close: () => Promise<void>
}

const connectTerminal = (url: string, cookie?: string) =>
  Effect.promise(
    () =>
      new Promise<TerminalClient>((resolve, reject) => {
        const ws = new WebSocket(url, cookie ? { headers: { cookie } } : {})
        const frames: Array<TerminalServerFrame> = []
        const buffer: Array<TerminalServerFrame> = []
        const waiters: Array<(f: TerminalServerFrame) => void> = []
        const closed = new Promise<{ code: number; reason: string }>((res) => {
          ws.once('close', (code, reason) => res({ code, reason: reason.toString() }))
        })
        ws.on('message', (data) => {
          const frame = JSON.parse(data.toString()) as TerminalServerFrame
          frames.push(frame)
          const waiter = waiters.shift()
          if (waiter) waiter(frame)
          else buffer.push(frame)
        })
        ws.on('unexpected-response', (_req, res) => reject(new Error(`http ${res.statusCode}`)))
        ws.on('error', reject)
        const next = (ms = 5000) =>
          new Promise<TerminalServerFrame>((res, rej) => {
            const buffered = buffer.shift()
            if (buffered) return res(buffered)
            const timer = setTimeout(() => rej(new Error('timed out waiting for frame')), ms)
            waiters.push((f) => {
              clearTimeout(timer)
              res(f)
            })
          })
        ws.on('open', () =>
          resolve({
            ws,
            frames,
            closed,
            next,
            nextOf: async (tag, ms = 5000) => {
              const deadline = Date.now() + ms
              for (;;) {
                const frame = await next(Math.max(1, deadline - Date.now()))
                if (frame._tag === tag) return frame as never
              }
            },
            send: (frame) => ws.send(JSON.stringify(frame)),
            close: () =>
              new Promise<void>((res) => {
                ws.once('close', () => res())
                ws.close()
              })
          })
        )
      })
  )

/** Frames until `predicate` holds or `ms` elapse (whichever first). */
const collect = async (
  client: TerminalClient,
  predicate: (frames: ReadonlyArray<TerminalServerFrame>) => boolean,
  ms = 1500
) => {
  const startedAt = Date.now()
  while (!predicate(client.frames) && Date.now() - startedAt < ms) {
    await new Promise((r) => setTimeout(r, 25))
  }
  return client.frames
}

const dataText = (frames: ReadonlyArray<TerminalServerFrame>): string =>
  frames
    .filter((f): f is Extract<TerminalServerFrame, { _tag: 'data' }> => f._tag === 'data')
    .map((f) => unb64(f.data))
    .join('')

// ── a docker-shaped fake runtime with the scripted PTY and a scripted `ps` ───

const PS_LINES: ReadonlyArray<string> = [
  '    1     0  86400  0.0  0.1 sleep infinity',
  ' 4242     1     17 12.5  3.4 node /usr/local/bin/claude -p --output-format stream-json',
  '   99  4242      2  0.0  0.0 ps -eo pid,ppid,etimes,pcpu,pmem,args --no-headers',
  'this is not a ps line'
]

const dockerFake = (handles: Array<FakePtyHandle>) => {
  const options: FakeRuntimeOptions = {
    provider: 'docker',
    openPty: (_spec: MachineSpec, o: PtyOptions) =>
      makeFakePty(o).pipe(
        Effect.tap((handle) =>
          Effect.sync(() => {
            handles.push(handle)
          })
        ),
        Effect.map((handle) => handle.pty)
      ),
    exec: (o: ExecOptions) => (o.cmd[0] === 'ps' ? PS_LINES : undefined)
  }
  return makeFakeRuntime(options)
}

/** Owner (admin, head of engineering), dana (head of design), bob (member); mila ∈ design, bruno ∈ engineering. */
const setupCompany = Effect.gen(function* () {
  const owner = yield* makeClient
  yield* owner.api.auth.signup({
    payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
  })
  const acme = yield* owner.api.companies.create({
    payload: { slug: 'acme', name: 'Acme', avatar }
  })
  const me = yield* owner.api.auth.me()
  const invite = (email: string) => owner.api.invites.create({ payload: { email, role: 'member' } })
  const dana = yield* makeClient
  const danaAccepted = yield* dana.api.invites.accept({
    payload: {
      token: (yield* invite('dana@taut.local')).token,
      name: 'Dana',
      password: 'password123'
    }
  })
  const bob = yield* makeClient
  yield* bob.api.invites.accept({
    payload: {
      token: (yield* invite('bob@taut.local')).token,
      name: 'Bob',
      password: 'password123'
    }
  })
  const engineering = yield* owner.api.departments.create({
    payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
  })
  const design = yield* owner.api.departments.create({
    payload: { name: 'Design', slug: 'design', headUserId: danaAccepted.user.id }
  })
  const mila = yield* dana.api.agents.create({ payload: agentPayload('mila', design.id) })
  const bruno = yield* owner.api.agents.create({ payload: agentPayload('bruno', engineering.id) })
  return { owner, dana, bob, acme, engineering, design, mila, bruno }
})

// ═══════════════════════════════════════════════════════════════════════════
// A. docker-shaped box: endpoints, gallery read, the socket, per-viewer/per-agent caps
// ═══════════════════════════════════════════════════════════════════════════

describe('workspace: machine endpoints, gallery read, terminal socket (docker fake)', () => {
  const dir = makeTempDir()
  afterAll(() => removeDir(dir))
  const handles: Array<FakePtyHandle> = []
  const fake = dockerFake(handles)
  const app = appLive(fake.layer, { maxPerAgent: 1 }).pipe(Layer.provide(testConfig(dir)))

  const state: {
    owner?: TestClient
    dana?: TestClient
    bob?: TestClient
    acme?: Company
    mila?: Agent
    bruno?: Agent
  } = {}

  layer(app, { excludeTestServices: true })((it) => {
    it.effect('setup', () =>
      Effect.gen(function* () {
        Object.assign(state, yield* setupCompany)
      })
    )

    it.effect('D3: only admin+ or the head of the agent’s department may see the box', () =>
      Effect.gen(function* () {
        const { dana, bob, owner } = {
          dana: need(state.dana, 'dana'),
          bob: need(state.bob, 'bob'),
          owner: need(state.owner, 'owner')
        }
        const mila = need(state.mila, 'mila')
        const bruno = need(state.bruno, 'bruno')

        const byBob = yield* Effect.flip(bob.api.agents.getMachine({ path: { agentId: mila.id } }))
        expect(byBob._tag).toBe('Forbidden')
        const wrongDept = yield* Effect.flip(
          dana.api.agents.getMachine({ path: { agentId: bruno.id } })
        )
        expect(wrongDept._tag).toBe('Forbidden')
        const gone = yield* Effect.flip(
          owner.api.agents.getMachine({ path: { agentId: AgentId.make('agt_nope') } })
        )
        expect(gone._tag).toBe('NotFound')
        const start = yield* Effect.flip(
          bob.api.agents.startMachine({ path: { agentId: mila.id } })
        )
        expect(start._tag).toBe('Forbidden')
        const stop = yield* Effect.flip(bob.api.agents.stopMachine({ path: { agentId: mila.id } }))
        expect(stop._tag).toBe('Forbidden')
        const ps = yield* Effect.flip(bob.api.agents.listProcesses({ path: { agentId: mila.id } }))
        expect(ps._tag).toBe('Forbidden')

        // the head sees her agent; the admin sees everyone's
        const info = yield* dana.api.agents.getMachine({ path: { agentId: mila.id } })
        expect(info).toEqual({
          provider: 'docker',
          status: 'missing',
          home: '',
          terminal: true,
          liveView: true
        })
        expect((yield* owner.api.agents.getMachine({ path: { agentId: mila.id } })).status).toBe(
          'missing'
        )
      })
    )

    it.effect(
      'D5: start is create-or-reuse and reports the running box; stop keeps it listed',
      () =>
        Effect.gen(function* () {
          const dana = need(state.dana, 'dana')
          const mila = need(state.mila, 'mila')
          const started = yield* dana.api.agents.startMachine({ path: { agentId: mila.id } })
          expect(started.status).toBe('running')
          expect(started.machineId).toBe(`fake:${mila.id}`)
          expect(started.terminal).toBe(true)
          expect(started.home).toBe(agentHomePath(dir, 'acme', 'mila'))
          const again = yield* dana.api.agents.startMachine({ path: { agentId: mila.id } })
          expect(again.machineId).toBe(started.machineId)
          const info = yield* dana.api.agents.getMachine({ path: { agentId: mila.id } })
          expect(info.status).toBe('running')
          const stopped = yield* dana.api.agents.stopMachine({ path: { agentId: mila.id } })
          expect(stopped.machineId).toBe(started.machineId)
        })
    )

    it.effect('D13: processes come from `ps` inside the box, parsed, without the ps row', () =>
      Effect.gen(function* () {
        const dana = need(state.dana, 'dana')
        const mila = need(state.mila, 'mila')
        const bruno = need(state.bruno, 'bruno')
        const owner = need(state.owner, 'owner')
        const entries = yield* dana.api.agents.listProcesses({ path: { agentId: mila.id } })
        expect(entries.map((e) => e.pid)).toEqual([1, 4242])
        expect(entries[1]).toEqual({
          pid: 4242,
          ppid: 1,
          elapsedSeconds: 17,
          cpuPercent: 12.5,
          memoryPercent: 3.4,
          command: 'node /usr/local/bin/claude -p --output-format stream-json'
        })
        const ps = fake.execs.filter((e) => e.cmd[0] === 'ps')
        expect(ps.length).toBe(1)
        expect(ps[0]!.cmd).toEqual(['ps', '-eo', 'pid,ppid,etimes,pcpu,pmem,args', '--no-headers'])
        // no box yet → nothing, not an error
        expect(yield* owner.api.agents.listProcesses({ path: { agentId: bruno.id } })).toEqual([])
      })
    )

    it.effect('D12: readFile streams a home file with its real content type, managers only', () =>
      Effect.gen(function* () {
        const { http } = yield* baseUrl
        const dana = need(state.dana, 'dana')
        const bob = need(state.bob, 'bob')
        const mila = need(state.mila, 'mila')
        const home = agentHomePath(dir, 'acme', 'mila')
        const out = join(home, '.taut', 'browser', 'out')
        mkdirSync(out, { recursive: true })
        const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
        writeFileSync(join(out, 'page-1.png'), png)

        const url = (path: string) =>
          `${http}/api/agents/${mila.id}/files/content?path=${encodeURIComponent(path)}`
        const cookie = yield* dana.cookieHeader
        const ok = yield* Effect.promise(() =>
          fetch(url('.taut/browser/out/page-1.png'), { headers: { cookie } })
        )
        expect(ok.status).toBe(200)
        expect(ok.headers.get('content-type')).toBe('image/png')
        expect(ok.headers.get('content-disposition')).toContain('inline')
        expect(ok.headers.get('x-content-type-options')).toBe('nosniff')
        expect(Buffer.from(yield* Effect.promise(() => ok.arrayBuffer()))).toEqual(png)

        const listed = yield* dana.api.agents.listFiles({
          path: { agentId: mila.id },
          urlParams: { path: '.taut/browser/out' }
        })
        expect(listed.items.map((f) => f.path)).toEqual(['.taut/browser/out/page-1.png'])

        const missing = yield* Effect.promise(() =>
          fetch(url('.taut/browser/out/nope.png'), { headers: { cookie } })
        )
        expect(missing.status).toBe(404)
        const directory = yield* Effect.promise(() =>
          fetch(url('.taut/browser/out'), { headers: { cookie } })
        )
        expect(directory.status).toBe(404)
        const escape = yield* Effect.promise(() =>
          fetch(url('../../../taut.db'), { headers: { cookie } })
        )
        expect(escape.status).toBe(403)
        const bobCookie = yield* bob.cookieHeader
        const byBob = yield* Effect.promise(() =>
          fetch(url('.taut/browser/out/page-1.png'), { headers: { cookie: bobCookie } })
        )
        expect(byBob.status).toBe(403)
      })
    )

    it.effect('D6: the socket rejects before the handshake: 400 bad id, 401, 403, 404', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const dana = need(state.dana, 'dana')
        const bob = need(state.bob, 'bob')
        const mila = need(state.mila, 'mila')
        const bruno = need(state.bruno, 'bruno')
        const attempt = (url: string, cookie?: string) =>
          Effect.flip(Effect.tryPromise(() => Effect.runPromise(connectTerminal(url, cookie))))

        const badId = yield* attempt(`${ws}/ws/terminal?agentId=nope`, yield* dana.cookieHeader)
        expect(String(badId.cause)).toContain('400')
        const noCookie = yield* attempt(`${ws}/ws/terminal?agentId=${mila.id}`)
        expect(String(noCookie.cause)).toContain('401')
        const member = yield* attempt(
          `${ws}/ws/terminal?agentId=${mila.id}`,
          yield* bob.cookieHeader
        )
        expect(String(member.cause)).toContain('403')
        const wrongDept = yield* attempt(
          `${ws}/ws/terminal?agentId=${bruno.id}`,
          yield* dana.cookieHeader
        )
        expect(String(wrongDept.cause)).toContain('403')
        const unknown = yield* attempt(
          `${ws}/ws/terminal?agentId=agt_00000000000000000000000000`,
          yield* dana.cookieHeader
        )
        expect(String(unknown.cause)).toContain('404')
        // still nobody else's: /ws keeps its 404 for paths that are neither
        const stray = yield* attempt(`${ws}/nope`, yield* dana.cookieHeader)
        expect(String(stray.cause)).toContain('404')
      })
    )

    it.effect('a box that was never started refuses with an error frame and 4503', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const owner = need(state.owner, 'owner')
        const bruno = need(state.bruno, 'bruno')
        const client = yield* connectTerminal(
          `${ws}/ws/terminal?agentId=${bruno.id}`,
          yield* owner.cookieHeader
        )
        const frame = yield* Effect.promise(() => client.nextOf('error'))
        expect(frame._tag).toBe('error')
        if (frame._tag === 'error') expect(frame.message).toContain('has not been started')
        const closed = yield* Effect.promise(() => client.closed)
        expect(closed.code).toBe(TERMINAL_CLOSE.unavailable)
      })
    )

    it.effect(
      'D7/D8: ready → base64 stdin echoes back → resize reaches the PTY → exit frame + 1000',
      () =>
        Effect.gen(function* () {
          const { ws } = yield* baseUrl
          const dana = need(state.dana, 'dana')
          const mila = need(state.mila, 'mila')
          const terminals = yield* TerminalWsServer
          const before = handles.length
          const client = yield* connectTerminal(
            `${ws}/ws/terminal?agentId=${mila.id}&cols=100&rows=30`,
            yield* dana.cookieHeader
          )
          const ready = yield* Effect.promise(() => client.nextOf('ready'))
          expect(ready).toEqual({
            _tag: 'ready',
            shell: '/bin/fake-sh',
            machineId: `fake:${mila.id}`
          })
          expect(handles.length).toBe(before + 1)
          const handle = handles[handles.length - 1]!
          expect(handle.options).toEqual({ cols: 100, rows: 30 })
          expect(yield* terminals.openCount(mila.id)).toBe(1)

          // a multi-byte sequence survives the round trip because it travels as bytes
          client.send({ _tag: 'stdin', data: b64('echo héllo — 🙂\n') })
          const echoed = yield* Effect.promise(() => client.nextOf('data'))
          expect(echoed._tag).toBe('data')
          if (echoed._tag === 'data') expect(unb64(echoed.data)).toBe('echo héllo — 🙂\n')
          expect(handle.input()).toBe('echo héllo — 🙂\n')

          client.send({ _tag: 'resize', cols: 90, rows: 40 })
          yield* sleep(100)
          expect(handle.resizes).toEqual([{ cols: 90, rows: 40 }])
          // an invalid frame is ignored, not fatal
          client.ws.send('{"_tag":"resize","cols":0,"rows":9999}')
          client.ws.send('not json')
          yield* sleep(100)
          expect(handle.resizes.length).toBe(1)

          client.send({ _tag: 'stdin', data: b64('exit 3\n') })
          const exit = yield* Effect.promise(() => client.nextOf('exit'))
          expect(exit).toEqual({ _tag: 'exit', exitCode: 3 })
          const closed = yield* Effect.promise(() => client.closed)
          expect(closed.code).toBe(TERMINAL_CLOSE.exited)
          yield* sleep(100)
          expect(yield* terminals.openCount(mila.id)).toBe(0)
        })
    )

    it.effect('D10: one terminal per viewer per agent (4409), then the per-agent cap (4429)', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const dana = need(state.dana, 'dana')
        const owner = need(state.owner, 'owner')
        const mila = need(state.mila, 'mila')
        const url = `${ws}/ws/terminal?agentId=${mila.id}`
        const first = yield* connectTerminal(url, yield* dana.cookieHeader)
        expect((yield* Effect.promise(() => first.nextOf('ready')))._tag).toBe('ready')

        const again = yield* connectTerminal(url, yield* dana.cookieHeader)
        const busy = yield* Effect.promise(() => again.nextOf('error'))
        expect(busy._tag).toBe('error')
        if (busy._tag === 'error') expect(busy.message).toContain('already have a terminal')
        expect((yield* Effect.promise(() => again.closed)).code).toBe(TERMINAL_CLOSE.viewerBusy)

        // maxPerAgent is 1 in this app: the admin is a different viewer and still refused
        const other = yield* connectTerminal(url, yield* owner.cookieHeader)
        const full = yield* Effect.promise(() => other.nextOf('error'))
        expect(full._tag).toBe('error')
        if (full._tag === 'error') expect(full.message).toContain('already has 1 terminals')
        expect((yield* Effect.promise(() => other.closed)).code).toBe(TERMINAL_CLOSE.agentFull)

        // the first session is untouched by the refusals, and the refusals took no PTY
        first.send({ _tag: 'stdin', data: b64('still here\n') })
        const echoed = yield* Effect.promise(() => first.nextOf('data'))
        if (echoed._tag === 'data') expect(unb64(echoed.data)).toBe('still here\n')
        const handle = handles[handles.length - 1]!
        expect(handle.input()).toBe('still here\n')

        // the viewer leaving kills the PTY (scope) and frees the slot
        yield* Effect.promise(() => first.close())
        yield* sleep(150)
        expect(handle.killed).toBe(true)
        const terminals = yield* TerminalWsServer
        expect(yield* terminals.openCount(mila.id)).toBe(0)
        const back = yield* connectTerminal(url, yield* owner.cookieHeader)
        expect((yield* Effect.promise(() => back.nextOf('ready')))._tag).toBe('ready')
        yield* Effect.promise(() => back.close())
      })
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B. the time and volume limits, shrunk to milliseconds and bytes
// ═══════════════════════════════════════════════════════════════════════════

describe('workspace: idle timeout and hard cap (D10)', () => {
  const dir = makeTempDir()
  afterAll(() => removeDir(dir))
  const handles: Array<FakePtyHandle> = []
  const fake = dockerFake(handles)
  const app = appLive(fake.layer, { idleMs: 300, maxMs: 1200 }).pipe(Layer.provide(testConfig(dir)))

  const state: { owner?: TestClient; mila?: Agent } = {}

  layer(app, { excludeTestServices: true })((it) => {
    it.effect('setup', () =>
      Effect.gen(function* () {
        const { owner, mila } = yield* setupCompany
        yield* owner.api.agents.startMachine({ path: { agentId: mila.id } })
        Object.assign(state, { owner, mila })
      })
    )

    it.effect('idle: no input and no output for the limit → notice, 4408, PTY killed', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const owner = need(state.owner, 'owner')
        const mila = need(state.mila, 'mila')
        const client = yield* connectTerminal(
          `${ws}/ws/terminal?agentId=${mila.id}`,
          yield* owner.cookieHeader
        )
        expect((yield* Effect.promise(() => client.nextOf('ready')))._tag).toBe('ready')
        const startedAt = Date.now()
        const notice = yield* Effect.promise(() => client.nextOf('error', 2000))
        expect(notice._tag).toBe('error')
        if (notice._tag === 'error') expect(notice.message).toContain('without activity')
        const closed = yield* Effect.promise(() => client.closed)
        expect(closed.code).toBe(TERMINAL_CLOSE.idle)
        expect(Date.now() - startedAt).toBeGreaterThanOrEqual(250)
        yield* sleep(50)
        expect(handles[handles.length - 1]!.killed).toBe(true)
      })
    )

    it.effect(
      'activity resets the idle clock, but the hard cap still ends the session (4410)',
      () =>
        Effect.gen(function* () {
          const { ws } = yield* baseUrl
          const owner = need(state.owner, 'owner')
          const mila = need(state.mila, 'mila')
          const client = yield* connectTerminal(
            `${ws}/ws/terminal?agentId=${mila.id}`,
            yield* owner.cookieHeader
          )
          expect((yield* Effect.promise(() => client.nextOf('ready')))._tag).toBe('ready')
          const startedAt = Date.now()
          // type every 100 ms — well inside the 300 ms idle limit
          const typing = setInterval(() => {
            if (client.ws.readyState === WebSocket.OPEN) {
              client.send({ _tag: 'stdin', data: b64('k') })
            }
          }, 100)
          const closed = yield* Effect.promise(() => client.closed)
          clearInterval(typing)
          const elapsed = Date.now() - startedAt
          expect(closed.code).toBe(TERMINAL_CLOSE.sessionCap)
          expect(elapsed).toBeGreaterThanOrEqual(1100)
          const notice = client.frames.find((f) => f._tag === 'error')
          expect(notice !== undefined && notice._tag === 'error' && notice.message).toContain(
            'sessions end after'
          )
          // the echoes kept flowing until the cap: idle never fired
          expect(client.frames.filter((f) => f._tag === 'data').length).toBeGreaterThan(5)
        })
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// B2. the output throttle alone (default idle/cap, so a quiet second is allowed)
// ═══════════════════════════════════════════════════════════════════════════

describe('workspace: output throttle (D10)', () => {
  const dir = makeTempDir()
  afterAll(() => removeDir(dir))
  const handles: Array<FakePtyHandle> = []
  const fake = dockerFake(handles)
  const app = appLive(fake.layer, { outputBytesPerSecond: 1000 }).pipe(
    Layer.provide(testConfig(dir))
  )

  const state: { owner?: TestClient; mila?: Agent } = {}

  layer(app, { excludeTestServices: true })((it) => {
    it.effect('setup', () =>
      Effect.gen(function* () {
        const { owner, mila } = yield* setupCompany
        yield* owner.api.agents.startMachine({ path: { agentId: mila.id } })
        Object.assign(state, { owner, mila })
      })
    )

    it.effect(
      'throttle: a burst over the budget is cut to it, one marker, budget back next second',
      () =>
        Effect.gen(function* () {
          const { ws } = yield* baseUrl
          const owner = need(state.owner, 'owner')
          const mila = need(state.mila, 'mila')
          const client = yield* connectTerminal(
            `${ws}/ws/terminal?agentId=${mila.id}`,
            yield* owner.cookieHeader
          )
          expect((yield* Effect.promise(() => client.nextOf('ready')))._tag).toBe('ready')
          const marker = '[output truncated]'
          client.send({ _tag: 'stdin', data: b64('burst 5000\n') })
          const frames = yield* Effect.promise(() =>
            collect(client, (fs) => dataText(fs).includes(marker), 1000)
          )
          const text = dataText(frames)
          expect(text.split(marker).length - 1).toBe(1)
          const payload = text.replace(`\r\n${marker}\r\n`, '')
          // the echo of the command line plus what survived of the 5000 x's — never past the budget
          expect(payload.startsWith('burst 5000\n')).toBe(true)
          expect(payload.length).toBeLessThanOrEqual(1000)
          expect(payload.length).toBeGreaterThan(900)

          // the next window admits output again, without a second marker
          yield* sleep(1050)
          const seen = client.frames.length
          client.send({ _tag: 'stdin', data: b64('back\n') })
          const later = yield* Effect.promise(() => collect(client, (fs) => fs.length > seen, 1000))
          expect(dataText(later.slice(seen))).toBe('back\n')
          yield* Effect.promise(() => client.close())
        })
    )
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// C. the local provider: an explainer, never a socket (D2)
// ═══════════════════════════════════════════════════════════════════════════

describe('workspace: local provider (D2)', () => {
  const dir = makeTempDir()
  afterAll(() => removeDir(dir))
  const fake = makeFakeRuntime()
  const app = appLive(fake.layer).pipe(Layer.provide(testConfig(dir)))

  layer(app, { excludeTestServices: true })((it) => {
    it.effect('reports terminal: false, lists no processes, and the socket refuses with 4503', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const { owner, mila } = yield* setupCompany
        const info = yield* owner.api.agents.getMachine({ path: { agentId: mila.id } })
        // No shell here (D2), but the browser live view is offered all the same.
        expect(info).toEqual({
          provider: 'local',
          status: 'missing',
          home: '',
          terminal: false,
          liveView: true
        })
        const started = yield* owner.api.agents.startMachine({ path: { agentId: mila.id } })
        expect(started.provider).toBe('local')
        expect(started.terminal).toBe(false)
        expect(started.liveView).toBe(true)
        expect(yield* owner.api.agents.listProcesses({ path: { agentId: mila.id } })).toEqual([])

        const client = yield* connectTerminal(
          `${ws}/ws/terminal?agentId=${mila.id}`,
          yield* owner.cookieHeader
        )
        const frame = yield* Effect.promise(() => client.nextOf('error'))
        expect(frame._tag).toBe('error')
        if (frame._tag === 'error') expect(frame.message).toContain('local provider')
        expect((yield* Effect.promise(() => client.closed)).code).toBe(TERMINAL_CLOSE.unavailable)

        // …but `pty=0` opens the same socket without one, for the live view alone.
        const browserOnly = yield* connectTerminal(
          `${ws}/ws/terminal?agentId=${mila.id}&pty=0`,
          yield* owner.cookieHeader
        )
        const ready = yield* Effect.promise(() => browserOnly.nextOf('ready'))
        expect(ready._tag).toBe('ready')
        if (ready._tag === 'ready') {
          expect(ready.shell).toBe('')
          expect(ready.machineId.length).toBeGreaterThan(0)
        }
        yield* Effect.promise(() => browserOnly.close())
      })
    )
  })
})
