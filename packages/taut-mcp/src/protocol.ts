/**
 * The `/api/agent-runtime/*` wire protocol between the `taut` MCP server / CLI (running inside
 * the agent's machine) and the Taut server. This file is the contract the server implements.
 *
 * Every request carries `Authorization: Bearer <TAUT_TOKEN>`; the token is task-scoped, so the
 * server derives `from`, `taskId`, `threadId` and the memory DB from it — none are parameters
 * (docs/agent-model.md §9 "Per-task credentials", §10 "Isolation by construction").
 *
 * Errors: any non-2xx status with body `ErrorBody`. Codes the client understands:
 * `unauthorized` 401 · `forbidden` 403 · `needs_gate` 403/429 (a human gate was posted) ·
 * `cross_department` 403 (the department boundary — no gate exists, never retry) ·
 * `not_found` 404 · `task_mismatch` 409 · `validation` 422 · `rate_limited` 429.
 */
import { Schema } from 'effect'

// --- primitives -------------------------------------------------------------

/** `@handle` (a member — human or agent) or `#channel`. Omitted → the department head. */
export const Target = Schema.String.pipe(
  Schema.pattern(/^[@#][A-Za-z0-9_.-]+$/, {
    message: () => 'expected "@handle" or "#channel"'
  })
)
export type Target = typeof Target.Type

export const Seq = Schema.NonNegativeInt
export const IsoDate = Schema.String.annotations({ description: 'ISO-8601 UTC timestamp' })

export const Intent = Schema.Literal('task', 'ask', 'reply', 'done', 'handoff', 'status', 'chat')
export type Intent = typeof Intent.Type

export const Sender = Schema.Struct({
  kind: Schema.Literal('user', 'agent'),
  id: Schema.String,
  handle: Schema.String
})
export type Sender = typeof Sender.Type

/**
 * A file inside the agent's home to attach to a message: machine-absolute
 * (`/home/agent/work/report.csv`) or home-relative (`work/report.csv`). Paths that resolve
 * outside the home, do not exist or exceed the size limit fail with 422 `validation`
 * (docs/build-plan-attachments.md D4).
 */
export const AttachmentPath = Schema.String.pipe(Schema.minLength(1), Schema.maxLength(1024))
export type AttachmentPath = typeof AttachmentPath.Type

const AttachmentPaths = Schema.Array(AttachmentPath).pipe(Schema.maxItems(10))

/** A file a human sent, already copied into your home under `inbox/<messageId>/` (D3). */
export const InboxAttachment = Schema.Struct({
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.NonNegativeInt,
  path: Schema.String.annotations({
    description: 'Machine path of the file inside your home (inbox/<messageId>/<name>).'
  })
})
export type InboxAttachment = typeof InboxAttachment.Type

/**
 * A message that landed in your thread **while this run was in flight**
 * (docs/build-plan-steering-reactions.md D5, D9). It rides on every `taut_*` response, so you
 * cannot touch Taut without seeing what changed under you. Same shape as an inbox item.
 */
export const SteerItem = Schema.Struct({
  messageId: Schema.String,
  channelId: Schema.String,
  threadId: Schema.optional(Schema.String),
  from: Sender,
  text: Schema.String,
  at: IsoDate,
  attachments: Schema.optional(Schema.Array(InboxAttachment))
})
export type SteerItem = typeof SteerItem.Type

/**
 * The one line that precedes a `steer` list wherever an agent reads one. Kept here so the
 * server, the MCP server and the CLI all say the same thing.
 */
export const STEER_PREAMBLE =
  'These messages arrived while you were working. Take them into account before you continue. ' +
  'A reaction alone is a complete answer: if a teammate already said what you were about to say, ' +
  'react to their message with taut_react instead of repeating them.'

export const MemoryKind = Schema.Literal('message', 'note', 'task', 'file')
export type MemoryKind = typeof MemoryKind.Type

/** Mirrors `@taut/memory` `MemoryItem` (kept structurally identical; not imported to keep this package standalone). */
export const MemoryItem = Schema.Struct({
  id: Schema.String,
  kind: MemoryKind,
  sourceId: Schema.String,
  channelId: Schema.NullOr(Schema.String),
  threadId: Schema.NullOr(Schema.String),
  authorKind: Schema.NullOr(Schema.Literal('user', 'agent')),
  authorId: Schema.NullOr(Schema.String),
  authorHandle: Schema.NullOr(Schema.String),
  at: IsoDate,
  /** Raw content. */
  body: Schema.String,
  /** What was indexed: `[#channel] [@author] [date] [thread:…]` + body. */
  text: Schema.String,
  meta: Schema.Record({ key: Schema.String, value: Schema.Unknown })
})
export type MemoryItem = typeof MemoryItem.Type

