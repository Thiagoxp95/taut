/**
 * `local` provider: spawns on the host with `node:child_process`. Dev only — no
 * isolation beyond a clean env and a private `$HOME` (docs/agent-model.md §7).
 *
 * Env policy: the child never inherits the host env. It gets exactly
 * `PATH`, `LANG`, `TERM`, `USER` (from `hostEnv`, default `process.env`), `HOME` set to
 * `<home>/.taut/home`, `TMPDIR` under it, plus whatever the caller passes in
 * `ExecOptions.env` (which wins on conflict).
 */
import { Effect, Layer, Option, type Scope } from 'effect'
import { spawn } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { connect, type Socket } from 'node:net'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Duplex } from 'node:stream'

import { TAUT_PATHS, ensureHomeLayout } from './home.js'
import type { SpawnedProcess } from './process.js'
import { looksLikeMissingBinary, processStream, runExec } from './process.js'
import { MachineProviderTag } from './tag.js'
import type {
  ExecOptions,
  ExecOutput,
  ExecResult,
  Machine,
  MachineProvider,
  MachineSpec,
  TaskSignal
} from './types.js'
import { BinaryMissing, ExecFailed, MachineUnavailable, WORKSPACE_EXEC_ENV } from './types.js'

/**
 * `USER` is included because Claude Code's macOS keychain lookup keys on it; without
 * it a host login fails with a misleading "OAuth session expired" (see docs/CHANGELOG.md).
 */
export const LOCAL_ENV_ALLOWLIST = ['PATH', 'LANG', 'TERM', 'USER'] as const

export interface LocalProviderOptions {
  /** Source of the allow-listed variables. Defaults to `process.env`. */
  readonly hostEnv?: Readonly<Record<string, string | undefined>>
  /** Used when `hostEnv.PATH` is unset. */
  readonly fallbackPath?: string
}

const DEFAULT_PATH = '/usr/local/bin:/usr/bin:/bin'

const spawnLocal = (
  agentId: string,
  cmd: ReadonlyArray<string>,
  cwd: string,
  env: Record<string, string>,
  hasStdin: boolean,
  /** Called once the child exists, with its pid (it leads its own process group). */
  onSpawn?: (pid: number | undefined, exited: Promise<unknown>) => void
): Effect.Effect<SpawnedProcess, ExecFailed | BinaryMissing> =>
  Effect.async<SpawnedProcess, ExecFailed | BinaryMissing>((resume) => {
    const [bin, ...args] = cmd
    if (bin === undefined) {
      resume(Effect.fail(new ExecFailed({ agentId, cmd: [...cmd], reason: 'empty command' })))
      return
    }
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: [hasStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // Own process group so we can kill the whole tree (claude spawns helpers).
      detached: process.platform !== 'win32'
    })
    let settled = false
    child.once('error', (cause) => {
      if (settled) return
      settled = true
      resume(
        Effect.fail(
          looksLikeMissingBinary(cause)
            ? new BinaryMissing({ agentId, binary: bin })
            : new ExecFailed({ agentId, cmd: [...cmd], reason: cause.message, cause })
        )
      )
    })
    child.once('spawn', () => {
      if (settled) return
      settled = true
      const stdout = child.stdout
      if (stdout === null) {
        resume(Effect.fail(new ExecFailed({ agentId, cmd: [...cmd], reason: 'no stdout pipe' })))
        return
      }
      const exited = new Promise<{ exitCode: number | null; signal: string | null }>((res) => {
        // 'close' fires after stdio drained — after 'exit'.
        child.once('close', (code, signal) => res({ exitCode: code, signal }))
      })
      const kill = (signal: 'SIGTERM' | 'SIGKILL') => {
        try {
          if (child.pid !== undefined && process.platform !== 'win32') {
            process.kill(-child.pid, signal)
          } else {
            child.kill(signal)
          }
        } catch {
          // already gone
        }
      }
      onSpawn?.(child.pid, exited)
      resume(
        Effect.succeed<SpawnedProcess>({
          stdout,
          stderr: child.stderr,
          stdin: child.stdin,
          kill,
          exited
        })
      )
    })
  })

