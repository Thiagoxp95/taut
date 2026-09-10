/**
 * One task run, end to end (docs/agent-model.md §11; build-plan "Agent execution"):
 *
 *   pick seat (pool §4, or dev `host-login`) → resolve credential → `MachineProvider.ensure`
 *   → instructions file + MCP config + task token → `runTask` (adapter + redactor)
 *   → deltas coalesced into the streaming message → finalize (`agent.task.done|failed`)
 *   → notify the human who asked, expire the token, presence back to `idle`.
 *
 * Retries (each at most once per task): a rate-limit / usage-cap answer parks the seat
 * (`Subscriptions.markRateLimited`) and re-picks; an auth failure marks it `auth-failed`
 * and re-picks; a failed `--resume` clears the stored session and reruns fresh.
 * Interruption (cancel) finalizes the message as `failed: cancelled`. Never fails: every
 * error becomes a `failed` task with a human-readable message.
 *
 * Secrets (docs/build-plan-browser-vaults.md D5): one `Redactor` per task, seeded with the
 * seat secret and kept in `redactors` for as long as the task runs. `vault_get`
 * (`AgentApi.vaultGet`) calls `registerSecret` before its response is written, so a value
 * fetched mid-task is masked from the very next stream line. The entry goes away in the
 * `ensuring` of `run` — done, failed, crashed or cancelled alike.
 *
 * Browser (D1, D7): when `agent.browserAccess` the MCP config gets a second stdio server
 * `browser` (Playwright MCP, `browserMcpSpec`), claude-code's allow-list gains
 * `mcp__browser__*`, and the instructions file says the browser is there.
 *
 * Repositories (docs/build-plan-repositories.md): every repository the agent is granted gets a
 * worktree under the task's work dir (`prepareRepos`), the exec env gets a `git` credential
 * helper pointing back at this server (`gitCredentialEnv` — no token on disk, D4), and the
 * instruction file lists what was actually prepared. The whole block is skipped when the agent
 * has no grant, so such a task runs exactly as it did before the feature existed; and nothing
 * inside it can fail a task — a repository that will not clone is logged and dropped.
 */
import { FileSystem } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import { Agent, type Message, type Subscription } from '@taut/contract/domain'
import {
  type AgentId,
  type ChannelId,
  CompanyId,
  type MemberId,
  type MessageId,
  type TaskId
} from '@taut/contract/ids'
import {
  type AgentEvent,
  type AgentEventOf,
  BROWSER_MCP_SERVER_KEY,
  BROWSER_PATHS,
  BROWSER_WEB_BUILTIN_TOOLS,
  type BuiltCommand,
  type Machine,
  MachineProviderTag,
  type InstructionFileGrant,
  type InstructionRepo,
  type PreparedRepo,
  type Redactor,
  type RepoSpec,
  type RuntimeCredential,
  adapterFor,
  browserCdpEndpoint,
  browserMcpSpec,
  browserMcpBridgeSource,
  browserPromptLine,
  ensureBrowserDaemon,
  gitCredentialEnv,
  localBrowserEndpoint,
  makeRedactor,
  opencodePermission,
  prepareRepos,
  renderInstructions,
  runTask as runtimeRunTask,
  teardownRepos
} from '@taut/runtime'
import {
  type InjectOptions,
  claudeMcpConfig,
  claudeAllowedTools,
  codexConfigToml,
  cursorCliJsonFor,
  cursorMcpJson,
  opencodeJson
} from '@taut/taut-mcp/inject'
import { Cause, Effect, Either, Option, Redacted, Schedule, Schema, Stream } from 'effect'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, posix } from 'node:path'
import { AppConfig } from '../config.js'
import { findOne, nowIso } from '../db/sql.js'
import { HttpNodeServer } from '../http/server.js'
import { Bus } from '../realtime/bus.js'
import { userHandle } from '../services/access.js'
import { Agents } from '../services/agents.js'
import { Attachments } from '../services/attachments.js'
import { Channels } from '../services/channels.js'
import { Messages } from '../services/messages.js'
import { ModelCatalogs } from '../services/modelCatalog.js'
import { Projects } from '../services/projects.js'
import { Repositories } from '../services/repositories.js'
import { ThreadContexts } from '../services/threadContext.js'
import { type Emit, EventPublisher } from '../services/publisher.js'
import {
  CLAUDE_COOLDOWN_MS,
  DEFAULT_COOLDOWN_MS,
  Subscriptions
} from '../services/subscriptions.js'
import { type TaskInternal, Tasks } from '../services/tasks.js'
import { Users } from '../services/users.js'
import { Vault } from '../services/vault.js'
import { describeTool, isBrowserTool, makeActivitySummary } from './activity.js'
import { issueContextBlock } from './issueContext.js'
import { CONTEXT_MESSAGES, renderPrompt, tautSection } from './prompt.js'
import { makeReplyText } from './replyText.js'
import { AgentSessions } from './sessions.js'
import { TaskTokens } from './tokens.js'

/** No stdout/stderr for this long → the runtime is killed. */
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000
/** Hard wall-clock cap per attempt. */
export const HARD_TIMEOUT_MS = 60 * 60 * 1000

export const RATE_LIMIT_RE =
  /\b429\b|rate.?limit|usage limit|out of (?:extra )?usage|quota|overloaded|too many requests|capacity/i
export const AUTH_FAILED_RE =
  /authentication_failed|not logged in|invalid (?:x-)?api[- ]key|\b401\b|unauthori[sz]ed|invalid_api_key|authentication error|oauth (?:session|token)/i
const RESUME_FAILED_RE =
  /no conversation found|session.*not found|could not resume|unknown session/i

interface Seat {
  readonly subscription?: Subscription | undefined
  readonly credential: RuntimeCredential
  readonly secret?: string | undefined
}

/**
 * Floor between two context broadcasts (docs/build-plan-context-meter.md D10). Samples arrive
 * per assistant message; the ring is a number that moves once a turn.
 */
const CONTEXT_BROADCAST_MS = 1_000

/**
 * Floor between two activity broadcasts (docs/build-plan-activity.md D3). Fast enough that
 * the line reads as live, slow enough that a run hammering `Read` in a loop does not become
 * a strobe nobody can read a word of.
 */
const ACTIVITY_BROADCAST_MS = 400

interface AttemptResult {
  readonly ok: boolean
  readonly error: string
  readonly sawText: boolean
  readonly rateLimited: boolean
  readonly authFailed: boolean
  readonly resumeFailed: boolean
  readonly sessionId?: string | undefined
  readonly summary?: string | undefined
}

/**
 * Home directories every task may reach, whatever the agent's file grants are. The task runs in
 * `<home>/work/<taskId>`, so the rest of the home is outside what a runtime scopes itself to and
 * headless claude-code auto-denies a read there ("it's outside the dirs I'm allowed to read" is
 * what an agent answered when told to follow one of its own skills).
 *
 * - `inbox/` — attachments (D3) and files dropped through the Files tab.
 * - `skills/` — the instruction file points at `<home>/skills/<name>/SKILL.md`, and a skill keeps
 *   its docs and scripts next to that file; without the directory the agent has the one-line
 *   description and nothing else.
 * - `memory/` — `@<home>/memory/MEMORY.md` in the claude-code instruction file.
 *
 * `HOME_DIRS` guarantees all three exist. Skills and memory are written through the MCP tools
 * (`skill_write`, `memory_note`), never by hand, so they go in read-only — which only opencode
 * enforces, the rest merely state it.
 */
const homeDirGrants = (home: string): ReadonlyArray<InstructionFileGrant> => [
  { path: posix.join(home, 'inbox'), mode: 'rw' },
  { path: posix.join(home, 'skills'), mode: 'ro' },
  { path: posix.join(home, 'memory'), mode: 'ro' }
]