export const MemoryHit = Schema.Struct({
  ...MemoryItem.fields,
  snippet: Schema.String,
  score: Schema.Number
})
export type MemoryHit = typeof MemoryHit.Type

export const ErrorBody = Schema.Struct({
  error: Schema.Struct({
    code: Schema.String,
    message: Schema.String,
    /** Set with `needs_gate`: the gate message the heads must resolve. */
    gateId: Schema.optional(Schema.String)
  })
})
export type ErrorBody = typeof ErrorBody.Type

// --- messaging (§9) -----------------------------------------------------------

export const SendRequest = Schema.Struct({
  to: Target.annotations({
    description: '"@handle" of a member or "#channel". Omit-able only on the server side.'
  }),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)).annotations({
    description: 'Message body (markdown). Keep it short; put substance in files and refer to them.'
  }),
  threadId: Schema.optional(Schema.String).annotations({
    description: 'Root message id to reply under. Defaults to the current task thread.'
  }),
  attachments: Schema.optional(AttachmentPaths).annotations({
    description:
      'Files or images to share (screenshot, CSV, PDF…): up to 10 paths inside your home, absolute or home-relative. The human sees them inline.'
  })
})
export type SendRequest = typeof SendRequest.Type

export const SendResponse = Schema.Struct({
  /** Always `true`. `false` is the `Deflected` shape below (D7). */
  posted: Schema.Literal(true),
  messageId: Schema.String,
  channelId: Schema.String,
  threadId: Schema.optional(Schema.String),
  seq: Seq,
  /** One entry per `attachments` path, in order. */
  attachments: Schema.optional(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
  )
})
export type SendResponse = typeof SendResponse.Type

/**
 * Your post did **not** happen because a teammate answered while you were writing
 * (docs/build-plan-steering-reactions.md D7). Read `steer`, then decide again: react to what
 * they said and finish, or send something that adds to it. At most one deflection per run —
 * the next call goes through whatever it says.
 */
export const Deflected = Schema.Struct({
  posted: Schema.Literal(false),
  reason: Schema.Literal('steered'),
  steer: Schema.Array(SteerItem),
  hint: Schema.String
})
export type Deflected = typeof Deflected.Type

export const SendResult = Schema.Union(SendResponse, Deflected)
export type SendResult = typeof SendResult.Type

export const isDeflected = (r: { readonly posted?: unknown }): r is Deflected => r.posted === false

export const InboxQuery = Schema.Struct({
  since: Schema.optional(Seq).annotations({
    description: 'Return only messages with seq > since. Omit for everything unread.'
  })
})
export type InboxQuery = typeof InboxQuery.Type

export const InboxMessage = Schema.Struct({
  seq: Seq,
  messageId: Schema.String,
  channelId: Schema.String,
  channelName: Schema.optional(Schema.String),
  threadId: Schema.optional(Schema.String),
  from: Sender,
  text: Schema.String,
  at: IsoDate,
  intent: Schema.optional(Intent),
  /** Present when this message answers one of your `taut_ask`s. */
  askId: Schema.optional(Schema.String),
  /** Files sent with the message, already on your disk — read images with your file tool. */
  attachments: Schema.optional(Schema.Array(InboxAttachment))
})
export type InboxMessage = typeof InboxMessage.Type

export const InboxResponse = Schema.Struct({
  items: Schema.Array(InboxMessage),
  /** Pass back as `since` next time. */
  nextSince: Seq
})
export type InboxResponse = typeof InboxResponse.Type

export const AskRequest = Schema.Struct({
  to: Target.annotations({
    description: 'Who must answer: "@handle" (usually your department head).'
  }),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)).annotations({
    description: 'The question. Offer concrete options when you can ("drop or keep nullable?").'
  }),
  timeoutSec: Schema.optional(Schema.Number.pipe(Schema.between(1, 45))).annotations({
    description: 'How long to wait for the answer before parking (max 45, default 45).'
  })
})
export type AskRequest = typeof AskRequest.Type

export const AskCreated = Schema.Struct({
  askId: Schema.String,
  messageId: Schema.String,
  threadId: Schema.String
})
export type AskCreated = typeof AskCreated.Type

export const AskStatusQuery = Schema.Struct({
  /** Server may long-poll up to this many ms before answering `pending`. */
  wait: Schema.optional(Schema.NonNegativeInt)
})

export const AskAnswer = Schema.Struct({
  text: Schema.String,
  from: Sender,
  at: IsoDate,
  messageId: Schema.String
})
export type AskAnswer = typeof AskAnswer.Type

