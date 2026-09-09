/**
 * Browser live view + take control, Phase 1e/1f (docs/build-plan-workspace.md D11,
 * D12, D15, D16, D17): over the docker-shaped fake runtime, whose `openTunnel` hands
 * the server a TCP socket to `_fakeCdp.ts` — the same shape the docker relay yields —
 * so the real CDP client, screencast pacing, input mapping and the pause interlock run
 * end to end without Chromium.
 */
import { layer } from '@effect/vitest'
import type { Agent, Channel, Company, Task } from '@taut/contract/domain'
import type { AgentId } from '@taut/contract/ids'
import type { TerminalClientFrame, TerminalServerFrame } from '@taut/contract/terminal'
import type { ExecOptions, MachineSpec, PtyOptions } from '@taut/runtime'
import { Duration, Effect, Layer, Option, Redacted } from 'effect'
import { WebSocket } from 'ws'
import { afterAll, beforeAll, describe, expect } from 'vitest'
import { Scheduler } from '../src/agents/scheduler.js'
import { appLive } from '../src/layers.js'
import { TerminalWsServer } from '../src/realtime/terminalWs.js'
import { baseUrl, makeClient, sleep, type TestClient } from './_client.js'
import { startFakeCdp, type FakeCdp } from './_fakeCdp.js'
import { makeFakePty, type FakePtyHandle } from './_fakePty.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testConfig } from './_harness.js'

const avatar = { kind: 'emoji', value: 'A' } as const
const GOOD_SECRET = 'sk-ant-api03-good-000000000000000000000000'

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const unb64 = (data: string): string => Buffer.from(data, 'base64').toString('utf8')

// ── a terminal socket client (frames kept, close code exposed) ──────────────

interface TerminalClient {
  readonly ws: WebSocket
  readonly frames: Array<TerminalServerFrame>
  readonly next: (ms?: number) => Promise<TerminalServerFrame>
  /** The next frame with this tag, skipping others (screencast frames interleave). */
  readonly nextOf: <T extends TerminalServerFrame['_tag']>(
    tag: T,
    ms?: number
  ) => Promise<Extract<TerminalServerFrame, { _tag: T }>>
  readonly send: (frame: TerminalClientFrame) => void
  readonly closed: Promise<{ code: number }>
  readonly close: () => Promise<void>
}

