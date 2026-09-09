# Taut data model — MVP

Taut is open-source Slack where some members are agents. **One deployment =
one company.** A company spins up its own instance, and all its vault
items, subscriptions, agents, files and memory live there.

Research behind the decisions here lives in `docs/research/`; claims carry a
short pointer instead of a repeated citation.

## 0. Deployment

Target: `docker compose up` on a €4 VPS. No managed services.

```
┌─ taut (one container) ───────────────────────────┐
│  web client (React, static)                      │
│  API + WebSocket (Node, Hono)                     │
│  SQLite  ──────────────────────── /data/taut.db   │
│  agent homes ─────────────────── /data/companies  │
│  MachineProvider ──── docker.sock → taut-agent    │
│                       containers (one per agent)  │
└──────────────────────────────────────────────────┘
        volume: /data      env: TAUT_MASTER_KEY
```

- **Single image, single volume.** Backup = copy `/data`.
- **SQLite** via `better-sqlite3`. Postgres is a later option, not a requirement.
- **`TAUT_MASTER_KEY`** is the only required secret. Generated on first boot
  and printed once if missing.
- The runtimes (`claude`, `codex`, `cursor-agent`, `opencode`) live in a second
  image, `taut-agent`, not in the server image (§7).
- The Electron app in `apps/desktop` is a thin shell pointing at the instance
  URL — not the product.

Multi-company on one instance is on (every table has `company_id`). Anyone may
create a company from the sidebar and switch between the ones they belong to;
an owner may delete a company only while they still belong to another.

The root entity is the **Company**: members (humans, §2), departments (§2),
vault (§3), subscriptions (§4) and agents (§5), each agent owning a home folder,
a machine (§7) and a memory DB (§10).

Hard rule: nothing crosses a company boundary. An agent in company A cannot
see company B's vault, subscriptions, files, channels or memory.

---

## MVP scope

**In v1**

- Companies; humans invited by email token; roles `owner|admin|member`
- Departments, each with one human head; channels belong to a department
- Vault, two scopes: company items (usable by every agent) and agent items (one agent,
  managed by admin+ or the head of its department) — add, list (metadata only), revoke;
  `vault_list` / `vault_get` runtime tools, plus `vault_add` / `vault_update` / `vault_delete`
  scoped to the agent's own items only — the company vault is read-only for agents (§3, §9)
- Company subscriptions: a pool per runtime kind, rotation on rate-limit
- Create agent: handle, name, avatar, role, mandate, skills, department, runtime kind,
  browser access (§7)
- Agent home on disk: `AGENT.md`, `skills/`, `memory/`
- Machines: `MachineProvider` with `local` and `docker` providers (§7)
- @mention an agent → task thread → it runs on its machine → streams into the thread
- Realtime: WebSocket with seq-based resume, streaming replies, unread badges,
  @mention/DM notifications (§8)
- Agent messaging: `taut` MCP server + CLI — send / inbox / ask / done / handoff,
  routing and loop limits enforced server-side (§9)
- Memory: `MEMORY.md` + a per-agent SQLite FTS5 index fed from the event log (§10)

**Deferred**

- Fly Machines provider; `runsc`/`sysbox-runc` are a config knob, not a default (§7)
- Dense embeddings, RRF, reranking, nightly consolidation (§10)
- Token budgets, concurrency limits
- Shared skill library
- A `web.login` credential kind (url + user + password) for the browser; egress allow-lists

---

## 1. Company

```ts
type CompanyId = string // "cmp_…"

interface Company {
  id: CompanyId
  slug: string // "acme" — used for the on-disk folder
  name: string // "Acme Inc"
  avatar: Avatar
  createdAt: string
}
```

On disk:

```
/data/companies/acme/
├── company.json
└── agents/
    └── bruno/          ← §5
```

Vault, subscriptions and departments live in the app DB, not on disk.

## 2. Departments & roles

A department is how a company is cut into teams. **Each department has
exactly one human head** (`headUserId`) — the person its agents report to.
Heads are always humans; an agent is never a head.

```ts
type DepartmentId = string // "dep_…"
type CompanyRole = 'owner' | 'admin' | 'member'
type MemberKind = 'user' | 'agent'

interface Membership {
  companyId: CompanyId
  userId: UserId
  role: CompanyRole
}
interface Department {
  id: DepartmentId
  companyId: CompanyId
  name: string // "Backend"
  slug: string // "backend"
  headUserId: UserId // exactly one, human
  createdAt: string
}
interface DepartmentMember {
  departmentId: DepartmentId
  memberKind: MemberKind
  memberId: string
}
```

- **Members** are users _and_ agents. Every agent belongs to exactly one
  department; its head is the human it answers to by default (§9).
- **Channels belong to a department** (`channels.departmentId`). A channel's
  membership is independent of the department's (you can invite someone in) but
  the department is what a channel is _for_, and what routing keys off.
- **DMs do not belong to a department** (`kind: "dm"`, `departmentId: null`).
  They are between two humans, or a human and an agent. There are no
  agent-to-agent DMs, ever (§9).
- **Invites** are by email + token: `invites (id, companyId, email, role, token,
invitedBy, expiresAt, acceptedAt?)`. Accepting creates the `Membership`.

Authorization (enforced in services, not routes):

| actor             | may                                                                                                                                                                                      |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `owner` / `admin` | everything in the company                                                                                                                                                                |
| `member`          | read/post in channels they belong to; DM                                                                                                                                                 |
| department head   | manage that department's members, channels and agents                                                                                                                                    |
| agent             | post only in channels it is a member of; resolve company vault items and its own agent items, and **write only its own vault items** (§3); write only inside its home + `rw` file grants |

Every query is scoped by `companyId` from the session's active company.

## 3. Vault (per company, two scopes)

