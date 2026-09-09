# Build plan — overnight MVP

Read `docs/agent-model.md` first. This file is the engineering contract every
implementation agent follows. If this file and your instincts disagree, this
file wins; if this file is silent, do the simplest thing and leave a `// TODO(plan):` comment.

## Stack (decided)

| Layer    | Choice                                                                                          |
| -------- | ----------------------------------------------------------------------------------------------- |
| Language | TypeScript 5.9, strict, ESM everywhere. Node ≥ 22.                                              |
| Core     | **Effect** (`effect`) is mandatory wherever it fits: services, errors, schema, streams, config. |
| HTTP     | `@effect/platform` `HttpApi` + `@effect/platform-node` `NodeHttpServer`. One API, typed client. |
| DB       | SQLite via `@effect/sql` + `@effect/sql-sqlite-node`. Migrations via `@effect/sql` `Migrator`.  |
| Realtime | `ws` on the same HTTP server, bridged into Effect (`Queue`/`Stream`). Seq-based resume.         |
| Web      | React 19 + Vite + Tailwind 4 + shadcn (`@taut/ui`). TanStack Router + TanStack Query.           |
| Client   | `HttpApiClient` derived from the shared `HttpApi` — no hand-written fetch.                      |
| Auth     | Email + password (`node:crypto` scrypt), httpOnly session cookie, invite tokens. No 3rd-party.  |
| Crypto   | Vault: AES-256-GCM, key = HKDF(TAUT_MASTER_KEY, info=companyId). `node:crypto` only.            |
| Runtime  | `MachineProvider` interface. MVP providers: `local` (spawn on host) and `docker` (dockerode).   |
| Tests    | `vitest` + `@effect/vitest`. Every service gets at least one test.                              |
| Lint/fmt | Existing `@taut/eslint-config`, prettier.                                                       |

Package manager is pnpm workspaces + turbo (already set up). Use `pnpm add` in
the right workspace; always install the **latest** `effect` / `@effect/*` and
pin exact versions across packages (they must match).

## Repo layout

```
packages/
  contract/        @taut/contract  — Effect Schema domain types, branded ids, errors, HttpApi groups
  ui/              @taut/ui        — shadcn components (exists)
  runtime/         @taut/runtime   — MachineProvider, providers (local, docker), runtime adapters, NDJSON parsers
apps/
  server/          @taut/server    — Effect app: sql, migrations, auth, services, HttpApi impl, ws, scheduler
  web/             @taut/web       — React SPA, served by server in prod, Vite dev server in dev (proxy /api,/ws)
  desktop/         (exists; untouched tonight)
docs/
  agent-model.md   product/data model
  build-plan.md    this file
  build-plan-browser-vaults.md   extension: per-agent browser access (Playwright MCP) + two vault scopes (company / agent)
  research/        cited research
Dockerfile, docker-compose.yml at root
```

## Effect conventions

- Services: `class Foo extends Effect.Service<Foo>()("Foo", { effect: …, dependencies: […] }) {}`.
- Errors: `class NotFound extends Schema.TaggedError<NotFound>()("NotFound", { … }) {}` in `@taut/contract`; HttpApi endpoints declare them with `.addError()`.
- Ids: `Schema.String.pipe(Schema.brand("CompanyId"))` etc. Prefix ids: `cmp_ usr_ dep_ chn_ msg_ agt_ vlt_ sub_ inv_ tsk_`. Generate with `crypto.randomUUID()` → base62-ish or just `${prefix}_${uuid}`.
- Config: `Config.string("TAUT_MASTER_KEY")` etc. via `Config`/`ConfigProvider`; never `process.env` outside `config.ts`.
- SQL: `SqlClient` tagged templates; `SqlSchema.findAll/findOne/single` with Schema decoding. No ORM.
- Streams for WS and for agent output. `Scope`d resources for child processes.
- Web: React stays React. Use Effect for the API client, Schema decoding, and any non-trivial async. `ManagedRuntime` once, at app root.
- No `any`. No `as unknown as`. `noUncheckedIndexedAccess` is on.

## Domain (authoritative summary; details in agent-model.md)

```
User            (id, email, passwordHash, name, avatar, createdAt)
Session         (id, userId, expiresAt)
Company         (id, slug, name, avatar, createdAt)
Membership      (companyId, userId, role: owner|admin|member)
Invite          (id, companyId, email, role, token, invitedBy, expiresAt, acceptedAt?)
Department      (id, companyId, name, slug, headUserId, createdAt)
DepartmentMember(departmentId, memberKind: user|agent, memberId)
Channel         (id, companyId, departmentId?, name, kind: channel|dm, createdAt)   -- dm: departmentId null
ChannelMember   (channelId, memberKind: user|agent, memberId, lastReadSeq)
Message         (id, companyId, channelId, threadId?, authorKind: user|agent, authorId, body, status: sent|streaming|failed, createdAt, editedAt?)
Event           (seq, companyId, at, type, payload)                      -- append-only, per company
Notification    (id, companyId, userId, eventSeq, kind, readAt?)
VaultItem       (id, companyId, kind, label, ciphertext, hint, createdAt, lastUsedAt?, lastUsedBy?)
Subscription    (id, companyId, runtime, label, credentialId, defaultModel?, status, weight, cooldownUntil?, tasksToday, lastCheckedAt?)
Agent           (id, companyId, handle, name, avatar, role, mandate, runtimeKind, pinnedSubscriptionId?, model?, permissionMode, status, createdAt, updatedAt)
AgentSkill      (agentId, name, description)              -- body on disk
AgentFileGrant  (agentId, path, mode: ro|rw)              -- paths outside its home it may touch
AgentVaultGrant (agentId, vaultItemId)                    -- items it may resolve at runtime
Task            (id, companyId, agentId, channelId, threadId, messageId, subscriptionId?, status, startedAt, endedAt?, error?)
AuditLog        (id, companyId, agentId?, taskId?, vaultItemId?, purpose, at)
```