const connectTerminal = (url: string, cookie: string) =>
  Effect.promise(
    () =>
      new Promise<TerminalClient>((resolve, reject) => {
        const ws = new WebSocket(url, { headers: { cookie } })
        const frames: Array<TerminalServerFrame> = []
        const buffer: Array<TerminalServerFrame> = []
        const waiters: Array<(f: TerminalServerFrame) => void> = []
        const closed = new Promise<{ code: number }>((res) => {
          ws.once('close', (code) => res({ code }))
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

const waitFor = <A, E, R>(
  what: string,
  probe: Effect.Effect<Option.Option<A>, E, R>,
  timeoutMs = 10_000
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = yield* probe
      if (Option.isSome(found)) return found.value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      yield* Effect.sleep(Duration.millis(50))
    }
  })

// ── the box: docker-shaped, PTY scripted, tunnel to the fake CDP, daemon "started" ──

describe('workspace: browser live view + take control (D11, D12, D15, D16, D17)', () => {
  const dir = makeTempDir()
  const handles: Array<FakePtyHandle> = []
  let cdp: FakeCdp
  const daemonExecs: Array<ExecOptions> = []
  const fake = makeFakeRuntime({
    provider: 'docker',
    openPty: (_spec: MachineSpec, o: PtyOptions) =>
      makeFakePty(o).pipe(
        Effect.tap((handle) => Effect.sync(() => void handles.push(handle))),
        Effect.map((handle) => handle.pty)
      ),
    openTunnel: () =>
      Effect.acquireRelease(
        Effect.sync(() => cdp.tunnel()),
        (socket) => Effect.sync(() => socket.destroy())
      ),
    exec: (o: ExecOptions) => {
      if (o.cmd[0] === 'bash' && (o.cmd[2] ?? '').includes('remote-debugging-port')) {
        daemonExecs.push(o)
        return ['started']
      }
      return undefined
    }
  })
  const app = appLive(fake.layer).pipe(Layer.provide(testConfig(dir)))

  beforeAll(async () => {
    cdp = await startFakeCdp({ burst: 20 })
  })
  afterAll(async () => {
    await cdp.close()
    removeDir(dir)
  })

  const state: {
    owner?: TestClient
    dana?: TestClient
    acme?: Company
    ownerId?: string
    danaId?: string
    mila?: Agent
    bruno?: Agent
    dm?: Channel
  } = {}

  layer(app, { excludeTestServices: true })((it) => {
    it.effect('setup: a seat, mila with browserAccess (design, head dana), bruno without', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const me = yield* owner.api.auth.me()
        const invite = yield* owner.api.invites.create({
          payload: { email: 'dana@taut.local', role: 'member' }
        })
        const dana = yield* makeClient
        const accepted = yield* dana.api.invites.accept({
          payload: { token: invite.token, name: 'Dana', password: 'password123' }
        })
        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const design = yield* owner.api.departments.create({
          payload: { name: 'Design', slug: 'design', headUserId: accepted.user.id }
        })
        const good = yield* owner.api.vault.add({
          payload: { kind: 'anthropic.api_key', label: 'good', secret: Redacted.make(GOOD_SECRET) }
        })
        yield* owner.api.subscriptions.add({
          payload: { runtime: 'claude-code', label: 'Good seat', credentialId: good.id }
        })
        const agent = (handle: string, departmentId: string, browserAccess: boolean) => ({
          handle,
          name: handle,
          avatar,
          role: 'x',
          mandate: 'x',
          runtimeKind: 'claude-code' as const,
          permissionMode: 'plan' as const,
          departmentId: departmentId as never,
          browserAccess
        })
        const mila = yield* dana.api.agents.create({ payload: agent('mila', design.id, true) })
        const bruno = yield* owner.api.agents.create({
          payload: agent('bruno', engineering.id, false)
        })
        yield* dana.api.agents.startMachine({ path: { agentId: mila.id } })
        yield* owner.api.agents.startMachine({ path: { agentId: bruno.id } })
        const dm = yield* dana.api.channels.dm({
          payload: { memberKind: 'agent', memberId: mila.id }
        })
        Object.assign(state, {
          owner,
          dana,
          acme,
          ownerId: me.user.id,
          danaId: accepted.user.id,
          mila,
          bruno,
          dm
        })
      })
    )

    it.effect('D16: no browserAccess → `browser: off`, no tunnel, no Chromium launched', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const owner = need(state.owner, 'owner')
        const bruno = need(state.bruno, 'bruno')
        const client = yield* connectTerminal(
          `${ws}/ws/terminal?agentId=${bruno.id}`,
          yield* owner.cookieHeader
        )
        expect((yield* Effect.promise(() => client.nextOf('ready')))._tag).toBe('ready')
        const browser = yield* Effect.promise(() => client.nextOf('browser'))
        expect(browser).toEqual({ _tag: 'browser', state: 'off' })
        yield* sleep(100)
        expect(cdp.connections).toBe(0)
        expect(daemonExecs.length).toBe(0)
        yield* Effect.promise(() => client.close())
      })
    )

    it.effect('D11: starting → live, Chromium launched loopback-only, frames paced to 8 fps', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const dana = need(state.dana, 'dana')
        const mila = need(state.mila, 'mila')
        const client = yield* connectTerminal(
          `${ws}/ws/terminal?agentId=${mila.id}`,
          yield* dana.cookieHeader
        )
        yield* Effect.promise(() => client.nextOf('ready'))
        const starting = yield* Effect.promise(() => client.nextOf('browser'))
        expect(starting.state).toBe('starting')
        const live = yield* Effect.promise(() => client.nextOf('browser'))
        expect(live.state).toBe('live')

        // the daemon script ran in the box with the D18 flags
        expect(daemonExecs.length).toBe(1)
        const script = daemonExecs[0]!.cmd[2] ?? ''
        expect(script).toContain('--remote-debugging-address=127.0.0.1')
        // the fake box's home is the host temp dir; the real one is /home/agent
        expect(script).toContain('/.taut/browser/profile"')
        // two tunnels: /json/version, then the CDP socket
        expect(cdp.connections).toBe(2)
        const started = cdp.calls.find((c) => c.method === 'Page.startScreencast')
        expect(started?.params).toMatchObject({ format: 'jpeg', quality: 60, maxWidth: 1280 })
        expect(started?.sessionId).toBe('session-1')

        // 20 frames arrived in a burst; the viewer gets ≤ 8/s, and the last one for sure
        const startedAt = Date.now()
        let last: string | undefined
        while (Date.now() - startedAt < 1500 && last !== unb64(cdp.emitted[19] ?? '')) {
          const frame = yield* Effect.promise(() => client.nextOf('frame', 1500))
          expect(frame.width).toBe(1280)
          expect(frame.height).toBe(720)
          last = unb64(frame.data)
        }
        expect(last).toBe('jpeg-20')
        const received = client.frames.filter((f) => f._tag === 'frame').length
        expect(received).toBeLessThanOrEqual(10)
        expect(received).toBeGreaterThanOrEqual(1)
        // every frame was acked at once, so Chromium keeps sending
        yield* sleep(50)
        expect(cdp.calls.filter((c) => c.method === 'Page.screencastFrameAck').length).toBe(20)
        yield* Effect.promise(() => client.close())
      })
    )

    it.effect('D12: input is dropped without control; with it, events reach the page scaled', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const dana = need(state.dana, 'dana')
        const mila = need(state.mila, 'mila')
        const client = yield* connectTerminal(
          `${ws}/ws/terminal?agentId=${mila.id}`,
          yield* dana.cookieHeader
        )
        yield* Effect.promise(() => client.nextOf('ready'))
        const initial = yield* Effect.promise(() => client.nextOf('control'))
        expect(initial).toEqual({ _tag: 'control', holder: null, paused: false })
        const live = yield* Effect.promise(() =>
          client.nextOf('browser').then((f) => (f.state === 'live' ? f : client.nextOf('browser')))
        )
        expect(live.state).toBe('live')
        const inputsBefore = cdp.calls.filter((c) => c.method.startsWith('Input.')).length

        // not holding control: nothing reaches the page (D12)
        client.send({
          _tag: 'input',
          event: {
            _tag: 'mouse',
            type: 'mousePressed',
            x: 0.5,
            y: 0.25,
            button: 'left',
            clickCount: 1
          }
        })
        yield* sleep(150)
        expect(cdp.calls.filter((c) => c.method.startsWith('Input.')).length).toBe(inputsBefore)

        client.send({ _tag: 'control', hold: true })
        const taken = yield* Effect.promise(() => client.nextOf('control'))
        expect(taken).toEqual({
          _tag: 'control',
          holder: need(state.danaId, 'danaId'),
          paused: false
        })
        const terminals = yield* TerminalWsServer
        expect(yield* terminals.controlOf(mila.id as AgentId)).toEqual({
          holder: state.danaId,
          paused: false
        })

        client.send({
          _tag: 'input',
          event: {
            _tag: 'mouse',
            type: 'mousePressed',
            x: 0.5,
            y: 0.25,
            button: 'left',
            clickCount: 1
          }
        })
        client.send({
          _tag: 'input',
          event: { _tag: 'key', type: 'keyDown', key: 'a', code: 'KeyA', text: 'a', keyCode: 65 }
        })
        client.send({
          _tag: 'input',
          event: { _tag: 'mouse', type: 'mouseWheel', x: 0.1, y: 0.1, deltaY: 120 }
        })
        yield* waitFor(
          'three input calls',
          Effect.sync(() => {
            const inputs = cdp.calls
              .filter((c) => c.method.startsWith('Input.'))
              .slice(inputsBefore)
            return inputs.length >= 3 ? Option.some(inputs) : Option.none()
          })
        )
        const inputs = cdp.calls.filter((c) => c.method.startsWith('Input.')).slice(inputsBefore)
        expect(inputs[0]).toEqual({
          method: 'Input.dispatchMouseEvent',
          sessionId: 'session-1',
          params: {
            type: 'mousePressed',
            x: 640,
            y: 180,
            button: 'left',
            clickCount: 1,
            modifiers: 0
          }
        })
        expect(inputs[1]).toEqual({
          method: 'Input.dispatchKeyEvent',
          sessionId: 'session-1',
          params: {
            type: 'keyDown',
            key: 'a',
            code: 'KeyA',
            text: 'a',
            windowsVirtualKeyCode: 65,
            nativeVirtualKeyCode: 65,
            modifiers: 0
          }
        })
        expect(inputs[2]?.params).toMatchObject({ type: 'mouseWheel', x: 128, y: 72, deltaY: 120 })

        // an out-of-range event never leaves the schema
        client.ws.send(
          JSON.stringify({
            _tag: 'input',
            event: { _tag: 'mouse', type: 'mousePressed', x: 2, y: 0 }
          })
        )
        client.ws.send(
          JSON.stringify({ _tag: 'input', event: { _tag: 'raw', method: 'Runtime.evaluate' } })
        )
        yield* sleep(150)
        expect(cdp.calls.filter((c) => c.method.startsWith('Input.')).length).toBe(inputsBefore + 3)

        client.send({ _tag: 'control', hold: false })
        const released = yield* Effect.promise(() => client.nextOf('control'))
        expect(released).toEqual({ _tag: 'control', holder: null, paused: false })
        client.send({
          _tag: 'input',
          event: { _tag: 'mouse', type: 'mouseMoved', x: 0.2, y: 0.2 }
        })
        yield* sleep(150)
        expect(cdp.calls.filter((c) => c.method.startsWith('Input.')).length).toBe(inputsBefore + 3)
        yield* Effect.promise(() => client.close())
      })
    )

    it.effect('D15: control is exclusive across viewers and released when the holder leaves', () =>
      Effect.gen(function* () {
        const { ws } = yield* baseUrl
        const dana = need(state.dana, 'dana')
        const owner = need(state.owner, 'owner')
        const mila = need(state.mila, 'mila')
        const url = `${ws}/ws/terminal?agentId=${mila.id}`
        const first = yield* connectTerminal(url, yield* dana.cookieHeader)
        yield* Effect.promise(() => first.nextOf('ready'))
        yield* Effect.promise(() => first.nextOf('control'))
        first.send({ _tag: 'control', hold: true })
        yield* Effect.promise(() => first.nextOf('control'))

        const second = yield* connectTerminal(url, yield* owner.cookieHeader)
        yield* Effect.promise(() => second.nextOf('ready'))
        // a joining viewer learns who is driving
        const seen = yield* Effect.promise(() => second.nextOf('control'))
        expect(seen).toEqual({ _tag: 'control', holder: state.danaId, paused: false })
        second.send({ _tag: 'control', hold: true })
        const refused = yield* Effect.promise(() => second.nextOf('control'))
        expect(refused.holder).toBe(state.danaId)
        expect(refused.reason).toContain('Someone else is driving')

        // the holder disconnects → everyone else sees the release
        yield* Effect.promise(() => first.close())
        const released = yield* Effect.promise(() => second.nextOf('control'))
        expect(released).toEqual({ _tag: 'control', holder: null, paused: false })
        second.send({ _tag: 'control', hold: true })
        const mine = yield* Effect.promise(() => second.nextOf('control'))
        expect(mine.holder).toBe(state.ownerId)
        yield* Effect.promise(() => second.close())
        yield* sleep(100)
        const terminals = yield* TerminalWsServer
        expect(yield* terminals.controlOf(mila.id as AgentId)).toBeUndefined()
      })
    )

    it.effect(
      'D15: with a running task, control needs `pause`: STOP on take, CONT on release',
      () =>
        Effect.gen(function* () {
          const { ws } = yield* baseUrl
          const dana = need(state.dana, 'dana')
          const mila = need(state.mila, 'mila')
          const dm = need(state.dm, 'dm')
          const acme = need(state.acme, 'acme')
          const trigger = yield* dana.api.messages.create({
            payload: { channelId: dm.id, body: 'please hang forever' }
          })
          const scheduler = yield* Scheduler
          const running = yield* waitFor(
            'task running',
            scheduler
              .taskOf(acme.id, mila.id, trigger.id as Task['messageId'])
              .pipe(Effect.map(Option.filter((t) => t.status === 'running')))
          )
          // the task runner launched Taut's Chromium and attached playwright-mcp to it (D11).
          // The daemon comes up first, so the config is what says it worked.
          yield* waitFor(
            'chromium launched for the task',
            Effect.sync(() => (daemonExecs.length >= 2 ? Option.some(true) : Option.none()))
          )
          const mcp = yield* waitFor(
            'the browser MCP server written for the task',
            Effect.sync(() => Option.fromNullable(fake.mcpConfigs().find((c) => c.browser)))
          )
          expect(mcp?.browser?.args.slice(0, 3)).toEqual([
            '--cdp-endpoint',
            'http://127.0.0.1:9222',
            '--output-dir'
          ])
          expect(mcp?.browser?.args[3]).toMatch(/\/\.taut\/browser\/out$/)

          const client = yield* connectTerminal(
            `${ws}/ws/terminal?agentId=${mila.id}`,
            yield* dana.cookieHeader
          )
          yield* Effect.promise(() => client.nextOf('ready'))
          yield* Effect.promise(() => client.nextOf('control'))
          const signalsBefore = fake.signals.length

          client.send({ _tag: 'control', hold: true })
          const refused = yield* Effect.promise(() => client.nextOf('control'))
          expect(refused.holder).toBeNull()
          expect(refused.reason).toContain('running a task')
          expect(fake.signals.length).toBe(signalsBefore)

          client.send({ _tag: 'control', hold: true, pause: true })
          const paused = yield* Effect.promise(() => client.nextOf('control'))
          expect(paused).toEqual({ _tag: 'control', holder: state.danaId, paused: true })
          expect(fake.signals.slice(signalsBefore)).toEqual(['STOP'])

          client.send({ _tag: 'control', hold: false })
          const released = yield* Effect.promise(() => client.nextOf('control'))
          expect(released).toEqual({ _tag: 'control', holder: null, paused: false })
          expect(fake.signals.slice(signalsBefore)).toEqual(['STOP', 'CONT'])

          // disconnecting while paused resumes the agent too
          client.send({ _tag: 'control', hold: true, pause: true })
          yield* Effect.promise(() => client.nextOf('control'))
          yield* Effect.promise(() => client.close())
          yield* waitFor(
            'CONT after disconnect',
            Effect.sync(() =>
              fake.signals.slice(signalsBefore).length === 4 ? Option.some(true) : Option.none()
            )
          )
          expect(fake.signals.slice(signalsBefore)).toEqual(['STOP', 'CONT', 'STOP', 'CONT'])

          yield* dana.api.tasks.cancel({ path: { taskId: running.id } })
        })
    )
  })
})