export const AskStatus = Schema.Struct({
  askId: Schema.String,
  status: Schema.Literal('pending', 'answered'),
  answer: Schema.optional(AskAnswer)
})
export type AskStatus = typeof AskStatus.Type

export const DoneRequest = Schema.Struct({
  summary: Schema.String.pipe(Schema.maxLength(8000)).annotations({
    description:
      'What you did, what changed, what is left. This is posted to the thread. Pass "" only when your whole answer was a reaction (taut_react): the empty reply is withdrawn instead of posted.'
  }),
  outcome: Schema.optional(Schema.Literal('succeeded', 'failed')).annotations({
    description: 'Default "succeeded".'
  }),
  filesChanged: Schema.optional(Schema.Array(Schema.String)).annotations({
    description: 'Paths you created or modified.'
  }),
  attachments: Schema.optional(AttachmentPaths).annotations({
    description:
      'Files or images to share with the summary (screenshot, CSV, PDF…): up to 10 paths inside your home, absolute or home-relative. The human sees them inline.'
  })
})
export type DoneRequest = typeof DoneRequest.Type

export const DoneResponse = Schema.Struct({
  /** Always `true`. `false` is the `Deflected` shape (D7): the task is still open. */
  posted: Schema.Literal(true),
  taskId: Schema.String,
  status: Schema.Literal('done', 'failed'),
  /** D4: the empty reply was withdrawn because your whole answer was a reaction. */
  withdrew: Schema.optional(Schema.Boolean)
})
export type DoneResponse = typeof DoneResponse.Type

export const DoneResult = Schema.Union(DoneResponse, Deflected)
export type DoneResult = typeof DoneResult.Type

export const HandoffRequest = Schema.Struct({
  to: Target.annotations({
    description: '"@handle" of the agent that should take the child task.'
  }),
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(8000)).annotations({
    description: 'The spec for the child task: goal, constraints, where the inputs are.'
  })
})
export type HandoffRequest = typeof HandoffRequest.Type

export const HandoffResponse = Schema.Struct({
  /** The child task, linked to yours by `parentTaskId`. Its `taut_done` posts back into your thread. */
  taskId: Schema.String,
  threadId: Schema.String,
  messageId: Schema.String
})
export type HandoffResponse = typeof HandoffResponse.Type

// --- reactions (docs/build-plan-steering-reactions.md D1-D3) ------------------

export const ReactRequest = Schema.Struct({
  messageId: Schema.String.annotations({
    description: 'The message to react to. Any message in a channel you can see.'
  }),
  emoji: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(32)).annotations({
    description: 'One emoji, 1-8 code points: "\u{1F44D}", "\u2705", "\u{1F440}", "\u{1F389}".'
  }),
  on: Schema.optional(Schema.Boolean).annotations({
    description: 'Default true. Pass false to take your reaction back.'
  })
})
export type ReactRequest = typeof ReactRequest.Type

export const ReactResponse = Schema.Struct({
  messageId: Schema.String,
  emoji: Schema.String,
  on: Schema.Boolean,
  /** Every emoji now on the message with its count, so you can see what the room already said. */
  reactions: Schema.Array(Schema.Struct({ emoji: Schema.String, count: Schema.NonNegativeInt }))
})
export type ReactResponse = typeof ReactResponse.Type

// --- memory (§10) ---------------------------------------------------------

export const MemorySearchRequest = Schema.Struct({
  query: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: 'Keywords. Terms are ANDed; add a trailing * for prefix match ("migrat*").'
  }),
  limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 50))).annotations({
    description: 'Default 10.'
  }),
  since: Schema.optional(IsoDate),
  until: Schema.optional(IsoDate),
  channelId: Schema.optional(Schema.String),
  kind: Schema.optional(MemoryKind),
  authorId: Schema.optional(Schema.String)
})
export type MemorySearchRequest = typeof MemorySearchRequest.Type

export const MemoryGrepRequest = Schema.Struct({
  pattern: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: 'JavaScript regular expression matched against message bodies.'
  }),
  flags: Schema.optional(Schema.String).annotations({ description: 'RegExp flags, default "i".' }),
  limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 100))).annotations({
    description: 'Default 20.'
  }),
  since: Schema.optional(IsoDate),
  until: Schema.optional(IsoDate),
  channelId: Schema.optional(Schema.String),
  kind: Schema.optional(MemoryKind)
})
export type MemoryGrepRequest = typeof MemoryGrepRequest.Type

export const MemoryRecallThreadRequest = Schema.Struct({
  threadId: Schema.String.annotations({
    description: 'Root message id of the thread (also accepts a message id that is the root).'
  }),
  limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 200)))
})
export type MemoryRecallThreadRequest = typeof MemoryRecallThreadRequest.Type

