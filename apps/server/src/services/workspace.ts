/**
 * The agent workspace (docs/build-plan-workspace.md): machine control (D5), the
 * process list (D13) and the seam the terminal socket opens a PTY through (D8).
 *
 * Every entry point is gated on "may manage the agent" — admin+ or the head of
 * the agent's department, the same rule as the vault and `grantFile` (D3): a
 * shell in the box is total access to that agent's home, its vault-injected env
 * and its browser profile. Nothing here is persisted (D4); the box is looked up
 * through `MachineProviderTag` on every call and sessions live in
 * `realtime/terminalWs.ts`'s memory.
 *
 * Failures of the box itself (`MachineUnavailable`, an exec that will not run)
 * surface as the contract's `RuntimeUnavailable` (503) — the same error a task
 * gets when the provider is down.
 */
import { SqlClient } from '@effect/sql'
import type { Agent, MachineInfo, ProcessEntry } from '@taut/contract/domain'
import type { CurrentUserShape } from '@taut/contract/api'
import { Forbidden, NotFound, RuntimeUnavailable, type Unauthorized } from '@taut/contract/errors'
import { type AgentId, CompanyId, type UserId } from '@taut/contract/ids'
import {
  BROWSER_CDP_PORT,
  type BinaryMissing,
  type ExecFailed,
  type Machine,
  type MachineSpec,
  MachineProviderTag,
  MachineUnavailable,
  type Pty,
  type PtyOptions,
  type TaskSignal,
  ensureBrowserDaemon,
  ensureLocalBrowserDaemon
} from '@taut/runtime'
import { Effect, Option, Schema, type Scope } from 'effect'
import { AppConfig } from '../config.js'
import { findOne } from '../db/sql.js'
import { type Actor, actor } from './access.js'
import { makeAgentAccess } from './agentAccess.js'
import { Agents } from './agents.js'
import { type BrowserSession, openBrowserSession } from './browserLive.js'
import { Tasks } from './tasks.js'
import { Users } from './users.js'

/** D13: one line per process, `args` last so it may contain spaces. */
export const PS_COMMAND: ReadonlyArray<string> = [
  'ps',
  '-eo',
  'pid,ppid,etimes,pcpu,pmem,args',
  '--no-headers'
]

/** No `ps` should take this long; a wedged box must not hang the Processes pane. */
const PS_TIMEOUT_MS = 10_000

const PS_LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+(.*?)\s*$/

/**
 * Parse one `ps -eo pid,ppid,etimes,pcpu,pmem,args --no-headers` line. `null` for
 * anything that does not fit (a header, a locale-mangled number): the pane shows
 * what parsed rather than failing the whole list on one odd row.
 */
export const parsePsLine = (line: string): ProcessEntry | null => {
  const m = PS_LINE.exec(line)
  if (m === null) return null
  const [, pid, ppid, etimes, pcpu, pmem, args] = m
  return {
    pid: Number(pid),
    ppid: Number(ppid),
    elapsedSeconds: Number(etimes),
    cpuPercent: Number(pcpu),
    memoryPercent: Number(pmem),
    command: args ?? ''
  }
}

/**
 * Content type for a file served out of the home (D12 gallery), from its extension.
 * Playwright MCP writes `.png`/`.jpeg` screenshots and `.zip` traces; everything
 * unknown is an opaque download.
 */
export const contentTypeOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  const ext = dot === -1 ? '' : name.slice(dot + 1).toLowerCase()
  switch (ext) {
    case 'png':
      return 'image/png'
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg'
    case 'gif':
      return 'image/gif'
    case 'webp':
      return 'image/webp'
    case 'svg':
      return 'image/svg+xml'
    case 'pdf':
      return 'application/pdf'
    case 'json':
      return 'application/json'
    case 'txt':
    case 'log':
      return 'text/plain; charset=utf-8'
    case 'md':
      return 'text/markdown; charset=utf-8'
    case 'html':
      return 'text/html; charset=utf-8'
    case 'zip':
      return 'application/zip'
    default:
      return 'application/octet-stream'
  }
}

