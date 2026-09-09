/**
 * `docker` provider: one long-lived container per agent over the Docker socket
 * (docs/agent-model.md §7, docs/research/agent-sandboxes.md §6).
 *
 * - container `taut-<companySlug>-<handle>`, image `taut/agent:latest` by default
 * - home bind-mounted at `/home/agent`; nothing else mounted
 * - `User: 1000:1000`, `CapDrop: ALL`, `no-new-privileges`, pids/memory/cpu limits,
 *   read-only rootfs + tmpfs `/tmp`, one bridge network per company `taut-<slug>`
 * - optional `Runtime` (`runc` | `runsc` | `sysbox-runc`)
 * - tasks are `container.exec` with per-call `Env`: secrets never touch the container config
 *
 * Interrupting an exec: Docker has no "kill exec" endpoint, so every exec gets a
 * private `TAUT_EXEC_ID` and interruption runs a second exec that signals every
 * process carrying that id in `/proc/<pid>/environ`.
 */
import Dockerode from 'dockerode'
import { Deferred, Effect, Layer, Option, Queue, Runtime, type Scope, Stream } from 'effect'
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, posix } from 'node:path'
import { Duplex, PassThrough, Readable } from 'node:stream'
import { extract, pack } from 'tar-stream'

import { AGENT_GID, AGENT_UID, ensureHomeLayout } from './home.js'
import type { SpawnedProcess } from './process.js'
import { KILL_GRACE_MS, looksLikeMissingBinary, processStream, runExec } from './process.js'
import { MachineProviderTag } from './tag.js'
import type {
  ExecOptions,
  Machine,
  MachineProvider,
  MachineSpec,
  MachineStatus,
  Pty,
  PtyOptions,
  TaskSignal
} from './types.js'
import { BinaryMissing, ExecFailed, MachineUnavailable, WORKSPACE_EXEC_ENV } from './types.js'

export const DEFAULT_IMAGE = 'taut/agent:latest'
export const CONTAINER_HOME = '/home/agent'
/** What an interactive shell in the box gets (docs/build-plan-workspace.md D8, D9). */
export const PTY_SHELL: ReadonlyArray<string> = ['/bin/bash', '-l']
export const PTY_TERM = 'xterm-256color'
/**
 * Chunks buffered between the hijacked socket and the `Pty.output` consumer. The
 * socket is paused while the queue is full, so a `yes` loop backs up into docker
 * (and the container's own pty buffer) instead of into server memory.
 */
const PTY_OUTPUT_BUFFER = 64
/** The relay must report `ok` on stderr within this long, or the port is not answering. */
const TUNNEL_CONNECT_MS = 5_000

/**
 * The `docker exec` relay behind `Machine.openTunnel` (docs/build-plan-workspace.md
 * D18 and its "blocking risk"): a few lines of node — already in the image for the
 * runtimes — that splice this exec's stdin/stdout onto a loopback TCP port inside the
 * container. Readiness and failure go to **stderr** (`ok` / the error), which docker
 * multiplexes separately, so the data channel carries nothing but the port's bytes.
 *
 * Why a relay and not the container's bridge address: the server runs on the owner's
 * macOS host in dev, where bridge IPs are not routable, and a debug port bound to the
 * `taut-<slug>` bridge would be reachable by every other agent of the company. A port
 * bound to `127.0.0.1` in the container's own namespace is reachable only from inside
 * — by `playwright-mcp` and by this relay.
 */
export const TUNNEL_RELAY_SCRIPT = [
  "const net = require('node:net');",
  'const port = Number(process.argv[1]);',
  "const s = net.connect(port, '127.0.0.1');",
  "s.on('connect', () => { process.stderr.write('ok\\n'); process.stdin.pipe(s); s.pipe(process.stdout); });",
  "s.on('error', (e) => { process.stderr.write(String(e.code || e.message) + '\\n'); process.exit(2); });",
  "s.on('close', () => process.exit(0));",
  "process.stdin.on('end', () => s.end());",
  "process.stdout.on('error', () => process.exit(0));"
].join(' ')