Authorization rules (enforce in services, not routes):

- Company `owner|admin`: everything in the company. `member`: read channels they belong to, post, DM.
- Department `headUserId`: manage that department's members, channels, agents. Heads are humans.
- Agents: post only to channels they are members of; resolve only granted vault items; write only inside home + `rw` grants.
- Every query is scoped by `companyId` from the session's active company. No cross-company reads, ever.

## HTTP API (groups in `@taut/contract`)

`/api/auth` signup, login, logout, me
`/api/invites` create, list, accept(token), revoke
`/api/companies` create, list(mine), get, switch(active), members, setRole
`/api/departments` crud, addMember, removeMember, setHead
`/api/channels` crud, members, dm(open with user|agent), markRead
`/api/messages` list(channelId, before, limit), create, edit, delete, thread(threadId)
`/api/vault` list(meta), add, revoke
`/api/subscriptions` list, add, remove, setWeight, check(detect)
`/api/agents` crud, skills(put/delete), files(list/upload/grant), vaultGrants, memory(search — later)
`/api/tasks` list, get, cancel
`ws /ws?since=<seq>` server → client Event stream; client → server: typing, ping

All write endpoints return the created/updated entity. All list endpoints return `{ items, nextCursor? }`.

## Realtime

Every mutation calls `EventLog.append(companyId, type, payload)` inside the same
transaction as the write. `Bus` fans out to sockets subscribed to that company.
Socket connect: authenticate via cookie, read `?since=`, replay from `events`
where `seq > since`, then live. Client keeps `lastSeq` in memory + localStorage.

## PWA + Web Push

The web client is installable and can notify a phone when a message arrives.

**Install.** `vite-plugin-pwa` (`injectManifest`) emits `manifest.webmanifest` and
precaches the built shell; `apps/web/src/sw.ts` is ours and owns the push handlers.
The server serves `dist/` at `/`, so scope is `/` and the SW controls the whole app.
iOS/iPadOS only expose the Push API to an app added to the Home Screen, so the
"turn on notifications" control explains that instead of failing.

**Push.** `PushNotifier` subscribes to `Bus.streamAll()` and turns every `notification`
event into a Web Push message (RFC 8291 aes128gcm, RFC 8292 VAPID) addressed to each
`push_devices` row of that user. Payload is `{ title, body, tag, url }` — self-contained,
because the service worker runs with the app closed and has no session. A 404/410 from
the push service deletes the row; nothing else does.

**Config.** `TAUT_VAPID_PUBLIC_KEY` / `TAUT_VAPID_PRIVATE_KEY` (+ `TAUT_VAPID_SUBJECT`).
Unset, or invalid, and push disables itself with a log line — the server still boots.
Endpoints are user-scoped, not company-scoped: a phone follows its user.

## Agent execution (P1)

`@taut/runtime`:

```ts
interface MachineProvider {
  ensure(agent): Effect<Machine>
  get(id)
  destroy(id)
}
interface Machine {
  exec(cmd: string[], opts: { env; cwd; stdin?; onLine(line) }): Effect<ExitCode>
  putFile
  getFile
}
interface RuntimeAdapter {
  kind
  detect(machine)
  buildCommand(task, opts): { cmd; env }
  parseLine(line): AgentEvent | null
}
```

`local` provider = spawn on host with cwd = agent home. `docker` provider = one container per agent, bind-mount home, `docker exec -e` per task.
Claude Code adapter: `claude -p <prompt> --output-format stream-json --verbose [--resume <sid>] --mcp-config … --allowedTools "mcp__taut__*"`. Secrets from `Vault.resolveForSpawn`. Redact secrets from every line before it becomes an event.

Flow: message.created with @agent mention → Scheduler creates Task + a `streaming` message → picks Subscription (pool rules in agent-model §3) → exec → `agent.task.delta` appends to the message → `done` finalizes → notification to the human who mentioned.

## Dev experience

- `pnpm dev` → turbo runs server (tsx watch, :3000) and web (vite, :5173, proxies `/api` and `/ws` to :3000).
- `pnpm typecheck`, `pnpm test`, `pnpm lint` all green before any phase is "done".
- First boot with no users: `/signup` creates the user, then `/onboarding` creates the first company (user = owner).
- `.env.example` documents `TAUT_MASTER_KEY`, `TAUT_DATA_DIR` (default `./data`), `PORT`.
- Seed script `pnpm --filter @taut/server seed` creates a demo company, 2 departments, 3 agents, sample channels.

## Definition of done per phase

1. `pnpm typecheck && pnpm test && pnpm lint` pass from repo root.
2. The phase's endpoints are exercised by at least one vitest test against a temp SQLite file.
3. The UI for the phase is reachable from the sidebar and works against the real server (no mocks).
4. A 5-line note appended to `docs/CHANGELOG.md` saying what now works and how to try it.
