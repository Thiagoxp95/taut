/**
 * A fake `MachineProvider` for the scheduler tests: no process is spawned, `execStream`
 * plays a scripted claude `stream-json` transcript chosen from the prompt (stdin) and the
 * injected credential, so the real claude-code adapter, parser and redactor are exercised.
 *
 *   prompt contains "hang"        → init line, then never ends (until interrupted)
 *   prompt contains "two parts"   → "pi" … "ng" as two assistant turns, 150 ms apart
 *   prompt contains "wait for release" → init line, then blocks until `release(text)`; the
 *                                   text is then printed as one assistant turn + result
 *   ANTHROPIC_API_KEY ~ ratelimit → `result` with is_error + a 429 rate-limit text
 *   otherwise                     → "pong"
 */
import type {
  ExecFailed,
  ExecOptions,
  ExecOutput,
  Machine,
  MachineProvider,
  MachineSpec,
  Pty,
  PtyOptions,
  TaskSignal
} from '@taut/runtime'
import { MachineProviderTag, MachineUnavailable } from '@taut/runtime'
import { Deferred, Effect, Layer, Option, Schedule, type Scope, Stream } from 'effect'
import type { Duplex } from 'node:stream'

/** Knobs for the workspace tests (docs/build-plan-workspace.md); the scheduler tests use none. */
export interface FakeRuntimeOptions {
  /** Reported as `provider.name` / `machine.provider`. Default `local`. */
  readonly provider?: 'local' | 'docker'
  /** Every machine's `openPty`. Default: refuse with `MachineUnavailable`, as `local` does (D2). */
  readonly openPty?: (
    spec: MachineSpec,
    options: PtyOptions
  ) => Effect.Effect<Pty, MachineUnavailable | ExecFailed, Scope.Scope>
  /**
   * Scripted stdout for plain execs such as `ps` (D13): return the lines for this
   * command, or `undefined` to fall through to the claude transcript below.
   */
  readonly exec?: (options: ExecOptions) => ReadonlyArray<string> | undefined
  /** `openTunnel` for every machine (a socket to a fake CDP server). Default: refuse like `local`. */
  readonly openTunnel?: (
    spec: MachineSpec,
    port: number
  ) => Effect.Effect<Duplex, MachineUnavailable | ExecFailed, Scope.Scope>
}

export interface FakeExec {
  readonly cmd: ReadonlyArray<string>
  readonly env: Readonly<Record<string, string>>
  readonly stdin: string | undefined
  readonly cwd: string | undefined
  interrupted: boolean
  finished: boolean
}

export interface FakeRuntime {
  readonly layer: Layer.Layer<MachineProviderTag>
  readonly execs: Array<FakeExec>
  /** Every `putFile` (machine-visible path → content). */
  readonly files: Map<string, string>
  /** `TAUT_TOKEN`s found in written MCP configs, oldest first. */
  readonly tokens: () => Array<string>
  readonly mcpConfigs: () => Array<FakeMcpConfig>
  /**
   * Let the oldest exec that is blocked on a "wait for release" prompt finish, printing
   * `text` as its reply. No-op when nothing is waiting.
   */
  readonly release: (text: string) => void
  /** Every `signalTasks` call, in order (workspace D15). */
  readonly signals: Array<TaskSignal>
}

export interface FakeMcpConfig {
  readonly url: string
  readonly token: string
  readonly taskId?: string
  /** `mcpServers` keys in file order (`taut` first, then any extra such as `browser`). */
  readonly servers: Array<string>
  readonly browser?: {
    readonly command: string
    readonly args: Array<string>
    readonly env?: Record<string, string>
  }
}

let sessionCounter = 0

const line = (json: Record<string, unknown>): ExecOutput => ({
  _tag: 'stdout',
  line: JSON.stringify(json)
})

const init = (sessionId: string): ExecOutput =>
  line({ type: 'system', subtype: 'init', session_id: sessionId, model: 'claude-fake' })

const assistant = (text: string): ExecOutput =>
  line({ type: 'assistant', message: { content: [{ type: 'text', text }] } })

const result = (sessionId: string, text: string, ok: boolean, subtype = 'success'): ExecOutput =>
  line({
    type: 'result',
    subtype,
    is_error: !ok,
    result: text,
    session_id: sessionId,
    num_turns: 1,
    duration_ms: 5,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 }
  })

const exit: ExecOutput = { _tag: 'exit', result: { exitCode: 0, durationMs: 5 } }