export const MemoryTimelineRequest = Schema.Struct({
  from: IsoDate,
  to: IsoDate,
  channelId: Schema.optional(Schema.String),
  limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 200))).annotations({
    description: 'Default 100.'
  })
})
export type MemoryTimelineRequest = typeof MemoryTimelineRequest.Type

export const MemoryNoteRequest = Schema.Struct({
  text: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(20_000)).annotations({
    description: 'The note (markdown). One topic per note.'
  }),
  tags: Schema.optional(Schema.Array(Schema.String))
})
export type MemoryNoteRequest = typeof MemoryNoteRequest.Type

export const MemoryNotesListQuery = Schema.Struct({
  limit: Schema.optional(Schema.Int.pipe(Schema.between(1, 200)))
})
export type MemoryNotesListQuery = typeof MemoryNotesListQuery.Type

export const MemoryForgetRequest = Schema.Struct({
  id: Schema.String.annotations({ description: 'Note id from memory_note / memory_notes_list.' })
})
export type MemoryForgetRequest = typeof MemoryForgetRequest.Type

export const MemoryHits = Schema.Struct({ items: Schema.Array(MemoryHit) })
export type MemoryHits = typeof MemoryHits.Type
export const MemoryItems = Schema.Struct({ items: Schema.Array(MemoryItem) })
export type MemoryItems = typeof MemoryItems.Type
export const MemoryNoteResponse = Schema.Struct({ item: MemoryItem })
export type MemoryNoteResponse = typeof MemoryNoteResponse.Type
export const MemoryForgetResponse = Schema.Struct({ deleted: Schema.Boolean })
export type MemoryForgetResponse = typeof MemoryForgetResponse.Type

// --- vault (docs/build-plan-browser-vaults.md D5) ----------------------------------

export const VaultScope = Schema.Literal('company', 'agent')
export type VaultScope = typeof VaultScope.Type

/** Metadata only — never the secret. */
export const VaultItemSummary = Schema.Struct({
  id: Schema.String,
  /** Credential kind, e.g. `anthropic.api_key`, `github.token`, `generic`. */
  kind: Schema.String,
  label: Schema.String,
  /** Masked preview (`••••1234`). */
  hint: Schema.String,
  /** `company`: shared by every agent of the company. `agent`: private to this agent. */
  scope: VaultScope,
  lastUsedAt: Schema.optional(IsoDate)
})
export type VaultItemSummary = typeof VaultItemSummary.Type

export const VaultListQuery = Schema.Struct({})
export type VaultListQuery = typeof VaultListQuery.Type

export const VaultListResponse = Schema.Struct({ items: Schema.Array(VaultItemSummary) })
export type VaultListResponse = typeof VaultListResponse.Type

export const VaultGetRequest = Schema.Struct({
  vaultItemId: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: 'The `id` of an item from vault_list.'
  })
})
export type VaultGetRequest = typeof VaultGetRequest.Type

/** Plaintext for the agent's process only. The server adds `secret` to the task redactor first. */
export const VaultGetResponse = Schema.Struct({
  id: Schema.String,
  kind: Schema.String,
  label: Schema.String,
  secret: Schema.String
})
export type VaultGetResponse = typeof VaultGetResponse.Type

/**
 * Writes are always to **your own** vault. There is no scope parameter on any of them: the
 * server takes the owner from your task token. A company item, or another agent's item, is
 * `403 forbidden` on update and delete — company credentials are read-only for agents.
 */
export const VaultAddRequest = Schema.Struct({
  kind: Schema.String.pipe(Schema.minLength(1)).annotations({
    description:
      'Credential kind: "generic.secret" for a password or site login, or one of anthropic.api_key, claude.oauth, openai.api_key, openai.oauth, cursor.api_key.'
  }),
  label: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120)).annotations({
    description: 'How you will recognise it later, e.g. "acme-portal login".'
  }),
  secret: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: 'The value to store. Encrypted at rest; never returned by vault_list.'
  })
})
export type VaultAddRequest = typeof VaultAddRequest.Type

export const VaultAddResponse = Schema.Struct({ item: VaultItemSummary })
export type VaultAddResponse = typeof VaultAddResponse.Type

export const VaultUpdateRequest = Schema.Struct({
  vaultItemId: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: 'The `id` of one of your own items (scope "agent" in vault_list).'
  }),
  label: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(120))),
  secret: Schema.optional(Schema.String.pipe(Schema.minLength(1)))
})
export type VaultUpdateRequest = typeof VaultUpdateRequest.Type

export const VaultUpdateResponse = Schema.Struct({ item: VaultItemSummary })
export type VaultUpdateResponse = typeof VaultUpdateResponse.Type