const splitCommand = (raw: string): { command: string; args: ReadonlyArray<string> } => {
  const [command = 'node', ...args] = raw.trim().split(/\s+/)
  return { command, args }
}

/** `packages/taut-mcp/dist/mcp.js` next to the installed package, when it has been built. */
const bundledMcp = (): string | undefined => {
  try {
    const protocol = createRequire(import.meta.url).resolve('@taut/taut-mcp/protocol')
    const candidate = join(dirname(protocol), '..', 'dist', 'mcp.js')
    return existsSync(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

export class TaskRunner extends Effect.Service<TaskRunner>()('TaskRunner', {
  effect: Effect.gen(function* () {
    const config = yield* AppConfig
    const sql = yield* SqlClient.SqlClient
    const fs = yield* FileSystem.FileSystem
    const publisher = yield* EventPublisher
    const bus = yield* Bus
    const messages = yield* Messages
    const projects = yield* Projects
    const attachments = yield* Attachments
    const tasks = yield* Tasks
    const subscriptions = yield* Subscriptions
    const vault = yield* Vault
    const agents = yield* Agents
    const channels = yield* Channels
    const repositories = yield* Repositories
    const users = yield* Users
    const tokens = yield* TaskTokens
    const sessions = yield* AgentSessions
    const threadContexts = yield* ThreadContexts
    const modelCatalogs = yield* ModelCatalogs
    const provider = yield* MachineProviderTag
    const { server } = yield* HttpNodeServer

    const companyRow = findOne({
      Request: CompanyId,
      Result: Schema.Struct({ slug: Schema.String, name: Schema.String }),
      execute: (id) => sql`SELECT slug, name FROM companies WHERE id = ${id}`
    })

    // ── per-task redactors ──────────────────────────────────────────────────

    /** One per running task; created at the top of `run`, removed in its `ensuring`. */
    const redactors = new Map<TaskId, Redactor>()

    /**
     * Mask `secret` in everything the task prints from now on. `false` when the task is not
     * running any more (nothing left to redact — the caller should refuse to hand it out).
     */
    const registerSecret = (taskId: TaskId, secret: string): boolean => {
      const redactor = redactors.get(taskId)
      if (redactor === undefined) return false
      redactor.add(secret)
      return true
    }

    // ── steering (docs/build-plan-steering-reactions.md D5, D7) ─────────────

    /**
     * What a running task needs to be steered: where its conversation is, whose messages to
     * ignore (its own), what has piled up since it was last drained, and whether it has
     * already spent its one deflection.
     *
     * `conversation` is the thread the task *replies into* — `task.threadId` when it answers
     * inside a thread, `undefined` when it answers at channel root — which is exactly how a
     * message identifies the conversation it belongs to. Two agents mentioned in one root
     * message therefore steer each other without a special case (D12).
     */
    interface SteerState {
      readonly channelId: ChannelId
      readonly conversation: MessageId | undefined
      readonly agentId: AgentId
      readonly queued: Set<MessageId>
      pending: Array<Message>
      deflections: number
      /** D4: the agent reacted at least once this run, so silence is a real answer. */
      reacted: boolean
      /** A tool already posted this turn's contribution in this conversation. */
      sent: boolean
      /** Completed teammate messages included in this turn's prompt or tool results. */
      readonly read: Set<MessageId>
      /** D4: `taut_done("")` was accepted; the empty reply is taken back at the end. */
      withdraw: boolean
    }

    /** One entry per running task; created in `run`, removed in its `ensuring`. */
    const steering = new Map<TaskId, SteerState>()
    // Queued mentions can be included in an earlier turn's fresh prompt. Keep receipts
    // only for successful turns; failed/cancelled turns must not swallow a queued request.
    const readByConversation = new Map<string, Set<MessageId>>()
    const conversationKey = (t: TaskInternal): string => `${t.task.agentId}:${t.task.threadId}`

    /** Oldest dropped past this; a run that ignores its steer list does not grow a backlog. */
    const MAX_STEER_QUEUED = 20

    /** At most one `taut_send` / `taut_done` may be deflected per run (D7) — never a loop. */
    const MAX_DEFLECTIONS = 1

    const sameConversation = (message: Message, state: SteerState): boolean =>
      message.channelId === state.channelId &&
      (message.threadId ?? null) === (state.conversation ?? null)

    /**
     * Feed a message to every run it is news for (D5). Called from the scheduler's bus
     * consumer for both `message.created` and the `message.updated` that closes an agent's
     * streaming reply, so an agent answer arrives once, complete, and only when it has text.
     * Never fails and never blocks the bus.
     */
    const steer = (message: Message): void => {
      if (message.status !== 'sent' || message.body.trim().length === 0) return
      for (const state of steering.values()) {
        if (message.authorKind === 'agent' && message.authorId === state.agentId) continue
        if (!sameConversation(message, state)) continue
        if (state.queued.has(message.id)) continue
        state.queued.add(message.id)
        state.pending.push(message)
        if (state.pending.length > MAX_STEER_QUEUED) state.pending.shift()
      }
    }

    /** Drain what has landed for this task. Empty for a task not running in this process. */
    const takeSteer = (taskId: TaskId): ReadonlyArray<Message> => {
      const state = steering.get(taskId)
      if (state === undefined || state.pending.length === 0) return []
      const out = state.pending
      state.pending = []
      for (const message of out) {
        if (message.authorKind === 'agent') state.read.add(message.id)
      }
      return out
    }

    /** Read without draining — what `send`/`done` decide a deflection on. */
    const peekSteer = (taskId: TaskId): ReadonlyArray<Message> =>
      steering.get(taskId)?.pending ?? []

    /** `taut_react` succeeded for this task (D4). */
    const noteReaction = (taskId: TaskId): void => {
      const state = steering.get(taskId)
      if (state !== undefined) state.reacted = true
    }

    const noteSent = (taskId: TaskId, message: Message): void => {
      const state = steering.get(taskId)
      if (state !== undefined && sameConversation(message, state)) state.sent = true
    }

    /**
     * An explicit silent completion: the contribution was already sent or was a reaction.
     * Accept it only after that side effect exists; then even runtime closing narration
     * must not create a second message.
     */
    const noteWithdraw = (taskId: TaskId): boolean => {
      const state = steering.get(taskId)
      if (state === undefined || (!state.reacted && !state.sent)) return false
      state.withdraw = true
      return true
    }

    /**
     * Spend this run's one deflection. `true` means the caller must refuse the post and hand
     * the agent its steer list instead; `false` means it has already been deflected once (or
     * is not running here) and the post goes through whatever landed.
     */
    const useDeflection = (taskId: TaskId): boolean => {
      const state = steering.get(taskId)
      if (state === undefined || state.pending.length === 0) return false
      if (state.deflections >= MAX_DEFLECTIONS) return false
      state.deflections += 1
      return true
    }

    /**
     * `taut_done(summary)` per running task. The summary becomes the reply only when the
     * runtime prints nothing after calling it — appending it eagerly doubled the text
     * (`pongpong`) whenever the agent called `taut_done` and then wrote its answer, which
     * is what claude-code does. `false` when the task is not running in this process.
     */
    const doneSummaries = new Map<TaskId, string>()
    const noteDoneSummary = (taskId: TaskId, summary: string): boolean => {
      if (!redactors.has(taskId)) return false
      doneSummaries.set(taskId, summary)
      return true
    }

    // ── environment seen from the machine ──────────────────────────────────

    const agentApiUrl = (): string => {
      const configured = config.agentApiUrl ?? config.publicUrl
      if (configured !== undefined) return configured.replace(/\/+$/, '')
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : config.port
      const host = config.machineProvider === 'docker' ? 'host.docker.internal' : '127.0.0.1'
      return `http://${host}:${port}`
    }

    const mcpCommand = (): { command: string; args: ReadonlyArray<string> } | undefined => {
      if (config.mcpCommand !== undefined) return splitCommand(config.mcpCommand)
      if (config.machineProvider === 'docker')
        return { command: 'node', args: ['/opt/taut/mcp.js'] }
      const bundled = bundledMcp()
      return bundled === undefined ? undefined : { command: process.execPath, args: [bundled] }
    }

    // ── the running commentary ──────────────────────────────────────────────

    /**
     * What the agent is doing, while it is doing it (docs/build-plan-activity.md D1). One
     * line at a time, replacing the last, straight onto the `Bus` — never the event log and
     * never the message body, because none of it is worth keeping once the reply lands (D2).
     *
     * Throttled the way the context meter is: the newest line always wins, and a run that
     * calls six tools in one tick broadcasts the sixth, not all six.
     */
    const makeActivity = (agent: Agent, t: TaskInternal) =>
      Effect.gen(function* () {
        let latest: { readonly kind: 'thinking' | 'tool'; readonly text: string } | undefined
        let sent: string | undefined
        let lastBroadcastAt = 0
        let hasBrowser = false

        const write = (line: { readonly kind: 'thinking' | 'tool'; readonly text: string }) => {
          lastBroadcastAt = Date.now()
          sent = line.text
          return bus.publish({
            _tag: 'Activity',
            companyId: t.task.companyId,
            taskId: t.task.id,
            messageId: t.task.messageId,
            channelId: t.task.channelId,
            threadId: t.task.threadId,
            agentId: agent.id,
            kind: line.kind,
            text: line.text,
            browser: hasBrowser
          })
        }

        /** Whatever the throttle is holding, if it is not what the client already has. */
        const flush = Effect.suspend(() => {
          const pending = latest
          if (pending === undefined || pending.text === sent) return Effect.void
          return write(pending)
        })

        yield* Effect.forkScoped(
          flush.pipe(Effect.repeat(Schedule.spaced(`${ACTIVITY_BROADCAST_MS} millis`)))
        )

        return {
          push: (kind: 'thinking' | 'tool', text: string, browser = false) => {
            const startedBrowser = browser && !hasBrowser
            hasBrowser ||= browser
            if (text.length === 0 || (!startedBrowser && text === latest?.text)) return Effect.void
            latest = { kind, text }
            // Opening the live pane must not wait for a status-text throttle or deduplication.
            return !startedBrowser && Date.now() - lastBroadcastAt < ACTIVITY_BROADCAST_MS
              ? Effect.void
              : write(latest)
          }
        } as const
      })

    // ── seat selection ──────────────────────────────────────────────────────

    const chooseSeat = (
      agent: Agent,
      t: TaskInternal
    ): Effect.Effect<
      { readonly _tag: 'seat'; seat: Seat } | { readonly _tag: 'none'; reason: string }
    > =>
      Effect.gen(function* () {
        const picked = yield* Effect.either(
          subscriptions.pick(agent.companyId, agent.runtimeKind, agent.pinnedSubscriptionId)
        )
        if (picked._tag === 'Right') {
          const sub = picked.right
          const resolved = yield* Effect.either(
            vault.resolveForSpawn(sub.credentialId, agent.id, {
              subscriptionId: sub.id,
              taskId: t.task.id
            })
          )
          if (resolved._tag === 'Left') {
            return {
              _tag: 'none',
              reason: `cannot resolve the credential of subscription "${sub.label}": ${resolved.left.message}`
            } as const
          }
          yield* subscriptions.markUsed(agent.companyId, sub.id).pipe(Effect.ignore)
          yield* tasks
            .update(agent.companyId, t.task.id, { subscriptionId: sub.id })
            .pipe(Effect.ignore)
          // A `claude.login` seat runs on an access token that lives hours, so
          // it is renewed here rather than handed to the runtime already spent.
          const fresh = yield* subscriptions.freshenSeatSecret(
            agent.companyId,
            sub.credentialId,
            resolved.right.item.kind,
            resolved.right.secret
          )
          const secret = Redacted.value(fresh)
          return {
            _tag: 'seat',
            seat: {
              subscription: sub,
              credential: { kind: resolved.right.item.kind, secret },
              secret
            }
          } as const
        }
        if (config.devHostLogin && agent.runtimeKind === 'claude-code') {
          yield* Effect.logWarning(
            `TAUT_DEV_HOST_LOGIN: no usable claude-code subscription (${picked.left.reason}); running @${agent.handle} with this host user's claude login. DEVELOPMENT ONLY.`
          )
          return { _tag: 'seat', seat: { credential: { kind: 'host-login' } } } as const
        }
        return {
          _tag: 'none',
          reason: `No usable ${agent.runtimeKind} subscription (${picked.left.reason}). Ask the department head or an admin to connect one under Subscriptions.`
        } as const
      })

    // ── prompt + instructions ───────────────────────────────────────────────

    /**
     * D3: every attachment of the trigger and of the context messages is copied into
     * `<hostHome>/inbox/<messageId>/` before the prompt names it. Best effort per file
     * (`Attachments.materialise` logs and skips); the prompt still lists the path.
     */
    const materialiseFor = (
      companyId: CompanyId,
      machine: Machine,
      candidates: ReadonlyArray<Message>
    ): Effect.Effect<void> =>
      Effect.forEach(
        candidates.filter((m) => m.attachments.length > 0),
        (m) => attachments.materialise(companyId, m, machine.paths.hostHome),
        { discard: true }
      )

    const buildPrompt = (
      agent: Agent,
      t: TaskInternal,
      trigger: Message,
      companyName: string,
      channel: { readonly kind: 'channel' | 'dm'; readonly name: string },
      machine: Machine,
      /** Set when this run resumes a session: the last thread message that runtime has seen (D7). */
      seenUpTo: MessageId | undefined
    ) =>
      Effect.gen(function* () {
        const [members, agentRefs, context] = yield* Effect.all([
          users.membersOf(agent.companyId),
          users.agentsOf(agent.companyId),
          // Warm path: the resumed runtime already holds the thread up to `seenUpTo`, so only
          // what came after it goes into the prompt. Cold path: the last CONTEXT_MESSAGES of
          // the thread, as before.
          seenUpTo === undefined
            ? messages.recent(
                agent.companyId,
                t.task.channelId,
                t.repliesInThread ? t.task.threadId : null,
                CONTEXT_MESSAGES
              )
            : messages.since(agent.companyId, t.task.threadId, seenUpTo, CONTEXT_MESSAGES)
        ])
        yield* materialiseFor(agent.companyId, machine, [trigger, ...context])
        const read = steering.get(t.task.id)?.read
        for (const message of [trigger, ...context]) {
          if (message.authorKind === 'agent' && message.status === 'sent') read?.add(message.id)
        }
        /**
         * D17: the ticket this thread hangs off, when it is one. One indexed read
         * of `project_issues.thread_message_id` per run — it answers nothing for
         * every ordinary thread, which is the whole reason it can be asked
         * unconditionally rather than guarded by a flag somebody has to set.
         */
        const ticket = yield* projects.issueForThread(agent.companyId, t.task.threadId)
        // A reply inside a thread this agent opened is the answer to its own question. The
        // errand that prompted it sits in a different thread, so without this the agent reads
        // the answer and stops there (docs/agent-model.md §9).
        const root =
          trigger.id === t.task.threadId
            ? Option.none<Message>()
            : yield* messages.byId(agent.companyId, t.task.threadId)
        const answersYourQuestion = Option.isSome(root)
          ? root.value.authorKind === 'agent' && root.value.authorId === agent.id
          : false
        const userHandles = new Map<string, string>(members.map((m) => [m.id, userHandle(m.email)]))
        const agentHandles = new Map<string, string>(agentRefs.map((a) => [a.id, a.handle]))
        const handle = (kind: 'user' | 'agent', id: MemberId): string =>
          `@${(kind === 'user' ? userHandles.get(id) : agentHandles.get(id)) ?? id}`
        return renderPrompt({
          agentHandle: agent.handle,
          companyName,
          ...(Option.isNone(ticket) ? {} : { issue: issueContextBlock(ticket.value) }),
          trigger,
          context,
          names: { handle, channel: channel.kind === 'dm' ? 'dm' : `#${channel.name}` },
          channelKind: channel.kind,
          inThread: t.repliesInThread,
          answersYourQuestion,
          machineHome: machine.paths.home,
          mandate: agent.mandate
        })
      })

    /** The `browser` MCP server for this machine, or nothing when the agent has no browser access. */
    /**
     * Local provider only: Chromium binds a Unix socket under Playwright's sockets dir, whose
     * path is capped at 104 bytes on macOS — an agent home under a deep data dir blew past it
     * ("socket directory path is too long (126 bytes); set PWTEST_SOCKETS_DIR to a shorter
     * location", `pnpm e2e`). A short dir under the OS temp dir keeps it well under the cap.
     * In docker the home is `/home/agent`, so nothing to fix there.
     */
    const browserSocketsDir = (): string | undefined =>
      provider.name === 'local' ? join(tmpdir(), 'taut-pw') : undefined

    const browserServer = (
      agent: Agent,
      machine: Machine,
      /** Set once Taut's own Chromium is up; the agent then shares that browser. */
      cdpEndpoint: string | undefined
    ): Pick<InjectOptions, 'extraServers'> => {
      if (!agent.browserAccess) return {}
      // Attach to the Chromium Taut runs (workspace D11) so the live view and the
      // agent share one browser — and one profile dir, which Chromium will not open
      // twice. Without one, playwright-mcp launches its own, as it always did.
      const spec = browserMcpSpec({
        follow: true,
        provider: provider.name,
        homeDir: machine.paths.home,
        ...(cdpEndpoint === undefined ? {} : { cdpEndpoint })
      })
      const socketsDir = browserSocketsDir()
      return {
        extraServers: {
          [BROWSER_MCP_SERVER_KEY]:
            socketsDir === undefined
              ? spec
              : { ...spec, env: { ...spec.env, PWTEST_SOCKETS_DIR: socketsDir } }
        }
      }
    }

    const writeInstructionFile = (
      agent: Agent,
      machine: Machine,
      cwd: string,
      companyName: string,
      mcpAvailable: boolean,
      fileGrants: ReadonlyArray<InstructionFileGrant>,
      /** Worktrees that actually exist — never the grants, which may not have cloned. */
      repos: ReadonlyArray<InstructionRepo>
    ) =>
      Effect.gen(function* () {
        const hostHome = machine.paths.hostHome
        const skillRows = yield* agents.skillsOf(agent.id)
        const skills = yield* Effect.forEach(skillRows, (s) =>
          fs.readFileString(join(hostHome, 'skills', s.name, 'SKILL.md')).pipe(
            Effect.map((body) => ({ name: s.name, description: s.description, body })),
            Effect.orElseSucceed(() => ({ name: s.name, description: s.description }))
          )
        )
        const memoryMd = yield* fs
          .readFileString(join(hostHome, 'memory', 'MEMORY.md'))
          .pipe(Effect.option, Effect.map(Option.getOrUndefined))
        const departments = yield* agents.departmentsOf(agent.id)
        const heads = yield* Effect.forEach(departments, (d) =>
          users
            .byId(d.headUserId)
            .pipe(
              Effect.map(Option.map((u) => userHandle(u.email))),
              Effect.map(Option.getOrElse(() => 'head'))
            )
        )
        const rendered = renderInstructions({
          kind: agent.runtimeKind,
          // Absolute, like every other path in this file. The default is `../..` from the work
          // dir, and a relative `@import` is one more thing between claude-code and a skill it
          // is now allowed to read.
          homeFromWork: machine.paths.home,
          agent: {
            name: agent.name,
            handle: agent.handle,
            role: agent.role,
            mandate: agent.mandate
          },
          skills,
          ...(memoryMd === undefined ? {} : { memoryMd }),
          fileGrants,
          repos,
          extra: tautSection({
            agentHandle: agent.handle,
            agentName: agent.name,
            companyName,
            departmentNames: departments.map((d) => d.name),
            headHandles: [...new Set(heads)],
            mcpAvailable,
            ...(agent.browserAccess && mcpAvailable
              ? { browserLine: browserPromptLine(machine.paths.home, agent.runtimeKind) }
              : {})
          })
        })
        yield* machine.putFile(posix.join(cwd, rendered.path), rendered.content)
      })

    /**
     * `<home>/.taut/browser/{profile,out}` must exist before Playwright MCP starts (it does not
     * create `--user-data-dir` / `--output-dir` parents). Created on the host side of the home,
     * which is the same directory the machine sees. Best effort: a failure is logged, the
     * browser server then fails on its own and the task still runs.
     */
    const ensureBrowserDirs = (machine: Machine): Effect.Effect<void> =>
      Effect.gen(function* () {
        const profile = join(machine.paths.hostHome, ...BROWSER_PATHS.profile.split('/'))
        const output = join(machine.paths.hostHome, ...BROWSER_PATHS.output.split('/'))
        const socketsDir = browserSocketsDir()
        yield* Effect.forEach(
          [profile, output, ...(socketsDir === undefined ? [] : [socketsDir])],
          (dir) =>
            fs.makeDirectory(dir, { recursive: true }).pipe(
              Effect.tapError((e) =>
                Effect.logWarning(`cannot create browser dir ${dir}: ${e.message}`)
              ),
              Effect.ignore
            ),
          { discard: true }
        )
        yield* fs
          .writeFileString(
            join(machine.paths.hostHome, BROWSER_PATHS.bridge),
            browserMcpBridgeSource
          )
          .pipe(Effect.ignore)
        // A Chromium that died mid-task leaves its profile lock behind and the next launch
        // fails with "browser is already in use". Tasks of one agent never overlap (per-agent
        // semaphore) and the MCP server dies with the runtime, so at this point no browser
        // of this agent is running: the lock is always stale here.
        yield* Effect.forEach(
          ['SingletonLock', 'SingletonSocket', 'SingletonCookie'],
          (name) => fs.remove(join(profile, name), { force: true }).pipe(Effect.ignore),
          { discard: true }
        )
      })

    /** What `writeMcpConfig` produced: the claude `--mcp-config` path (claude-code only) + allow-list. */
    interface McpWiring {
      readonly configPath: string | undefined
      /** claude-code `--allowedTools`; `taut` first, then `browser` when the agent has it. */
      readonly allowedTools: ReadonlyArray<string>
    }

    /**
     * MCP config files for the runtime. With `agent.browserAccess` every file carries the
     * `browser` server next to `taut` (cursor's `cli.json` allows both). On opencode the
     * same `opencode.json` also carries the file grants as a `permission` block
     * (`opencodePermission`), since that runtime has no `--add-dir`.
     */
    const writeMcpConfig = (
      agent: Agent,
      machine: Machine,
      cwd: string,
      token: string,
      t: TaskInternal,
      fileGrants: ReadonlyArray<InstructionFileGrant>,
      cdpEndpoint: string | undefined,
      redactor: Redactor
    ): Effect.Effect<McpWiring | undefined, string> =>
      Effect.gen(function* () {
        const remoteServers = yield* agents.connectorsForRuntime(agent.id)
        const cmd = mcpCommand()
        if (cmd === undefined) {
          if (Object.keys(remoteServers).length > 0) {
            return yield* Effect.fail(
              'Cannot load connectors: build @taut/taut-mcp or set TAUT_MCP_COMMAND'
            )
          }
          yield* Effect.logWarning(
            'taut MCP server not found (build @taut/taut-mcp or set TAUT_MCP_COMMAND); the agent runs without taut_* tools'
          )
          return undefined
        }
        for (const server of Object.values(remoteServers)) {
          for (const value of Object.values(server.headers)) redactor.add(value)
        }
        const o: InjectOptions = {
          remoteServers,
          url: agentApiUrl(),
          token,
          taskId: t.task.id,
          threadId: t.task.threadId,
          command: cmd.command,
          args: cmd.args,
          ...browserServer(agent, machine, cdpEndpoint)
        }
        // claude-code `--allowedTools`: `mcp__taut__*`, plus `mcp__browser__*` and the built-in
        // `WebSearch` / `WebFetch` with browser access — headless `claude` denies every tool the
        // list does not name, and an agent denied `WebSearch` concludes it has no web at all.
        const allowedTools: ReadonlyArray<string> = [
          ...claudeAllowedTools(o),
          ...(agent.browserAccess ? BROWSER_WEB_BUILTIN_TOOLS : [])
        ]
        const put = (path: string, content: string) =>
          machine
            .putFile(path, content)
            .pipe(Effect.mapError(() => 'Cannot write MCP connector configuration'))
        switch (agent.runtimeKind) {
          case 'claude-code': {
            const path = posix.join(cwd, '.taut', 'mcp.json')
            yield* put(path, JSON.stringify(claudeMcpConfig(o), null, 2))
            return { configPath: path, allowedTools }
          }
          case 'codex':
            yield* put(
              posix.join(machine.paths.home, '.taut', 'codex', 'config.toml'),
              codexConfigToml(o)
            )
            return {
              configPath: posix.join(machine.paths.home, '.taut', 'codex', 'config.toml'),
              allowedTools
            }
          case 'cursor':
            yield* put(
              posix.join(cwd, '.cursor', 'mcp.json'),
              JSON.stringify(cursorMcpJson(o), null, 2)
            )
            yield* put(
              posix.join(cwd, '.cursor', 'cli.json'),
              JSON.stringify(cursorCliJsonFor(o), null, 2)
            )
            return { configPath: posix.join(cwd, '.cursor', 'mcp.json'), allowedTools }
          case 'opencode': {
            // Home dirs first: opencode has no `--add-dir`, so `skills/`, `memory/` and
            // `inbox/` reach it only through this block.
            const permission = opencodePermission([
              ...homeDirGrants(machine.paths.home),
              ...fileGrants
            ])
            yield* put(
              posix.join(cwd, 'opencode.json'),
              JSON.stringify(
                { ...opencodeJson(o), ...(permission === undefined ? {} : { permission }) },
                null,
                2
              )
            )
            return { configPath: posix.join(cwd, 'opencode.json'), allowedTools }
          }
        }
      })

    // ── the context meter ────────────────────────────────────────────────────

    /**
     * Turns a run's `context` samples into the ring the user sees
     * (docs/build-plan-context-meter.md D2, D6, D9, D10).
     *
     * Three rules do all the work here, and each exists because the obvious thing is wrong:
     *
     * - **Keep the last sample, never the sum.** Every sample states how full the window is,
     *   not how much was added to it. Adding two turns together counts the same resident
     *   prompt twice, which is how a 40k conversation reports as full.
     * - **Never let the number go up on a technicality.** `totalTokens` is the opposite
     *   quantity — the bill — and it does accumulate, across the whole thread, which is why
     *   it starts from what the thread already recorded.
     * - **Broadcast at most once a second.** Samples arrive per assistant message, which on a
     *   tool-heavy turn is several a second, for a number that meaningfully moves once.
     */
    const makeContextMeter = (agent: Agent, t: TaskInternal, channelId: ChannelId) =>
      Effect.gen(function* () {
        const adapter = adapterFor(agent.runtimeKind)
        const previous = yield* threadContexts
          .get(agent.id, t.task.threadId)
          .pipe(Effect.map(Option.getOrUndefined))
        const carriedTotal = previous?.totalTokens ?? 0

        let latest: AgentEventOf<'context'> | undefined
        let billedThisRun = 0
        let lastBroadcastAt = 0
        let previousUsed = previous?.usedTokens ?? 0
        let compactedAt = previous?.compactedAt
        let compacting = false
        let awaitingCompactedSample = false

        /** A window that lost a fifth of its contents did not forget; it compacted (D9). */
        const COMPACTION_DROP = 0.8

        const write = (sample: AgentEventOf<'context'>) =>
          Effect.gen(function* () {
            const model = sample.model ?? agent.model
            const maxTokens =
              sample.maxTokens ??
              (model === undefined
                ? undefined
                : yield* modelCatalogs
                    .contextWindow(agent.runtimeKind, model)
                    .pipe(Effect.map(Option.getOrUndefined)))
            yield* threadContexts.record({
              companyId: agent.companyId,
              agentId: agent.id,
              threadId: t.task.threadId,
              channelId,
              runtime: agent.runtimeKind,
              usedTokens: sample.usedTokens,
              maxTokens,
              totalTokens: carriedTotal + billedThisRun,
              model,
              compactsAutomatically: adapter.compactsAutomatically,
              compacting,
              compactedAt
            })
            lastBroadcastAt = Date.now()
          }).pipe(
            // The meter must never be the reason a reply fails to land.
            Effect.catchAllCause((cause) =>
              Effect.logWarning(`context meter write failed for task ${t.task.id}`, cause)
            )
          )

        const compaction = (active: boolean) => {
          if (compacting === active) return Effect.void
          compacting = active
          if (!active) awaitingCompactedSample = true
          // A lifecycle event bypasses the usage throttle, even before the first sample.
          return write(
            latest ?? {
              type: 'context',
              usedTokens: previous?.usedTokens ?? 0,
              ...(previous?.maxTokens === undefined ? {} : { maxTokens: previous.maxTokens }),
              ...(previous?.model === undefined ? {} : { model: previous.model })
            }
          )
        }

        return {
          compaction,
          /** Called for every `context` event the runtime emits. */
          sample: (event: AgentEventOf<'context'>) => {
            const dropped = previousUsed > 0 && event.usedTokens < previousUsed * COMPACTION_DROP
            if (dropped) {
              compactedAt = nowIso()
            }
            const flush = dropped || awaitingCompactedSample
            awaitingCompactedSample = false
            previousUsed = event.usedTokens
            latest = event
            return !flush && Date.now() - lastBroadcastAt < CONTEXT_BROADCAST_MS
              ? Effect.void
              : write(event)
          },
          /** Called once the run ends, so the final sample is never the one that got throttled. */
          settle: (billed: number) => {
            billedThisRun = billed
            return latest === undefined ? Effect.void : write(latest)
          }
        } as const
      })

    // ── one attempt ──────────────────────────────────────────────────────────

    const execute = (
      agent: Agent,
      machine: Machine,
      cwd: string,
      built: BuiltCommand,
      seat: Seat,
      resumeSessionId: string | undefined,
      redactor: Redactor,
      /** Set only when this task has repository worktrees; absent otherwise (D14). */
      gitAuth: { readonly url: string; readonly token: string } | undefined,
      /** The context meter, already throttled (docs/build-plan-context-meter.md D10). */
      meter: {
        readonly compaction: (active: boolean) => Effect.Effect<void>
        readonly sample: (event: AgentEventOf<'context'>) => Effect.Effect<void>
        readonly settle: (billedTokens: number) => Effect.Effect<void>
      },
      /** The running commentary, already throttled (docs/build-plan-activity.md D3). */
      activity: {
        readonly push: (
          kind: 'thinking' | 'tool',
          text: string,
          browser?: boolean
        ) => Effect.Effect<void>
      }
    ): Effect.Effect<AttemptResult> =>
      Effect.gen(function* () {
        const adapter = adapterFor(agent.runtimeKind)
        const errors: Array<string> = []
        const stderr: Array<string> = []
        let sawText = false
        let sessionId: string | undefined
        let billedTokens = 0
        let done: Extract<AgentEvent, { type: 'done' }> | undefined
        const reply = makeReplyText()
        const summarizeActivity = makeActivitySummary()

        const env: Record<string, string> = { ...built.env }
        if (seat.credential.kind === 'host-login') env['HOME'] = homedir()
        // `git` in the box authenticates through `!taut git-credential`, which reads the task's
        // own bearer token out of its environment and trades it for a repository-scoped
        // installation token (D4) — nothing is written to disk. `gitCredentialEnv` appends to
        // whatever `GIT_CONFIG_COUNT` the adapter already set rather than replacing it.
        if (gitAuth !== undefined) {
          Object.assign(env, gitCredentialEnv(env), {
            TAUT_URL: gitAuth.url,
            TAUT_TOKEN: gitAuth.token
          })
        }

        const handle = (event: AgentEvent): Effect.Effect<void> => {
          reply.observe(event)
          const summary = summarizeActivity(event)
          switch (event.type) {
            case 'text_delta': {
              sawText = true
              return summary === undefined ? Effect.void : activity.push('thinking', summary)
            }
            // Keep the last public summary visible between calls; never broadcast raw reasoning.
            case 'thinking':
              return Effect.void
            case 'tool_use': {
              return activity.push(
                'tool',
                describeTool(event.name, event.input),
                isBrowserTool(event.name)
              )
            }
            case 'session':
              sessionId = event.sessionId
              return Effect.void
            // Occupancy. The last one of the run is the one that counts (D2).
            case 'context':
              return meter.sample(event)
            case 'compaction':
              return meter.compaction(event.compacting)
            // The bill, which is a different quantity and accumulates (D1).
            case 'usage':
              billedTokens +=
                event.inputTokens +
                event.outputTokens +
                (event.cacheReadTokens ?? 0) +
                (event.cacheWriteTokens ?? 0)
              return Effect.void
            case 'error':
              errors.push(
                event.code === undefined ? event.message : `${event.message} (${event.code})`
              )
              return Effect.void
            case 'done':
              done = event
              if (event.sessionId !== undefined) sessionId = event.sessionId
              return Effect.void
            default:
              return Effect.void
          }
        }

        const streamed = yield* Effect.either(
          Stream.runForEach(
            runtimeRunTask({
              machine,
              adapter,
              command: { ...built, env },
              cwd,
              // The task's redactor: seat secret + env/file secrets now, `vault_get` values later.
              redactor,
              ...(seat.secret === undefined ? {} : { secrets: [seat.secret] }),
              onStderr: (line) => {
                stderr.push(line)
                if (stderr.length > 40) stderr.shift()
              },
              idleTimeoutMs: IDLE_TIMEOUT_MS,
              timeoutMs: HARD_TIMEOUT_MS
            }),
            handle
          ).pipe(Effect.ensuring(Effect.suspend(() => meter.compaction(false))))
        )
        if (streamed._tag === 'Left') {
          const e = streamed.left
          errors.push(
            e._tag === 'BinaryMissing'
              ? `The "${e.binary}" CLI is not installed on @${agent.handle}'s machine (${provider.name} provider).`
              : `runtime exec failed: ${e.reason}`
          )
        }

        // The final sample, whatever the throttle swallowed on the way (D10).
        yield* meter.settle(billedTokens)

        const ok = done?.ok === true && streamed._tag === 'Right'
        const haystack = [...errors, done?.summary ?? '', done?.reason ?? '', ...stderr].join('\n')
        if (!ok) {
          yield* Effect.logWarning(
            `runtime attempt failed (${done?.reason ?? 'no result'}): ${errors.slice(-2).join(' | ')}${stderr.length > 0 ? `\n  stderr: ${stderr.slice(-3).join(' | ')}` : ''}`
          )
        }
        const lastError =
          errors[errors.length - 1] ??
          (done !== undefined && !done.ok
            ? (done.summary ??
              (done.reason === undefined ? 'runtime failed' : `runtime failed: ${done.reason}`))
            : 'runtime ended without a result')
        const rateLimited = !ok && RATE_LIMIT_RE.test(haystack)
        const authFailed = !ok && !rateLimited && AUTH_FAILED_RE.test(haystack)
        return {
          ok,
          error: lastError,
          sawText,
          rateLimited,
          authFailed,
          resumeFailed:
            !ok &&
            !rateLimited &&
            !authFailed &&
            resumeSessionId !== undefined &&
            (!sawText || RESUME_FAILED_RE.test(haystack)),
          sessionId,
          summary: reply.finish(ok, done?.summary)
        }
      })

    // ── finalization ──────────────────────────────────────────────────────────

    const presence = (emit: Emit, agent: Agent, state: 'idle' | 'working') =>
      emit({
        type: 'presence.changed',
        payload: { memberKind: 'agent', memberId: agent.id, state }
      })

    const finishDone = (
      agent: Agent,
      t: TaskInternal,
      seat: Seat | undefined,
      fallbackBody: string | undefined,
      /** D4: take the empty reply back once the task is closed — the answer was a reaction. */
      withdraw: boolean
    ) =>
      publisher.transact(agent.companyId, (emit) =>
        Effect.gen(function* () {
          const current = yield* tasks.byId(agent.companyId, t.task.id).pipe(Effect.orDie)
          const status =
            current.status === 'done' || current.status === 'failed' ? current.status : 'done'
          const task = yield* tasks
            .update(agent.companyId, t.task.id, {
              status,
              endedAt: nowIso(),
              // The seat the successful attempt ran on; `null` when it was the dev host login.
              subscriptionId: seat?.subscription === undefined ? null : seat.subscription.id
            })
            .pipe(Effect.orDie)
          const message = yield* messages.finalizeAgentMessage(
            emit,
            agent.companyId,
            t.task.messageId,
            { status: 'sent', appendBody: fallbackBody }
          )
          const event = yield* emit({ type: 'agent.task.done', payload: { task, message } })
          // D4: the reply is finalized first so every consumer sees the task close normally,
          // then taken back. A run whose only answer was a 👍 does not ping the human either.
          const withdrawn = withdraw
            ? yield* messages.withdrawAgentMessage(emit, agent.companyId, t.task.messageId)
            : false
          if (!withdrawn) yield* notify(emit, t, 'agent_done', event.seq, message)
          yield* presence(emit, agent, 'idle')
        })
      )

    const finishFailed = (agent: Agent, t: TaskInternal, error: string) =>
      publisher.transact(agent.companyId, (emit) =>
        Effect.gen(function* () {
          const current = yield* tasks.byId(agent.companyId, t.task.id).pipe(Effect.orDie)
          const status = current.status === 'cancelled' ? 'cancelled' : 'failed'
          const task = yield* tasks
            .update(agent.companyId, t.task.id, { status, endedAt: nowIso(), error })
            .pipe(Effect.orDie)
          const message = yield* messages.finalizeAgentMessage(
            emit,
            agent.companyId,
            t.task.messageId,
            { status: 'failed', error }
          )
          const event = yield* emit({
            type: 'agent.task.failed',
            payload: { task, message, error }
          })
          yield* notify(emit, t, 'agent_failed', event.seq, message)
          yield* presence(emit, agent, 'idle')
        })
      )

    const notify = (
      emit: Emit,
      t: TaskInternal,
      kind: 'agent_done' | 'agent_failed',
      eventSeq: number,
      message: Message
    ) =>
      t.triggerUserId === undefined
        ? Effect.void
        : messages.notifyUser(
            emit,
            t.task.companyId,
            t.triggerUserId,
            kind,
            eventSeq,
            t.task.channelId,
            message.id
          )

    /** Idempotent: only a still-streaming message is closed. */
    const finalizeCancelled = (t: TaskInternal): Effect.Effect<void> =>
      Effect.gen(function* () {
        const message = yield* messages.byId(t.task.companyId, t.task.messageId)
        if (Option.isNone(message) || message.value.status !== 'streaming') return
        const agent = yield* agents.byId(t.task.companyId, t.task.agentId).pipe(Effect.option)
        if (Option.isNone(agent)) return
        yield* finishFailed(agent.value, t, 'Cancelled.')
        yield* tokens.expireForTask(t.task.id)
      }).pipe(
        Effect.catchAllCause((cause) => Effect.logError('task cancel finalize failed', cause))
      )

    // ── the run ─────────────────────────────────────────────────────────────

    const runOnce = (t: TaskInternal, redactor: Redactor): Effect.Effect<void, string> =>
      Effect.gen(function* () {
        const companyId = t.task.companyId
        const configured = yield* agents
          .byId(companyId, t.task.agentId)
          .pipe(Effect.mapError(() => 'agent no longer exists'))
        const channel = yield* channels
          .find(companyId, t.task.channelId)
          .pipe(Effect.flatMap(Effect.orElseFail(() => 'channel no longer exists')))
        const company = yield* companyRow(companyId).pipe(
          Effect.flatMap(Effect.orElseFail(() => 'company no longer exists'))
        )
        const trigger =
          t.triggerMessageId === undefined
            ? Option.none()
            : yield* messages.byId(companyId, t.triggerMessageId)
        if (Option.isNone(trigger))
          return yield* Effect.fail('the message that started this task was deleted')
        if (
          trigger.value.authorKind === 'agent' &&
          readByConversation.get(conversationKey(t))?.has(trigger.value.id)
        ) {
          // Its question was already consumed in an earlier successful turn. Retain the
          // task for trigger idempotency, but spend no model call and leave no empty bubble.
          return yield* finishDone(configured, t, undefined, undefined, true)
        }

        /**
         * What the message asked for wins over what the agent is configured with,
         * for this run only (docs/build-plan-run-overrides.md D1, D4).
         *
         * Applied once, here, onto the `Agent` everything downstream already
         * reads: seat rotation, the adapter, the session key and the prompt all
         * follow without knowing an override exists. Which is also why a runtime
         * override resumes nothing — the session key carries `runtimeKind` (D5).
         *
         * `permissionMode` is not in `RunOverride` and cannot arrive here (D9).
         */
        const override = trigger.value.runOverride
        const agent =
          override === undefined
            ? configured
            : new Agent({
                ...configured,
                runtimeKind: override.runtimeKind ?? configured.runtimeKind,
                pinnedSubscriptionId: override.subscriptionId ?? configured.pinnedSubscriptionId,
                model: override.model ?? configured.model
              })
        const reasoningEffort = override?.reasoningEffort

        yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            const task = yield* tasks
              .update(companyId, t.task.id, { status: 'running' })
              .pipe(Effect.orDie)
            yield* emit({ type: 'task.updated', payload: { task } })
            yield* presence(emit, agent, 'working')
          })
        )

        const home = yield* agents.homeOf(companyId, agent.id).pipe(Effect.orDie)
        const machine = yield* provider
          .ensure({
            agentId: agent.id,
            companyId,
            companySlug: company.slug,
            handle: agent.handle,
            ...(config.agentImage === undefined ? {} : { image: config.agentImage }),
            homeDir: home,
            limits: { cpus: 2, memoryMb: 2048, pidsLimit: 512 },
            network: { egress: 'allow-all' }
          })
          .pipe(Effect.mapError((e) => e.message))
        // D3: the working directory is the THREAD's, not the task's. claude-code stores its
        // sessions at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`, so a per-task directory
        // meant `--resume` could never find the session it was handed — every resume failed and
        // silently retried cold. Reusing the thread's directory is what makes resume work, and
        // it also leaves the files the agent wrote last turn where it left them.
        const cwd = posix.join(machine.paths.home, 'work', t.task.threadId)
        const token = yield* tokens.mint({ taskId: t.task.id, agentId: agent.id, companyId })
        const grants = yield* agents.fileGrantsOf(agent.id)
        // Repositories (docs/build-plan-repositories.md). Everything below is guarded on the
        // agent having at least one grant: with none, not a single git command runs, the exec
        // env is untouched and the instruction file gains nothing — the task path is the one
        // it was before this feature existed (D14).
        const repoGrants = yield* repositories.grantsOf(agent.id)
        const gitAuth = repoGrants.length === 0 ? undefined : { url: agentApiUrl(), token }
        const prepared =
          gitAuth === undefined
            ? ([] as ReadonlyArray<PreparedRepo>)
            : yield* prepareRepos({
                machine,
                homeDir: machine.paths.home,
                workDir: cwd,
                handle: agent.handle,
                // D6: one conversation is one unit of work, so it is one branch and one PR.
                sessionId: t.task.threadId,
                repos: repoGrants.map((g): RepoSpec => ({
                  owner: g.repository.owner,
                  name: g.repository.name,
                  cloneUrl: g.repository.cloneUrl,
                  defaultBranch: g.repository.defaultBranch,
                  mode: g.mode
                })),
                // The credential helper reads TAUT_URL / TAUT_TOKEN out of its own env, so a
                // clone of a private repository only works when the exec carries them too.
                env: {
                  ...gitCredentialEnv(),
                  TAUT_URL: gitAuth.url,
                  TAUT_TOKEN: gitAuth.token
                }
              })
        if (prepared.length > 0 && gitAuth !== undefined) {
          // Runs when `runOnce`'s scope closes — done, failed, crashed or cancelled alike. A
          // branch with commits `origin/<default>` has not seen is left standing (its worktree
          // with it) so unpushed work is never deleted; the next run prunes it.
          yield* Effect.addFinalizer(() =>
            teardownRepos(machine, prepared, {
              ...gitCredentialEnv(),
              TAUT_URL: gitAuth.url,
              TAUT_TOKEN: gitAuth.token
            })
          )
        }
        const instructionRepos = prepared.map((p): InstructionRepo => ({
          fullName: `${p.repo.owner}/${p.repo.name}`,
          path: p.worktreeDir,
          mode: p.repo.mode,
          branch: p.branch,
          defaultBranch: p.repo.defaultBranch
        }))
        // The browser comes up before the MCP config is written: only a Chromium that
        // actually answers gets an `--cdp-endpoint`, so a failed daemon leaves
        // playwright-mcp launching its own browser rather than failing to attach.
        let cdpEndpoint: string | undefined
        if (agent.browserAccess) {
          yield* ensureBrowserDirs(machine)
          if (provider.name === 'docker') {
            const started = yield* Effect.either(
              ensureBrowserDaemon(machine, { homeDir: machine.paths.home })
            )
            if (Either.isLeft(started)) {
              yield* Effect.logWarning(
                `browser: cannot start chromium in the box: ${started.left.message}`
              )
            } else {
              cdpEndpoint = browserCdpEndpoint()
            }
          } else {
            // No launch on the task path: attach only if the agent's Chromium is
            // already up (the live view started it), otherwise playwright-mcp
            // launches its own as it always has.
            cdpEndpoint = yield* localBrowserEndpoint(machine.paths.home)
          }
        }
        const mcp = yield* writeMcpConfig(
          agent,
          machine,
          cwd,
          token,
          t,
          grants,
          cdpEndpoint,
          redactor
        )
        yield* writeInstructionFile(
          agent,
          machine,
          cwd,
          company.name,
          mcp !== undefined,
          grants,
          instructionRepos
        ).pipe(Effect.mapError((e) => `cannot write instructions: ${e.message}`))
        const adapter = adapterFor(agent.runtimeKind)

        // D1: the session belongs to the thread, so the next turn of this conversation resumes
        // this same runtime session — a different thread with the same agent is a different copy
        // with its own context.
        const resume = yield* sessions
          .get(agent.id, t.task.threadId, agent.runtimeKind)
          .pipe(Effect.map(Option.getOrUndefined))
        let resumeSessionId = resume?.sessionId
        let prompt = yield* buildPrompt(
          agent,
          t,
          trigger.value,
          company.name,
          channel,
          machine,
          resume?.lastMessageId
        )

        const meter = yield* makeContextMeter(agent, t, channel.id)
        const activity = yield* makeActivity(agent, t)
        let seatRetried = false
        let resumeRetried = false
        let lastSeat: Seat | undefined

        for (;;) {
          const chosen = yield* chooseSeat(agent, t)
          if (chosen._tag === 'none') return yield* Effect.fail(chosen.reason)
          const seat = chosen.seat
          lastSeat = seat
          const built = adapter.buildCommand({
            prompt,
            cwd,
            home: machine.paths.home,
            permissionMode: agent.permissionMode,
            ...((agent.model ?? seat.subscription?.defaultModel)
              ? { model: agent.model ?? seat.subscription?.defaultModel }
              : {}),
            ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
            credential: seat.credential,
            ...(resumeSessionId === undefined ? {} : { resumeSessionId }),
            // Only claude-code reads `configPath`; the allow-list is `['mcp__taut__*']`, plus
            // `mcp__browser__*` when the agent has browser access (the default otherwise).
            ...(mcp?.configPath === undefined
              ? {}
              : {
                  mcp: {
                    configPath: mcp.configPath,
                    allowedTools: mcp.allowedTools
                  }
                }),
            // `inbox/`, `skills/` and `memory/` sit outside the work dir the runtime scopes
            // itself to, and are granted on every task (`homeDirGrants`). File grants follow.
            // Worktrees sit under `cwd`, but claude-code scopes on the directories it was
            // given, so an explicit entry keeps a worktree readable when the runtime narrows.
            addDirs: [
              ...homeDirGrants(machine.paths.home).map((g) => g.path),
              ...grants.map((g) => g.path),
              ...prepared.map((p) => p.worktreeDir)
            ]
          })
          const result = yield* execute(
            agent,
            machine,
            cwd,
            built,
            seat,
            resumeSessionId,
            redactor,
            gitAuth,
            meter,
            activity
          )
          if (result.sessionId !== undefined) {
            yield* sessions.set(
              agent.id,
              t.task.threadId,
              channel.id,
              agent.runtimeKind,
              result.sessionId,
              // Everything up to this run's trigger is now in the runtime's own history (D7).
              t.triggerMessageId ?? trigger.value.id,
              agent.mandate
            )
          }
          if (result.ok) {
            const summary = doneSummaries.get(t.task.id)
            // An accepted empty completion is authoritative, including when the runtime
            // narrates its tool use afterwards ("I reacted; no message was needed").
            const withdraw =
              (steering.get(t.task.id)?.withdraw ?? false) &&
              (summary === undefined || summary.trim().length === 0)
            const fallback = withdraw ? undefined : (result.summary ?? summary)
            yield* finishDone(agent, t, lastSeat, fallback, withdraw)
            const key = conversationKey(t)
            const read = readByConversation.get(key) ?? new Set<MessageId>()
            for (const id of steering.get(t.task.id)?.read ?? []) read.add(id)
            // Record only committed successful turns, with a bounded recent history.
            readByConversation.set(key, new Set([...read].slice(-100)))
            return
          }
          if (
            seat.subscription !== undefined &&
            !seatRetried &&
            (result.rateLimited || result.authFailed)
          ) {
            seatRetried = true
            if (result.rateLimited) {
              yield* Effect.logWarning(
                `task ${t.task.id}: subscription ${seat.subscription.id} rate-limited; cooling down and retrying`
              )
              yield* subscriptions
                .markRateLimited(
                  companyId,
                  seat.subscription.id,
                  agent.runtimeKind === 'claude-code' ? CLAUDE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS
                )
                .pipe(Effect.ignore)
            } else {
              yield* Effect.logWarning(
                `task ${t.task.id}: subscription ${seat.subscription.id} rejected its credential; marking auth-failed and retrying`
              )
              yield* subscriptions
                .markAuthFailed(companyId, seat.subscription.id)
                .pipe(Effect.ignore)
            }
            continue
          }
          if (result.resumeFailed && !resumeRetried) {
            resumeRetried = true
            yield* Effect.logInfo(
              `task ${t.task.id}: resume of ${resumeSessionId} failed; retrying fresh`
            )
            yield* sessions.clear(agent.id, t.task.threadId)
            resumeSessionId = undefined
            // The cold prompt carries the thread history the lost session was holding (D8).
            prompt = yield* buildPrompt(
              agent,
              t,
              trigger.value,
              company.name,
              channel,
              machine,
              undefined
            )
            continue
          }
          return yield* Effect.fail(result.error)
        }
      }).pipe(Effect.scoped)

    /**
     * Run a queued task to completion. Never fails; interruption finalizes the reply as
     * `failed: Cancelled.`.
     */
    const run = (t: TaskInternal): Effect.Effect<void> =>
      Effect.suspend(() => {
        // Registered before anything the agent could call exists (the token is minted inside
        // `runOnce`), removed in the `ensuring` below on every exit path.
        const redactor = makeRedactor()
        redactors.set(t.task.id, redactor)
        steering.set(t.task.id, {
          channelId: t.task.channelId,
          conversation: t.repliesInThread ? t.task.threadId : undefined,
          agentId: t.task.agentId,
          // Never news to itself: its own reply, and the message that woke it — that one is
          // already the prompt it started from.
          queued: new Set(
            t.triggerMessageId === undefined
              ? [t.task.messageId]
              : [t.task.messageId, t.triggerMessageId]
          ),
          pending: [],
          deflections: 0,
          reacted: false,
          sent: false,
          read: new Set(),
          withdraw: false
        })
        return runOnce(t, redactor)
      }).pipe(
        Effect.catchAll((reason) =>
          Effect.gen(function* () {
            const agent = yield* agents.byId(t.task.companyId, t.task.agentId).pipe(Effect.option)
            if (Option.isSome(agent)) yield* finishFailed(agent.value, t, reason)
          })
        ),
        Effect.catchAllCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logError(`task ${t.task.id} crashed`, cause)
            const agent = yield* agents.byId(t.task.companyId, t.task.agentId).pipe(Effect.option)
            if (Option.isSome(agent)) {
              yield* finishFailed(
                agent.value,
                t,
                `internal error: ${Cause.pretty(cause).split('\n')[0]}`
              )
            }
          }).pipe(Effect.ignore)
        ),
        Effect.ensuring(
          Effect.sync(() => {
            redactors.delete(t.task.id)
            doneSummaries.delete(t.task.id)
            steering.delete(t.task.id)
          }).pipe(Effect.zipRight(tokens.expireForTask(t.task.id)))
        ),
        Effect.onInterrupt(() => finalizeCancelled(t)),
        Effect.annotateLogs({ taskId: t.task.id, agentId: t.task.agentId })
      )

    return {
      run,
      finalizeCancelled,
      registerSecret,
      noteDoneSummary,
      steer,
      takeSteer,
      peekSteer,
      useDeflection,
      noteReaction,
      noteSent,
      noteWithdraw
    } as const
  })
}) {}