Server-side, no OS keychain. Each item is encrypted with **AES-256-GCM**
using a key derived from `TAUT_MASTER_KEY` (HKDF, info = company id).
Random 12-byte nonce per item, AAD = item id. Plaintext exists only in the
API process: at spawn time (a seat's credential) and inside `vault_get`.

One table, two scopes (docs/build-plan-browser-vaults.md D3, D4):

- **Company item** (`agentId` absent) — usable by every agent of the company.
  Owner/admin add and revoke. The `/vault` page.
- **Agent item** (`agentId` set) — belongs to exactly one agent; only that agent
  can resolve it at runtime. Added, listed and revoked by owner/admin **or the
  head of that agent's department** (`requireManageAgent`, shared with §5's
  agent management). The "Agent vault" tab on the agent page. Deleting the
  agent deletes its items (`ON DELETE CASCADE`).

The crypto is the same for both (key = HKDF(master, companyId), AAD = item id):
scope is a row-level fact, not a key. There are no grants — the former
`agent_vault_grants` table is gone.

**The company vault is read-only for agents.** An agent may create, change and
delete items in its own vault and nowhere else: never a company item, never
another agent's item. Owner rule, 2026-09-08; see the `…ForAgent` calls below.

Rotation: `taut vault rotate-key` re-encrypts every item under a new master
key. Deferred, but the format (`version` byte in the ciphertext) allows it.

```ts
type VaultItemId = string // "vlt_…"

type CredentialKind =
  | 'anthropic.api_key'
  | 'claude.oauth'
  | 'claude.login' // read-only, usage probe only (build-plan-usage-limits.md)
  | 'openai.api_key'
  | 'openai.oauth'
  | 'cursor.api_key'
  | 'voyage.api_key' // §10, optional
  | 'generic.secret'

interface VaultItem {
  id: VaultItemId
  companyId: CompanyId
  agentId?: AgentId // absent = company item; present = that agent's item
  kind: CredentialKind
  label: string // "Acme Anthropic key"
  ciphertext: Buffer
  hint: string // last 4 chars — the only plaintext ever shown
  createdAt: string
  lastUsedAt?: string
  lastUsedBy?: AgentId
}
```

HTTP surface (no `get` for humans — on purpose), plus the server-internal calls:

```ts
vault.list(companyId, { agentId? })         → VaultItemMeta[]   // no ciphertext; absent agentId = company items
vault.add(companyId, kind, label, secret, agentId?) → VaultItemMeta   // agentId present = agent item
vault.revoke(itemId)                        → void              // + deletes subscriptions using it
// server-internal:
vault.resolveForSpawn(itemId, agentId, { subscriptionId?, taskId? }) → { item, secret, injection }  // audit purpose "spawn"
vault.resolveForTool(itemId, agentId, { taskId })                    → same                          // audit purpose "tool" (vault_get)
vault.listForAgent(agentId)                 → VaultItemMeta[]   // company items + that agent's (vault_list)
// server-internal, agent self-service — scope is the agent, never an argument:
vault.addForAgent(agentId, { kind, label, secret }, { taskId })      → VaultItemMeta  // audit purpose "agent_add"
vault.updateForAgent(agentId, itemId, { label?, secret? }, { taskId }) → VaultItemMeta  // audit purpose "agent_update"
vault.revokeForAgent(agentId, itemId, { taskId })                    → void           // audit purpose "agent_revoke"
```

Authorization lives in the service, not the routes:

| call                                       | company item (`agentId` null)                  | agent item                                                    |
| ------------------------------------------ | ---------------------------------------------- | ------------------------------------------------------------- |
| `vault.list`                               | any member                                     | admin+ or head of that agent's department, else `Forbidden`   |
| `vault.add`                                | admin+                                         | admin+ or head of that agent's department                     |
| `vault.revoke`                             | admin+                                         | admin+ or head of that agent's department                     |
| `vault.resolveForSpawn` / `…Tool`          | any agent of the company (or via subscription) | only `item.agentId === agentId`; anything else is `Forbidden` |
| `vault.addForAgent`                        | impossible — no scope argument exists          | always the calling agent's own item                           |
| `vault.updateForAgent` / `…revokeForAgent` | `Forbidden` — read-only for agents             | only `item.agentId === agentId`; anything else is `Forbidden` |

Every resolve writes an `audit_log` row
(`purpose: spawn | tool | probe | revoke | agent_add | agent_update | agent_revoke`),
bumps `lastUsedAt/By` and appends a line to `<agent home>/.taut/audit.log`.
A value fetched with `vault_get` is added to the task's redactor **before** the
response is written (§11), so it is masked out of chat, events and logs from
that moment on.

## 4. Subscriptions (per company)

A subscription is a runtime seat the company owns. It pairs a runtime kind
with a vault item. Agents point at one.

```ts
type SubscriptionId = string // "sub_…"
type RuntimeKind = 'claude-code' | 'codex' | 'cursor' | 'opencode'

interface Subscription {
  id: SubscriptionId
  companyId: CompanyId
  runtime: RuntimeKind
  label: string // "Claude Code — Acme"
  credentialId: VaultItemId // must be a kind the runtime accepts (table below)
  defaultModel?: string
  status: 'ok' | 'auth-failed' | 'binary-missing' | 'unchecked'
  lastCheckedAt?: string
  weight: number // default 1; 0 = drain (no new tasks)
  cooldownUntil?: string // set on rate-limit / 429 / usage-cap error
  tasksToday: number // reset at company-local midnight
}
```

| runtime     | binary         | accepts credential kinds              | injected as                                         |
| ----------- | -------------- | ------------------------------------- | --------------------------------------------------- |
| claude-code | `claude`       | `claude.oauth`, `anthropic.api_key`   | `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` env |
| codex       | `codex`        | `openai.oauth`, `openai.api_key`      | per-task `CODEX_HOME/auth.json` or `OPENAI_API_KEY` |
| cursor      | `cursor-agent` | `cursor.api_key`                      | `CURSOR_API_KEY` env                                |
| opencode    | `opencode`     | `anthropic.api_key`, `openai.api_key` | provider env + generated `opencode.json`            |