export const VaultDeleteRequest = Schema.Struct({
  vaultItemId: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: 'The `id` of one of your own items (scope "agent" in vault_list).'
  })
})
export type VaultDeleteRequest = typeof VaultDeleteRequest.Type

export const VaultDeleteResponse = Schema.Struct({ deleted: Schema.Boolean })
export type VaultDeleteResponse = typeof VaultDeleteResponse.Type

// --- repositories (docs/build-plan-repositories.md D4, D7) ------------------------

/**
 * What `taut git-credential get` asks on behalf of `git`, built from the `key=value` block git
 * writes on its stdin. No token is ever sent *up* — the task's own bearer token is the only
 * credential in the request, and the server decides which repository it may unlock (D14).
 */
export const GitCredentialRequest = Schema.Struct({
  /** `github.com`. Anything else is refused: only github.com in this phase (D10). */
  host: Schema.String.pipe(Schema.minLength(1)),
  /**
   * `owner/name.git` — how the server maps the request to a granted repository, and the only
   * thing that keeps two repositories of the same company apart. git sends it only when
   * `credential.<url>.useHttpPath` is on, which the task runner sets per exec; a helper that
   * did not get one answers nothing rather than guessing which repository was meant.
   */
  path: Schema.String.pipe(Schema.minLength(1))
})
export type GitCredentialRequest = typeof GitCredentialRequest.Type

/**
 * A freshly minted, repository-scoped installation token, alive for about an hour and never
 * written anywhere: the helper prints it on stdout for the `git` process that asked and exits.
 */
export const GitCredentialResponse = Schema.Struct({
  /** Always `x-access-token` for a GitHub App installation token. */
  username: Schema.String,
  password: Schema.String,
  expiresAt: Schema.optional(IsoDate)
})
export type GitCredentialResponse = typeof GitCredentialResponse.Type

export const OpenPullRequestRequest = Schema.Struct({
  repo: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: '"owner/name" of a repository you have read-write access to.'
  }),
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)).annotations({
    description: 'One line, imperative, what the change does.'
  }),
  body: Schema.String.pipe(Schema.maxLength(60_000)).annotations({
    description: 'Markdown description: what changed, why, how it was checked.'
  }),
  head: Schema.optional(Schema.String).annotations({
    description: "Branch to merge from. Defaults to this task's branch in that repository."
  }),
  base: Schema.optional(Schema.String).annotations({
    description: "Branch to merge into. Defaults to the repository's default branch."
  })
})
export type OpenPullRequestRequest = typeof OpenPullRequestRequest.Type

export const OpenPullRequestResponse = Schema.Struct({
  url: Schema.String,
  number: Schema.Number
})
export type OpenPullRequestResponse = typeof OpenPullRequestResponse.Type

// --- linear (docs/build-plan-projects.md D21, D22) ------------------------------

/**
 * What an agent files as a Linear ticket. Everything an id could be inferred from
 * is resolved by the server from the mirror: the agent names a project it can
 * already see, and the team, the assignee and the workspace all follow from that.
 * No Linear id an agent typed ever reaches Linear.
 */
export const CreateIssueRequest = Schema.Struct({
  projectId: Schema.String.pipe(Schema.minLength(1)).annotations({
    description:
      'The `projectId` of a project in this company, as `linear_projects` lists it (a `prj_…` id).'
  }),
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(300)).annotations({
    description: 'One line, imperative, what needs doing. This is the ticket title.'
  }),
  description: Schema.String.pipe(Schema.maxLength(60_000)).annotations({
    description:
      'Markdown body: the problem, what "done" looks like, and anything you already know. Write it for whoever picks the ticket up, not for the person who asked.'
  }),
  priority: Schema.optional(Schema.Number.pipe(Schema.between(0, 4))).annotations({
    description:
      "Linear's priority: 0 none, 1 urgent, 2 high, 3 medium, 4 low. Leave it out unless the person who asked said how urgent it is."
  })
})
export type CreateIssueRequest = typeof CreateIssueRequest.Type

/** The ticket as Linear now holds it — the identifier is the thing to quote back. */
export const CreateIssueResponse = Schema.Struct({
  /** Linear's human key, e.g. `ENG-4636`. */
  identifier: Schema.String,
  title: Schema.String,
  url: Schema.String,
  /** The workflow state Linear filed it into, e.g. `Triage`, `Backlog`. */
  state: Schema.String,
  /** Who it is assigned to: the Linear person the human who asked is mapped to. */
  assignee: Schema.optional(Schema.String),
  projectName: Schema.String
})
export type CreateIssueResponse = typeof CreateIssueResponse.Type