/**
 * POSIX `sh` that signals every *task* exec: processes whose environment carries a
 * `TAUT_EXEC_ID` but not the workspace marker (D15). Prints how many it signalled.
 */
export const signalTasksScript = (signal: TaskSignal): string =>
  `n=0; for p in /proc/[0-9]*; do ` +
  `e=$(tr '\\0' '\\n' < "$p/environ" 2>/dev/null) || continue; ` +
  `case "$e" in *TAUT_EXEC_ID=*) ;; *) continue;; esac; ` +
  `case "$e" in *${WORKSPACE_EXEC_ENV}=1*) continue;; esac; ` +
  `kill -${signal} "\${p#/proc/}" 2>/dev/null && n=$((n+1)); done; echo $n; exit 0`
const AGENT_USER = `${AGENT_UID}:${AGENT_GID}`
const LABEL_COMPANY = 'taut.company'
const LABEL_AGENT = 'taut.agent'
const LABEL_SPEC = 'taut.spec'

export const containerName = (spec: Pick<MachineSpec, 'companySlug' | 'handle'>): string =>
  `taut-${spec.companySlug}-${spec.handle}`
export const networkName = (companySlug: string): string => `taut-${companySlug}`

export interface DockerProviderOptions {
  /** An existing client, or options for `new Dockerode(...)`. Defaults to the local socket. */
  readonly docker?: Dockerode | Dockerode.DockerOptions
  /** Default image when the spec has none. */
  readonly image?: string
  /** `docker pull` the image when it is missing locally. Default `true`. */
  readonly pullMissingImage?: boolean
  /** `--read-only --tmpfs /tmp`. Default `true`. */
  readonly readOnlyRootfs?: boolean
}

interface DockerError {
  readonly statusCode?: number
  readonly message?: string
  readonly reason?: string
}

const statusCode = (cause: unknown): number | undefined =>
  typeof cause === 'object' && cause !== null ? (cause as DockerError).statusCode : undefined