A company holds **many subscriptions per runtime** — a pool. "Add
subscription" = pick runtime → pick or add a vault item → Taut runs
`detect()` and sets `status`.

A seat may also carry a second, **read-only** credential
(`usageCredentialId`) that only the usage probe reads and no runtime ever
sees. Claude is the reason it exists: `claude setup-token` is inference-only
and cannot read `/api/oauth/usage`, so a Claude seat needs a `claude.login`
item to show a limits strip. Codex reads its own login and needs nothing
extra (docs/build-plan-usage-limits.md).

**Rotation.** Agents bind to a runtime kind, not to a subscription. At task
start the scheduler picks
`healthy ∧ not cooling-down → lowest tasksToday → highest weight`. On a
rate-limit or usage-cap error mid-task the adapter sets `cooldownUntil`
(default 1h, 5h for Claude's rolling window), the task retries once on the next
subscription, and the department head is notified if the pool is exhausted. An
agent _may_ pin a `subscriptionId` ("always run on the Max seat") and skip
rotation.

**Licensing — decision.** `claude.oauth` (shared subscription tokens from
`claude setup-token`) **stays in MVP**. We are testing whether the shared-seat
model sticks; the owner's reading is that Anthropic currently permits this. If
that changes the pool degrades gracefully: mark the oauth items `weight: 0`,
add `anthropic.api_key` items, nothing else moves. Keep the one-line UI note on
oauth items ("subscription seat — check your provider's terms") so operators of
other instances make their own call (research/agent-sandboxes.md §5).

## 5. Agent

```ts
type AgentId = string // "agt_…"

interface Agent {
  id: AgentId
  companyId: CompanyId
  departmentId: DepartmentId // §2 — its head is the human it reports to

  handle: string // "bruno" — unique within company, @mentionable
  name: string // "Bruno"
  avatar: Avatar // { kind: "emoji"; value: "🦫" } | { kind: "image"; assetId: string }
  role: string // one line: "Backend engineer"
  mandate: string // markdown: standing instructions + boundaries. Becomes AGENT.md.
  skills: Skill[] // { name, description }; body at <home>/skills/<name>/SKILL.md

  runtime: {
    kind: RuntimeKind // picks from the company pool (§4 rotation)
    pinnedSubscriptionId?: SubscriptionId // optional: skip rotation
    model?: string // overrides subscription.defaultModel
    permissionMode: 'plan' | 'auto-edit' // "full-auto" deferred
  }
  browserAccess: boolean // §7 — a headless browser (Playwright MCP) inside the machine; off by default
  machine: {
    // §7
    provider: 'local' | 'docker'
    limits: { cpus: number; memoryMb: number; pidsLimit: number }
  }

  status: 'active' | 'paused'
  createdAt: string
  updatedAt: string
}
```

**Role vs mandate.** Role is the job title (member list). Mandate is the
contract — what it should do, must never do, how it reports. Mandate is the
system prompt; role is a label.

### Home folder ("files")

```
/data/companies/acme/agents/bruno/home/     ← bind-mounted at /home/agent (§7)
├── AGENT.md            # rendered from `mandate` — edit either side, Taut syncs
├── skills/
│   └── review-pr/SKILL.md
├── memory/             # §10 — MEMORY.md, memory.db, notes/, files/
├── inbox/              # attachments humans send it, one folder per message (inbox/<messageId>/<name>)
├── work/               # one folder per task; runtime cwd
├── .claude/ .codex/ …  # runtime state, survives because the home persists
└── .taut/audit.log
```

At task start the adapter renders `AGENT.md` + skills + `memory/MEMORY.md`
into the runtime's native format: `CLAUDE.md` for Claude Code, `AGENTS.md`
for Codex/OpenCode, `.cursor/rules/*.mdc` for Cursor.

Paths outside the home an agent may touch are explicit rows:
`agent_file_grants (agent_id, path, mode: ro|rw)`.

## 6. Runtime adapter

An adapter knows one CLI. It never spawns anything itself: it produces a
command and env, and parses NDJSON. Execution belongs to the machine (§7) —
the split is the one part of Sandcastle worth lifting
(research/agent-sandboxes.md §2).

```ts
interface RuntimeAdapter {
  kind: RuntimeKind
  detect(m: Machine): Promise<{ installed: boolean; version?: string }>
  materialize(agent: Agent, task: Task, m: Machine): Promise<string> // writes work dir, returns cwd
  buildCommand(task: Task, opts: BuildOpts): { cmd: string[]; env: Record<string, string> }
  parseLine(line: string): AgentEvent | null
  resume?(sessionId: string, prompt: string): { cmd: string[] } // §9 park/resume
}

type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'session'; sessionId: string }
  | { type: 'file_change'; path: string }
  | { type: 'done'; summary?: string }
  | { type: 'error'; message: string }
```

MVP ships **claude-code only**; the other three are stubs returning
`detect() → { installed: false }` so the UI greys them out. Claude Code,
headless: `claude -p <prompt> --output-format stream-json --verbose
[--resume <sid>] --mcp-config <f> --strict-mcp-config --allowedTools
"mcp__taut__*"`, prompt on stdin not argv (128 KB limit).

## 7. Machines

Every agent gets **one long-lived box**, not one per task: that is what makes
the home folder — and therefore `~/.claude`, sessions, repos, memory —
persistent by construction, and task start milliseconds rather than seconds
(research/agent-sandboxes.md §6).

`MachineProvider` is the seam. **MVP ships `local`** (spawn on the host as
`taut-agent`; dev only, no isolation) **and `docker`** (one container per agent,
over the Docker socket). **Fly Machines is the planned second provider** — one
machine + volume per agent, ≈$2/agent/mo, same `exec` semantics. Hetzner/DO per
agent (billed while off), Cloudflare (ephemeral disk), Daytona (OSS dead) and
E2B self-host (nested virt) are rejected. **Sandcastle is not a dependency**:
its command builders, NDJSON parsers and Dockerfile lineage are ported into
`@taut/runtime` (MIT, attribution in the file headers); its ephemeral-container
lifecycle is exactly what we don't want (research/agent-sandboxes.md §2).

```ts
export interface MachineSpec {
  agentId: string
  companyId: string
  image: string // "taut-agent:<version>"
  homeDir: string // host path; mounted at /home/agent
  limits: { cpus: number; memoryMb: number; pidsLimit?: number }
  network: { egress: 'allow-all' | { allowDomains: string[] } }
  runtime?: 'runc' | 'runsc' | 'sysbox-runc'
}

export interface ExecOptions {
  cmd: string[]
  cwd?: string
  env?: Record<string, string> // vault.resolveForSpawn() output, per task
  stdin?: string | AsyncIterable<Uint8Array>
  signal?: AbortSignal
  onStdoutLine: (line: string) => void // NDJSON from the agent CLI
  onStderr?: (chunk: string) => void
  idleTimeoutMs?: number // no output for N ms → kill
}

export interface Machine {
  id: string
  status(): Promise<'running' | 'stopped' | 'missing'>
  start(): Promise<void> // idempotent, < ~1 s on docker
  exec(o: ExecOptions): Promise<{ exitCode: number; killedBy?: 'idle' | 'abort' }>
  putFile(path: string, content: Uint8Array): Promise<void>
  getFile(path: string): Promise<Uint8Array>
  stop(): Promise<void> // keeps the home dir
  destroy(): Promise<void> // removes the box, not the home dir
}

export interface MachineProvider {
  readonly name: 'local' | 'docker' | 'fly'
  ensure(spec: MachineSpec): Promise<Machine> // create-or-reuse for this agent
  get(agentId: string): Promise<Machine | null>
  list(companyId: string): Promise<Machine[]>
}
```

**Lifecycle.** `missing → (ensure) → running → (idle N min) → stopped →
(start, <1 s on @mention) → running`. `destroy` removes the container and
keeps `/data/…/home`; deleting the _agent_ is what deletes the home.
`ensure()` is idempotent and is called before every task.

**Docker hardening — from day one.** The container runs `sleep infinity` as
non-root `agent` (UID 1000); tasks are `docker exec -i -u agent -e …`.

- `--cap-drop ALL --security-opt no-new-privileges`
- `--pids-limit 512 --memory 2g --cpus 2`
- `--read-only --tmpfs /tmp` (the home bind-mount stays writable)
- one bridge network **per company** — no agent reaches another company's boxes
- `runtime` knob `runc | runsc | sysbox-runc`, so an operator with gVisor or
  Sysbox installed gets stronger isolation with no code change

**Persistence.** `/data/companies/<slug>/agents/<handle>/home` → `/home/agent`.
Everything in §5's tree survives container restarts, image upgrades and
provider swaps. Nothing else is mounted.

**Secrets at exec, never at run.** `docker run` gets no credentials;
`vault.resolveForSpawn()` output goes on `docker exec -e` per task, so
revocation is immediate and `docker inspect` shows nothing. Still readable by
host root via `/proc/<pid>/environ` — acceptable for MVP; a credential-injecting
proxy is the later upgrade (§13).

**Browser access** (`Agent.browserAccess`, docs/build-plan-browser-vaults.md D1, D7).
When the toggle is on, the task's MCP config carries a second stdio server,
`browser` — **Playwright MCP** (`@playwright/mcp@0.0.80`) — started inside the
agent's machine next to `taut`: headless Chromium, a **persistent profile** at
`<home>/.taut/browser/profile` (logins survive tasks) and screenshots under
`<home>/.taut/browser/out`. Claude Code's allow-list becomes
`--allowedTools mcp__taut__* mcp__browser__*`; the instructions file gains one
line saying the browser is there. In Docker it runs with `--no-sandbox` — the
container is the sandbox (cap-drop ALL, no-new-privileges, read-only rootfs) and
Chromium's own sandbox needs caps it lacks; Chromium lives at `/opt/pw-browsers`
in the image (outside the bind-mounted home). On the `local` provider run
`npx playwright install chromium` once on the host; the server pins
`PLAYWRIGHT_BROWSERS_PATH` to that cache. Off by default; settable by whoever
may manage the agent (admin+ or its department head).

**Claude Code headless gotchas** (research/agent-sandboxes.md §5):

- `--output-format stream-json` **requires `--verbose`**, or it errors out.
- Claude Code **refuses `--dangerously-skip-permissions` as root** — hence the
  non-root `agent` user.
- **`--bare` does not read `CLAUDE_CODE_OAUTH_TOKEN`.** Never use `--bare`.
- Persist `~/.claude` **and** set `CLAUDE_CONFIG_DIR` to it, or the OAuth
  account and folder-trust state are lost every task.
- Auth precedence: `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` >
  `apiKeyHelper` > `CLAUDE_CODE_OAUTH_TOKEN`. Inject exactly one.
- Sessions are `~/.claude/projects/<encoded-cwd>/<id>.jsonl` + `--resume <id>`;
  with a persistent home there is nothing to copy out (§9 resume).

## 8. Realtime

Everything the client sees arrives over **one WebSocket per session**. HTTP
is for writes and initial page loads only. There is no polling.

### Event log

Every mutation appends to a per-company, monotonically numbered event log.
The WebSocket replays from the client's last seen `seq`, so a reconnect
never loses messages.

```ts
interface Event {
  seq: number // per company, gap-free
  companyId: CompanyId
  at: string
  type: EventType
  payload: unknown
}

type EventType =
  | 'message.created'
  | 'message.updated'
  | 'message.deleted'
  | 'task.created'
  | 'task.state' // §9
  | 'agent.task.started'
  | 'agent.task.delta'
  | 'agent.task.done'
  | 'agent.task.failed'
  | 'presence.changed' // human online/away; agent idle/working/waiting
  | 'typing' // ephemeral — not written to the log
  | 'notification' // fan-out target: one user
  | 'unread.changed'
```

Table: `events (seq, company_id, at, type, payload_json)`, indexed on
`(company_id, seq)`. Ephemeral types (`typing`) are broadcast only. The log
is retained 7 days and is also what feeds agent memory (§10).

### Bus

In-process `EventEmitter` behind `Bus { publish(e); subscribe(companyId,
fromSeq, fn) }`. Single container ⇒ no Redis in MVP; the interface is what lets
a multi-node deploy swap in Redis/NATS later without touching handlers. The
per-agent memory consumers (§10) are ordinary subscribers.

### Agent streaming

An agent reply is **one message that grows**. `agent.task.started` creates the
message with `status: "streaming"`; each `agent.task.delta` appends text (after
the redactor); `agent.task.done` finalizes it. Deltas are coalesced to ≤ 10/sec
per task so a chatty runtime can't flood the socket. Agent presence is derived,
not set: `idle` (no task), `working` (task running), `waiting` (parked on an
ask, §9).

### Notifications

Written on `message.created`, fanned out per recipient:

| trigger                  | who                         | shape           |
| ------------------------ | --------------------------- | --------------- |
| @mention / @channel      | mentioned users             | badge + sound   |
| DM                       | recipient                   | badge + sound   |
| reply in a thread I'm in | thread participants         | badge, no sound |
| agent task done / failed | the human who @mentioned it | badge + sound   |
| `needs_gate` approval    | both department heads       | badge + sound   |

Unread counts come from `channel_members.last_read_seq` per
`(member, channel)` — one integer, no per-message read receipts.

Web push / desktop notifications: the Electron shell subscribes to the same
socket and calls the OS notifier. Browser Web Push is deferred.

**Ordering.** Within a channel, messages order by `seq` — no clock skew. A
reconnect sends `{ resume: lastSeq }` and the server replays from the log then
goes live; if `lastSeq` predates the retained log, the client fully reloads.

## 9. Agent-to-agent messaging

**Built natively — the chat _is_ the bus.** No external orchestration
dependency: every credible tool is either a desktop app that owns a terminal
or a same-host SQLite file, and Taut already has a durable, ordered,
replayable log (research/agent-orchestration.md §5). Semantics are borrowed:
Orca's run/task/dispatch/gate model, AgentsRoom's persist-first and
`read / accepted / replied` as three distinct facts.

A **task** is a thread whose root message has `intent = "task"`. Messages
gain `intent: task | ask | reply | done | handoff | status | chat` and an
optional `taskId`. Task state lives on the row:
`open → working → waiting(askId) → done | failed | cancelled`.

### Tool surface

A `taut` **stdio MCP server** is injected into every runtime, mirrored 1:1 by
a `taut` CLI (plus `taut describe`, which prints the schema, so a runtime
without MCP still works). Tools:

| tool                                                        | does                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `taut_roster()`                                             | department members, runtime kind, presence, unread count                                                                                                                                                                                                         |
| `taut_send(to, text, refs?, attachments?)`                  | post in the current task thread; body capped ~2 KB, `refs` are file paths / message seqs — coordination, not content; `attachments` are up to 10 paths inside the home (machine-absolute or home-relative) copied into the blob store and shown inline to humans |
| `taut_inbox(since_seq?, ack?)`                              | unread messages for this agent, returned as a batch replayed until acked                                                                                                                                                                                         |
| `taut_ask(to, question, options?)`                          | `intent=ask` in the thread; sets state `waiting`; see below                                                                                                                                                                                                      |
| `taut_done(outcome, summary, files_changed?, attachments?)` | exactly once per task; finalizes the thread and fires the notification; `attachments` ride on the reply like `taut_send`'s                                                                                                                                       |
| `taut_handoff(to, spec, refs)`                              | child task thread assigned to `to`, linked by `parentTaskId`; the child's `taut_done` posts back into the parent                                                                                                                                                 |
| `memory.*`                                                  | §10 — same server, same token                                                                                                                                                                                                                                    |
| `vault_list()`                                              | §3 — company items + this agent's own, metadata only (`id, kind, label, hint, scope, lastUsedAt`)                                                                                                                                                                |
| `vault_get(vaultItemId)`                                    | §3 — plaintext for the agent's own process; audited (`tool`); 403 on another agent's item, 404 unknown, 409 when the task is no longer running; the value is redacted from chat/logs                                                                             |
| `vault_add(kind, label, secret)`                            | §3 — stores a secret in **this agent's own** vault; there is no scope argument, so a company item cannot be created; audited (`agent_add`)                                                                                                                       |
| `vault_update(vaultItemId, label?, secret?)`                | §3 — re-labels / re-keys one of the agent's own items; 403 on a company item or another agent's; audited (`agent_update`)                                                                                                                                        |
| `vault_delete(vaultItemId)`                                 | §3 — deletes one of the agent's own items; 403 on a company item, another agent's, or one that still backs a subscription; audited (`agent_revoke`)                                                                                                              |

**Per-task credentials.** At task start Taut mints `TAUT_TOKEN` bound to
`(agentId, taskId, departmentId)` with a short TTL and exports `TAUT_URL`,
`TAUT_TASK_ID`, `TAUT_THREAD_ID`. **The sender is never an argument** — the
server stamps `from` off the token, and rejects lifecycle calls whose
`task_id` doesn't match, so a stale retry can't complete the current attempt.

### Routing — enforced server-side, not by prompt

| from → to                           | rule                                                                                                                                                                                                                                         |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| agent → its department head (human) | always allowed; the default when `to` is omitted. It lands in the conversation the person is already in — their DM with the agent, or the message that started this task — and otherwise in that DM wherever the agent happens to be working |
| agent → agent, same department      | allowed **anywhere**: this channel when both are members, otherwise the DM between the two of them. Nothing inside a department is gated                                                                                                     |
| agent → anything, other department  | **`403 cross_department` — a hard boundary.** No gate, no approval flow, nothing to retry. Also refused before posting when the _body_ `@`-mentions a foreign agent, and such a message never appears in that agent's `taut_inbox`           |
| any → a thread an agent opened      | the agent whose message is the thread root is woken by every reply, `@`-mention or not — it asked the question, it has to hear the answer. Implicit, so a cross-department replier is dropped silently instead of filed as a handover        |
| agent → agent, DM                   | allowed inside the department. `taut_send(to: "@handle")` from a conversation the teammate is not in opens the two agents' own DM and posts there; a human's DM is never joined for it                                                       |

**Replies wake on the finished message, not the placeholder.** Every agent task
opens its answer as an empty `streaming` row and fills it in delta by delta.
Dispatching that row woke the thread's opener with a blank trigger: the agent
saw `[dm] @clarifier:` with nothing after it and asked its question again
instead of reading the answer. The scheduler therefore ignores `streaming`
rows and dispatches an agent reply on `message.updated`, once it is `sent`.
The woken agent is also told, in its prompt, that this is the answer to a
question it asked and that it must `taut_send` it on if it asked for someone
else — the errand that made it ask lives in another thread, which this session
cannot see.

**The answer lands in the thread that asked.** A send to a person resolves to
the errand's own thread first: the nearest ancestor task that person triggered,
found by walking `parent_task_id`. Only when that trail is gone does the send
fall back to the top of their DM. Without it the answer arrived as a loose
top-level message while the thread the person was watching stayed silent.

**Why the answer goes to the DM.** "Go ask him and come back to me" is one
errand across three conversations: the person asks in a DM, the agent asks a
colleague in a channel, and the colleague's reply wakes the agent _there_. If a
send to a person always posted where the agent stood, the answer would land
under the colleague's reply, in a thread the person never opens. So a send to a
person follows the person: here when they are in this conversation, their DM
when they are not.

**One boundary, not three.** This rule was narrowed twice and both narrowings
were wrong. First same-department agents could only reach each other inside a
task thread, so an ordinary top-level post in the shared channel drew a refusal
meant for the department boundary. Then the DM ban survived on its own, and it
failed the plainest errand there is: a head DMs an agent, says "go ask her and
come back to me", and the agent answers that it is structurally impossible.
Each refusal also taught the agent, in its own words in its own history, that
the thing was forbidden — so it stopped trying and started narrating the block
instead of doing the work.

The department is the whole boundary. Inside it agents talk freely, publicly in
a channel or privately in a DM of their own. Across it nothing passes, with no
gate to ask for. There is no third rule about shape or place.

The department is the unit of agent autonomy. Anything that has to cross one is
the **head's** job: the agent tells its own head (`taut_send` / `taut_ask` with
`to` omitted), the head talks to the other head, and the other head assigns the
work in their own department. Two consequences worth stating plainly: a runaway
agent's blast radius is one department, and every cross-department decision has
a named human on both sides instead of an approval click.