/** The box a Workspace call resolved: the agent, and its machine when one exists. */
export interface ResolvedBox {
  readonly agent: Agent
  readonly machine: Option.Option<Machine>
}

/**
 * The `MachineSpec` for an agent, identical to the one `agents/runTask.ts` builds
 * before a task. Kept next to the workspace because the task runner is held by
 * other builds; converging the two is a `TODO(plan)` in the report.
 */
export const machineSpecFor = (o: {
  readonly agent: Pick<Agent, 'id' | 'handle'>
  readonly companyId: CompanyId
  readonly companySlug: string
  readonly homeDir: string
  readonly image: string | undefined
}): MachineSpec => ({
  agentId: o.agent.id,
  companyId: o.companyId,
  companySlug: o.companySlug,
  handle: o.agent.handle,
  ...(o.image === undefined ? {} : { image: o.image }),
  homeDir: o.homeDir,
  limits: { cpus: 2, memoryMb: 2048, pidsLimit: 512 },
  network: { egress: 'allow-all' }
})

export class Workspace extends Effect.Service<Workspace>()('Workspace', {
  effect: Effect.gen(function* () {
    const provider = yield* MachineProviderTag
    const agents = yield* Agents
    const users = yield* Users
    const tasks = yield* Tasks
    const config = yield* AppConfig
    const sql = yield* SqlClient.SqlClient
    const { requireManageAgent } = yield* makeAgentAccess

    const companySlug = findOne({
      Request: CompanyId,
      Result: Schema.Struct({ slug: Schema.String }),
      execute: (id) => sql`SELECT slug FROM companies WHERE id = ${id}`
    })

    const unavailable = (agent: Agent, reason: string): RuntimeUnavailable =>
      new RuntimeUnavailable({ runtime: agent.runtimeKind, reason })

    const providerError = (agent: Agent) => (e: MachineUnavailable | ExecFailed) =>
      unavailable(agent, e.message)

    // ── authorization ────────────────────────────────────────────────────────

    /** The agent (404 first, so a manager learns it is gone) then the D3 gate. */
    const authorizeActor = (
      who: Actor,
      agentId: AgentId
    ): Effect.Effect<Agent, NotFound | Forbidden> =>
      agents.byId(who.companyId, agentId).pipe(Effect.tap(() => requireManageAgent(who, agentId)))

    const authorize = (
      me: CurrentUserShape,
      agentId: AgentId
    ): Effect.Effect<{ who: Actor; agent: Agent }, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const agent = yield* authorizeActor(who, agentId)
        return { who, agent }
      })

    /**
     * Same gate for the terminal socket, whose principal comes from the cookie
     * (`WsAuthenticator`) and carries no role: it is looked up here.
     */
    const authorizePrincipal = (
      principal: { readonly userId: UserId; readonly companyId: CompanyId },
      agentId: AgentId
    ): Effect.Effect<Agent, NotFound | Forbidden> =>
      users.roleIn(principal.companyId, principal.userId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new Forbidden({ message: 'Not a member of this company' })),
            onSome: (role) => authorizeActor({ ...principal, role }, agentId)
          })
        )
      )

    // ── machine info ─────────────────────────────────────────────────────────

    const boxOf = (agent: Agent): Effect.Effect<ResolvedBox, RuntimeUnavailable> =>
      provider.get(agent.id).pipe(
        Effect.mapError(providerError(agent)),
        Effect.map((machine) => ({ agent, machine }))
      )

    const infoOf = (box: ResolvedBox): Effect.Effect<MachineInfo, RuntimeUnavailable> =>
      Option.match(box.machine, {
        onNone: () =>
          Effect.succeed<MachineInfo>({
            provider: provider.name,
            status: 'missing',
            home: '',
            terminal: provider.name === 'docker',
            liveView: true
          }),
        onSome: (machine) =>
          machine.status().pipe(
            Effect.mapError(providerError(box.agent)),
            Effect.map((status): MachineInfo => ({
              provider: provider.name,
              status,
              machineId: machine.id,
              home: machine.paths.home,
              terminal: provider.name === 'docker',
              liveView: true,
              ...(machine.spec.image === undefined ? {} : { image: machine.spec.image })
            }))
          )
      })

    const info = (
      me: CurrentUserShape,
      agentId: AgentId
    ): Effect.Effect<MachineInfo, Unauthorized | NotFound | Forbidden | RuntimeUnavailable> =>
      authorize(me, agentId).pipe(
        Effect.flatMap(({ agent }) => boxOf(agent)),
        Effect.flatMap(infoOf)
      )

    /** `ensure` is create-or-reuse + start (docs/agent-model.md §7), so this is idempotent. */
    const start = (
      me: CurrentUserShape,
      agentId: AgentId
    ): Effect.Effect<MachineInfo, Unauthorized | NotFound | Forbidden | RuntimeUnavailable> =>
      Effect.gen(function* () {
        const { who, agent } = yield* authorize(me, agentId)
        const homeDir = yield* agents.homeOf(who.companyId, agent.id)
        const company = yield* companySlug(who.companyId).pipe(Effect.flatMap(Effect.orDie))
        const machine = yield* provider
          .ensure(
            machineSpecFor({
              agent,
              companyId: who.companyId,
              companySlug: company.slug,
              homeDir,
              image: config.agentImage
            })
          )
          .pipe(Effect.mapError(providerError(agent)))
        yield* Effect.logInfo('workspace: machine started').pipe(
          Effect.annotateLogs({ agentId: agent.id, viewerId: who.userId, machineId: machine.id })
        )
        return yield* infoOf({ agent, machine: Option.some(machine) })
      })

    const stop = (
      me: CurrentUserShape,
      agentId: AgentId
    ): Effect.Effect<MachineInfo, Unauthorized | NotFound | Forbidden | RuntimeUnavailable> =>
      Effect.gen(function* () {
        const { who, agent } = yield* authorize(me, agentId)
        const box = yield* boxOf(agent)
        if (Option.isSome(box.machine)) {
          yield* box.machine.value.stop().pipe(Effect.mapError(providerError(agent)))
          yield* Effect.logInfo('workspace: machine stopped').pipe(
            Effect.annotateLogs({
              agentId: agent.id,
              viewerId: who.userId,
              machineId: box.machine.value.id
            })
          )
        }
        return yield* infoOf(box)
      })

    // ── processes (D13) ──────────────────────────────────────────────────────

    /**
     * `ps` inside the box. Empty when there is no running box (the pane says so
     * through `MachineInfo.status`, not through an error). The `ps` row itself is
     * dropped. No kill: `// TODO(plan)` — killing a runtime mid-task would corrupt
     * the task and its handover (D13).
     */
    const processes = (
      me: CurrentUserShape,
      agentId: AgentId
    ): Effect.Effect<
      ReadonlyArray<ProcessEntry>,
      Unauthorized | NotFound | Forbidden | RuntimeUnavailable
    > =>
      Effect.gen(function* () {
        const { agent } = yield* authorize(me, agentId)
        if (provider.name !== 'docker') {
          // D2: on `local` there is no box, so `ps` would list the host's processes.
          return []
        }
        const box = yield* boxOf(agent)
        if (Option.isNone(box.machine)) return []
        const machine = box.machine.value
        const status = yield* machine.status().pipe(Effect.mapError(providerError(agent)))
        if (status !== 'running') return []
        const lines: Array<string> = []
        yield* machine
          .exec({
            cmd: PS_COMMAND,
            timeoutMs: PS_TIMEOUT_MS,
            onLine: (line) => {
              lines.push(line)
            }
          })
          .pipe(Effect.mapError((e) => unavailable(agent, e.message)))
        const own = PS_COMMAND.join(' ')
        return lines
          .map(parsePsLine)
          .filter((entry): entry is ProcessEntry => entry !== null && entry.command !== own)
      })

    // ── terminal (D8) ────────────────────────────────────────────────────────

    /**
     * A PTY in the agent's box for the terminal socket. The box must exist and be
     * running (the tab's Connect button calls `start` first); on `local` the
     * provider itself refuses (D2). Lives in the caller's `Scope`.
     */
    const openPty = (
      agent: Agent,
      options: PtyOptions
    ): Effect.Effect<
      { readonly pty: Pty; readonly machine: Machine },
      MachineUnavailable | ExecFailed,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const found = yield* provider.get(agent.id)
        if (Option.isNone(found)) {
          return yield* new MachineUnavailable({
            provider: provider.name,
            agentId: agent.id,
            reason: 'the box has not been started yet'
          })
        }
        const machine = found.value
        const pty = yield* machine.openPty(options)
        return { pty, machine }
      })

    /** The running box of `agent`, or `MachineUnavailable`. */
    const runningMachine = (agent: Agent): Effect.Effect<Machine, MachineUnavailable> =>
      Effect.gen(function* () {
        const found = yield* provider.get(agent.id)
        if (Option.isNone(found)) {
          return yield* new MachineUnavailable({
            provider: provider.name,
            agentId: agent.id,
            reason: 'the box has not been started yet'
          })
        }
        return found.value
      })

    // ── browser live view (D11, D16) ─────────────────────────────────────────

    /**
     * Bring Chromium up in the box (idempotent) and open a CDP session on it. Only
     * for agents with `browserAccess` (D16) — the caller checks — and only on docker
     * (D2: the tunnel refuses on `local`). Lives in the caller's `Scope`.
     */
    const openLiveView = (
      agent: Agent
    ): Effect.Effect<
      BrowserSession,
      MachineUnavailable | ExecFailed | BinaryMissing,
      Scope.Scope
    > =>
      Effect.gen(function* () {
        const machine = yield* runningMachine(agent)
        // Same Chromium either way, started where the agent runs: through an exec in
        // the container on `docker`, straight from Node on `local` (no box, no /proc,
        // and the host cache holds the binary). The port is fixed inside a container
        // and per-agent on the host, where the owner's own Chrome may well hold 9222.
        let port = BROWSER_CDP_PORT
        if (provider.name === 'docker') {
          yield* ensureBrowserDaemon(machine, { homeDir: machine.paths.home, port })
        } else {
          const daemon = yield* ensureLocalBrowserDaemon({
            agentId: agent.id,
            homeDir: machine.paths.home
          })
          port = daemon.port
        }
        return yield* openBrowserSession(machine, { port })
      })

    // ── take control interlock (D15) ─────────────────────────────────────────

    /** `true` while the agent has a task in `running` — its runtime may be driving the browser. */
    const hasRunningTask = (agent: Agent): Effect.Effect<boolean> =>
      tasks
        .live()
        .pipe(
          Effect.map((all) =>
            all.some((task) => task.agentId === agent.id && task.status === 'running')
          )
        )

    /** Freeze (`STOP`) or resume (`CONT`) every task exec in the agent's box. */
    const signalTasks = (
      agent: Agent,
      signal: TaskSignal
    ): Effect.Effect<number, MachineUnavailable | ExecFailed> =>
      runningMachine(agent).pipe(Effect.flatMap((machine) => machine.signalTasks(signal)))

    return {
      info,
      start,
      stop,
      processes,
      authorizePrincipal,
      openPty,
      /** The running box of an agent — what a browser-only socket connects to (no PTY). */
      runningMachine,
      openLiveView,
      hasRunningTask,
      signalTasks,
      /** Which provider is wired, for the socket's own explainer. */
      providerName: provider.name
    } as const
  })
}) {}