export const makeLocalProvider = (options: LocalProviderOptions = {}): MachineProvider => {
  const hostEnv = options.hostEnv ?? process.env
  const machines = new Map<string, Machine>()

  const baseEnv = (home: string): Record<string, string> => {
    const env: Record<string, string> = {}
    for (const key of LOCAL_ENV_ALLOWLIST) {
      const value = hostEnv[key]
      if (value !== undefined) env[key] = value
    }
    env['PATH'] ??= options.fallbackPath ?? DEFAULT_PATH
    env['HOME'] = join(home, TAUT_PATHS.localHome)
    env['TMPDIR'] = join(home, TAUT_PATHS.localHome, 'tmp')
    return env
  }

  const makeMachine = (spec: MachineSpec): Machine => {
    const home = resolve(spec.homeDir)
    const agentId = spec.agentId
    const abs = (path: string) => (isAbsolute(path) ? path : join(home, path))

    /**
     * Process groups of the *task* execs running right now — the ones carrying a
     * `TAUT_EXEC_ID` without the `WORKSPACE_EXEC_ENV` marker, exactly the set
     * docker's `signalTasksScript` picks out of `/proc`. There is no `/proc` on
     * macOS, so `local` keeps the same set in memory instead
     * (docs/build-plan-workspace.md D15).
     */
    const taskGroups = new Set<number>()

    const execStream = (o: ExecOptions) => {
      const env = { ...baseEnv(home), ...(o.env ?? {}) }
      const cwd = o.cwd === undefined ? home : abs(o.cwd)
      const isTask = env['TAUT_EXEC_ID'] !== undefined && env[WORKSPACE_EXEC_ENV] !== '1'
      const track = (pid: number | undefined, exited: Promise<unknown>) => {
        if (!isTask || pid === undefined || process.platform === 'win32') return
        taskGroups.add(pid)
        void exited.finally(() => taskGroups.delete(pid))
      }
      return processStream(
        { agentId, cmd: o.cmd },
        o,
        Effect.tryPromise({
          try: () => mkdir(env['TMPDIR'] ?? join(home, TAUT_PATHS.localHome), { recursive: true }),
          catch: (cause) =>
            new ExecFailed({ agentId, cmd: [...o.cmd], reason: 'cannot create TMPDIR', cause })
        }).pipe(
          Effect.andThen(
            spawnLocal(agentId, o.cmd, cwd, env, o.stdin !== undefined, track)
          )
        )
      )
    }

    /**
     * `SIGSTOP` / `SIGCONT` every tracked task group (D15). The signal goes to the
     * whole group (`-pid`), because a runtime spawns helpers that would otherwise
     * keep driving the browser while its parent is frozen.
     */
    const signalTasks = (signal: TaskSignal): Effect.Effect<number, MachineUnavailable> =>
      Effect.sync(() => {
        let n = 0
        for (const pid of taskGroups) {
          try {
            process.kill(-pid, `SIG${signal}`)
            n += 1
          } catch {
            taskGroups.delete(pid)
          }
        }
        return n
      })

    /**
     * A byte stream to `127.0.0.1:<port>` on the host. On `local` the "box" *is*
     * the host, so the tunnel is a plain loopback socket — no relay needed, and
     * the port is still unreachable from anywhere else (D18). Used only by the
     * browser live view; D2 keeps `openPty` refusing.
     */
    const openTunnel = (port: number): Effect.Effect<Duplex, MachineUnavailable, Scope.Scope> =>
      Effect.acquireRelease(
        Effect.async<Socket, MachineUnavailable>((resume) => {
          const socket = connect({ host: '127.0.0.1', port })
          socket.once('connect', () => resume(Effect.succeed(socket)))
          socket.once('error', (cause) => {
            socket.destroy()
            resume(
              Effect.fail(
                new MachineUnavailable({
                  provider: 'local',
                  agentId,
                  reason: `nothing is listening on 127.0.0.1:${port}: ${cause.message}`,
                  cause
                })
              )
            )
          })
        }),
        (socket) => Effect.sync(() => socket.destroy())
      )

    const machine: Machine = {
      id: `local:${agentId}`,
      provider: 'local',
      spec,
      paths: { home, hostHome: home },
      status: () => Effect.succeed('running' as const),
      start: () => Effect.void,
      stop: () => Effect.void,
      destroy: () =>
        Effect.sync(() => {
          machines.delete(agentId)
        }),
      execStream,
      exec: (o: ExecOptions): Effect.Effect<ExecResult, ExecFailed | BinaryMissing> =>
        runExec({ agentId, cmd: o.cmd }, o, execStream(o) as ReturnType<typeof execStream>),
      /**
       * Never on `local` (docs/build-plan-workspace.md D2): there is no box here, so a
       * PTY would be an unsandboxed shell on the owner's own machine, reachable by
       * every department head. The Workspace tab shows an explainer instead.
       */
      openPty: () =>
        Effect.fail(
          new MachineUnavailable({
            provider: 'local',
            agentId,
            reason:
              'no terminal on the local provider: it would be a shell on the host, not on an agent box (docs/build-plan-workspace.md D2)'
          })
        ),
      openTunnel,
      signalTasks,
      putFile: (path, content) =>
        Effect.tryPromise({
          try: async () => {
            const target = abs(path)
            await mkdir(dirname(target), { recursive: true })
            await writeFile(target, content)
          },
          catch: (cause) =>
            new ExecFailed({
              agentId,
              cmd: ['putFile', path],
              reason: cause instanceof Error ? cause.message : String(cause),
              cause
            })
        }),
      getFile: (path) =>
        Effect.tryPromise({
          try: async () => new Uint8Array(await readFile(abs(path))),
          catch: (cause) =>
            new ExecFailed({
              agentId,
              cmd: ['getFile', path],
              reason: cause instanceof Error ? cause.message : String(cause),
              cause
            })
        })
    }
    return machine
  }

  const provider: MachineProvider = {
    name: 'local',
    ensure: (spec) =>
      ensureHomeLayout(spec.homeDir).pipe(
        Effect.mapError(
          (cause) =>
            new MachineUnavailable({
              provider: 'local',
              agentId: spec.agentId,
              reason: `cannot create home: ${cause.message}`,
              cause
            })
        ),
        Effect.map(() => {
          const existing = machines.get(spec.agentId)
          if (existing !== undefined && existing.spec.homeDir === spec.homeDir) return existing
          const machine = makeMachine(spec)
          machines.set(spec.agentId, machine)
          return machine
        })
      ),
    get: (agentId) => Effect.succeed(Option.fromNullable(machines.get(agentId))),
    list: (companyId) =>
      Effect.succeed([...machines.values()].filter((m) => m.spec.companyId === companyId)),
    destroy: (agentId) =>
      Effect.sync(() => {
        machines.delete(agentId)
      })
  }
  return provider
}

/** `Layer` providing the `local` provider as `MachineProviderTag`. */
export const LocalProviderLive = (options: LocalProviderOptions = {}) =>
  Layer.succeed(MachineProviderTag, makeLocalProvider(options))

export type { ExecOutput }