/** One project an agent may file against, with just enough to choose between them. */
export const LinearProjectSummary = Schema.Struct({
  projectId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  /** Where it stands: `Planning`, `In progress`, whatever the workspace calls it. */
  status: Schema.String,
  url: Schema.String
})
export type LinearProjectSummary = typeof LinearProjectSummary.Type

export const LinearProjectsResponse = Schema.Struct({
  projects: Schema.Array(LinearProjectSummary),
  /**
   * Whether the human in this conversation is mapped to a Linear person (D21).
   * `false` means `linear_create_issue` will refuse, and the agent should say so
   * rather than filing and failing.
   */
  canCreateIssues: Schema.Boolean,
  /** Why not, when `canCreateIssues` is false. Say this to the human verbatim. */
  reason: Schema.optional(Schema.String)
})
export type LinearProjectsResponse = typeof LinearProjectsResponse.Type

export const LinearProjectsQuery = Schema.Struct({})
export type LinearProjectsQuery = typeof LinearProjectsQuery.Type

// --- signals (docs/build-plan-triggers.md Part II) --------------------------------

/**
 * A signal as the emitting agent sees it. `deliverAt` is the thing to quote back to the human:
 * the agent asked for "in three minutes" and this is the clock time that turned into, so it can
 * say "6:32 PM" instead of guessing.
 */
export const SignalSummary = Schema.Struct({
  signalId: Schema.String,
  name: Schema.String,
  note: Schema.String,
  /** ISO 8601, UTC. */
  deliverAt: Schema.String,
  /** `pending` until it goes off; `delivered`, `cancelled` or `expired` after. */
  status: Schema.String,
  /** Absent for a broadcast — a signal nobody is targeted by, only listened for. */
  targetAgentId: Schema.optional(Schema.String),
  /** The thread the wake will land in, when it is this conversation. */
  threadId: Schema.optional(Schema.String)
})
export type SignalSummary = typeof SignalSummary.Type

export const EmitSignalRequest = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(64)).annotations({
    description:
      'A short lower-case name for what this is: `remind`, `deploy-finished`, `check-inbox`. Letters, digits, ".", "_" and "-" only. Names are shared across the company, which is how one agent can listen for another\'s signal.'
  }),
  note: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)).annotations({
    description:
      'What you should do when it goes off, written to your future self: "tell Ted to buy watermelon". This becomes the message you are woken with.'
  }),
  payload: Schema.optional(
    Schema.Record({ key: Schema.String, value: Schema.Unknown })
  ).annotations({
    description:
      'Optional JSON hint carried along (max 8 KB). You do not need it for your own reminders — you will be woken in this same thread with everything you already know. It is for a broadcast another agent picks up.'
  }),
  deliverIn: Schema.optional(Schema.String).annotations({
    description:
      'How long from now, e.g. "3 minutes", "30s", "2 hours". Leave both this and deliverAt out to fire immediately.'
  }),
  deliverAt: Schema.optional(Schema.String).annotations({
    description: 'An absolute ISO 8601 instant instead of deliverIn, e.g. "2026-09-09T18:32:00Z".'
  }),
  to: Schema.optional(Schema.String).annotations({
    description:
      '"self" (the default) wakes you. "broadcast" wakes only agents whose trigger is listening for this name. An `agt_…` id wakes that agent specifically.'
  }),
  thread: Schema.optional(Schema.Literal('current', 'new')).annotations({
    description:
      '"current" (the default) wakes you in this thread, with this conversation\'s context. "new" starts a fresh one.'
  })
})
export type EmitSignalRequest = typeof EmitSignalRequest.Type

export const EmitSignalResponse = Schema.Struct({ signal: SignalSummary })
export type EmitSignalResponse = typeof EmitSignalResponse.Type

export const ListSignalsQuery = Schema.Struct({
  status: Schema.optional(Schema.String).annotations({
    description: 'Filter by status; defaults to `pending`, which is the only one worth acting on.'
  })
})
export type ListSignalsQuery = typeof ListSignalsQuery.Type

export const ListSignalsResponse = Schema.Struct({ signals: Schema.Array(SignalSummary) })
export type ListSignalsResponse = typeof ListSignalsResponse.Type

export const CancelSignalRequest = Schema.Struct({
  signalId: Schema.String.pipe(Schema.minLength(1)).annotations({
    description: 'The `signalId` from emit_signal or list_signals.'
  })
})
export type CancelSignalRequest = typeof CancelSignalRequest.Type

export const CancelSignalResponse = Schema.Struct({ cancelled: Schema.Boolean })
export type CancelSignalResponse = typeof CancelSignalResponse.Type

// --- the route table ------------------------------------------------------------

