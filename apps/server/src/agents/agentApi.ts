import type { MessageComponent, RenderComponentRequest } from '@taut/contract/domain'
import { Authorizations } from '../services/authorizations.js'
/**
 * What the `taut` MCP server / CLI calls from inside a machine (`packages/taut-mcp/src/protocol.ts`).
 * The sender is always the token's agent; the task's channel/thread is the default place to
 * post. Routing (docs/agent-model.md §9) is enforced here, not by prompt:
 *
 * | from → to                                   | rule                                                   |
 * | agent → its department head / the human of the DM / the human who asked | allowed — lands in
 *   this conversation when they are in it, otherwise in that person's DM with the agent        |
 * | agent → agent, same department              | anywhere: this channel when both are in it, else their DM |
 * | agent → agent / @handle, other department   | `403 cross_department` — a hard boundary, no gate      |
 * | agent → anything else                       | `403 needs_gate`                                       |
 * | any → thread with ≥ 20 agent turns          | `429 needs_gate`                                       |
 *
 * The department is the blast radius, and the only one: inside it agents talk freely, in a
 * channel or directly. Across it an agent never reaches another department, not even through a
 * gate, and a body that `@`-mentions a foreign agent is refused before it is posted (a mention
 * is a task trigger). Work that crosses departments is the heads' job, human to human — the
 * agent's move is to tell its own head.
 *
 * Vault (docs/build-plan-browser-vaults.md D5): `vault_list` is the company's items plus the
 * token's agent's own; `vault_get` decrypts one of them (`Vault.resolveForTool`, audited as
 * `tool`) and hands the plaintext to `TaskRunner.registerSecret` *before* answering, so the
 * value is masked from every later line the task prints.
 *
 * Attachments (docs/build-plan-attachments.md D3/D4): `send` and `done` take paths inside the
 * agent home — machine-absolute (`/home/agent/work/x.csv`) or home-relative (`work/x.csv`) —
 * and map them to the host home through `resolveAttachments`; `inbox` materialises incoming
 * files under `inbox/<messageId>/` and reports their machine paths.
 */
import { FileSystem } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import { CredentialKind, SignalStatus } from '@taut/contract/domain'
import type {
  Agent,
  AgentSkill,
  FileGrantMode,
  IssueDetail,
  Message,
  Repository,
  Signal,
  VaultItemMeta
} from '@taut/contract/domain'
import {
  AgentId,
  ChannelId,
  CompanyId,
  MessageId,
  ProjectId,
  SignalId,
  TaskId,
  type UserId,
  VaultItemId
} from '@taut/contract/ids'
import { CONTAINER_HOME, MachineProviderTag } from '@taut/runtime'
import type {
  AgentSearchRequest,
  AgentSearchResponse,
  DiscoverableAgent,
  AskCreated,
  AskRequest,
  AskStatus,
  CancelSignalRequest,
  CancelSignalResponse,
  CreateIssueRequest,
  CreateIssueResponse,
  EmitSignalRequest,
  EmitSignalResponse,
  ListSignalsQuery,
  ListSignalsResponse,
  SignalSummary,
  Deflected,
  DoneRequest,
  DoneResponse,
  HandoffRequest,
  HandoffResponse,
  InboxMessage,
  InboxResponse,
  GetIssueRequest,
  IssueSummary,
  LinearProjectsResponse,
  UpdateIssueRequest,
  ReactRequest,
  ReactResponse,
  DeleteRequest,
  DeleteResponse,
  SendRequest,
  SendResponse,
  Sender,
  SteerItem,
  SkillInstallRequest,
  SkillInstallResponse,
  SkillListResponse,
  SkillRemoveRequest,
  SkillRemoveResponse,
  SkillUpdateRequest,
  SkillUpdateResponse,
  SkillWriteRequest,
  SkillWriteResponse,
  VaultAddRequest,
  VaultAddResponse,
  VaultDeleteRequest,
  VaultDeleteResponse,
  VaultGetRequest,
  VaultGetResponse,
  VaultItemSummary,
  VaultListResponse,
  VaultUpdateRequest,
  VaultUpdateResponse
} from '@taut/taut-mcp/protocol'
import { STEER_PREAMBLE } from '@taut/taut-mcp/protocol'
import { Data, DateTime, Duration, Effect, Option, Redacted, Schema, Stream } from 'effect'
import { randomUUID } from 'node:crypto'
import { basename, isAbsolute } from 'node:path'
import { AppConfig } from '../config.js'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import type { ChannelRow } from '../domain/rows.js'
import { EventLog } from '../realtime/eventLog.js'
import { userHandle } from '../services/access.js'
import { Agents } from '../services/agents.js'
import { Attachments, type HostFile, humanSize } from '../services/attachments.js'
import { Canvases, type CanvasScope } from '../services/canvases.js'
import { Channels } from '../services/channels.js'
import { Handovers } from '../services/handovers.js'
import { AgentHomes } from '../services/homes.js'
import { Messages, parseHandles } from '../services/messages.js'
import { Projects } from '../services/projects.js'
import { EventPublisher } from '../services/publisher.js'
import { Reactions } from '../services/reactions.js'
import { Signals } from '../services/signals.js'
import {
  GIT_CREDENTIAL_USERNAME,
  Repositories,
  repoPathToFullName
} from '../services/repositories.js'
import { GitHubApp } from '../services/githubApp.js'
import { type TaskInternal, Tasks } from '../services/tasks.js'
import { Users } from '../services/users.js'
import { Vault } from '../services/vault.js'
import { MemoryIngest } from './memoryIngest.js'
import { attachmentMachinePath } from './prompt.js'
import { TaskRunner } from './runTask.js'
import { MAX_HANDOFF_DEPTH, TURN_CAP } from './scheduler.js'
import type { TokenPrincipal } from './tokens.js'

/** Non-2xx answer; becomes `ErrorBody` on the wire. */
export class ApiFailure extends Data.TaggedError('ApiFailure')<{
  readonly status: number
  readonly code: string
  readonly message: string
  readonly gateId?: string | undefined
}> {}

const needsGate = (status: 403 | 429, message: string) =>
  new ApiFailure({ status, code: 'needs_gate', message })

/** Something on Taut's side broke. Never carries the underlying error: it is not the agent's. */
const internal = (message: string) => new ApiFailure({ status: 500, code: 'internal', message })

/**
 * The department boundary. Unlike `needs_gate` there is nothing to wait for: no gate is posted
 * and retrying never succeeds. The agent's only route across is its own department head.
 */
const crossDepartment = (message: string) =>
  new ApiFailure({ status: 403, code: 'cross_department', message })

const CROSS_DEPARTMENT_HINT =
  'agents only talk inside their own department and no gate can lift that. The attempt is queued for your department head, who decides whether to raise it with the other head; say what you need in your own thread and carry on with what you can do.'

/** `GET /ask/:id?wait=` never holds longer than this (agent-model §9: 45 s ceiling). */
export const ASK_MAX_WAIT_MS = 45_000
const ASK_POLL_MS = 500
const HANDOFF_WAIT_MS = 3_000
const INBOX_LIMIT = 100

interface Ctx {
  readonly principal: TokenPrincipal
  readonly task: TaskInternal
  readonly agent: Agent
  readonly channel: ChannelRow
}

type Target =
  | { readonly kind: 'user'; readonly id: UserId; readonly handle: string }
  | { readonly kind: 'agent'; readonly agent: Agent; readonly handle: string }
  | { readonly kind: 'channel'; readonly channel: ChannelRow }

interface Destination {
  readonly channelId: ChannelId
  readonly threadId: MessageId | undefined
}

/** The agent home from both sides (`Machine.paths`), for mapping paths the agent names. */
interface Homes {
  readonly hostHome: string
  readonly machineHome: string
}

const AskRow = Schema.Struct({
  id: Schema.String,
  task_id: TaskId,
  to_kind: Schema.Literal('user', 'agent'),
  to_id: Schema.String,
  channel_id: ChannelId,
  thread_id: Schema.NullOr(MessageId),
  message_id: MessageId,
  status: Schema.Literal('pending', 'answered'),
  reply_message_id: Schema.NullOr(MessageId)
})

/**
 * The two repository routes of the agent API (docs/build-plan-repositories.md).
 * They are declared here rather than in `@taut/taut-mcp/protocol` because the
 * `git-credential` half is a CLI subcommand, not an MCP tool, and because the
 * response of one of them carries a live push credential — a shape that belongs
 * next to the code that mints it.
 */
export const GitCredentialRequest = Schema.Struct({
  /** Always `github.com` today (D10); anything else is `not_found`. */
  host: Schema.String,
  /** What git asks for: `owner/name`, with or without a leading `/` or a `.git`. */
  path: Schema.String
})
export type GitCredentialRequest = typeof GitCredentialRequest.Type

/** `password` is a one-hour, single-repository installation token. Never log this. */
export const GitCredentialResponse = Schema.Struct({
  username: Schema.String,
  password: Schema.String,
  expiresAt: Schema.String
})
export type GitCredentialResponse = typeof GitCredentialResponse.Type

export const OpenPullRequestRequest = Schema.Struct({
  /** `owner/name`. */
  repo: Schema.String,
  title: Schema.String,
  body: Schema.String,
  /** The branch the agent pushed. The server pushes nothing. */
  head: Schema.String,
  /** Defaults to the repository's default branch. */
  base: Schema.optional(Schema.String)
})
export type OpenPullRequestRequest = typeof OpenPullRequestRequest.Type

export const OpenPullRequestResponse = Schema.Struct({
  url: Schema.String,
  number: Schema.Number
})
export type OpenPullRequestResponse = typeof OpenPullRequestResponse.Type