export const makeFakeRuntime = (options: FakeRuntimeOptions = {}): FakeRuntime => {
  const providerName = options.provider ?? 'local'
  const execs: Array<FakeExec> = []
  const files = new Map<string, string>()
  const machines = new Map<string, Machine>()
  const waiting: Array<Deferred.Deferred<string>> = []
  const signals: Array<TaskSignal> = []

  const release = (text: string): void => {
    const next = waiting.shift()
    if (next !== undefined) Effect.runSync(Deferred.succeed(next, text))
  }

  const script = (exec: FakeExec): Stream.Stream<ExecOutput> => {
    const sessionId = `sess_${++sessionCounter}`
    // The prompt is `[context ---] trigger --- footer`; only the trigger line picks the script,
    // otherwise an earlier "hang" in the context would replay forever. With no context (the
    // first message of a DM) the trigger is the first part.
    const full = exec.stdin ?? ''
    const parts = full.split('\n---\n')
    const prompt = (parts.length >= 3 ? parts[1] : parts[0]) ?? full
    const key = exec.env['ANTHROPIC_API_KEY'] ?? ''
    if (key.includes('ratelimit')) {
      return Stream.make(
        init(sessionId),
        result(
          sessionId,
          'API Error: 429 {"type":"error","error":{"type":"rate_limit_error","message":"rate limit exceeded"}}',
          false,
          'error_during_execution'
        ),
        exit
      )
    }
    if (prompt.includes('hang')) {
      return Stream.concat(Stream.make(init(sessionId)), Stream.never)
    }
    if (prompt.includes('wait for release')) {
      const gate = Effect.runSync(Deferred.make<string>())
      waiting.push(gate)
      return Stream.concat(
        Stream.make(init(sessionId)),
        Stream.fromEffect(Deferred.await(gate)).pipe(
          Stream.flatMap((text) =>
            Stream.make(assistant(text), result(sessionId, text, true), exit)
          )
        )
      )
    }
    if (prompt.includes('two parts')) {
      return Stream.make(
        init(sessionId),
        assistant('pi'),
        assistant('ng'),
        result(sessionId, 'ping', true)
      ).pipe(Stream.schedule(Schedule.spaced('150 millis')), Stream.concat(Stream.make(exit)))
    }
    return Stream.make(init(sessionId), assistant('pong'), result(sessionId, 'pong', true), exit)
  }

  const makeMachine = (spec: MachineSpec): Machine => {
    const execStream = (o: ExecOptions): Stream.Stream<ExecOutput, never> => {
      const exec: FakeExec = {
        cmd: o.cmd,
        env: o.env ?? {},
        stdin: o.stdin,
        cwd: o.cwd,
        interrupted: false,
        finished: false
      }
      execs.push(exec)
      const scripted = options.exec?.(o)
      const source =
        scripted === undefined
          ? script(exec)
          : Stream.concat(
              Stream.fromIterable(scripted.map((line): ExecOutput => ({ _tag: 'stdout', line }))),
              Stream.make(exit)
            )
      return source.pipe(
        Stream.tap((out) =>
          Effect.sync(() => (out._tag === 'exit' ? (exec.finished = true) : undefined))
        ),
        Stream.ensuring(
          Effect.sync(() => {
            if (!exec.finished) exec.interrupted = true
          })
        )
      )
    }
    return {
      id: `fake:${spec.agentId}`,
      provider: providerName,
      spec,
      paths: { home: spec.homeDir, hostHome: spec.homeDir },
      status: () => Effect.succeed('running' as const),
      start: () => Effect.void,
      stop: () => Effect.void,
      destroy: () => Effect.void,
      execStream,
      exec: (o) =>
        Stream.runForEach(execStream(o), (out) =>
          Effect.sync(() => {
            if (out._tag === 'stdout') o.onLine?.(out.line)
            else if (out._tag === 'stderr') o.onStderr?.(out.line)
          })
        ).pipe(Effect.as({ exitCode: 0, durationMs: 1 })),
      openPty: (o) =>
        options.openPty === undefined
          ? Effect.fail(
              new MachineUnavailable({
                provider: providerName,
                agentId: spec.agentId,
                reason: 'no terminal on the local provider (fake)'
              })
            )
          : options.openPty(spec, o),
      openTunnel: (port) =>
        options.openTunnel === undefined
          ? Effect.fail(
              new MachineUnavailable({
                provider: providerName,
                agentId: spec.agentId,
                reason: 'no browser live view on the local provider (fake)'
              })
            )
          : options.openTunnel(spec, port),
      signalTasks: (signal) =>
        Effect.sync(() => {
          signals.push(signal)
          return 1
        }),
      putFile: (path, content) =>
        Effect.sync(() => {
          files.set(path, typeof content === 'string' ? content : Buffer.from(content).toString())
        }),
      getFile: (path) => Effect.succeed(new TextEncoder().encode(files.get(path) ?? ''))
    }
  }

  const provider: MachineProvider = {
    name: providerName,
    ensure: (spec) =>
      Effect.sync(() => {
        const existing = machines.get(spec.agentId)
        if (existing !== undefined) return existing
        const machine = makeMachine(spec)
        machines.set(spec.agentId, machine)
        return machine
      }),
    get: (agentId) => Effect.succeed(Option.fromNullable(machines.get(agentId))),
    list: (companyId) =>
      Effect.succeed([...machines.values()].filter((m) => m.spec.companyId === companyId)),
    destroy: (agentId) =>
      Effect.sync(() => {
        machines.delete(agentId)
      })
  }

  const mcpConfigs = (): Array<FakeMcpConfig> =>
    [...files.entries()]
      .filter(([path]) => path.endsWith('/.taut/mcp.json'))
      .map(([, content]) => {
        const parsed = JSON.parse(content) as {
          mcpServers: { taut: { env: Record<string, string> } } & Record<
            string,
            { command: string; args: Array<string>; env?: Record<string, string> }
          >
        }
        const env = parsed.mcpServers.taut.env
        const browser = parsed.mcpServers['browser']
        return {
          url: env['TAUT_URL'] ?? '',
          token: env['TAUT_TOKEN'] ?? '',
          ...(env['TAUT_TASK_ID'] === undefined ? {} : { taskId: env['TAUT_TASK_ID'] }),
          servers: Object.keys(parsed.mcpServers),
          ...(browser === undefined ? {} : { browser })
        }
      })

  return {
    layer: Layer.succeed(MachineProviderTag, provider),
    execs,
    files,
    tokens: () => mcpConfigs().map((c) => c.token),
    mcpConfigs,
    release,
    signals
  }
}