export const AGENT_RUNTIME_PREFIX = '/api/agent-runtime'

// -- skills (docs/build-plan-skills.md) ---------------------------------------

/**
 * One of the agent's own skills, as it sees it. `state: "pending"` is an install the agent asked
 * for that a human has not accepted yet: it is on disk, but the agent is not using it.
 */
export const SkillSummary = Schema.Struct({
  name: Schema.String,
  description: Schema.String,
  /** `builtin` ships with Taut, `authored` you wrote, `installed` came from a source. */
  origin: Schema.String,
  state: Schema.String,
  /** Where an installed skill came from, e.g. `github:mattpocock/skills#grill-with-docs`. */
  source: Schema.optional(Schema.String),
  /** `manual`, `notify` or `auto`. */
  updatePolicy: Schema.String,
  /** Upstream has changed and the change has not been applied. */
  updateAvailable: Schema.Boolean
})
export type SkillSummary = typeof SkillSummary.Type

export const SkillListQuery = Schema.Struct({})
export type SkillListQuery = typeof SkillListQuery.Type

export const SkillListResponse = Schema.Struct({ skills: Schema.Array(SkillSummary) })
export type SkillListResponse = typeof SkillListResponse.Type

export const SkillWriteRequest = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(2), Schema.maxLength(32)).annotations({
    description:
      'Skill name, 2-32 chars of a-z, 0-9, _ and -. Writing an existing name replaces it.'
  }),
  description: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(400)).annotations({
    description:
      'One line saying when this skill applies. This is what you read when you decide whether to use it, so write it for your future self.'
  }),
  body: Schema.String.annotations({
    description: 'The markdown body of SKILL.md, without frontmatter. Taut adds the frontmatter.'
  })
})
export type SkillWriteRequest = typeof SkillWriteRequest.Type

export const SkillWriteResponse = Schema.Struct({ skill: SkillSummary })
export type SkillWriteResponse = typeof SkillWriteResponse.Type

export const SkillInstallRequest = Schema.Struct({
  source: Schema.String.pipe(Schema.minLength(1)).annotations({
    description:
      'Where the skill is. A link, a GitHub repo like `owner/repo` (optionally `#skill-name`), the `npx skills@latest add ...` command someone pasted, or the SKILL.md markdown itself. Pass it exactly as you received it; it is parsed, never run as a command.'
  }),
  name: Schema.optional(
    Schema.String.annotations({
      description: 'Which skill to take, when the source holds more than one.'
    })
  ),
  updatePolicy: Schema.optional(
    Schema.String.annotations({
      description:
        '`notify` (default) tells your owner when it changes upstream, `auto` applies changes for you, `manual` never checks.'
    })
  )
})
export type SkillInstallRequest = typeof SkillInstallRequest.Type

export const SkillInstallResponse = Schema.Struct({
  skill: SkillSummary,
  /** True when a human has to approve before you can use it. */
  pending: Schema.Boolean,
  /** One line to relay to whoever gave you the skill. */
  message: Schema.String
})
export type SkillInstallResponse = typeof SkillInstallResponse.Type

export const SkillUpdateRequest = Schema.Struct({
  name: Schema.String.annotations({ description: 'One of your installed skills.' })
})
export type SkillUpdateRequest = typeof SkillUpdateRequest.Type

export const SkillUpdateResponse = Schema.Struct({ skill: SkillSummary })
export type SkillUpdateResponse = typeof SkillUpdateResponse.Type

export const SkillRemoveRequest = Schema.Struct({
  name: Schema.String.annotations({ description: 'One of your own skills. Built-ins are refused.' })
})
export type SkillRemoveRequest = typeof SkillRemoveRequest.Type

export const SkillRemoveResponse = Schema.Struct({ removed: Schema.Boolean })
export type SkillRemoveResponse = typeof SkillRemoveResponse.Type

export interface Route<
  Req extends Schema.Schema.AnyNoContext,
  Res extends Schema.Schema.AnyNoContext
> {
  readonly method: 'GET' | 'POST'
  /** Relative to `AGENT_RUNTIME_PREFIX`. `:id` is a path parameter. */
  readonly path: string
  /** POST → JSON body; GET → URL query parameters. */
  readonly request: Req
  readonly response: Res
}

const route = <Req extends Schema.Schema.AnyNoContext, Res extends Schema.Schema.AnyNoContext>(
  method: 'GET' | 'POST',
  path: string,
  request: Req,
  response: Res
): Route<Req, Res> => ({ method, path, request, response })