const messageOf = (cause: unknown): string =>
  cause instanceof Error
    ? cause.message
    : typeof cause === 'object' && cause !== null && 'message' in cause
      ? String((cause as DockerError).message)
      : String(cause)

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`

/** POSIX `sh` script that signals every process whose environment carries `TAUT_EXEC_ID=<id>`. */
const killScript = (execId: string, signal: 'HUP' | 'TERM' | 'KILL'): string =>
  `for p in /proc/[0-9]*; do ` +
  `if tr '\\0' '\\n' < "$p/environ" 2>/dev/null | grep -qx ${shellQuote(`TAUT_EXEC_ID=${execId}`)}; ` +
  `then kill -${signal} "\${p#/proc/}" 2>/dev/null; fi; done; exit 0`

export const makeDockerProvider = (options: DockerProviderOptions = {}): MachineProvider => {
  const docker =
    options.docker instanceof Dockerode ? options.docker : new Dockerode(options.docker)
  const defaultImage = options.image ?? DEFAULT_IMAGE
  const pullMissing = options.pullMissingImage ?? true
  const readOnly = options.readOnlyRootfs ?? true

  const unavailable = (agentId: string, reason: string, cause?: unknown) =>
    new MachineUnavailable({ provider: 'docker', agentId, reason, cause })

  const tryDocker = <A>(agentId: string, what: string, thunk: () => Promise<A>) =>
    Effect.tryPromise({
      try: thunk,
      catch: (cause) => unavailable(agentId, `${what}: ${messageOf(cause)}`, cause)
    })

  // -- networks ------------------------------------------------------------

  const ensureNetwork = (spec: MachineSpec) =>
    tryDocker(spec.agentId, 'network', async () => {
      const name = networkName(spec.companySlug)
      const found = await docker.listNetworks({ filters: JSON.stringify({ name: [name] }) })
      if (found.some((n) => n.Name === name)) return name
      try {
        await docker.createNetwork({
          Name: name,
          Driver: 'bridge',
          CheckDuplicate: true,
          Labels: { [LABEL_COMPANY]: spec.companySlug }
        })
      } catch (cause) {
        if (statusCode(cause) !== 409) throw cause // created concurrently
      }
      return name
    })

  // -- images --------------------------------------------------------------

  const pullImage = (agentId: string, image: string) =>
    tryDocker(agentId, `pull ${image}`, async () => {
      const stream = await docker.pull(image)
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (err: Error | null) =>
          err === null ? resolve() : reject(err)
        )
      })
    })

  // -- containers ----------------------------------------------------------

  const createOptions = (spec: MachineSpec, network: string): Dockerode.ContainerCreateOptions => {
    const memory = Math.round(spec.limits.memoryMb * 1024 * 1024)
    return {
      name: containerName(spec),
      Image: spec.image ?? defaultImage,
      Cmd: ['sleep', 'infinity'],
      User: AGENT_USER,
      WorkingDir: CONTAINER_HOME,
      Env: [`HOME=${CONTAINER_HOME}`, 'LANG=C.UTF-8', 'TERM=dumb'],
      Labels: {
        [LABEL_COMPANY]: spec.companySlug,
        [LABEL_AGENT]: spec.agentId,
        [LABEL_SPEC]: JSON.stringify(spec)
      },
      HostConfig: {
        Binds: [`${spec.homeDir}:${CONTAINER_HOME}`],
        CapDrop: ['ALL'],
        SecurityOpt: ['no-new-privileges'],
        PidsLimit: spec.limits.pidsLimit ?? 512,
        Memory: memory,
        MemorySwap: memory,
        NanoCpus: Math.round(spec.limits.cpus * 1e9),
        NetworkMode: network,
        ...(spec.runtime !== undefined ? { Runtime: spec.runtime } : {}),
        ...(readOnly ? { ReadonlyRootfs: true, Tmpfs: { '/tmp': 'rw,nosuid,size=512m' } } : {}),
        RestartPolicy: { Name: 'no' }
        // TODO(plan): `spec.network.egress.allowDomains` is recorded but not enforced —
        // needs an egress proxy or iptables rules on the per-company bridge.
      }
    }
  }

  const inspectOrNull = (agentId: string, name: string) =>
    tryDocker(agentId, 'inspect', async () => {
      try {
        return await docker.getContainer(name).inspect()
      } catch (cause) {
        if (statusCode(cause) === 404) return null
        throw cause
      }
    })

  const createContainer = (spec: MachineSpec, network: string) =>
    Effect.gen(function* () {
      const opts = createOptions(spec, network)
      const attempt = tryDocker(spec.agentId, 'create', () => docker.createContainer(opts))
      return yield* attempt.pipe(
        Effect.catchIf(
          (e) => pullMissing && /no such image/i.test(e.reason),
          () => pullImage(spec.agentId, opts.Image ?? defaultImage).pipe(Effect.andThen(attempt))
        )
      )
    })

  const startContainer = (agentId: string, container: Dockerode.Container) =>
    tryDocker(agentId, 'start', async () => {
      try {
        await container.start()
      } catch (cause) {
        if (statusCode(cause) !== 304) throw cause // 304 = already running
      }
    })

  const toStatus = (info: Dockerode.ContainerInspectInfo | null): MachineStatus =>
    info === null
      ? 'missing'
      : info.State.Running
        ? 'running'
        : info.State.Status === 'created'
          ? 'creating'
          : 'stopped'

  // -- exec ----------------------------------------------------------------

  const spawnExec = (
    spec: MachineSpec,
    container: Dockerode.Container,
    o: ExecOptions,
    execId: string
  ): Effect.Effect<SpawnedProcess, ExecFailed | BinaryMissing> =>
    Effect.tryPromise({
      try: async (): Promise<SpawnedProcess> => {
        const env = { ...(o.env ?? {}), TAUT_EXEC_ID: execId }
        const exec = await container.exec({
          Cmd: [...o.cmd],
          Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
          WorkingDir: o.cwd === undefined ? CONTAINER_HOME : toContainerPath(o.cwd),
          User: AGENT_USER,
          AttachStdin: true,
          AttachStdout: true,
          AttachStderr: true,
          Tty: false
        })
        const socket: Duplex = await exec.start({ hijack: true, stdin: true })
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        docker.modem.demuxStream(socket, stdout, stderr)

        const exited = new Promise<{ exitCode: number | null; signal: string | null }>(
          (resolve, reject) => {
            const finish = async () => {
              stdout.end()
              stderr.end()
              try {
                // ExitCode can lag the stream end by a few ms.
                for (let i = 0; i < 50; i++) {
                  const info = await exec.inspect()
                  if (!info.Running) return resolve({ exitCode: info.ExitCode, signal: null })
                  await new Promise((r) => setTimeout(r, 20))
                }
                resolve({ exitCode: -1, signal: null })
              } catch (cause) {
                reject(cause)
              }
            }
            socket.once('end', () => void finish())
            socket.once('close', () => void finish())
            socket.once('error', (cause) => reject(cause))
          }
        )

        // Fail fast when the binary is missing: docker reports it via the exec exit
        // code (126/127) and a stderr line, not via the create call.
        const kill = async (signal: 'SIGTERM' | 'SIGKILL') => {
          try {
            const killer = await container.exec({
              Cmd: ['sh', '-c', killScript(execId, signal === 'SIGKILL' ? 'KILL' : 'TERM')],
              User: AGENT_USER,
              AttachStdout: false,
              AttachStderr: false
            })
            await killer.start({ Detach: true })
          } catch {
            // container gone — nothing to kill
          }
          if (signal === 'SIGKILL') socket.destroy()
        }

        return { stdout, stderr, stdin: socket, kill, exited }
      },
      catch: (cause) =>
        looksLikeMissingBinary(cause)
          ? new BinaryMissing({ agentId: spec.agentId, binary: o.cmd[0] ?? '' })
          : new ExecFailed({
              agentId: spec.agentId,
              cmd: [...o.cmd],
              reason: messageOf(cause),
              cause
            })
    })

  const toContainerPath = (path: string): string =>
    isAbsolute(path) ? path : posix.join(CONTAINER_HOME, path)

  // -- pty -----------------------------------------------------------------

  /**
   * Interactive shell (docs/build-plan-workspace.md D8). Same hijacked-socket
   * plumbing as `spawnExec`, with two differences: `Tty: true`, so the socket
   * carries raw terminal bytes (no stdout/stderr multiplexing — `demuxStream`
   * must NOT be used here), and `exec.resize` after start so the shell sees the
   * viewer's real geometry. The image sets `TERM=dumb` for the runtimes; this
   * exec overrides it (D9) or bash renders without colour or cursor addressing.
   *
   * Docker cannot kill an exec, so the shell carries a private `TAUT_EXEC_ID`
   * like every task exec and `kill()` signals whatever still carries it: HUP
   * first (a hangup is what a closed terminal means), KILL after the grace.
   */
  const openPty =
    (spec: MachineSpec, container: Dockerode.Container) =>
    (o: PtyOptions): Effect.Effect<Pty, MachineUnavailable | ExecFailed, Scope.Scope> =>
      Effect.gen(function* () {
        const agentId = spec.agentId
        const execId = randomUUID()
        const cmd = [...(o.cmd ?? PTY_SHELL)]
        const shell = cmd[0] ?? PTY_SHELL[0]!
        const env: Record<string, string> = {
          HOME: CONTAINER_HOME,
          LANG: 'C.UTF-8',
          ...(o.env ?? {}),
          TERM: PTY_TERM,
          TAUT_EXEC_ID: execId,
          [WORKSPACE_EXEC_ENV]: '1'
        }

        const runtime = yield* Effect.runtime<never>()
        // `null` is the end-of-output sentinel: `Queue.shutdown` would drop the tail.
        const output = yield* Queue.bounded<Uint8Array | null>(PTY_OUTPUT_BUFFER)
        const exited = yield* Deferred.make<number>()

        const started = yield* Effect.tryPromise({
          try: async () => {
            const exec = await container.exec({
              Cmd: cmd,
              Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
              WorkingDir: o.cwd === undefined ? CONTAINER_HOME : toContainerPath(o.cwd),
              User: AGENT_USER,
              AttachStdin: true,
              AttachStdout: true,
              AttachStderr: true,
              Tty: true
            })
            const socket: Duplex = await exec.start({ hijack: true, stdin: true, Tty: true })
            try {
              await exec.resize({ h: o.rows, w: o.cols })
            } catch {
              // the shell may already be gone; the exit path reports it
            }
            return { exec, socket }
          },
          catch: (cause): MachineUnavailable | ExecFailed =>
            statusCode(cause) === 409 || statusCode(cause) === 404
              ? unavailable(agentId, `container not running: ${messageOf(cause)}`, cause)
              : new ExecFailed({ agentId, cmd, reason: messageOf(cause), cause })
        })
        const { exec, socket } = started

        let finished = false
        const finish = async (): Promise<void> => {
          if (finished) return
          finished = true
          let code = -1
          try {
            // ExitCode can lag the stream end by a few ms (same as `spawnExec`).
            for (let i = 0; i < 50; i++) {
              const info = await exec.inspect()
              if (!info.Running) {
                code = info.ExitCode ?? -1
                break
              }
              await new Promise((r) => setTimeout(r, 20))
            }
          } catch {
            // container gone — the shell is gone with it
          }
          await Runtime.runPromise(runtime)(Queue.offer(output, null))
          await Runtime.runPromise(runtime)(Deferred.succeed(exited, code))
        }

        // Backpressure: the socket stays paused until the consumer has taken the chunk.
        socket.on('data', (chunk: Buffer) => {
          socket.pause()
          void Runtime.runPromise(runtime)(Queue.offer(output, new Uint8Array(chunk))).then(
            () => socket.resume(),
            () => socket.destroy()
          )
        })
        socket.once('end', () => void finish())
        socket.once('close', () => void finish())
        socket.on('error', () => void finish())

        const signal = async (sig: 'HUP' | 'KILL'): Promise<void> => {
          try {
            const killer = await container.exec({
              Cmd: ['sh', '-c', killScript(execId, sig)],
              User: AGENT_USER,
              AttachStdout: false,
              AttachStderr: false
            })
            await killer.start({ Detach: true })
          } catch {
            // container gone — nothing to kill
          }
        }

        let killing: Promise<void> | undefined
        const kill = (): Promise<void> => {
          killing ??= (async () => {
            if (finished) return
            await signal('HUP')
            const gone = () => finished
            const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
            for (let waited = 0; !gone() && waited < KILL_GRACE_MS; waited += 100) await wait(100)
            if (!gone()) {
              await signal('KILL')
              for (let waited = 0; !gone() && waited < KILL_GRACE_MS; waited += 100) await wait(100)
            }
            socket.destroy()
            await finish()
          })()
          return killing
        }

        yield* Effect.addFinalizer(() => Effect.promise(kill))

        const pty: Pty = {
          id: exec.id,
          shell,
          write: (bytes) =>
            Effect.sync(() => {
              if (!finished && !socket.destroyed) socket.write(Buffer.from(bytes))
            }),
          resize: (cols, rows) =>
            Effect.promise(() => exec.resize({ h: rows, w: cols })).pipe(Effect.ignore),
          output: Stream.fromQueue(output).pipe(
            Stream.takeWhile((chunk): chunk is Uint8Array => chunk !== null)
          ),
          exit: Deferred.await(exited),
          kill: () => Effect.promise(kill)
        }
        return pty
      })

  // -- tunnel (docs/build-plan-workspace.md D18) ------------------------------

  const openTunnel =
    (spec: MachineSpec, container: Dockerode.Container) =>
    (port: number): Effect.Effect<Duplex, MachineUnavailable | ExecFailed, Scope.Scope> =>
      Effect.gen(function* () {
        const agentId = spec.agentId
        const execId = randomUUID()
        const cmd = ['node', '-e', TUNNEL_RELAY_SCRIPT, String(port)]
        const failed = (reason: string, cause?: unknown) =>
          new ExecFailed({ agentId, cmd: ['tunnel', String(port)], reason, cause })

        const started = yield* Effect.tryPromise({
          try: async () => {
            const exec = await container.exec({
              Cmd: cmd,
              Env: [`TAUT_EXEC_ID=${execId}`, `${WORKSPACE_EXEC_ENV}=1`, `HOME=${CONTAINER_HOME}`],
              User: AGENT_USER,
              AttachStdin: true,
              AttachStdout: true,
              AttachStderr: true,
              Tty: false
            })
            const socket: Duplex = await exec.start({ hijack: true, stdin: true })
            return { exec, socket }
          },
          catch: (cause): MachineUnavailable | ExecFailed =>
            statusCode(cause) === 409 || statusCode(cause) === 404
              ? unavailable(agentId, `container not running: ${messageOf(cause)}`, cause)
              : failed(messageOf(cause), cause)
        })
        const { socket } = started
        const stdout = new PassThrough()
        const stderr = new PassThrough()
        docker.modem.demuxStream(socket, stdout, stderr)

        // Readiness handshake on the side channel; the data channel stays pristine.
        const ready = yield* Effect.async<void, ExecFailed>((resume) => {
          let text = ''
          let settled = false
          const settle = (result: Effect.Effect<void, ExecFailed>) => {
            if (settled) return
            settled = true
            stderr.off('data', onData)
            resume(result)
          }
          const onData = (chunk: Buffer | string) => {
            text += chunk.toString()
            const nl = text.indexOf('\n')
            if (nl === -1) return
            const line = text.slice(0, nl).trim()
            settle(
              line === 'ok'
                ? Effect.void
                : Effect.fail(failed(`cannot reach 127.0.0.1:${port} in the box: ${line}`))
            )
          }
          stderr.on('data', onData)
          socket.once('close', () => settle(Effect.fail(failed('relay exited before connecting'))))
          socket.once('error', (cause) => settle(Effect.fail(failed(messageOf(cause), cause))))
        }).pipe(
          Effect.timeoutFail({
            duration: `${TUNNEL_CONNECT_MS} millis`,
            onTimeout: () => failed(`no answer from 127.0.0.1:${port} in the box`)
          }),
          Effect.either
        )
        if (ready._tag === 'Left') {
          socket.destroy()
          return yield* ready.left
        }

        // `http.request({ createConnection })` and `ws` treat what they get as a
        // `net.Socket` and call these; they have nothing to do on a relayed stream.
        const tunnel = Object.assign(Duplex.from({ readable: stdout, writable: socket }), {
          setNoDelay: () => tunnel,
          setKeepAlive: () => tunnel,
          setTimeout: () => tunnel,
          ref: () => tunnel,
          unref: () => tunnel
        })
        // Destroying a composed Duplex aborts both halves with an `AbortError` that is
        // *emitted*, not thrown; nobody needs to hear it (the consumer is gone).
        const swallow = () => undefined
        tunnel.on('error', swallow)
        stdout.on('error', swallow)
        stderr.on('error', swallow)
        socket.on('error', swallow)
        socket.once('close', () => {
          stdout.end()
          if (!tunnel.destroyed) tunnel.destroy()
        })
        yield* Effect.addFinalizer(() =>
          Effect.promise(async () => {
            if (!tunnel.destroyed) tunnel.destroy()
            socket.destroy()
            try {
              const killer = await container.exec({
                Cmd: ['sh', '-c', killScript(execId, 'KILL')],
                User: AGENT_USER,
                AttachStdout: false,
                AttachStderr: false
              })
              await killer.start({ Detach: true })
            } catch {
              // container gone — nothing to kill
            }
          })
        )
        return tunnel
      })

  const signalTasks =
    (machine: Pick<Machine, 'exec'>, agentId: string) =>
    (signal: TaskSignal): Effect.Effect<number, MachineUnavailable | ExecFailed> =>
      Effect.gen(function* () {
        const lines: Array<string> = []
        yield* machine
          .exec({
            cmd: ['sh', '-c', signalTasksScript(signal)],
            env: { [WORKSPACE_EXEC_ENV]: '1' },
            timeoutMs: 10_000,
            onLine: (line) => {
              lines.push(line)
            }
          })
          .pipe(
            Effect.mapError((e) =>
              e._tag === 'BinaryMissing'
                ? new ExecFailed({ agentId, cmd: ['sh'], reason: e.message })
                : e
            )
          )
        const n = Number(lines[lines.length - 1] ?? '0')
        return Number.isFinite(n) ? n : 0
      })

  // -- files ---------------------------------------------------------------

  const putFile =
    (spec: MachineSpec, container: Dockerode.Container) =>
    (path: string, content: Uint8Array | string) =>
      Effect.tryPromise({
        try: async () => {
          const target = toContainerPath(path)
          const dir = dirname(target)
          const mk = await container.exec({
            Cmd: ['mkdir', '-p', dir],
            User: AGENT_USER,
            AttachStdout: true,
            AttachStderr: true
          })
          const s = await mk.start({ hijack: true })
          await new Promise<void>((resolve) => {
            s.on('end', resolve)
            s.on('close', resolve)
            s.resume()
          })
          const tar = pack()
          const buffer = typeof content === 'string' ? Buffer.from(content, 'utf8') : content
          tar.entry(
            { name: posix.basename(target), mode: 0o644, uid: AGENT_UID, gid: AGENT_GID },
            Buffer.from(buffer)
          )
          tar.finalize()
          await container.putArchive(Readable.from(tar), { path: dir })
        },
        catch: (cause) =>
          new ExecFailed({
            agentId: spec.agentId,
            cmd: ['putFile', path],
            reason: messageOf(cause),
            cause
          })
      })

  const getFile = (spec: MachineSpec, container: Dockerode.Container) => (path: string) =>
    Effect.tryPromise({
      try: async () => {
        const archive = await container.getArchive({ path: toContainerPath(path) })
        return await new Promise<Uint8Array>((resolve, reject) => {
          const ex = extract()
          let found: Buffer | undefined
          ex.on('entry', (header, stream, next) => {
            const chunks: Array<Buffer> = []
            stream.on('data', (c) => {
              chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c)))
            })
            stream.on('end', () => {
              if (found === undefined && header.type === 'file') found = Buffer.concat(chunks)
              next()
            })
            stream.resume()
          })
          ex.on('finish', () =>
            found === undefined
              ? reject(new Error(`no file entry in archive for ${path}`))
              : resolve(new Uint8Array(found))
          )
          ex.on('error', reject)
          archive.pipe(ex)
        })
      },
      catch: (cause) =>
        new ExecFailed({
          agentId: spec.agentId,
          cmd: ['getFile', path],
          reason: messageOf(cause),
          cause
        })
    })

  // -- machine -------------------------------------------------------------

  const makeMachine = (spec: MachineSpec): Machine => {
    const name = containerName(spec)
    const container = docker.getContainer(name)
    const agentId = spec.agentId

    const execStream = (o: ExecOptions) =>
      processStream({ agentId, cmd: o.cmd }, o, spawnExec(spec, container, o, randomUUID()))

    const machine: Machine = {
      id: name,
      provider: 'docker',
      spec,
      paths: { home: CONTAINER_HOME, hostHome: spec.homeDir },
      status: () => inspectOrNull(agentId, name).pipe(Effect.map(toStatus)),
      start: () =>
        inspectOrNull(agentId, name).pipe(
          Effect.flatMap((info) =>
            info === null
              ? Effect.fail(unavailable(agentId, 'container missing; call ensure()'))
              : info.State.Running
                ? Effect.void
                : startContainer(agentId, container)
          )
        ),
      stop: () =>
        tryDocker(agentId, 'stop', async () => {
          try {
            await container.stop({ t: 5 })
          } catch (cause) {
            const code = statusCode(cause)
            if (code !== 304 && code !== 404) throw cause
          }
        }),
      destroy: () =>
        tryDocker(agentId, 'remove', async () => {
          try {
            await container.remove({ force: true })
          } catch (cause) {
            if (statusCode(cause) !== 404) throw cause
          }
        }),
      execStream,
      exec: (o) => runExec({ agentId, cmd: o.cmd }, o, execStream(o)),
      openPty: openPty(spec, container),
      openTunnel: openTunnel(spec, container),
      signalTasks: (signal) => signalTasks(machine, agentId)(signal),
      putFile: putFile(spec, container),
      getFile: getFile(spec, container)
    }
    return machine
  }

  const specFromLabels = (labels: Record<string, string> | undefined): MachineSpec | null => {
    const raw = labels?.[LABEL_SPEC]
    if (raw === undefined) return null
    try {
      return JSON.parse(raw) as MachineSpec
    } catch {
      return null
    }
  }

  const provider: MachineProvider = {
    name: 'docker',
    ensure: (spec) =>
      Effect.gen(function* () {
        yield* ensureHomeLayout(spec.homeDir, { chownToAgent: true }).pipe(
          Effect.mapError((cause) =>
            unavailable(spec.agentId, `cannot create home: ${cause.message}`, cause)
          )
        )
        const network = yield* ensureNetwork(spec)
        const name = containerName(spec)
        let info = yield* inspectOrNull(spec.agentId, name)
        if (info === null) {
          yield* createContainer(spec, network)
          info = yield* inspectOrNull(spec.agentId, name)
        }
        if (info === null || !info.State.Running) {
          yield* startContainer(spec.agentId, docker.getContainer(name))
        }
        return makeMachine(spec)
      }),
    get: (agentId) =>
      tryDocker(agentId, 'list', async () => {
        const found = await docker.listContainers({
          all: true,
          filters: JSON.stringify({ label: [`${LABEL_AGENT}=${agentId}`] })
        })
        const spec = specFromLabels(found[0]?.Labels)
        return spec === null ? Option.none() : Option.some(makeMachine(spec))
      }),
    list: (companyId) =>
      tryDocker(companyId, 'list', async () => {
        const found = await docker.listContainers({
          all: true,
          filters: JSON.stringify({ label: [LABEL_AGENT] })
        })
        return found
          .map((c) => specFromLabels(c.Labels))
          .filter((s): s is MachineSpec => s !== null && s.companyId === companyId)
          .map(makeMachine)
      }),
    destroy: (agentId) =>
      provider.get(agentId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (m) => m.destroy()
          })
        )
      )
  }
  return provider
}

/** `Layer` providing the `docker` provider as `MachineProviderTag`. */
export const DockerProviderLive = (options: DockerProviderOptions = {}) =>
  Layer.succeed(MachineProviderTag, makeDockerProvider(options))