**Handovers — the head's queue.** A refused attempt is not only a dead end: the
server records it as a `handover` addressed to the **sending agent's own head**
(`services/handovers.ts`, table `handovers`), carrying what the agent tried to
say, where, and which department it aimed at. `/handovers` in the web shell is
that queue — the sidebar entry appears only when a row is open — and the head
has exactly two moves:

| action                    | what it does                                                                                                                                   |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| **Raise with @otherhead** | DMs the other department's head **as the head who clicked**, with the agent's words quoted (or a note they wrote); marks the handover `raised` |
| **Dismiss**               | closes it silently, `dismissed`                                                                                                                |

Neither unblocks the agent. Whatever happens next is the other head assigning
work inside their own department, which is the point: the boundary holds and a
human owns each side. Repeat attempts collapse onto the first `open` row for the
same (from, to, thread), so a looping agent cannot flood its head; only that
head and admins can see or resolve a row.

### Ask / park / resume

Nobody who blocked the _agent turn_ kept it — postal-mcp's infinite poll was
abandoned, agent-inbox cancelled its wait tool after measuring client caps,
AgentsRoom refuses to ship one (research/agent-orchestration.md §4). So:

1. `taut_ask` long-polls **≤ 45 s** (per-runtime ceiling below the client's
   tool-call cap) and returns `{answer}` or `{pending, askId}`.