/**
 * What the server must implement. Bearer auth on all of them.
 *
 * | route            | method | path                     |
 * | ---------------- | ------ | ------------------------ |
 * | send             | POST   | /send                    |
 * | inbox            | GET    | /inbox?since=            |
 * | ask              | POST   | /ask                     |
 * | askStatus        | GET    | /ask/:id?wait=<ms>       |
 * | done             | POST   | /done                    |
 * | handoff          | POST   | /handoff                 |
 * | react            | POST   | /react                   |
 * | memorySearch     | POST   | /memory/search           |
 * | memoryGrep       | POST   | /memory/grep             |
 * | memoryRecall     | POST   | /memory/recall-thread    |
 * | memoryTimeline   | POST   | /memory/timeline         |
 * | memoryNote       | POST   | /memory/note             |
 * | memoryNotesList  | GET    | /memory/notes?limit=     |
 * | memoryForget     | POST   | /memory/forget           |
 * | vaultList        | GET    | /vault                   |
 * | vaultGet         | POST   | /vault/get               |
 * | vaultAdd         | POST   | /vault/add               |
 * | vaultUpdate      | POST   | /vault/update            |
 * | vaultDelete      | POST   | /vault/delete            |
 * | emitSignal       | POST   | /signals/emit            |
 * | listSignals      | GET    | /signals?status=         |
 * | cancelSignal     | POST   | /signals/cancel          |
 * | gitCredential    | POST   | /git-credential          |
 * | githubOpenPr     | POST   | /github/pull-request     |
 * | linearProjects   | GET    | /linear/projects         |
 * | linearCreateIssue| POST   | /linear/issue            |
 */
export const AgentRuntimeRoutes = {
  send: route('POST', '/send', SendRequest, SendResult),
  inbox: route('GET', '/inbox', InboxQuery, InboxResponse),
  ask: route('POST', '/ask', AskRequest, AskCreated),
  askStatus: route('GET', '/ask/:id', AskStatusQuery, AskStatus),
  done: route('POST', '/done', DoneRequest, DoneResult),
  handoff: route('POST', '/handoff', HandoffRequest, HandoffResponse),
  react: route('POST', '/react', ReactRequest, ReactResponse),
  memorySearch: route('POST', '/memory/search', MemorySearchRequest, MemoryHits),
  memoryGrep: route('POST', '/memory/grep', MemoryGrepRequest, MemoryItems),
  memoryRecall: route('POST', '/memory/recall-thread', MemoryRecallThreadRequest, MemoryItems),
  memoryTimeline: route('POST', '/memory/timeline', MemoryTimelineRequest, MemoryItems),
  memoryNote: route('POST', '/memory/note', MemoryNoteRequest, MemoryNoteResponse),
  memoryNotesList: route('GET', '/memory/notes', MemoryNotesListQuery, MemoryItems),
  memoryForget: route('POST', '/memory/forget', MemoryForgetRequest, MemoryForgetResponse),
  vaultList: route('GET', '/vault', VaultListQuery, VaultListResponse),
  vaultGet: route('POST', '/vault/get', VaultGetRequest, VaultGetResponse),
  vaultAdd: route('POST', '/vault/add', VaultAddRequest, VaultAddResponse),
  vaultUpdate: route('POST', '/vault/update', VaultUpdateRequest, VaultUpdateResponse),
  vaultDelete: route('POST', '/vault/delete', VaultDeleteRequest, VaultDeleteResponse),
  skillList: route('GET', '/skills', SkillListQuery, SkillListResponse),
  skillWrite: route('POST', '/skills/write', SkillWriteRequest, SkillWriteResponse),
  skillInstall: route('POST', '/skills/install', SkillInstallRequest, SkillInstallResponse),
  skillUpdate: route('POST', '/skills/update', SkillUpdateRequest, SkillUpdateResponse),
  skillRemove: route('POST', '/skills/remove', SkillRemoveRequest, SkillRemoveResponse),
  gitCredential: route('POST', '/git-credential', GitCredentialRequest, GitCredentialResponse),
  githubOpenPr: route(
    'POST',
    '/github/pull-request',
    OpenPullRequestRequest,
    OpenPullRequestResponse
  ),
  linearProjects: route('GET', '/linear/projects', LinearProjectsQuery, LinearProjectsResponse),
  linearCreateIssue: route('POST', '/linear/issue', CreateIssueRequest, CreateIssueResponse),
  emitSignal: route('POST', '/signals/emit', EmitSignalRequest, EmitSignalResponse),
  listSignals: route('GET', '/signals', ListSignalsQuery, ListSignalsResponse),
  cancelSignal: route('POST', '/signals/cancel', CancelSignalRequest, CancelSignalResponse)
} as const

export type AgentRuntimeRoutes = typeof AgentRuntimeRoutes
export type RouteName = keyof AgentRuntimeRoutes