export class AgentApi extends Effect.Service<AgentApi>()('AgentApi', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const publisher = yield* EventPublisher
    const eventLog = yield* EventLog
    const messages = yield* Messages
    const tasks = yield* Tasks
    const agents = yield* Agents
    const channels = yield* Channels
    const handovers = yield* Handovers
    const users = yield* Users
    const memoryIngest = yield* MemoryIngest
    const vault = yield* Vault
    const runner = yield* TaskRunner
    const reactions = yield* Reactions
    const signals = yield* Signals
    const attachments = yield* Attachments
    const homes = yield* AgentHomes
    const config = yield* AppConfig
    const fs = yield* FileSystem.FileSystem
    const provider = yield* MachineProviderTag
    const repositories = yield* Repositories
    const github = yield* GitHubApp
    const projects = yield* Projects
    const canvases = yield* Canvases
    const authorizations = yield* Authorizations

    // ── queries ──────────────────────────────────────────────────────────────

    // Select only public capability metadata, scoped before searching. EXISTS avoids
    // duplicating colleagues who share more than one department with the caller.
    const departmentAgentRows = findAll({
      Request: Schema.Struct({ companyId: CompanyId, agentId: AgentId }),
      Result: Schema.Struct({
        id: AgentId,
        handle: Schema.String,
        name: Schema.String,
        role: Schema.String,
        status: Schema.Literal('active', 'paused'),
        skill_name: Schema.NullOr(Schema.String),
        skill_description: Schema.NullOr(Schema.String)
      }),
      execute: (r) => sql`
        SELECT a.id, a.handle, a.name, a.role, a.status,
          s.name AS skill_name, s.description AS skill_description
        FROM agents a
        LEFT JOIN agent_skills s ON s.agent_id = a.id AND s.state = 'active'
        WHERE a.company_id = ${r.companyId} AND a.id != ${r.agentId}
          AND a.archived_at IS NULL
          AND EXISTS (
            SELECT 1 FROM department_members mine
            JOIN department_members peer ON peer.department_id = mine.department_id
            JOIN departments d ON d.id = mine.department_id
            WHERE mine.member_kind = 'agent' AND mine.member_id = ${r.agentId}
              AND peer.member_kind = 'agent' AND peer.member_id = a.id
              AND d.company_id = ${r.companyId}
          )
        ORDER BY a.handle, a.id, s.name`
    })

    const agentSearch = (
      principal: TokenPrincipal,
      input: AgentSearchRequest
    ): Effect.Effect<AgentSearchResponse, ApiFailure> =>
      Effect.gen(function* () {
        yield* context(principal)
        const rows = yield* departmentAgentRows(principal)
        const peers = new Map<string, DiscoverableAgent>()
        for (const row of rows) {
          const peer = peers.get(row.id) ?? {
            id: row.id,
            handle: row.handle,
            name: row.name,
            role: row.role,
            status: row.status,
            skills: []
          }
          peers.set(row.id, {
            ...peer,
            skills:
              row.skill_name === null
                ? peer.skills
                : [
                    ...peer.skills,
                    { name: row.skill_name, description: row.skill_description ?? '' }
                  ]
          })
        }
        const terms = (input.query ?? '')
          .trim()
          .toLowerCase()
          .split(/\s+/)
          .filter(Boolean)
          .map((term) => term.replace(/^@/, ''))
        const matches = [...peers.values()].filter((peer) => {
          const text = [
            peer.handle,
            peer.name,
            peer.role,
            ...peer.skills.flatMap((skill) => [skill.name, skill.description])
          ]
            .join(' ')
            .toLowerCase()
          return terms.every((term) => text.includes(term))
        })
        const limit = input.limit ?? 20
        return { agents: matches.slice(0, limit), hasMore: matches.length > limit }
      })

    const channelByName = findAll({
      Request: Schema.Struct({ companyId: CompanyId, name: Schema.String }),
      Result: Schema.Struct({ id: ChannelId }),
      execute: (r) => sql`
        SELECT id FROM channels
        WHERE company_id = ${r.companyId} AND kind = 'channel' AND name = ${r.name}
        ORDER BY created_at ASC, rowid ASC`
    })

    const insertAsk = run({
      Request: Schema.Struct({
        id: Schema.String,
        companyId: CompanyId,
        taskId: TaskId,
        agentId: AgentId,
        toKind: Schema.Literal('user', 'agent'),
        toId: Schema.String,
        channelId: ChannelId,
        threadId: Schema.NullOr(MessageId),
        messageId: MessageId,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO asks (id, company_id, task_id, agent_id, to_kind, to_id, channel_id, thread_id, message_id, status, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.taskId}, ${r.agentId}, ${r.toKind}, ${r.toId}, ${r.channelId},
                ${r.threadId}, ${r.messageId}, 'pending', ${r.createdAt})`
    })

    const askById = findOne({
      Request: Schema.Struct({ id: Schema.String, taskId: TaskId }),
      Result: AskRow,
      execute: (r) => sql`
        SELECT id, task_id, to_kind, to_id, channel_id, thread_id, message_id, status, reply_message_id
        FROM asks WHERE id = ${r.id} AND task_id = ${r.taskId}`
    })

    const askByReply = findOne({
      Request: Schema.Struct({ taskId: TaskId, messageId: MessageId }),
      Result: Schema.Struct({ id: Schema.String }),
      execute: (r) =>
        sql`SELECT id FROM asks WHERE task_id = ${r.taskId} AND reply_message_id = ${r.messageId}`
    })

    const answerAsk = run({
      Request: Schema.Struct({ id: Schema.String, replyMessageId: MessageId, at: Schema.String }),
      execute: (r) => sql`
        UPDATE asks SET status = 'answered', reply_message_id = ${r.replyMessageId}, answered_at = ${r.at}
        WHERE id = ${r.id} AND status = 'pending'`
    })

    /**
     * First *finished* message by the addressee after the ask, in the ask's thread (or DM top
     * level). `status = 'sent'` is the whole point: an agent's reply row is created empty and
     * `streaming` the moment its task starts, so without this the ask matches the placeholder
     * and returns `answered: true` with an empty string — and worse, records that placeholder as
     * the answer forever. A reply that ends `failed` never matches, and the ask parks instead.
     */
    const replyTo = findOne({
      Request: Schema.Struct({
        companyId: CompanyId,
        channelId: ChannelId,
        threadId: Schema.NullOr(MessageId),
        toId: Schema.String,
        afterMessageId: MessageId
      }),
      Result: Schema.Struct({ id: MessageId }),
      execute: (r) => sql`
        SELECT id FROM messages
        WHERE company_id = ${r.companyId} AND channel_id = ${r.channelId} AND author_id = ${r.toId}
          AND status = 'sent'
          AND (${r.threadId} IS NULL AND thread_id IS NULL OR thread_id = ${r.threadId})
          AND rowid > (SELECT rowid FROM messages WHERE id = ${r.afterMessageId})
        ORDER BY rowid ASC LIMIT 1`
    })

    // ── context + targets ───────────────────────────────────────────────────

    const context = (principal: TokenPrincipal): Effect.Effect<Ctx, ApiFailure> =>
      Effect.gen(function* () {
        const task = yield* tasks
          .internal(principal.companyId, principal.taskId)
          .pipe(
            Effect.mapError(
              () => new ApiFailure({ status: 404, code: 'not_found', message: 'task not found' })
            )
          )
        const agent = yield* agents
          .byId(principal.companyId, principal.agentId)
          .pipe(
            Effect.mapError(
              () => new ApiFailure({ status: 404, code: 'not_found', message: 'agent not found' })
            )
          )
        const channel = yield* channels.find(principal.companyId, task.task.channelId)
        if (Option.isNone(channel)) {
          return yield* new ApiFailure({
            status: 404,
            code: 'not_found',
            message: 'channel not found'
          })
        }
        return { principal, task, agent, channel: channel.value }
      })

    const userByHandle = (companyId: CompanyId, handle: string) =>
      users
        .membersOf(companyId)
        .pipe(Effect.map((all) => all.find((u) => userHandle(u.email) === handle)))

    const resolveTarget = (ctx: Ctx, to: string): Effect.Effect<Target, ApiFailure> =>
      Effect.gen(function* () {
        const name = to.slice(1).toLowerCase()
        if (to.startsWith('#')) {
          const rows = yield* channelByName({ companyId: ctx.principal.companyId, name })
          for (const row of rows) {
            const channel = yield* channels.find(ctx.principal.companyId, row.id)
            if (Option.isSome(channel)) return { kind: 'channel', channel: channel.value } as const
          }
          return yield* new ApiFailure({
            status: 404,
            code: 'not_found',
            message: `no channel #${name}`
          })
        }
        const agent = yield* agents.byHandle(ctx.principal.companyId, name)
        if (Option.isSome(agent))
          return { kind: 'agent', agent: agent.value, handle: name } as const
        const user = yield* userByHandle(ctx.principal.companyId, name)
        if (user !== undefined) return { kind: 'user', id: user.id, handle: name } as const
        return yield* new ApiFailure({
          status: 404,
          code: 'not_found',
          message: `no member @${name}`
        })
      })

    const sameDepartment = (a: AgentId, b: AgentId): Effect.Effect<boolean> =>
      Effect.all([agents.departmentsOf(a), agents.departmentsOf(b)]).pipe(
        Effect.map(([da, db]) => {
          const ids = new Set(da.map((d) => d.id))
          return db.some((d) => ids.has(d.id))
        })
      )

    /**
     * The first `@handle` in `body` naming an agent outside the sender's departments. Mentions
     * are what the scheduler dispatches on, so an unchecked one in a channel shared with another
     * department would start a task there; the boundary has to be enforced on the text too.
     */
    const foreignMention = (ctx: Ctx, body: string): Effect.Effect<Agent | undefined> =>
      Effect.gen(function* () {
        const handles = parseHandles(body)
        if (handles.length === 0) return undefined
        const mine = new Set((yield* agents.departmentsOf(ctx.agent.id)).map((d) => d.id))
        for (const handle of handles) {
          const found = yield* agents.byHandle(ctx.principal.companyId, handle)
          if (Option.isNone(found) || found.value.id === ctx.agent.id) continue
          const theirs = yield* agents.departmentsOf(found.value.id)
          if (!theirs.some((d) => mine.has(d.id))) return found.value
        }
        return undefined
      })

    /**
     * Park a refused attempt in the head's queue (`Handovers`) so the boundary produces a
     * human next step instead of only a dead end. Never fails: the refusal stands either way.
     */
    const recordHandover = (ctx: Ctx, toAgentId: AgentId, text: string): Effect.Effect<void> =>
      handovers
        .record({
          companyId: ctx.principal.companyId,
          fromAgentId: ctx.agent.id,
          toAgentId,
          channelId: ctx.channel.id,
          threadId: ctx.task.repliesInThread ? ctx.task.task.threadId : undefined,
          taskId: ctx.task.task.id,
          text
        })
        .pipe(Effect.asVoid)

    /**
     * Handoffs nest at most two levels, and a reply-woken turn adds one link per round trip;
     * six hops leaves room without letting a cycle in a corrupt chain spin.
     */
    const ERRAND_HOPS = 6

    /**
     * Where this errand was handed to the agent: the nearest ancestor task that `userId`
     * triggered, as a destination. "Go ask him and come back to me" spans two conversations —
     * the person's message here, the colleague's thread over there — and the answer belongs
     * under the message that asked for it. Landing it at the top of the DM instead reads as a
     * new topic, and the thread the person is watching stays silent. The chain of parent tasks
     * is the only trail back, so walk it. `None` when there is no such ancestor.
     */
    const errandOrigin = (ctx: Ctx, userId: UserId): Effect.Effect<Option.Option<Destination>> =>
      Effect.gen(function* () {
        let current: TaskInternal = ctx.task
        for (let hop = 0; hop < ERRAND_HOPS; hop++) {
          const parentId = current.parentTaskId
          if (parentId === undefined) return Option.none()
          const parent = yield* tasks
            .internal(ctx.principal.companyId, parentId)
            .pipe(Effect.option)
          if (Option.isNone(parent)) return Option.none()
          current = parent.value
          if (current.triggerUserId === userId) {
            return Option.some({
              channelId: current.task.channelId,
              threadId: current.repliesInThread ? current.task.threadId : undefined
            })
          }
        }
        return Option.none()
      })

    /** Where a message to `target` goes, or why it is refused (§9 routing). */
    const route = (
      ctx: Ctx,
      target: Target,
      text: string,
      delivery?: 'dm'
    ): Effect.Effect<Destination, ApiFailure> =>
      Effect.gen(function* () {
        const taskThread = ctx.task.repliesInThread ? ctx.task.task.threadId : undefined
        switch (target.kind) {
          case 'user': {
            const heads = new Set(
              (yield* agents.departmentsOf(ctx.agent.id)).map((d) => d.headUserId)
            )
            const inDm =
              ctx.channel.kind === 'dm' &&
              (yield* channels.isMember(ctx.channel.id, {
                memberKind: 'user',
                memberId: target.id
              }))
            const asked = ctx.task.triggerUserId === target.id
            if (!heads.has(target.id) && !inDm && !asked) {
              return yield* needsGate(
                403,
                `@${target.handle} is not your department head; messaging other people requires a human gate (not yet available)`
              )
            }
            // Here is the right place only when this person is already in this conversation:
            // their own DM, or the message that started this task. Otherwise the agent is
            // somewhere it was woken — a channel thread it opened to ask a colleague — and the
            // answer belongs in the DM where the person asked for it, not under the colleague's
            // reply (§9 "come back to me").
            if (delivery !== 'dm' && (inDm || asked)) {
              return { channelId: ctx.channel.id, threadId: taskThread }
            }
            // The errand's own thread first: it is the exact message that asked, not just the
            // right room. Only when the trail is gone does the DM stand in for it.
            const origin = yield* errandOrigin(ctx, target.id)
            if (
              delivery !== 'dm' &&
              Option.isSome(origin) &&
              (yield* channels.isMember(origin.value.channelId, {
                memberKind: 'agent',
                memberId: ctx.agent.id
              })) &&
              (yield* channels.isMember(origin.value.channelId, {
                memberKind: 'user',
                memberId: target.id
              }))
            ) {
              return origin.value
            }
            const home = yield* channels.ensureDm(
              ctx.principal.companyId,
              { memberKind: 'user', memberId: target.id },
              { memberKind: 'agent', memberId: ctx.agent.id }
            )
            return { channelId: home, threadId: undefined }
          }
          case 'agent': {
            if (target.agent.id === ctx.agent.id) {
              return yield* new ApiFailure({
                status: 422,
                code: 'validation',
                message: 'cannot message yourself'
              })
            }
            // The boundary is checked before the place rule: it is the harder of the two, and
            // an agent told "use a channel" would otherwise retry its way into a refusal that
            // no channel can lift.
            if (!(yield* sameDepartment(ctx.agent.id, target.agent.id))) {
              yield* recordHandover(ctx, target.agent.id, text)
              return yield* crossDepartment(
                `@${target.handle} is in another department: ${CROSS_DEPARTMENT_HINT}`
              )
            }
            // Same department: no further gate. Here when they are both here, otherwise their
            // own DM, opened on first use. Nothing is refused — the department is the boundary.
            const here = yield* channels.isMember(ctx.channel.id, {
              memberKind: 'agent',
              memberId: target.agent.id
            })
            if (here && delivery !== 'dm')
              return { channelId: ctx.channel.id, threadId: taskThread }
            const direct = yield* channels.ensureDm(
              ctx.principal.companyId,
              { memberKind: 'agent', memberId: ctx.agent.id },
              { memberKind: 'agent', memberId: target.agent.id }
            )
            return { channelId: direct, threadId: undefined }
          }
          case 'channel': {
            if (delivery === 'dm')
              return yield* new ApiFailure({
                status: 422,
                code: 'validation',
                message: 'DM delivery requires an @handle, not a #channel'
              })
            const member = yield* channels.isMember(target.channel.id, {
              memberKind: 'agent',
              memberId: ctx.agent.id
            })
            if (!member) {
              return yield* needsGate(403, `you are not a member of #${target.channel.name}`)
            }
            return { channelId: target.channel.id, threadId: undefined }
          }
        }
      })

    const withMention = (handle: string | undefined, text: string): string =>
      handle === undefined || text.toLowerCase().includes(`@${handle}`)
        ? text
        : `@${handle} ${text}`

    // ── attachments (D3/D4) ─────────────────────────────────────────────────

    /**
     * Host + machine home of the token's agent. The machine (when one exists) knows both; with
     * none — a task that has not started, or a test — the docker provider always mounts at
     * `/home/agent` and the local provider's machine home is the host home.
     */
    const homesOf = (ctx: Ctx): Effect.Effect<Homes> =>
      Effect.gen(function* () {
        const hostHome = yield* agents
          .homeOf(ctx.principal.companyId, ctx.agent.id)
          .pipe(Effect.orDie)
        const machine = yield* provider.get(ctx.agent.id).pipe(Effect.orElseSucceed(Option.none))
        const machineHome = Option.match(machine, {
          onSome: (m) => m.paths.home,
          onNone: () => (provider.name === 'docker' ? CONTAINER_HOME : hostHome)
        })
        return { hostHome, machineHome }
      })

    const validation = (message: string) =>
      new ApiFailure({ status: 422, code: 'validation', message })

    /**
     * D4: each path must name a regular file inside the agent home, at most
     * `TAUT_ATTACHMENT_MAX_BYTES`. Absolute paths must start with the machine home (or the host
     * home, which is the same directory on `local`); relative ones are home-relative. The
     * failure names the offending path.
     */
    const resolveAttachments = (
      ctx: Ctx,
      paths: ReadonlyArray<string> | undefined
    ): Effect.Effect<ReadonlyArray<HostFile>, ApiFailure> =>
      Effect.gen(function* () {
        if (paths === undefined || paths.length === 0) return []
        const { hostHome, machineHome } = yield* homesOf(ctx)
        const roots = [...new Set([machineHome, hostHome])]
        const out: Array<HostFile> = []
        for (const raw of paths) {
          const invalid = (why: string) => validation(`attachment "${raw}" ${why}`)
          let rel: string
          if (isAbsolute(raw) || raw.startsWith('/')) {
            const root = roots.find(
              (r) => raw === r || raw.startsWith(r.endsWith('/') ? r : `${r}/`)
            )
            if (root === undefined) return yield* invalid(`is outside your home (${machineHome})`)
            rel = raw.slice(root.length).replace(/^\/+/, '')
          } else {
            rel = raw
          }
          if (rel === '' || rel === '.') return yield* invalid('is your home, not a file')
          const hostPath = yield* homes
            .resolveInside(hostHome, rel)
            .pipe(Effect.mapError(() => invalid(`is outside your home (${machineHome})`)))
          const info = yield* fs
            .stat(hostPath)
            .pipe(Effect.mapError(() => invalid('does not exist')))
          if (info.type !== 'File') return yield* invalid('is not a regular file')
          if (Number(info.size) > config.attachmentMaxBytes) {
            return yield* invalid(
              `is ${humanSize(Number(info.size))}; the limit is ${humanSize(config.attachmentMaxBytes)}`
            )
          }
          out.push({ hostPath, name: basename(hostPath) })
        }
        return out
      })

    /** Post as the agent at `dest`, honouring an explicit `threadId` and the turn cap. */
    const post = (
      ctx: Ctx,
      dest: Destination,
      explicitThread: string | undefined,
      body: string,
      files: ReadonlyArray<HostFile> = [],
      component?: MessageComponent
    ): Effect.Effect<Message, ApiFailure> =>
      Effect.gen(function* () {
        const foreign = yield* foreignMention(ctx, body)
        if (foreign !== undefined) {
          yield* recordHandover(ctx, foreign.id, body)
          return yield* crossDepartment(
            `this message mentions @${foreign.handle}, an agent in another department: ${CROSS_DEPARTMENT_HINT} Drop the mention and post again.`
          )
        }
        let threadId = dest.threadId
        if (explicitThread !== undefined) {
          const decoded = Schema.decodeUnknownOption(MessageId)(explicitThread)
          if (Option.isNone(decoded)) {
            return yield* new ApiFailure({
              status: 422,
              code: 'validation',
              message: 'threadId is not a message id'
            })
          }
          threadId = yield* messages
            .threadRoot(ctx.principal.companyId, dest.channelId, decoded.value)
            .pipe(
              Effect.mapError(
                () =>
                  new ApiFailure({
                    status: 404,
                    code: 'not_found',
                    message: 'thread not found in that channel'
                  })
              )
            )
        }
        if (threadId !== undefined && ctx.channel.kind === 'channel') {
          const turns = yield* messages.agentTurnCount(ctx.principal.companyId, threadId)
          if (turns >= TURN_CAP) {
            return yield* needsGate(
              429,
              `turn cap reached (${TURN_CAP} agent messages in this thread); a human must continue`
            )
          }
        }
        return yield* messages
          .postAsAgent(ctx.principal.companyId, {
            agentId: ctx.agent.id,
            channelId: dest.channelId,
            threadId,
            body,
            attachments: files,
            component
          })
          .pipe(
            Effect.mapError((e) => {
              switch (e._tag) {
                case 'Forbidden':
                  return needsGate(403, e.message)
                case 'Validation':
                  return validation(e.issues.map((i) => i.message).join('; '))
                case 'NotFound':
                  return new ApiFailure({ status: 404, code: 'not_found', message: e.message })
              }
            })
          )
      })

    // ── endpoints ───────────────────────────────────────────────────────────

    // ── steering (docs/build-plan-steering-reactions.md D6, D7) ──────────────

    /**
     * Turn the messages the runner queued for this task into what the agent reads. Files are
     * deliberately left out: an attachment only becomes readable once it has been copied into
     * the agent's home, which is `taut_inbox`'s job — the steer list says a message arrived,
     * `taut_inbox` hands over its files.
     */
    const toSteerItems = (
      companyId: CompanyId,
      queued: ReadonlyArray<Message>
    ): Effect.Effect<ReadonlyArray<SteerItem>> =>
      Effect.forEach(queued, (m) =>
        senderOf(companyId, m).pipe(
          Effect.map((from): SteerItem => ({
            messageId: m.id,
            channelId: m.channelId,
            ...(m.threadId === undefined ? {} : { threadId: m.threadId }),
            from,
            text: m.body,
            at: DateTime.formatIso(m.createdAt)
          }))
        )
      )

    /**
     * D6: drain whatever landed for this task. Called once per request by the HTTP layer,
     * after the handler ran, and merged into the encoded body — so an agent cannot touch Taut
     * without reading what changed under it.
     */
    const drainSteer = (principal: TokenPrincipal): Effect.Effect<ReadonlyArray<SteerItem>> =>
      toSteerItems(principal.companyId, runner.takeSteer(principal.taskId))

    /**
     * D7: the one deflection. `taut_send` and `taut_done` call this before they do anything;
     * a non-`undefined` answer means the call must return it *instead* of posting. It fires at
     * most once per run, so an agent that decides to post the same thing anyway gets through.
     */
    const maybeDeflect = (
      principal: TokenPrincipal,
      what: 'send' | 'done'
    ): Effect.Effect<Deflected | undefined> =>
      Effect.gen(function* () {
        if (runner.peekSteer(principal.taskId).length === 0) return undefined
        if (!runner.useDeflection(principal.taskId)) return undefined
        const steer = yield* toSteerItems(principal.companyId, runner.takeSteer(principal.taskId))
        if (steer.length === 0) return undefined
        return {
          posted: false,
          reason: 'steered',
          steer,
          hint:
            `${STEER_PREAMBLE} Your ${what === 'send' ? 'message was not posted' : 'task is still open'}. ` +
            'Decide again: react to what they said with taut_react and finish, or ' +
            `${what === 'send' ? 'send' : 'call taut_done with'} something that adds to it. ` +
            'This happens at most once per run — the next call goes through.'
        } as const
      })

    const send = (
      principal: TokenPrincipal,
      req: SendRequest
    ): Effect.Effect<SendResponse | Deflected, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        // Before anything is written: a teammate may have just answered (D7).
        const deflected = yield* maybeDeflect(principal, 'send')
        if (deflected !== undefined) return deflected
        const target = yield* resolveTarget(ctx, req.to)
        const dest = yield* route(ctx, target, req.text, req.delivery)
        const body = withMention(target.kind === 'channel' ? undefined : target.handle, req.text)
        // Paths are checked before anything is posted: a bad one is a 422 and no message.
        const files = yield* resolveAttachments(ctx, req.attachments)
        const message = yield* post(ctx, dest, req.threadId, body, files)
        runner.noteSent(principal.taskId, message)
        return {
          posted: true,
          messageId: message.id,
          channelId: message.channelId,
          ...(message.threadId === undefined ? {} : { threadId: message.threadId }),
          seq: message.seq,
          ...(message.attachments.length === 0
            ? {}
            : { attachments: message.attachments.map((a) => ({ id: a.id, name: a.name })) })
        }
      })

    const senderOf = (companyId: CompanyId, m: Message): Effect.Effect<Sender> =>
      Effect.gen(function* () {
        if (m.authorKind === 'agent') {
          const a = yield* users.agentIn(companyId, m.authorId as AgentId)
          return {
            kind: 'agent',
            id: m.authorId,
            handle: Option.isSome(a) ? a.value.handle : m.authorId
          }
        }
        const u = yield* users.byId(m.authorId as UserId)
        return {
          kind: 'user',
          id: m.authorId,
          handle: Option.isSome(u) ? userHandle(u.value.email) : m.authorId
        }
      })

    const inbox = (
      principal: TokenPrincipal,
      since: number | undefined
    ): Effect.Effect<InboxResponse, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        const companyId = principal.companyId
        const trigger =
          ctx.task.triggerMessageId === undefined
            ? Option.none()
            : yield* messages.byId(companyId, ctx.task.triggerMessageId)
        const from = since ?? (Option.isSome(trigger) ? trigger.value.seq : 0)
        const dmChannels = new Map<ChannelId, boolean>()
        const isDmWithMe = (channelId: ChannelId) =>
          Effect.gen(function* () {
            const cached = dmChannels.get(channelId)
            if (cached !== undefined) return cached
            const ch = yield* channels.find(companyId, channelId)
            const member =
              Option.isSome(ch) && ch.value.kind === 'dm'
                ? yield* channels.isMember(channelId, {
                    memberKind: 'agent',
                    memberId: ctx.agent.id
                  })
                : false
            dmChannels.set(channelId, member)
            return member
          })
        const myDepartments = new Set((yield* agents.departmentsOf(ctx.agent.id)).map((d) => d.id))
        const reachable = new Map<AgentId, boolean>()
        /** §9: a channel shared with another department never delivers that department's agents. */
        const isTeammate = (agentId: AgentId) =>
          Effect.gen(function* () {
            const cached = reachable.get(agentId)
            if (cached !== undefined) return cached
            const theirs = yield* agents.departmentsOf(agentId)
            const same = theirs.some((d) => myDepartments.has(d.id))
            reachable.set(agentId, same)
            return same
          })
        // Resolved once per call, only when a delivered message actually carries files.
        let homesCache: Homes | undefined
        const inboxAttachments = (m: Message) =>
          Effect.gen(function* () {
            if (m.attachments.length === 0) return {}
            homesCache ??= yield* homesOf(ctx)
            const { hostHome, machineHome } = homesCache
            const files = yield* attachments.materialise(companyId, m, hostHome)
            return {
              attachments: files.map((f) => ({
                name: f.name,
                mimeType: f.mimeType,
                size: f.size,
                path: attachmentMachinePath(machineHome, m.id, f.name)
              }))
            }
          })
        const items: Array<InboxMessage> = []
        let nextSince = from
        yield* eventLog.since(companyId, from).pipe(
          Stream.orDie,
          Stream.runForEach((event) =>
            Effect.gen(function* () {
              nextSince = Math.max(nextSince, event.seq)
              if (event.type !== 'message.created' || items.length >= INBOX_LIMIT) return
              const m = event.payload.message
              if (m.authorKind === 'agent' && m.authorId === ctx.agent.id) return
              if (m.authorKind === 'agent' && !(yield* isTeammate(m.authorId as AgentId))) return
              const mentioned = (event.payload.mentions ?? []).some(
                (x) => x.memberKind === 'agent' && x.memberId === ctx.agent.id
              )
              const inTaskThread = ctx.task.repliesInThread && m.threadId === ctx.task.task.threadId
              const dm = yield* isDmWithMe(m.channelId)
              if (!mentioned && !inTaskThread && !dm) return
              const sender = yield* senderOf(companyId, m)
              const channel = yield* channels.find(companyId, m.channelId)
              const ask = yield* askByReply({ taskId: principal.taskId, messageId: m.id })
              items.push({
                seq: m.seq,
                messageId: m.id,
                channelId: m.channelId,
                ...(Option.isSome(channel) && channel.value.kind === 'channel'
                  ? { channelName: channel.value.name }
                  : {}),
                ...(m.threadId === undefined ? {} : { threadId: m.threadId }),
                from: sender,
                text: m.body,
                at: DateTime.formatIso(m.createdAt),
                ...(Option.isSome(ask) ? { askId: ask.value.id } : {}),
                ...(yield* inboxAttachments(m))
              })
            })
          )
        )
        return { items, nextSince }
      })

    const ask = (
      principal: TokenPrincipal,
      req: AskRequest
    ): Effect.Effect<AskCreated, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        const target = yield* resolveTarget(ctx, req.to)
        if (target.kind === 'channel') {
          return yield* new ApiFailure({
            status: 422,
            code: 'validation',
            message: 'ask a member (@handle), not a channel'
          })
        }
        if (req.questions !== undefined && target.kind !== 'user')
          return yield* validation('Interactive questions must be addressed to a human.')
        if (
          req.questions !== undefined &&
          (new Set(req.questions.map((q) => q.id)).size !== req.questions.length ||
            req.questions.some(
              (q) => new Set(q.options.map((o) => o.label)).size !== q.options.length
            ))
        )
          return yield* validation('Question IDs and option labels must be unique.')
        const dest = yield* route(ctx, target, req.text, req.delivery)
        const component: MessageComponent | undefined =
          req.questions === undefined || target.kind !== 'user'
            ? undefined
            : {
                kind: 'questions',
                title: req.text,
                questions: req.questions,
                recipientId: target.id,
                status: 'pending'
              }
        const message = yield* post(
          ctx,
          dest,
          undefined,
          withMention(target.handle, req.text),
          [],
          component
        )
        const id = `ask_${randomUUID()}`
        yield* insertAsk({
          id,
          companyId: principal.companyId,
          taskId: principal.taskId,
          agentId: ctx.agent.id,
          toKind: target.kind,
          toId: target.kind === 'user' ? target.id : target.agent.id,
          channelId: message.channelId,
          threadId: message.threadId ?? null,
          messageId: message.id,
          createdAt: nowIso()
        })
        const parked = target.kind === 'agent' && message.threadId === ctx.task.task.threadId
        if (parked) {
          runner.noteSent(principal.taskId, message)
          runner.noteWithdraw(principal.taskId)
        }
        return {
          askId: id,
          messageId: message.id,
          threadId: message.threadId ?? message.id,
          ...(parked ? { parked: true } : {})
        }
      })

    const askStatus = (
      principal: TokenPrincipal,
      askId: string,
      waitMs: number | undefined
    ): Effect.Effect<AskStatus, ApiFailure> =>
      Effect.gen(function* () {
        const row = yield* askById({ id: askId, taskId: principal.taskId })
        if (Option.isNone(row)) {
          return yield* new ApiFailure({ status: 404, code: 'not_found', message: 'ask not found' })
        }
        const a = row.value
        const answered = (replyId: MessageId): Effect.Effect<AskStatus> =>
          Effect.gen(function* () {
            const reply = yield* messages.byId(principal.companyId, replyId)
            if (Option.isNone(reply)) return { askId, status: 'pending' } as const
            const sender = yield* senderOf(principal.companyId, reply.value)
            return {
              askId,
              status: 'answered',
              answer: {
                text: reply.value.body,
                from: sender,
                at: DateTime.formatIso(reply.value.createdAt),
                messageId: reply.value.id
              }
            } as const
          })
        if (a.status === 'answered' && a.reply_message_id !== null)
          return yield* answered(a.reply_message_id)
        const deadline = Date.now() + Math.min(Math.max(waitMs ?? 0, 0), ASK_MAX_WAIT_MS)
        for (;;) {
          const reply = yield* replyTo({
            companyId: principal.companyId,
            channelId: a.channel_id,
            threadId: a.thread_id,
            toId: a.to_id,
            afterMessageId: a.message_id
          })
          if (Option.isSome(reply)) {
            yield* answerAsk({ id: askId, replyMessageId: reply.value.id, at: nowIso() })
            return yield* answered(reply.value.id)
          }
          if (Date.now() >= deadline) return { askId, status: 'pending' } as const
          yield* Effect.sleep(Duration.millis(Math.min(ASK_POLL_MS, deadline - Date.now())))
        }
      })

    const done = (
      principal: TokenPrincipal,
      req: DoneRequest
    ): Effect.Effect<DoneResponse | Deflected, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        const deflected = yield* maybeDeflect(principal, 'done')
        if (deflected !== undefined) return deflected
        const current = ctx.task.task
        if (current.status !== 'running' && current.status !== 'queued') {
          return yield* new ApiFailure({
            status: 409,
            code: 'task_mismatch',
            message: `task ${current.id} is already ${current.status}`
          })
        }
        const status = req.outcome === 'failed' ? 'failed' : 'done'
        // D4: an empty summary is only an answer when the agent actually reacted this run;
        // the runner takes the empty reply back when it ends, and only if nothing streamed.
        const silent = req.summary.trim().length === 0
        const withdrew = silent && runner.noteWithdraw(current.id)
        if (silent && !withdrew) {
          return yield* new ApiFailure({
            status: 422,
            code: 'validation',
            message:
              'summary is empty and you have not reacted or posted in this thread — contribute with taut_send or taut_react before calling taut_done("")'
          })
        }
        // Files ride on the agent's own reply (the task's streaming message). Resolved and
        // linked before the task closes, so a bad path fails the call and leaves the task open.
        const files = yield* resolveAttachments(ctx, req.attachments)
        if (files.length > 0) {
          yield* messages
            .attachAsAgent(principal.companyId, ctx.agent.id, current.messageId, files)
            .pipe(
              Effect.mapError((e) =>
                e._tag === 'Validation'
                  ? validation(e.issues.map((i) => i.message).join('; '))
                  : new ApiFailure({ status: 404, code: 'not_found', message: e.message })
              )
            )
        }
        yield* publisher.transact(principal.companyId, (emit) =>
          Effect.gen(function* () {
            const task = yield* tasks
              .update(principal.companyId, current.id, {
                status,
                endedAt: nowIso(),
                ...(status === 'failed' ? { error: req.summary } : {})
              })
              .pipe(Effect.orDie)
            yield* emit({ type: 'task.updated', payload: { task } })
          })
        )
        // The runner posts the summary as the reply only if the runtime prints nothing more
        // (claude-code calls `taut_done` and *then* writes its answer; appending here doubled
        // it). Only when the task is not running in this process is it appended right away.
        if (!runner.noteDoneSummary(current.id, req.summary)) {
          const reply = yield* messages.byId(principal.companyId, current.messageId)
          if (Option.isSome(reply) && reply.value.body.trim().length === 0) {
            yield* messages.appendDelta(
              principal.companyId,
              current.id,
              current.messageId,
              req.summary
            )
          }
        }
        return { posted: true, taskId: current.id, status, ...(withdrew ? { withdrew } : {}) }
      })

    const handoff = (
      principal: TokenPrincipal,
      req: HandoffRequest
    ): Effect.Effect<HandoffResponse, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        if (ctx.task.handoffDepth >= MAX_HANDOFF_DEPTH) {
          return yield* new ApiFailure({
            status: 403,
            code: 'forbidden',
            message: `handoff depth cap (${MAX_HANDOFF_DEPTH}) reached; finish the task yourself or ask your head`
          })
        }
        const target = yield* resolveTarget(ctx, req.to)
        if (target.kind !== 'agent') {
          return yield* new ApiFailure({
            status: 422,
            code: 'validation',
            message: 'hand off to an agent (@handle)'
          })
        }
        const dest = yield* route(ctx, target, req.text)
        const message = yield* post(ctx, dest, undefined, withMention(target.handle, req.text))
        // The scheduler picks the mention up from the bus; wait for the child task to exist.
        const deadline = Date.now() + HANDOFF_WAIT_MS
        for (;;) {
          const child = yield* tasks.byTrigger(principal.companyId, target.agent.id, message.id)
          if (Option.isSome(child)) {
            return { taskId: child.value.id, threadId: child.value.threadId, messageId: message.id }
          }
          if (Date.now() >= deadline) {
            return yield* new ApiFailure({
              status: 503,
              code: 'server_error',
              message:
                'the handoff was posted but no task was scheduled (is the agent paused or not a member?)'
            })
          }
          yield* Effect.sleep('100 millis')
        }
      })

    /**
     * `taut_react` (docs/build-plan-steering-reactions.md D1-D3): answer with an emoji instead
     * of a message. Reach is the agent's own channels — the channel its task runs in, or any
     * channel it is a member of. `channels.requireView` is not usable here: it speaks about a
     * user session, and an agent has none.
     */
    const react = (
      principal: TokenPrincipal,
      req: ReactRequest
    ): Effect.Effect<ReactResponse, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        const messageId = MessageId.make(req.messageId)
        const target = yield* messages.byId(principal.companyId, messageId)
        if (Option.isNone(target)) {
          return yield* new ApiFailure({
            status: 404,
            code: 'not_found',
            message: `no message ${req.messageId}`
          })
        }
        const channelId = target.value.channelId
        const allowed =
          channelId === ctx.channel.id ||
          (yield* channels.isMember(channelId, {
            memberKind: 'agent',
            memberId: ctx.agent.id
          }))
        if (!allowed) {
          return yield* new ApiFailure({
            status: 403,
            code: 'forbidden',
            message: 'you are not in that channel'
          })
        }
        const on = req.on ?? true
        const message = yield* reactions
          .setForMember(
            principal.companyId,
            messageId,
            { kind: 'agent', id: ctx.agent.id },
            req.emoji,
            on
          )
          .pipe(
            Effect.provideService(Messages, messages),
            Effect.mapError((e) =>
              e._tag === 'Validation'
                ? validation(e.issues.map((i) => i.message).join('; '))
                : new ApiFailure({ status: 404, code: 'not_found', message: e.message })
            )
          )
        // D4: silence is only a valid answer once the agent has actually said something.
        if (on) runner.noteReaction(principal.taskId)
        return {
          messageId,
          emoji: req.emoji,
          on,
          reactions: message.reactions.map((r) => ({ emoji: r.emoji, count: r.count }))
        }
      })

    const deleteMessage = (
      principal: TokenPrincipal,
      req: DeleteRequest
    ): Effect.Effect<DeleteResponse, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        if (ctx.task.task.agentId !== principal.agentId)
          return yield* new ApiFailure({
            status: 403,
            code: 'forbidden',
            message: 'Task belongs to another agent'
          })
        const messageId = MessageId.make(req.messageId)
        yield* messages.deleteAsAgent(principal.companyId, principal.agentId, messageId).pipe(
          Effect.mapError(
            (error) =>
              new ApiFailure({
                status: error._tag === 'NotFound' ? 404 : error._tag === 'Conflict' ? 409 : 403,
                code:
                  error._tag === 'NotFound'
                    ? 'not_found'
                    : error._tag === 'Conflict'
                      ? 'conflict'
                      : 'forbidden',
                message: error.message
              })
          )
        )
        return { deleted: true, messageId }
      })

    const memory = (principal: TokenPrincipal) =>
      memoryIngest.memoryOf(principal.agentId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(
                new ApiFailure({
                  status: 503,
                  code: 'server_error',
                  message: 'memory is not available for this agent'
                })
              ),
            onSome: Effect.succeed
          })
        )
      )

    // ── vault ───────────────────────────────────────────────────────────────

    const vaultSummary = (item: VaultItemMeta): VaultItemSummary => ({
      id: item.id,
      kind: item.kind,
      label: item.label,
      hint: item.hint,
      scope: item.agentId === undefined ? 'company' : 'agent',
      ...(item.lastUsedAt === undefined ? {} : { lastUsedAt: DateTime.formatIso(item.lastUsedAt) })
    })

    /** Company items + the token's agent's own items — metadata only. */
    const vaultList = (principal: TokenPrincipal): Effect.Effect<VaultListResponse, ApiFailure> =>
      vault.listForAgent(principal.agentId).pipe(
        Effect.mapError(
          (e) => new ApiFailure({ status: 404, code: 'not_found', message: e.message })
        ),
        Effect.map((items) => ({ items: items.map(vaultSummary) }))
      )

    /**
     * Plaintext of one item for the agent's process. Another agent's item is 403, an unknown
     * id 404, an undecryptable one 503. The value is registered with the task's redactor
     * first; a task that is no longer running has no redactor and gets 409 instead of a secret.
     */
    const vaultGet = (
      principal: TokenPrincipal,
      req: VaultGetRequest
    ): Effect.Effect<VaultGetResponse, ApiFailure> =>
      Effect.gen(function* () {
        const itemId = Schema.decodeUnknownOption(VaultItemId)(req.vaultItemId)
        if (Option.isNone(itemId)) {
          return yield* new ApiFailure({
            status: 404,
            code: 'not_found',
            message: `no vault item ${req.vaultItemId}`
          })
        }
        const resolved = yield* vault
          .resolveForTool(itemId.value, principal.agentId, { taskId: principal.taskId })
          .pipe(
            Effect.mapError((e) => {
              switch (e._tag) {
                case 'Forbidden':
                  return new ApiFailure({ status: 403, code: 'forbidden', message: e.message })
                case 'NotFound':
                  return new ApiFailure({ status: 404, code: 'not_found', message: e.message })
                case 'VaultLocked':
                  return new ApiFailure({ status: 503, code: 'server_error', message: e.message })
              }
            })
          )
        const secret = Redacted.value(resolved.secret)
        if (!runner.registerSecret(principal.taskId, secret)) {
          return yield* new ApiFailure({
            status: 409,
            code: 'task_mismatch',
            message: `task ${principal.taskId} is not running; vault_get is only available during a task`
          })
        }
        return {
          id: resolved.item.id,
          kind: resolved.item.kind,
          label: resolved.item.label,
          secret
        }
      })

    /**
     * The three writes an agent is allowed. Every one of them is scoped to
     * `principal.agentId` — the task token's agent — by construction: the scope is never a
     * parameter, so there is no body an agent could send that reaches the company vault or
     * another agent's item. `Vault.{add,update,revoke}ForAgent` refuse those with 403.
     */
    const vaultWriteFailure = (e: {
      readonly _tag: 'NotFound' | 'Forbidden' | 'Validation'
      readonly message?: string
    }): ApiFailure => {
      switch (e._tag) {
        case 'Forbidden':
          return new ApiFailure({
            status: 403,
            code: 'forbidden',
            message: e.message ?? 'forbidden'
          })
        case 'NotFound':
          return new ApiFailure({
            status: 404,
            code: 'not_found',
            message: e.message ?? 'not found'
          })
        case 'Validation':
          return new ApiFailure({
            status: 422,
            code: 'validation',
            message: e.message ?? 'invalid input'
          })
      }
    }

    /** An id that is not a `VaultItemId` is 404, not a decode error — it is simply not yours. */
    const ownItemId = (raw: string): Effect.Effect<VaultItemId, ApiFailure> =>
      Schema.decodeUnknownOption(VaultItemId)(raw).pipe(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ApiFailure({ status: 404, code: 'not_found', message: `no vault item ${raw}` })
            ),
          onSome: Effect.succeed
        })
      )

    /** Create an item in the calling agent's own vault. */
    const vaultAdd = (
      principal: TokenPrincipal,
      req: VaultAddRequest
    ): Effect.Effect<VaultAddResponse, ApiFailure> =>
      Effect.gen(function* () {
        const kind = Schema.decodeUnknownOption(CredentialKind)(req.kind)
        if (Option.isNone(kind)) {
          return yield* new ApiFailure({
            status: 422,
            code: 'validation',
            message: `unknown credential kind "${req.kind}"`
          })
        }
        const item = yield* vault
          .addForAgent(
            principal.agentId,
            { kind: kind.value, label: req.label, secret: Redacted.make(req.secret) },
            { taskId: principal.taskId }
          )
          .pipe(Effect.mapError(vaultWriteFailure))
        return { item: vaultSummary(item) }
      })

    /** Re-label or re-key one of the calling agent's own items. */
    const vaultUpdate = (
      principal: TokenPrincipal,
      req: VaultUpdateRequest
    ): Effect.Effect<VaultUpdateResponse, ApiFailure> =>
      Effect.gen(function* () {
        const itemId = yield* ownItemId(req.vaultItemId)
        const item = yield* vault
          .updateForAgent(
            principal.agentId,
            itemId,
            {
              label: req.label,
              secret: req.secret === undefined ? undefined : Redacted.make(req.secret)
            },
            { taskId: principal.taskId }
          )
          .pipe(Effect.mapError(vaultWriteFailure))
        return { item: vaultSummary(item) }
      })

    /** Delete one of the calling agent's own items. */
    const vaultDelete = (
      principal: TokenPrincipal,
      req: VaultDeleteRequest
    ): Effect.Effect<VaultDeleteResponse, ApiFailure> =>
      Effect.gen(function* () {
        const itemId = yield* ownItemId(req.vaultItemId)
        yield* vault
          .revokeForAgent(principal.agentId, itemId, { taskId: principal.taskId })
          .pipe(Effect.mapError(vaultWriteFailure))
        return { deleted: true }
      })

    // ── repositories (docs/build-plan-repositories.md) ───────────────────────

    /**
     * The agent's grant on one repository, by `owner/name`. A repository the agent
     * was never granted is `not_found`, never `forbidden` (D14): an agent must not
     * be able to learn that a repository exists by being refused it, so "no grant"
     * and "no such repository" have to be indistinguishable from inside the box.
     */
    const grantFor = (
      principal: TokenPrincipal,
      fullName: string
    ): Effect.Effect<
      { readonly repository: Repository; readonly mode: FileGrantMode },
      ApiFailure
    > =>
      repositories.grantsOf(principal.agentId).pipe(
        Effect.flatMap((grants) => {
          const wanted = fullName.toLowerCase()
          const found = grants.find((g) => g.repository.fullName.toLowerCase() === wanted)
          return found === undefined
            ? Effect.fail(
                new ApiFailure({
                  status: 404,
                  code: 'not_found',
                  message: `no repository ${fullName} here`
                })
              )
            : Effect.succeed(found)
        })
      )

    /**
     * `git`'s credential helper, answered per request (D4). Nothing is written to
     * disk inside the box: the helper asks, the server mints a token scoped to
     * exactly this repository at exactly this agent's mode, and the token lives in
     * the memory of one `git` process for one hour at most.
     *
     * The token is `Redacted` right up to the field it is written into, and the
     * log line records who asked for what — never the answer.
     */
    const gitCredential = (
      principal: TokenPrincipal,
      req: GitCredentialRequest
    ): Effect.Effect<GitCredentialResponse, ApiFailure> =>
      Effect.gen(function* () {
        if (req.host.toLowerCase() !== 'github.com') {
          // D10: github.com is the only host Taut has credentials for.
          return yield* new ApiFailure({
            status: 404,
            code: 'not_found',
            message: `no credential for ${req.host}`
          })
        }
        const fullName = repoPathToFullName(req.path)
        if (fullName === undefined) {
          return yield* new ApiFailure({
            status: 404,
            code: 'not_found',
            message: 'that is not a repository path'
          })
        }
        const grant = yield* grantFor(principal, fullName)
        const minted = yield* github
          .installationToken(
            principal.companyId,
            { id: grant.repository.id, name: grant.repository.name },
            grant.mode
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new ApiFailure({ status: 502, code: 'github_error', message: error.reason })
            )
          )
        yield* Effect.logInfo(
          `git-credential: ${principal.agentId} ${grant.repository.id} ${grant.mode}`
        )
        return {
          username: GIT_CREDENTIAL_USERNAME,
          password: Redacted.value(minted.token),
          expiresAt: minted.expiresAt
        }
      })

    /**
     * `github_open_pr` (D7). The agent pushes its own branch with the credential
     * above; this only opens the pull request, and only for a repository it holds
     * an `rw` grant on. `ro` is refused in a plain sentence rather than a code,
     * because the agent reads it.
     */
    const githubOpenPr = (
      principal: TokenPrincipal,
      req: OpenPullRequestRequest
    ): Effect.Effect<OpenPullRequestResponse, ApiFailure> =>
      Effect.gen(function* () {
        const grant = yield* grantFor(principal, req.repo)
        if (grant.mode === 'ro') {
          return yield* new ApiFailure({
            status: 403,
            code: 'read_only',
            message: `you have read-only access to ${grant.repository.fullName}, so you cannot open a pull request on it. Report what you found instead.`
          })
        }
        const opened = yield* github
          .openPullRequest(
            principal.companyId,
            {
              repositoryId: grant.repository.id,
              owner: grant.repository.owner,
              name: grant.repository.name
            },
            {
              title: req.title,
              body: req.body,
              head: req.head,
              base: req.base ?? grant.repository.defaultBranch
            }
          )
          .pipe(
            Effect.mapError(
              (error) =>
                new ApiFailure({ status: 502, code: 'github_error', message: error.reason })
            )
          )
        yield* Effect.logInfo(
          `github_open_pr: ${principal.agentId} ${grant.repository.fullName} #${opened.number}`
        )
        return opened
      })

    // ── linear (docs/build-plan-projects.md D21, D22) ────────────────────────

    /**
     * The human this run is answering, or `undefined` when there is none (D21).
     *
     * This is the task's trigger user, and it is the *only* identity the ticket
     * gate will consider. An agent cannot name a person to file on behalf of,
     * because a tool argument is something the model can choose and the whole
     * point of the mapping is that it cannot. A routine or a scheduled run has no
     * trigger user, so it files nothing.
     */
    const humanBehind = (ctx: Ctx): UserId | undefined => ctx.task.triggerUserId

    /**
     * D22: what an agent may file against, and whether it may file at all. Both
     * in one answer on purpose — an agent that has to ask two questions to learn
     * it is not allowed will ask neither and try anyway.
     */
    const linearProjects = (
      principal: TokenPrincipal
    ): Effect.Effect<LinearProjectsResponse, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        const requestedBy = humanBehind(ctx)
        const all = yield* projects
          .listForAgent(principal.companyId)
          .pipe(Effect.mapError(() => internal('the Linear mirror could not be read')))

        const gate =
          requestedBy === undefined
            ? {
                canCreateIssues: false,
                reason:
                  'this run has no person behind it, so there is nobody a ticket could belong to. Only a request made in a conversation can create one.'
              }
            : yield* projects
                .canCreateIssues(principal.companyId, requestedBy)
                .pipe(Effect.mapError(() => internal('the Linear mapping could not be read')))

        return {
          projects: all.map((project) => ({
            projectId: project.id,
            name: project.name,
            ...(project.description === undefined ? {} : { description: project.description }),
            status: project.status?.name ?? project.state,
            url: project.url
          })),
          canCreateIssues: gate.canCreateIssues,
          ...(gate.reason === undefined ? {} : { reason: gate.reason })
        }
      })

    /**
     * D21: file one ticket. Every refusal here is a 422 with the sentence the
     * agent should repeat to the human — an unmapped person is not an error the
     * agent should retry around, it is news it has to deliver.
     */
    const linearCreateIssue = (
      principal: TokenPrincipal,
      req: CreateIssueRequest
    ): Effect.Effect<CreateIssueResponse, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        const projectId = yield* Schema.decodeUnknown(ProjectId)(req.projectId).pipe(
          Effect.mapError(
            () =>
              new ApiFailure({
                status: 422,
                code: 'invalid_project',
                message: `"${req.projectId}" is not a project id. Call linear_projects and use one of the projectId values it returns.`
              })
          )
        )

        /**
         * The agent's own footer, appended rather than merged into the body: a
         * ticket has to say where it came from, and a description the model wrote
         * is not the place to trust it to.
         */
        const footer =
          `\n\n---\n_Filed by **${ctx.agent.name}** in Taut` +
          (ctx.channel.name === null ? '' : ` (#${ctx.channel.name})`) +
          `, at the request of the person it is assigned to._`

        const filed = yield* projects
          .createIssue(principal.companyId, humanBehind(ctx), {
            projectId,
            title: req.title,
            description: `${req.description}${footer}`,
            priority: req.priority
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === 'NotFound'
                ? new ApiFailure({
                    status: 422,
                    code: 'invalid_project',
                    message: `no project ${req.projectId} in this company. Call linear_projects for the ones you can file against.`
                  })
                : new ApiFailure({
                    status: 422,
                    code: 'linear_refused',
                    message: error.issues[0]?.message ?? 'Linear would not take the ticket'
                  })
            )
          )

        const issue = filed.issue
        yield* Effect.logInfo(`linear_create_issue: ${principal.agentId} filed ${issue.identifier}`)
        return {
          identifier: issue.identifier,
          title: issue.title,
          url: issue.url,
          state: issue.state.name,
          ...(issue.assignee === undefined ? {} : { assignee: issue.assignee.name }),
          projectName: filed.projectName
        }
      })

    /**
     * D18: the gate `linear_get_issue` and `linear_update_issue` share with
     * `linear_create_issue`, stated once and in the same words the create path
     * uses. An agent may not do to a ticket anything the human it is answering
     * could not do themselves, and a run with nobody behind it may not touch one
     * at all — a routine that quietly moves tickets is a routine nobody asked for.
     */
    const requireLinearHuman = (ctx: Ctx): Effect.Effect<UserId, ApiFailure> =>
      Effect.gen(function* () {
        const requestedBy = humanBehind(ctx)
        if (requestedBy === undefined) {
          return yield* new ApiFailure({
            status: 422,
            code: 'linear_refused',
            message:
              'this run has no person behind it, so there is nobody a ticket could belong to. Only a request made in a conversation can change one.'
          })
        }
        const gate = yield* projects
          .canCreateIssues(ctx.principal.companyId, requestedBy)
          .pipe(Effect.mapError(() => internal('the Linear mapping could not be read')))
        return gate.canCreateIssues
          ? requestedBy
          : yield* new ApiFailure({
              status: 422,
              code: 'linear_refused',
              message: gate.reason ?? 'you may not change Linear tickets from here'
            })
      })

    /** Linear's five priority words, for a ticket mirrored before `priorityLabel` existed. */
    const PRIORITY_WORDS = ['No priority', 'Urgent', 'High', 'Medium', 'Low'] as const

    /** One mirrored ticket as an agent reads it (D18). */
    const summarise = (detail: IssueDetail): IssueSummary => {
      const issue = detail.issue
      return {
        identifier: issue.identifier,
        title: issue.title,
        ...(issue.description === undefined ? {} : { description: issue.description }),
        state: issue.state.name,
        priority: issue.priorityLabel ?? PRIORITY_WORDS[issue.priority] ?? 'No priority',
        ...(issue.assignee === undefined ? {} : { assignee: issue.assignee.name }),
        labels: issue.labels.map((label) => label.name),
        projectId: detail.project.id,
        projectName: detail.project.name,
        ...(issue.milestoneName === undefined ? {} : { milestone: issue.milestoneName }),
        ...(issue.dueDate === undefined ? {} : { dueDate: issue.dueDate }),
        ...(issue.estimate === undefined ? {} : { estimate: issue.estimate }),
        ...(issue.parent === undefined ? {} : { parent: issue.parent.identifier }),
        subIssues: detail.subIssues.map((child) => child.identifier),
        url: issue.url
      }
    }

    /**
     * The schema already caps this at 0–4; this narrows the *type* to the five the
     * contract knows, without a cast — an agent's number becomes one of Linear's
     * levels or the ticket keeps the priority it had.
     */
    const asPriority = (value: number): 0 | 1 | 2 | 3 | 4 =>
      value === 1 ? 1 : value === 2 ? 2 : value === 3 ? 3 : value === 4 ? 4 : 0

    const issueNotFound = (ref: string) =>
      new ApiFailure({
        status: 404,
        code: 'not_found',
        message: `no ticket ${ref} in this company. Use the identifier as people write it (ENG-4636) or a pis_… id from a Taut link.`
      })

    /**
     * D18: read one ticket. Straight out of the mirror — the same rows the humans
     * on the issue page are looking at — so it costs nothing and works while
     * Linear is slow.
     */
    const linearGetIssue = (
      principal: TokenPrincipal,
      req: GetIssueRequest
    ): Effect.Effect<IssueSummary, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        yield* requireLinearHuman(ctx)
        const detail = yield* projects
          .issueForAgent(principal.companyId, req.ref)
          .pipe(Effect.mapError(() => issueNotFound(req.ref)))
        return summarise(detail)
      })

    /**
     * D18: change one ticket. `state` arrives as a name because an agent has no way
     * to know a workflow state's UUID; it is resolved against the team's live
     * pick-list (D14), and a name the team does not have comes back as the list of
     * the ones it does — which is the difference between an agent that corrects
     * itself and one that keeps guessing.
     */
    const linearUpdateIssue = (
      principal: TokenPrincipal,
      req: UpdateIssueRequest
    ): Effect.Effect<IssueSummary, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        yield* requireLinearHuman(ctx)
        const before = yield* projects
          .issueForAgent(principal.companyId, req.ref)
          .pipe(Effect.mapError(() => issueNotFound(req.ref)))

        let stateId: string | undefined = undefined
        if (req.state !== undefined) {
          const options = yield* projects
            .issueOptionsForAgent(principal.companyId, before.project.id)
            .pipe(
              Effect.mapError((error) =>
                error._tag === 'NotFound'
                  ? issueNotFound(req.ref)
                  : new ApiFailure({
                      status: 422,
                      code: 'linear_refused',
                      message:
                        error.issues[0]?.message ?? 'Linear would not say what states this team has'
                    })
              )
            )
          const wanted = req.state.trim().toLowerCase()
          const match = options.states.find((state) => state.name.toLowerCase() === wanted)
          if (match === undefined) {
            return yield* new ApiFailure({
              status: 422,
              code: 'validation',
              message: `"${req.state}" is not a state on this team. The ones it has: ${options.states.map((state) => state.name).join(', ')}.`
            })
          }
          stateId = match.id
        }

        const updated = yield* projects
          .updateIssueForAgent(principal.companyId, req.ref, {
            ...(req.title === undefined ? {} : { title: req.title }),
            ...(req.description === undefined ? {} : { description: req.description }),
            ...(stateId === undefined ? {} : { stateId }),
            ...(req.priority === undefined ? {} : { priority: asPriority(req.priority) }),
            // An empty string is how a tool call says "clear it": there is no
            // `null` an agent can type into a JSON schema field of type string.
            ...(req.dueDate === undefined
              ? {}
              : { dueDate: req.dueDate === '' ? null : req.dueDate }),
            ...(req.estimate === undefined ? {} : { estimate: req.estimate })
          })
          .pipe(
            Effect.mapError((error) =>
              error._tag === 'NotFound'
                ? issueNotFound(req.ref)
                : new ApiFailure({
                    status: 422,
                    code: 'linear_refused',
                    message: error.issues[0]?.message ?? 'Linear would not take the change'
                  })
            )
          )
        yield* Effect.logInfo(
          `linear_update_issue: ${principal.agentId} changed ${updated.identifier}`
        )
        const after = yield* projects
          .issueForAgent(principal.companyId, updated.id)
          .pipe(Effect.mapError(() => issueNotFound(req.ref)))
        return summarise(after)
      })

    // ── skills (docs/build-plan-skills.md D7, D8, D12) ───────────────────────

    /**
     * Every one of these takes the agent from `principal`, never from the payload: an agent can
     * only ever touch its own skills, the same rule the vault enforces above.
     */
    const skillSummary = (skill: AgentSkill) => ({
      name: skill.name,
      description: skill.description,
      origin: skill.origin,
      state: skill.state,
      ...(skill.source === undefined ? {} : { source: skill.source }),
      updatePolicy: skill.updatePolicy,
      updateAvailable: skill.updateAvailable
    })

    const skillList = (principal: TokenPrincipal): Effect.Effect<SkillListResponse, ApiFailure> =>
      agents
        .allSkillsOf(principal.agentId)
        .pipe(Effect.map((skills) => ({ skills: skills.map(skillSummary) })))

    const skillWrite = (
      principal: TokenPrincipal,
      req: SkillWriteRequest
    ): Effect.Effect<SkillWriteResponse, ApiFailure> =>
      agents.writeSkillForAgent(principal.agentId, req.name, req.description, req.body).pipe(
        Effect.mapError(vaultWriteFailure),
        Effect.map((skill) => ({ skill: skillSummary(skill) }))
      )

    const skillInstall = (
      principal: TokenPrincipal,
      req: SkillInstallRequest
    ): Effect.Effect<SkillInstallResponse, ApiFailure> =>
      Effect.gen(function* () {
        const policy =
          req.updatePolicy === 'auto' || req.updatePolicy === 'manual' ? req.updatePolicy : 'notify'
        const skill = yield* agents
          .installSkillForAgent(principal.agentId, req.source, req.name, policy)
          .pipe(Effect.mapError(vaultWriteFailure))
        const pending = skill.state === 'pending'
        return {
          skill: skillSummary(skill),
          pending,
          message: pending
            ? `Installed "${skill.name}" from ${skill.source ?? 'that source'}, but it is waiting for a human to approve it before you can use it. Say so, and say where it came from.`
            : `Installed "${skill.name}" from ${skill.source ?? 'that source'}. It applies from your next task.`
        }
      })

    const skillUpdate = (
      principal: TokenPrincipal,
      req: SkillUpdateRequest
    ): Effect.Effect<SkillUpdateResponse, ApiFailure> =>
      agents.updateSkillForAgent(principal.agentId, req.name).pipe(
        Effect.mapError(vaultWriteFailure),
        Effect.map((skill) => ({ skill: skillSummary(skill) }))
      )

    const skillRemove = (
      principal: TokenPrincipal,
      req: SkillRemoveRequest
    ): Effect.Effect<SkillRemoveResponse, ApiFailure> =>
      agents
        .removeSkillForAgent(principal.agentId, req.name)
        .pipe(Effect.mapError(vaultWriteFailure), Effect.as({ removed: true }))

    // ── signals (docs/build-plan-triggers.md Part II) ────────────────────────

    /**
     * `"3 minutes"`, `"30s"`, `"2h"`. Effect's own `Duration.decodeUnknown` only takes the long
     * form (`"3 minutes"`), and an agent that writes `"30s"` should get a reminder rather than a
     * 422 it has to guess its way out of — so the short forms are normalised first.
     */
    const UNITS: Readonly<Record<string, string>> = {
      s: 'seconds',
      sec: 'seconds',
      secs: 'seconds',
      second: 'seconds',
      seconds: 'seconds',
      m: 'minutes',
      min: 'minutes',
      mins: 'minutes',
      minute: 'minutes',
      minutes: 'minutes',
      h: 'hours',
      hr: 'hours',
      hrs: 'hours',
      hour: 'hours',
      hours: 'hours',
      d: 'days',
      day: 'days',
      days: 'days'
    }

    const parseDelay = (raw: string): Option.Option<Duration.Duration> => {
      const match = /^\s*(\d+(?:\.\d+)?)\s*([a-z]+)\s*$/i.exec(raw)
      if (match === null) return Option.none()
      const unit = UNITS[(match[2] ?? '').toLowerCase()]
      if (unit === undefined) return Option.none()
      return Duration.decodeUnknown(`${match[1]} ${unit}`)
    }

    /** When the signal goes off: `deliverIn`, else `deliverAt`, else now (an immediate emit). */
    const resolveWhen = (
      req: EmitSignalRequest
    ): Effect.Effect<DateTime.Utc | undefined, ApiFailure> =>
      Effect.gen(function* () {
        if (req.deliverIn !== undefined) {
          const delay = parseDelay(req.deliverIn)
          if (Option.isNone(delay)) {
            return yield* new ApiFailure({
              status: 422,
              code: 'invalid_delay',
              message: `"${req.deliverIn}" is not a delay I understand. Write it as "3 minutes", "30s" or "2 hours".`
            })
          }
          return DateTime.addDuration(yield* DateTime.now, delay.value)
        }
        if (req.deliverAt !== undefined) {
          const at = DateTime.make(req.deliverAt)
          if (Option.isNone(at)) {
            return yield* new ApiFailure({
              status: 422,
              code: 'invalid_delay',
              message: `"${req.deliverAt}" is not an ISO instant. Write it as "2026-09-09T18:32:00Z", or use deliverIn.`
            })
          }
          return DateTime.toUtc(at.value)
        }
        return undefined
      })

    /**
     * D18: `self` (the default) stamps the target and delivery goes straight to this agent —
     * a self-wake needs no trigger row at all, because making an agent write a listener before
     * it can set a reminder would make the common case the hard one. `broadcast` leaves the
     * target empty and only agents whose `SignalTrigger` matches wake up.
     */
    const resolveSignalTarget = (
      principal: TokenPrincipal,
      to: string | undefined
    ): Effect.Effect<AgentId | undefined, ApiFailure> =>
      Effect.gen(function* () {
        const raw = (to ?? 'self').trim()
        if (raw === 'self') return principal.agentId
        if (raw === 'broadcast') return undefined
        const agentId = yield* Schema.decodeUnknown(AgentId)(raw).pipe(
          Effect.mapError(
            () =>
              new ApiFailure({
                status: 422,
                code: 'invalid_target',
                message: `"${raw}" is not a target. Use "self", "broadcast", or an agt_… id.`
              })
          )
        )
        yield* agents.byId(principal.companyId, agentId).pipe(
          Effect.mapError(
            () =>
              new ApiFailure({
                status: 404,
                code: 'not_found',
                message: `no agent ${agentId} in this company`
              })
          )
        )
        return agentId
      })

    const signalSummary = (signal: Signal): SignalSummary => ({
      signalId: signal.id,
      name: signal.name,
      note: signal.note,
      deliverAt: DateTime.formatIso(signal.deliverAt),
      status: signal.status,
      ...(signal.targetAgentId === undefined ? {} : { targetAgentId: signal.targetAgentId }),
      ...(signal.threadId === undefined ? {} : { threadId: signal.threadId })
    })

    /**
     * The one tool that ends a turn on purpose. The row survives the process; the thread the
     * agent is woken in is the session it is woken with (D20), so nothing about the context
     * has to travel in the payload.
     */
    const emitSignal = (
      principal: TokenPrincipal,
      req: EmitSignalRequest
    ): Effect.Effect<EmitSignalResponse, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        const deliverAt = yield* resolveWhen(req)
        const targetAgentId = yield* resolveSignalTarget(principal, req.to)
        const inThread = (req.thread ?? 'current') === 'current'
        const signal = yield* signals
          .emit({
            companyId: principal.companyId,
            name: req.name,
            note: req.note,
            payload: req.payload,
            emittedByKind: 'agent',
            emittedById: principal.agentId,
            emittedByTaskId: principal.taskId,
            targetAgentId,
            channelId: ctx.task.task.channelId,
            threadId: inThread ? ctx.task.task.threadId : undefined,
            deliverAt
          })
          .pipe(
            Effect.mapError(
              (error) =>
                new ApiFailure({
                  status: 422,
                  code: 'signal_refused',
                  message: error.issues[0]?.message ?? 'the signal was refused'
                })
            )
          )
        yield* Effect.logInfo(
          `emit_signal: ${principal.agentId} armed ${signal.id} (${signal.name}) for ${DateTime.formatIso(signal.deliverAt)}`
        )
        return { signal: signalSummary(signal) }
      })

    const listSignals = (
      principal: TokenPrincipal,
      req: ListSignalsQuery
    ): Effect.Effect<ListSignalsResponse, ApiFailure> =>
      Effect.gen(function* () {
        const status = Schema.decodeUnknownOption(SignalStatus)(req.status ?? 'pending')
        const mine = yield* signals.ofEmitter(
          principal.companyId,
          principal.agentId,
          Option.getOrUndefined(status)
        )
        return { signals: mine.map(signalSummary) }
      })

    /** Own signals only: the emitter is the token's agent, never a request field. */
    const cancelSignal = (
      principal: TokenPrincipal,
      req: CancelSignalRequest
    ): Effect.Effect<CancelSignalResponse, ApiFailure> =>
      Effect.gen(function* () {
        const signalId = yield* Schema.decodeUnknown(SignalId)(req.signalId).pipe(
          Effect.mapError(
            () =>
              new ApiFailure({
                status: 422,
                code: 'invalid_signal',
                message: `"${req.signalId}" is not a signal id. Call list_signals for yours.`
              })
          )
        )
        const found = yield* signals.byId(principal.companyId, signalId)
        if (Option.isNone(found) || found.value.emittedById !== principal.agentId) {
          return yield* new ApiFailure({
            status: 404,
            code: 'not_found',
            message: 'no signal of yours with that id'
          })
        }
        yield* signals.markCancelled(principal.companyId, signalId)
        return { cancelled: true }
      })

    const renderComponent = (principal: TokenPrincipal, input: RenderComponentRequest) =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        if (ctx.task.task.agentId !== principal.agentId)
          return yield* validation('Task belongs to another agent.')
        const dest = {
          channelId: ctx.task.task.channelId,
          threadId: ctx.task.repliesInThread ? ctx.task.task.threadId : undefined
        }
        let component: MessageComponent
        if (input.kind === 'timer') {
          const { signal } = yield* emitSignal(principal, {
            name: 'timer',
            note: input.onComplete,
            deliverIn: `${input.durationSeconds}s`,
            to: 'self',
            thread: 'current'
          })
          component = {
            ...input,
            endsAt: signal.deliverAt,
            signalId: SignalId.make(signal.signalId)
          }
        } else component = input
        // If posting fails, remove the scheduled wake as well: no invisible timer is left behind.
        const message = yield* post(ctx, dest, undefined, input.title, [], component).pipe(
          Effect.tapError(() =>
            component.kind === 'timer'
              ? cancelSignal(principal, { signalId: component.signalId }).pipe(Effect.ignore)
              : Effect.void
          )
        )
        runner.noteSent(principal.taskId, message)
        return {
          messageId: message.id,
          ...(component.kind === 'timer'
            ? { signalId: component.signalId, endsAt: component.endsAt }
            : {})
        }
      })

    const canvasScope = (principal: TokenPrincipal): Effect.Effect<CanvasScope, ApiFailure> =>
      Effect.gen(function* () {
        const ctx = yield* context(principal)
        if (ctx.task.task.agentId !== principal.agentId)
          return yield* new ApiFailure({
            status: 403,
            code: 'forbidden',
            message: 'Task belongs to another agent'
          })
        return {
          companyId: principal.companyId,
          agentId: principal.agentId,
          channelId: ctx.task.task.channelId,
          threadId: ctx.task.task.threadId
        }
      })
    const canvasError = (error: { _tag: 'NotFound' | 'Validation'; message: string }) =>
      new ApiFailure({
        status: error._tag === 'NotFound' ? 404 : 422,
        code: error._tag === 'NotFound' ? 'not_found' : 'validation',
        message: error.message
      })

    return {
      agentSearch,
      proposeMandate: (p: TokenPrincipal, input: { mandate: string }) =>
        authorizations.proposeMandate(p, input.mandate).pipe(
          Effect.map((message) => ({ message })),
          Effect.mapError(
            (error) =>
              new ApiFailure({
                status: error._tag === 'Forbidden' ? 403 : error._tag === 'NotFound' ? 404 : 422,
                code:
                  error._tag === 'Forbidden'
                    ? 'forbidden'
                    : error._tag === 'NotFound'
                      ? 'not_found'
                      : 'validation',
                message: error.message
              })
          )
        ),
      canvasCreate: (p: TokenPrincipal, input: { title: string; html: string; open?: boolean }) =>
        canvasScope(p).pipe(
          Effect.flatMap((scope) =>
            canvases.create(scope, input).pipe(Effect.mapError(canvasError))
          ),
          Effect.map((canvas) => ({ canvas }))
        ),
      canvasChange: (
        p: TokenPrincipal,
        id: string,
        action: 'update' | 'open' | 'close',
        input: { title?: string; html?: string } = {}
      ) =>
        canvasScope(p).pipe(
          Effect.flatMap((scope) =>
            canvases.change(scope, id, action, input).pipe(Effect.mapError(canvasError))
          ),
          Effect.map((canvas) => ({ canvas }))
        ),
      canvasList: (p: TokenPrincipal) =>
        canvasScope(p).pipe(
          Effect.flatMap(canvases.listOwn),
          Effect.map((items) => ({ items }))
        ),
      send,
      delete: deleteMessage,
      inbox,
      renderComponent,
      ask,
      askStatus,
      done,
      handoff,
      react,
      drainSteer,
      memory,
      vaultList,
      vaultGet,
      vaultAdd,
      vaultUpdate,
      vaultDelete,
      skillList,
      skillWrite,
      skillInstall,
      skillUpdate,
      skillRemove,
      gitCredential,
      githubOpenPr,
      linearProjects,
      linearCreateIssue,
      linearGetIssue,
      linearUpdateIssue,
      emitSignal,
      listSignals,
      cancelSignal
    } as const
  })
}) {}