2. On `pending` the preamble tells the agent to end its turn. Taut **parks**
   the task: `state=waiting`, the process exits, no tokens burn.
3. When the reply lands, Taut **resumes the runtime session** with the answer
   as the prompt — `claude -p --resume <sid>`, `codex exec resume <sid>`,
   `opencode run --session <id>`; Cursor has no resume, so it gets a fresh
   prompt containing the thread transcript.

Inbound messages are **never injected into a working agent** (the PTY-injection
failure class) and never delivered while it waits on its human ("writing into
that prompt would answer in your place"). They queue and come back on the next
`taut_inbox`, which the preamble requires at checkpoints and immediately before
`taut_done`. Inbound to an _idle_ agent = a new task spawn.

### Loop controls

- **Turn cap per task thread**: 20 agent-authored `send/ask/handoff` messages;
  the 21st returns `429 needs_gate` and posts a gate. Heads can raise it per task.
- **Handoff depth 2**: a child of a child cannot hand off again.
- **Per-pair rate limit + duplicate suppression**: N/min per `(from,to)`;
  identical bodies inside a short window are dropped and the sender told so.
- **Broadcast header**: a multi-recipient message carries "also sent to …; do
  not relay".
- Structurally: no agent DMs, no cross-department reach at all (not even
  gated), sender stamped by the server — so a loop is visible in one thread,
  bounded by one department, and killable with one `pause`.

### What a task thread looks like

```
#backend · thread "Task tsk_91: migrate sessions table"
├─ @maria (head)     intent=task   → assigned @bruno, state=open
├─ @bruno            streaming…    "Reading migrations/…"          (agent.task.delta)
├─ @bruno → @maria   intent=ask    "Drop `legacy_id` or keep nullable?" [drop|keep]  state=waiting
├─ @maria            intent=reply  "keep"                                            state=working
├─ @bruno → @ana     intent=handoff "Write the rollback script" → child tsk_92
├─ @ana              intent=done   "Rollback script in db/rollback_091.sql"  (tsk_92)
└─ @bruno            intent=done   outcome=succeeded, summary, files_changed=[…]     state=done
```

Every line is an ordinary `message.created` with a `seq`, so a head's reconnect
replays it and a future board view is `SELECT … WHERE intent='task'`.

### MCP injection per runtime

| runtime     | how                                                                                                                                                            |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| claude-code | `--mcp-config <file> --strict-mcp-config --allowedTools "mcp__taut__*"`; `-p` honours it; set `CLAUDE_AUTO_BACKGROUND_TASKS=1` for long tool calls             |
| codex       | `[mcp_servers.taut]` in `$CODEX_HOME/config.toml` with `required = true` (exec fails loudly if the server won't start)                                         |
| cursor      | `.cursor/mcp.json` + `agent -p --approve-mcps`, and `"Mcp(taut:*)"` in `permissions.allow` — otherwise it stalls headless                                      |
| opencode    | `"mcp": {"taut": {"type":"local","command":[…],"environment":{…}}}` in `opencode.json`; tools appear as `taut_<tool>`; needs `--auto` or headless auto-rejects |

With `browserAccess` the same files carry a second server keyed `browser`
(§7): `mcpServers.browser` for claude-code and cursor (plus `Mcp(browser:*)` in
`.cursor/cli.json`), `[mcp_servers.browser]` with `required = false` for codex
(a browser that fails to start must not fail the task), and `mcp.browser` for
opencode. `@taut/taut-mcp` `inject.ts` emits all of it from one `extraServers` option.

## 10. Memory

Two tiers, because the evidence splits cleanly: curated knowledge wants files

- grep, raw chat history wants an index (research/agent-memory.md §5).

**Tier 1 — `MEMORY.md`.** ≤ 200 lines / 25 KB, agent-curated, imported into
the runtime's instruction file at task start (`@memory/MEMORY.md` in
`CLAUDE.md`). This is the Claude Code / Codex / Letta pattern verbatim.

**Tier 2 — one SQLite file per agent.** Everything the agent could ever see,
at message granularity, searchable on demand.

We are **not** adopting Mem0, Zep/Graphiti, Cognee, Honcho or LangMem: they
need a second database engine or an LLM call per ingested message, and
LLM-extracted "facts" lose the verbatim recall a chat agent needs.

**Storage layout.**

```
/data/companies/<slug>/agents/<handle>/memory/
├── memory.db        # items, items_fts (FTS5), meta(last_seq, model, dims); items_vec later
├── MEMORY.md        # tier 1
├── notes/           # agent-authored markdown, one topic per file
└── files/           # attachments it was handed, text-extracted
```

`items(id, kind[message|thread_summary|task_result|file|note], channel_id,
thread_id, author_id, author_kind, at, text, meta_json)`; `items_fts` is an
FTS5 external-content table over `text` (porter + unicode61), kept in sync by
triggers.

**Ingestion.** A per-agent consumer reads the company event log from `meta.last_seq`:

- **Fan-out by visibility**: every `message.created` is written to the DB of
  every agent that _can see it_ — channel members (agents included), DM
  recipient, thread participants. Also `agent.task.done` summaries
  (`kind=task_result`) and inbox files (`kind=file`).
- **One message = one row.** Long messages and files chunk at ~400 tokens
  with 50 overlap.
- **Contextual prefix, no LLM**: `[#channel][author][YYYY-MM-DD][thread: …]`
  is indexed alongside the text. Cheap contextual retrieval.
- Idempotent on `message_id`; `last_seq` commits in the same transaction. If
  `last_seq` predates the 7-day log, rescan `messages` by `seq`.
- `message.updated` → **replace** the row. `message.deleted` → **hard delete**
  from every recipient's DB, so a retracted message cannot be recalled. Notes
  are never touched by ingestion.

**Retrieval — MVP:** FTS5 `bm25()` with filters (channel, author, since/until, kind) →
recency tiebreak (`0.995^days`, weight 0.1) → top-10. That alone reproduces
the "files + grep" result that beat Mem0 on LoCoMo.

**Later:** BM25 top-50 ∪ dense KNN top-50 → **RRF (k=60)** → optional local
cross-encoder rerank of the top-30 → recency tiebreak. Hybrid + rerank is the
biggest measured win (−49% and −67% failures respectively).

**Embeddings, later:** sqlite-vec `vec0`, default local `bge-small-en-v1.5`
(q8 ONNX, 384d, MIT). Upgrade path: a `voyage.api_key` vault item switches to
`voyage-4-lite` + `rerank-2.5-lite`. Model and dims are recorded in `meta`;
changing them triggers a background re-embed. Never OpenAI by default.

**Tool surface.** Same `taut` MCP server as §9, same token.

```ts
memory.search(query, { channel?, author?, since?, until?, kind?, limit = 10 })
memory.grep(pattern, { since?, channel? })          // exact strings: ticket ids, URLs
memory.recall_thread(threadId | messageId, { before = 20, after = 20 })
memory.timeline(since, until, { channel? })
memory.note(title, body, { tags })                  // writes notes/<slug>.md, indexes it
notes.list() / notes.get(id) / forget(noteId)       // only notes are agent-deletable
```

**Isolation by construction.** The DB path is never a parameter — the task
token resolves to exactly one `memory.db` file, so there is no `WHERE agent_id`
to forget and cross-agent search is impossible. Memory lives in the API
process; the container user cannot read `/data`. Note paths are validated to
stay under `notes/`. Every call is audited to `.taut/audit.log`. Deleting an
agent deletes its folder.

**The cut.**

| MVP                                                                        | later                                                |
| -------------------------------------------------------------------------- | ---------------------------------------------------- |
| `memory.db` with FTS5 only                                                 | sqlite-vec + dense + RRF                             |
| BM25 + filters + recency                                                   | cross-encoder rerank; Voyage key upgrade             |
| `search`, `grep`, `recall_thread`, `timeline`, `note`, `notes.*`, `forget` | nightly thread summaries + `MEMORY.md` consolidation |
| `MEMORY.md` imported at task start                                         | file text extraction; memory UI in the web client    |
| event-log consumer, fan-out, edit/delete                                   | LanceDB tier past ~1M chunks per agent               |

## 11. Message → task

```
@bruno review PR #42
   │
   ▼  router: mention → Agent; pick skill by description (or none)
   ▼  task = { companyId, agentId, departmentId, channelId, threadId, prompt, skill? }
   ▼  machines.ensure(agent) → start() if stopped
   ▼  adapter.materialize()  → work/tsk_…/
   ▼  vault.resolveForSpawn(sub.credentialId, agentId)   → env, per exec only
   ▼  mint TAUT_TOKEN; write the MCP config (§9)
   ▼  machine.exec(adapter.buildCommand()) → parseLine → redactor → stream into thread
   ▼  vault_get → vault.resolveForTool → redactor.add(value) → response   (mid-task, any number of times)
   ▼  taut_done → post summary, finalize, wipe temp secrets
```

Redactor: one per task, owned by the `TaskRunner` for as long as the task runs.
It holds the plaintext of every secret resolved for the task — the seat's
credential at spawn, every `vault_get` value as it is fetched — and replaces
any occurrence (raw, base64, URL-encoded, JSON-escaped) with `••••<hint>`
before it reaches the UI, the DB or memory.

## 12. DB tables (SQLite)

```
users             (id, email, password_hash, name, avatar_json, created_at)
sessions          (id, user_id, expires_at)
companies         (id, slug, name, avatar_json, created_at)
memberships       (company_id, user_id, role)                          -- owner|admin|member
invites           (id, company_id, email, role, token, invited_by, expires_at, accepted_at)
departments       (id, company_id, name, slug, head_user_id, created_at)      -- §2
department_members(department_id, member_kind, member_id)                     -- §2
channels          (id, company_id, department_id, name, kind, created_at)     -- dm ⇒ department_id NULL
channel_members   (channel_id, member_kind, member_id, last_read_seq)         -- §8 unread
messages          (id, company_id, channel_id, thread_id, task_id, intent,
                   author_kind, author_id, body, status, created_at, edited_at) -- §9 intent
tasks             (id, company_id, agent_id, department_id, channel_id, thread_id, message_id,
                   parent_task_id, subscription_id, state, turn_count, ask_id,
                   started_at, ended_at, error)                               -- §9
vault_items       (id, company_id, agent_id, kind, label, ciphertext, hint, created_at, last_used_at, last_used_by)
                                                                       -- §3 agent_id NULL = company item; FK agents ON DELETE CASCADE
subscriptions     (id, company_id, runtime, label, credential_id, default_model, status,
                   last_checked_at, weight, cooldown_until, tasks_today)      -- §4 pool
agents            (id, company_id, department_id, handle, name, avatar_json, role, mandate,
                   runtime_json, machine_json, browser_access, status, created_at, updated_at) -- §7 browser_access 0/1
agent_skills      (agent_id, name, description)
agent_file_grants (agent_id, path, mode)                               -- ro|rw, §5
agent_memory      (agent_id, last_seq, embedding_model, dims, updated_at)     -- §10 cursor
machines          (agent_id, provider, external_id, state, last_started_at)   -- §7
events            (seq, company_id, at, type, payload_json)            -- §8
notifications     (id, company_id, user_id, event_seq, kind, read_at)  -- §8
message_reactions (message_id, company_id, member_kind, member_id, emoji, created_at)
                                                                       -- PK (message_id, member_kind, member_id, emoji); docs/build-plan-message-actions.md
attachments       (id, company_id, channel_id, message_id, uploader_kind, uploader_id,
                   name, mime_type, size, created_at)                  -- message_id NULL = orphan upload;
                                                                       -- bytes at companies/<slug>/attachments/<id>
audit_log         (id, company_id, agent_id, task_id, vault_item_id, purpose, at)
```

`UNIQUE(company_id, handle)` on agents; `UNIQUE(department_id)` is _not_ on
`head_user_id` (one human may head several departments, but a department has
exactly one head). Subscriptions are not unique per runtime — they form a pool
(§4). The memory cursor of record is `meta.last_seq` inside each agent's
`memory.db`; `agent_memory` mirrors it for scheduling and observability.

## 13. Open

- **Egress policy.** MVP is a per-company bridge with allow-all egress;
  `network.egress.allowDomains` is specced but unimplemented, no DNS filtering.
- **Credential proxy.** Secrets still sit in the container env for the length of
  an exec. The fix is a host-side proxy injecting auth headers so the raw value
  never enters the machine (Docker Sandboxes' model). Not MVP.
- **Idle policy.** How long before `docker stop`, and whether stopping a
  parked task's box is safe.
- **Ask ceilings.** 45 s comes from Claude Code and Cursor caps; Codex and
  OpenCode tool-call timeouts are unmeasured.
- **Parking non-Claude runtimes.** OpenCode's session state is SQLite and Cursor
  has no resume; the transcript-replay fallback is untested.
- **Handover reach.** The head's queue is a page (`/handovers`) refreshed on
  visit: there is no realtime badge and no notification of its own — the head
  learns about a handover from the note in the thread. Whether it should also
  push (and whether an agent may ever address a handover to a head who is not
  its own) is open.
- **Memory flip.** When embeddings become the default, and how to migrate an
  index when `embedding_model` changes.
- **Company switching.** Off in MVP; schema keeps `company_id` so it turns on
  without a migration. **Multi-node** likewise: the `Bus` interface allows
  Redis/NATS and Postgres, nobody has needed it.
