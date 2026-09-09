# Changelog

Append-only. Each entry: what now works and how to try it.

## Status for the morning

**Start:** `pnpm install && pnpm dev` → http://localhost:5173 → `/signup` → `/onboarding`. Or `pnpm --filter @taut/server seed` for `owner@taut.local` / `password123`.
Agents answer for real with `TAUT_DEV_HOST_LOGIN=true pnpm dev` (your own `claude` login). `pnpm e2e` proves the whole path on a throwaway data dir: **44/44 PASS** on this Mac (2026-09-08 16:25: bruno `pong`, agent-vault `vault_get` → `41` with the value nowhere, vera reading `/api/health` through headless Chromium, bruno reading a red PNG from `inbox/` and answering `red`, bruno sending `hello.txt` back through `taut_send` attachments).

**Click first (the eight things you asked for):** 1 create the company on `/onboarding` (one per instance; `TAUT_MULTI_COMPANY=true` allows more) · 2 `/subscriptions` → Connect: several seats per runtime, weight / drain / cooldown / check · 3 sidebar “+” next to a department → channels; `/departments/<id>/settings` for members · 4 ⌘K → pick an agent → DM it · 5 `/agents/new` (handle, department, runtime, mandate, **Browser access** switch) then tabs Skills (now loads the body before you edit) · Files (browse home, upload to `inbox/`, path grants) · **Agent vault** (that agent's private secrets; visible to admins and its department head) · 6 `/vault` → Add secret (company scope: every agent may `vault_get` it); seat credentials resolve automatically at spawn · 7 `/departments/<id>/settings` → set head (humans only); the head can create/manage that department's agents, their vault items and their browser switch · 8 `/members` → Invite → copy `/invite/<token>`, open it logged out; roles editable inline. · 9 DM an agent “use vault_list then vault_get on <label> and reply with its length” — the reply has the number, never the value (see "Browser access + agent vaults" at the end; **set the agent to `auto-edit`, plan mode blocks every MCP tool on claude-code 2.1.263**). · 10 ⌘K → type two letters: **Messages** (full-text, snippets, click → the channel scrolls to and flashes the message), **Agent notes** (admins/heads), **Ask @agent what we said about …** (DMs the agent a memory question) — see "Search" at the end. · 11 `/agents/<id>` → **Routines** tab → New routine: pick Weekly → Weekdays, or Monthly → **Odd**, add a time, watch the "Next:" preview — the agent gets the prompt on that schedule in your DM (see "Routines" at the end). · 11 hover any message → **✅ 👀 🙌**, `+` picker, forward, ⋮ copy link — see "Message actions" at the end. · 12 **attach a file or image in any composer** (paperclip, drop onto the box, or paste a screenshot) — then DM an agent a screenshot and ask what it shows, or ask it to send you a file back (see "Attachments" at the end).

**Verified live tonight (curl, no browser):** signup → company → department → invite → accept as new user → set head → vault → subscription → agent + skill (`getSkill` round-trip) → DM → agent reply `pong` (host login); Vite proxy: `/signup` serves the SPA, `/api/auth/me` 401 before login, `/api/health` ok; built server (`node apps/server/dist/main.js`) serves the SPA at `/` with fallback. **Verified only by tests:** rate-limit/auth-failure rotation, cancel, memory ingest, agent-runtime API routing, docker provider (opt-in suite), Codex/Cursor/OpenCode adapters. **Not verified at all:** rendering/interaction in a browser (the Claude-in-Chrome extension timed out on its single attempt, again).

**Known gaps, ranked:** (0) ~~claude-code `plan` mode refuses every MCP tool~~ **fixed**: the adapter now maps Taut's `plan` to `--permission-mode default` + `--allowedTools mcp__taut__* [mcp__browser__*] Read Glob Grep` (`packages/runtime/src/adapters/claudeCode.ts`, `PLAN_MODE_BUILTIN_TOOLS`); headless `-p` denies everything else, so `plan` stays read-only but keeps the chat, vault and browser tools · (1) no browser pass — UI bugs may exist that curl can't see · (2) a seat with an invalid API key makes `claude` retry ~3 min before it is marked `auth-failed`; `subscriptions.check` is binary detection only · (3) `taut_ask` doesn't park the task (cross-department messaging is now a deliberate hard block, not a gap) · (4) docker: the `taut/agent` image with Playwright + `/opt/taut/mcp.js` is written but **unbuilt and unrun**; idle-stop and egress allow-lists unenforced · (5) `vault.revoke` doesn't kill running tasks · (6) `/settings/company` is read-only in the UI although `companies.update` exists; `/invite/:token` doesn't use `invites.preview` yet · (7) Vite binds `[::1]:5173` here — use `localhost`, not `127.0.0.1` · (8) browser access verified for real on the `local` provider (`pnpm e2e` 34/34, 2026-09-08 14:30: vera opened `/api/health` through Playwright MCP and replied with the version); the local provider needs `PWTEST_SOCKETS_DIR` (set by the server) because its child `TMPDIR` lives inside the agent home; docker image unbuilt, codex/cursor/opencode MCP wiring config-only.

**Needs you:** approve the Claude-in-Chrome permission prompt (or run a browser pass by hand) · Docker proxy slowness on this machine (image builds took minutes) · choose a license (`TODO(owner)` in README) · decide whether to commit — everything is still untracked, `.gitignore` covers `data/`, `dist`, `node_modules`, `*.db*`, `master.key`, `.env*`.

## `@taut/contract` — shared domain types + HTTP API (Effect)

**Pinned versions — every other package must use exactly these** (`pnpm add --save-exact`):

| package            | version  | note                                                                          |
| ------------------ | -------- | ----------------------------------------------------------------------------- |
| `effect`           | `3.22.1` | `latest` on the registry; 4.x is still `rc` and was not used                  |
| `@effect/platform` | `0.97.1` | peers `effect ^3.22.1`                                                        |
| `@effect/vitest`   | `0.30.0` | dev; peers `vitest ^3.2.0`                                                    |
| `vitest`           | `3.2.7`  | dev; the `V3` dist-tag. **Do not use vitest 5** — `@effect/vitest` peers on 3 |
| `@types/node`      | `26.5.0` | dev; only for the `globalThis.crypto` typing in `ids.ts`                      |

**Export map** (all source, ESM, `"type": "module"` — consumers import `.ts` directly, no build step):

| specifier               | contents                                                                                                                                                                                                    |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@taut/contract`        | everything below                                                                                                                                                                                            |
| `@taut/contract/ids`    | branded ids (`CompanyId` … `NotificationId`), `MemberId`, `EventSeq`, `makeId(prefix)`, `new*Id()`                                                                                                          |
| `@taut/contract/domain` | `Schema.Class` entities (`User`, `Company`, `Message`, `Agent`, `Task`, `VaultItemMeta` …), literal unions (`MembershipRole`, `RuntimeKind` …), `Avatar`, `RuntimeCredentialKinds`, `Slug`/`Handle`/`Email` |
| `@taut/contract/errors` | `Unauthorized 401`, `Forbidden 403`, `NotFound 404`, `Conflict 409`, `Validation 422`, `RateLimited 429`, `VaultLocked 423`, `RuntimeUnavailable 503`, `TautError` union                                    |
| `@taut/contract/events` | `Event` discriminated union (24 types), `EventType`, `EventBody`, `EventPayload<T>`, `EphemeralEventTypes`, `ClientSocketMessage`/`ServerSocketMessage` for `/ws`                                           |
| `@taut/contract/api`    | `TautApi` (prefix `/api`), one group per build-plan line, `Authentication` middleware tag, `CurrentUser` tag, `SESSION_COOKIE`, `Page(schema)`, all payload/query schemas                                   |

Design notes:

- Dates are `Schema.DateTimeUtc` everywhere: `DateTime.Utc` in memory, ISO string on the wire.
- Public `User` has no `passwordHash`; public vault item is `VaultItemMeta` (no ciphertext). Internal row shapes belong to the server.
- `Authentication` is `HttpApiMiddleware.Tag` with `security: { session: apiKey({ in: 'cookie', key: 'taut_session' }) }`, `failure: Unauthorized`, `provides: CurrentUser` (`{ userId, activeCompanyId?, role? }`). Applied at group level everywhere except `auth` and `invites`, where it is per-endpoint so `auth.signup/login/logout` and `invites.accept` stay public.
- `Validation` is 422 (semantic), distinct from the platform's `HttpApiDecodeError` 400 (shape).
- `vault.add` takes `secret: Schema.Redacted(String)` — it decodes to `Redacted<string>` and never prints.
- `agents.uploadFile` is `HttpApiSchema.Multipart({ path, file: Multipart.SingleFileSchema })`.
- `agents.memory` is deferred (`// TODO(plan)` in `src/api/agents.ts`).

**Server: implementing one group** (`apps/server`):

```ts
import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { Authentication, CurrentUser, NotFound, TautApi } from '@taut/contract'

export const TasksLive = HttpApiBuilder.group(TautApi, 'tasks', (handlers) =>
  handlers
    .handle('list', ({ urlParams }) =>
      CurrentUser.pipe(Effect.flatMap((me) => TaskRepo.list(me.activeCompanyId, urlParams)))
    )
    .handle('get', ({ path }) => TaskRepo.get(path.taskId)) // fails with NotFound
    .handle('cancel', ({ path }) => Scheduler.cancel(path.taskId))
)
// AuthenticationLive = Layer.effect(Authentication, Effect.gen(function* () { … return { session: (cookie) => lookupSession(cookie) } }))
// ApiLive = HttpApiBuilder.api(TautApi).pipe(Layer.provide([TasksLive, …, AuthenticationLive]))
```

**Web: deriving the client** (`apps/web`):

```ts
import { FetchHttpClient, HttpApiClient } from '@effect/platform'
import { Effect } from 'effect'
import { TautApi } from '@taut/contract'

const program = Effect.gen(function* () {
  const api = yield* HttpApiClient.make(TautApi, { baseUrl: window.location.origin })
  const { items } = yield* api.messages.list({ urlParams: { channelId, limit: 50 } })
  return items // Message[] — decoded, dates are DateTime.Utc; errors are typed (NotFound | Forbidden | Unauthorized …)
}).pipe(Effect.provide(FetchHttpClient.layer)) // cookies ride along on same-origin fetch
```

Try it: `pnpm --filter @taut/contract typecheck && pnpm --filter @taut/contract test`.

## `@taut/web` — SPA shell (React 19 + Vite + TanStack Router/Query + Effect)

Slack-like shell with every route, layout and form in place. No API calls yet:
every hook returns typed stub data and every form fires a `notImplemented()` toast.

Try it: `pnpm --filter @taut/web dev` → http://localhost:5173 (proxies `/api` and
`/ws` → `http://localhost:3000`). Gates: `pnpm --filter @taut/web typecheck && … lint && … build`.

**Pinned `effect` version: `3.22.1`** (exact, matches `@taut/contract`). Web adds no
`@effect/*` package yet — `@effect/platform` `0.97.1` arrives with the API client.

### Route tree

```
__root                              TooltipProvider + Toaster + not-found
├── _app                            authenticated shell: 64px rail · 260px sidebar · main
│   ├── /                           redirect → /c/<first channel>
│   ├── /c/$channelId               message list + composer
│   ├── /dm/$channelId              same view, human or agent counterpart
│   ├── /agents                     agent cards
│   ├── /agents/new                 identity · mandate · runtime form
│   ├── /agents/$agentId            tabs: Profile · Mandate · Skills · Files · Vault access · Runtime
│   ├── /vault                      table + "add item" dialog (write-only secret)
│   ├── /subscriptions              pools grouped by runtime, status/cooldown/weight/tasksToday
│   ├── /members                    humans (role select) + agents
│   ├── /departments/$departmentId/settings   details · channels · members
│   └── /settings/company           identity · defaults · danger zone
└── _auth                           centred card layout
    ├── /login  ├── /signup  ├── /invite/$token  └── /onboarding (name + slug + emoji)
```

### Stubs a later agent must replace (all marked `// TODO(plan)`)

| file                         | name                                                                                                                                                                                                                   | replace with                                       |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `src/hooks/use-directory.ts` | `useCompanies` `useCurrentUser` `useMembers` `useDepartments` `useDepartment` `useChannels` `useDirectChannels` `useChannel` `useAgents` `useAgent` `useVaultItems` `useSubscriptions` `useMessages` `useMentionables` | `HttpApiClient.make(TautApi)` calls                |
| `src/lib/stub-data.ts`       | whole file (Acme · Engineering/Design · #general/#backend · bruno/mila)                                                                                                                                                | delete                                             |
| `src/lib/types.ts`           | whole file (local mirrors of the agent-model entities)                                                                                                                                                                 | `@taut/contract/domain` + `/ids`                   |
| `src/lib/runtime.ts`         | `AppLayer = Layer.empty`                                                                                                                                                                                               | `FetchHttpClient.layer` + api-client layer         |
| `src/lib/not-implemented.ts` | `notImplemented()`                                                                                                                                                                                                     | real mutations (`useMutation` on the typed client) |
| `src/lib/ws.ts`              | `RealtimeEvent`                                                                                                                                                                                                        | `Event` from `@taut/contract/events`               |
| `src/routes/_app.index.tsx`  | `FIRST_CHANNEL_ID` redirect                                                                                                                                                                                            | first channel of the session's active company      |
| `src/routes/_app.tsx`        | event handler body                                                                                                                                                                                                     | per-`EventType` query-cache invalidation           |

### What is real (not stubbed)

- `src/lib/runtime.ts` — one `ManagedRuntime` at module load; `useEffectQuery(key, effect)`
  bridges an Effect into TanStack Query and passes React Query's `AbortSignal` through.
- `src/lib/ws.ts` — `RealtimeClient`: `/ws?since=<lastSeq>`, exponential backoff with jitter
  (500ms → 30s), `lastSeq` in `localStorage`, `subscribe(fn)` / `onStatus(fn)` / `send(frame)`.
  Sidebar footer shows green/amber/red plus the current seq.
- Theme: `dark` class on `<html>`, pre-paint inline script, `light | dark | system` in the user dropdown.
- Composer: auto-growing textarea, Enter sends / Shift+Enter newline, `@` opens a member
  popover (arrows + Enter/Tab select, Escape closes) that inserts `@handle`.
- `MessageBubble`: `streaming` renders a pulsing caret plus a "working" pill on the agent avatar;
  `failed` renders the error with a Retry action.

### `@taut/ui` additions

`input, label, textarea, select, dialog, dropdown-menu, avatar, tabs, separator, scroll-area,
tooltip, sheet, switch, skeleton, sonner, command` plus `popover` and `collapsible` (needed by the
composer's mention picker and the sidebar's department groups). Hand-written in the existing
new-york style with the unified `radix-ui` package. New deps: `cmdk`, `sonner`.
`./components/*` export map unchanged.

## `@taut/server` — infrastructure (Effect + SQLite + HttpApi + ws)

**Pinned** (exact; `effect`/`@effect/platform`/`@effect/vitest`/`vitest` match `@taut/contract`):
`effect 3.22.1`, `@effect/platform 0.97.1`, `@effect/platform-node 0.108.1`, `@effect/sql 0.52.1`,
`@effect/sql-sqlite-node 0.53.0` (pulls `better-sqlite3`, allow-listed in `pnpm-workspace.yaml` `onlyBuiltDependencies`),
`ws 8.21.3`; dev: `@effect/vitest 0.30.0`, `vitest 3.2.7`, `tsup 8.5.1`, `tsx 4.23.13`, `@types/ws 8.18.1`.

**Run:** `pnpm --filter @taut/server dev` (tsx watch, http://localhost:3000) · `build && start` (tsup → `dist/main.js`, `@taut/contract` bundled in) ·
`test` (24 vitest tests against temp dirs) · `seed` (placeholder). Env in `/.env.example`; without `TAUT_MASTER_KEY` in dev a key is
generated at `$TAUT_DATA_DIR/master.key` (0600) with a one-line warning; `NODE_ENV=production` without it fails with a clear message.
Try: `curl localhost:3000/api/health` → `{"ok":true,"version":"0.0.0"}`;
`websocat -H 'Cookie: taut_session=usr_dev:cmp_dev' 'ws://localhost:3000/ws?since=0'` then send `{"type":"ping"}` → `{"type":"pong"}`.

**Layer graph** (`src/layers.ts`; built bottom-up, released top-down):

```
AppConfig (Config; env only here)        NodeContext (fs, path, cmd)
        └── SqliteLive  <TAUT_DATA_DIR>/taut.db, WAL, foreign_keys, busy_timeout 5s
              └── MigratorLive  file-system loader over src|dist/db/migrations/NNNN_*.ts|js   (= DbLive)
                    ├── EventLog  append(companyId,type,payload) → seq = MAX+1 in the same INSERT; since(companyId,seq) paged Stream
                    ├── Bus       one PubSub per company; publish / subscribe / stream
                    ├── HttpNodeServer  raw node:http server shared by both below          (+ WsAuthenticatorPlaceholder)
                    └── HttpLive  NodeHttpServer(PORT) + HttpApiBuilder.serve(api.ts groups) + StaticLive(../web/dist, SPA fallback)
                          └── WsServer  ws.WebSocketServer on /ws: auth → subscribe Bus → replay EventLog > since → live; ping/pong,
                                        heartbeat 30s, drop typing when bufferedAmount > 1MB, close 1013 when > 16MB, clean Scope shutdown
```

Notes: `EventLog.append` does **not** publish — call it inside `sql.withTransaction(...)` with the write, then `Bus.publish({ _tag: 'Event', companyId, event })` after commit.
Typing frames are rebroadcast as `{type:'event', event:{type:'typing', seq:<head>, …}}` per `ServerSocketMessage` and never logged. `WsServer` detaches
`NodeHttpServer`'s own `upgrade` listener (Effect's `HttpServerRequest.upgrade` is unused by design). Schema follows build-plan.md's Domain table:
`last_read_seq` lives on `channel_members` (no separate `channel_reads`), `events` PK is `(company_id, seq)`, `agents UNIQUE(company_id, handle)`.
`src/_placeholder/` holds the stand-ins to delete: `contract.ts` (local `TautApi` with only `health`), `auth.ts` (`WsAuthenticator` tag +
fake cookie principal `taut_session=<userId>:<companyId>`), `events.ts` (untyped `TautEvent`/`BusMessage`).

**Adding a domain group** (later phase):

1. Implement it in `src/http/<name>.ts`: `export const TasksLive = HttpApiBuilder.group(TautApi, 'tasks', (handlers) => handlers.handle('list', …))`.
2. Append the layer to the `groups` array in `src/http/api.ts`. `HttpApiBuilder.api(TautApi)` fails typecheck until every group of the api is provided,
   so switch `src/_placeholder/contract.ts` → `@taut/contract` only once all groups (and `AuthenticationLive`) exist, e.g.
   `const ServerApi = TautApi.add(HealthGroup)` keeping health local. Services the handlers need go into `InfraLive` in `src/layers.ts`.
3. Replace `WsAuthenticatorPlaceholder` with a layer that resolves the `taut_session` cookie against `sessions` + active company.

**Adding a migration:** create `src/db/migrations/0002_<name>.ts` default-exporting `Effect.gen(function* () { const sql = yield* SqlClient.SqlClient; yield* sql\`…\` })`.
Ids must be unique and increasing; applied ids are recorded in `effect_sql_migrations`and never re-run, so never edit`0001_init.ts`— add a new file.
tsup emits`dist/db/migrations/*.js`automatically (glob entry);`test/migrations.test.ts` `EXPECTED_TABLES` must be updated when tables are added.

## `@taut/memory` + `@taut/taut-mcp` — per-agent memory store and the `taut` MCP server / CLI

**Pinned** (exact, matching the rest of the repo): `effect 3.22.1`, `@effect/platform 0.97.1`, `@effect/sql 0.52.1`,
`@effect/sql-sqlite-node 0.53.0`; `@modelcontextprotocol/sdk 1.30.0`, `zod 4.5.4` (its peer); dev `@effect/vitest 0.30.0`,
`vitest 3.2.7`, `tsup 8.5.1`, `tsx 4.23.13`, `ajv 8.17.1` (schema validation in tests only).

Try it: `pnpm --filter @taut/memory test` (14 tests, incl. 10k-item search < 50 ms) ·
`pnpm --filter @taut/taut-mcp test` (22 tests: in-memory MCP client, fake HTTP server, CLI, inject, bundled stdio smoke) ·
`pnpm --filter @taut/taut-mcp build` → `dist/mcp.js` + `dist/cli.js` (single files, ~1.7 MB each, `node dist/mcp.js` needs no `node_modules`).

### `@taut/memory` (`packages/memory`, source exports, no build)

`AgentMemory` is an `Effect.Service` over ONE SQLite file — the path is the isolation boundary, there is no `agent_id` column.

```ts
import { AgentMemory, eventToMemoryOps, cursorName } from '@taut/memory'
AgentMemory.layer('/data/companies/acme/agents/bruno/memory/memory.db') // Layer<AgentMemory>
AgentMemory.open(path) // Effect<AgentMemory, …, Scope> — for loops over many agents
AgentMemory.Default // from whatever SqlClient is in context
```

| method                                                                                 | notes                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `upsert(item)` / `upsertMessage(input)`                                                | keyed by `(kind, sourceId)`; writing again **replaces** (edit) — FTS kept in sync by triggers                                                                                         |
| `deleteBySource(kind, sourceId)` → `boolean`                                           | hard delete                                                                                                                                                                           |
| `search(query, { limit=10, since, until, channelId, kind, authorId })` → `SearchHit[]` | FTS5 `bm25()` over `text` (porter+unicode61), then `score = -bm25 + 0.1·0.995^ageDays`; `snippet` via `snippet()`; query tokens are quoted (no raw FTS syntax), trailing `*` = prefix |
| `grep(regex, { flags='i', limit=20, since, until, channelId, kind })`                  | JS `RegExp` over the newest 5 000 candidates matching the filters                                                                                                                     |
| `recallThread(threadId, { limit })`                                                    | root first, then replies by `at`                                                                                                                                                      |
| `timeline({ from, to, channelId?, limit=100 })`                                        | oldest first                                                                                                                                                                          |
| `note(text, tags?)` · `notes.list({limit})` · `notes.get(id)` · `forget(id)`           | only `kind='note'` is deletable; `forget` returns `false` for anything else                                                                                                           |
| `getCursor(name)` / `setCursor(name, seq)` · `apply(ops, { name, seq }?)`              | `apply` runs a batch of `MemoryOp`s **and** the cursor update in one transaction                                                                                                      |
| `stats()`                                                                              | `{ total, byKind, oldestAt, newestAt, cursors }`                                                                                                                                      |

Schema (`src/schema.ts`, embedded migrations via `Migrator.fromRecord`, recorded in `effect_sql_migrations`; WAL on by `SqliteClient`):
`items(id PK = "<kind>:<sourceId>", kind CHECK(message|note|task|file), source_id, channel_id, thread_id, author_kind, author_id, author_handle, at, text, body, meta JSON)`,
`items_fts(text, content='items')` + insert/update/delete triggers, `cursors(name PK, seq)`. `text` = contextual prefix
`[#channel] [@author] [YYYY-MM-DD] [thread:<root>]` + `\n` + body (§10) — so the prefix is searchable; `body` is returned raw (`MemoryItem.body`).

`ingest.ts`: `eventToMemoryOps(event, visibility, names?)` is pure. `message.created|updated` → upsert when `visibility(channelId)`;
`message.deleted` → delete regardless (a retracted message must not be recallable); `agent.task.done` → the final message + a
`kind='task'` row keyed by `task.id`; everything else → `[]`. `names.channel(id)` / `names.member(kind,id)` make the prefix human.

### `@taut/taut-mcp` (`packages/taut-mcp`)

Runs **inside the agent's machine**; knows only `TAUT_URL` + `TAUT_TOKEN` (+ optional `TAUT_TASK_ID`, `TAUT_THREAD_ID`). Never sees a DB path.

- `src/protocol.ts` — Effect Schemas for every request/response + `AgentRuntimeRoutes` table (import from `@taut/taut-mcp/protocol`; the server should decode requests with these exact schemas).
- `src/tools.ts` — the 12 tools (`taut_send taut_inbox taut_ask taut_done taut_handoff memory_search memory_grep memory_recall_thread memory_timeline memory_note memory_notes_list memory_forget`), JSON schemas derived from the protocol schemas via `JSONSchema.make`, descriptions written for the agent. `runTool(name, args)` is shared by MCP and CLI.
- `src/server.ts` — `createTautServer(runtime)` (SDK low-level `Server`, `instructions` = the §9 preamble); `src/mcp.ts` = stdio entry; results are `{ content:[text json], structuredContent }`, failures are `isError` with a one-line explanation (`needs_gate` tells the agent not to retry).
- `taut_ask`: `POST /ask` then polls `GET /ask/:id?wait=<ms>` (≤ 10 s per poll) until `timeoutSec` (default/max 45) → `{ answered, answer }` or `{ parked: true, askId, hint }`.
- `src/cli-core.ts` + `src/cli.ts` — `taut send @bruno "text" [--thread id]`, `taut inbox [--since n]`, `taut ask @maria "q" [--timeout s]`, `taut done "summary" [--failed] [--files a,b]`, `taut handoff @ana "spec"`, `taut mem search|grep|recall|timeline|note|notes|forget …`, `taut describe`; `--json` anywhere; exit 1 on tool error, 2 on missing env.
- `src/inject.ts` — `claudeMcpConfig(o)` + `claudeArgs(path)` (`--mcp-config <p> --strict-mcp-config --allowedTools mcp__taut__*`, env `CLAUDE_AUTO_BACKGROUND_TASKS=1`), `codexConfigToml(o)` (`[mcp_servers.taut]` with `required = true`, `default_tools_approval_mode = "auto"`), `cursorMcpJson(o)` + `cursorCliJson` (`Mcp(taut:*)`) + `cursorArgs` (`--approve-mcps`), `opencodeJson(o)` (`mcp.taut` local) + `opencodeToolNames` (`taut_<tool>`) + `opencodeArgs` (`--auto`); `injectAll(o)` returns all of them. Default command `node /opt/taut/mcp.js`.

### `/api/agent-runtime/*` — what the server must implement (all `Authorization: Bearer <TAUT_TOKEN>`; non-2xx → `{ error: { code, message, gateId? } }`)

| method | path                    | request (schema)                                         | response (schema)                                         | server semantics                                                                                                                  |
| ------ | ----------------------- | -------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| POST   | `/send`                 | `SendRequest { to, text, threadId? }`                    | `SendResponse { messageId, channelId, threadId?, seq }`   | `from` from token; routing rules §9 (`403 needs_gate` cross-dept, `429 needs_gate` at the turn cap); default thread = task thread |
| GET    | `/inbox?since=`         | `InboxQuery`                                             | `InboxResponse { items: InboxMessage[], nextSince }`      | unread for this agent with `seq > since`; replies to asks carry `askId`                                                           |
| POST   | `/ask`                  | `AskRequest { to, text, timeoutSec? }`                   | `AskCreated { askId, messageId, threadId }`               | posts `intent=ask`, task → `waiting(askId)`                                                                                       |
| GET    | `/ask/:id?wait=`        | `AskStatusQuery`                                         | `AskStatus { askId, status: pending\|answered, answer? }` | may hold the response up to `wait` ms                                                                                             |
| POST   | `/done`                 | `DoneRequest { summary, outcome?, filesChanged? }`       | `DoneResponse { taskId, status: done\|failed }`           | once per task; `409 task_mismatch` if the token's task is not the current attempt                                                 |
| POST   | `/handoff`              | `HandoffRequest { to, text }`                            | `HandoffResponse { taskId, threadId, messageId }`         | child task, depth ≤ 2, cross-dept gate                                                                                            |
| POST   | `/memory/search`        | `MemorySearchRequest`                                    | `MemoryHits { items: MemoryHit[] }`                       | `AgentMemory.search` on the token's agent DB                                                                                      |
| POST   | `/memory/grep`          | `MemoryGrepRequest`                                      | `MemoryItems`                                             | `AgentMemory.grep`                                                                                                                |
| POST   | `/memory/recall-thread` | `MemoryRecallThreadRequest { threadId, limit? }`         | `MemoryItems`                                             | `AgentMemory.recallThread`                                                                                                        |
| POST   | `/memory/timeline`      | `MemoryTimelineRequest { from, to, channelId?, limit? }` | `MemoryItems`                                             | `AgentMemory.timeline`                                                                                                            |
| POST   | `/memory/note`          | `MemoryNoteRequest { text, tags? }`                      | `MemoryNoteResponse { item }`                             | `AgentMemory.note`                                                                                                                |
| GET    | `/memory/notes?limit=`  | `MemoryNotesListQuery`                                   | `MemoryItems`                                             | `AgentMemory.notes.list`                                                                                                          |
| POST   | `/memory/forget`        | `MemoryForgetRequest { id }`                             | `MemoryForgetResponse { deleted }`                        | `AgentMemory.forget` (notes only)                                                                                                 |

`MemoryItem`/`MemoryHit` in `protocol.ts` are structurally identical to `@taut/memory`'s `MemoryItem`/`SearchHit` — the handler can return them as-is.

### Running the memory ingest loop (server side)

1. Per agent, open its DB once: `const mem = yield* AgentMemory.open(join(agentHome, 'memory', 'memory.db'))` inside a `Scope` that lives as long as the server (or an LRU of open handles).
2. Read `const since = yield* mem.getCursor(cursorName(agentId))`.
3. Stream the company log: `EventLog.since(companyId, since)`; for each event compute `ops = eventToMemoryOps(event, (channelId) => isMember(agentId, channelId), { channel: channelName, member: memberHandle })`.
4. `yield* mem.apply(ops, { name: cursorName(agentId), seq: event.seq })` — rows and cursor commit together, so a crash replays instead of skipping; upserts are idempotent.
5. Then subscribe to `Bus` for live events and repeat 3–4; batch several events per `apply` when catching up.
6. Fan-out is "one event, N agent DBs": iterate the agents that can see the channel; `message.deleted` goes to **every** agent's DB (ops are visibility-independent for deletes).
7. If `since` predates the retained log, rescan `messages` ordered by `created_at` through `upsertMessage`, then set the cursor to the log head.
8. Notes are never touched by ingestion; deleting an agent deletes its folder.
9. The `/memory/*` handlers use the same open handle (resolve token → agentId → handle).
10. `mem.stats()` is cheap — expose it later on `agents.memory` for the UI.

## `@taut/server` — Phase 2 domain layer (auth · companies · invites · departments · channels · messages · notifications)

**What works.** Every `TautApi` group is served by `HttpApiBuilder.api(ServerApi)` (`ServerApi = TautApi.add(HealthGroup)`, `src/http/serverApi.ts`);
`src/_placeholder/` is gone. Real `Authentication` middleware (`src/auth/authentication.ts`: `taut_session` cookie → `sessions` → `CurrentUser`),
scrypt passwords (`src/auth/password.ts`, per-user salt, `timingSafeEqual`, dummy hash on unknown email), 30-day httpOnly cookie (`Secure` per
`TAUT_COOKIE_SECURE`/production). `/ws` uses the same cookie → session → active company (`WsAuthenticatorLive`; 401 no session, 403 no company).
Services are `Effect.Service`s in `src/services/*` (`Auth`, `Companies`, `Invites`, `Departments`, `Channels`, `Messages`, `Users`, `EventPublisher`),
wired once in `src/layers.ts` (`ServicesLive` → `InfraLive` → `HttpLive` → `WsServer`). Every query carries `company_id`; authorization lives in the
services (contract `Unauthorized`/`Forbidden`/`NotFound`/`Conflict`/`Validation`), infra failures are defects (`src/db/sql.ts` wrappers).
`EventLog` is now typed with the contract `Event` union; `EventPublisher.transact(companyId, emit => …)` runs the mutation + `emit(...)` in one
`sql.withTransaction` and publishes on `Bus` only after commit. `WsServer` filters `notification`/`unread.changed` per socket (`isVisibleTo`).
Migration `0002_session_active_company` adds `sessions.active_company_id`. Seed: `pnpm --filter @taut/server seed` (idempotent) →
`owner@taut.local` / `password123` (owner), `dana@taut.local` / `password123`, company `acme`, departments `engineering` (head owner) + `design`
(head dana), channels `#engineering` `#design` `#backend` + a DM, 20 messages. Tests: `test/domain.test.ts` (typed `HttpApiClient` with a cookie
jar per user + raw `ws`), `test/http.test.ts`, `test/eventLog.test.ts` — 32 server tests.

**Contract change (additive):** `message.created` payload is `{ message, mentions?: Mention[] }` with `Mention = { memberKind, memberId, handle }`
(`@taut/contract/events`). Agents match by `handle`; users match by the local part of their email (`@dana` → `dana@…`); `@channel`/`@here`
notify every human member. The Phase 3 scheduler keys off `mentions` with `memberKind: 'agent'`.

**Semantics worth knowing.** `TAUT_MULTI_COMPANY=false` (default): a user may create a company only while they belong to none (the first one is
never blocked). A session with no `active_company_id` auto-activates the user's oldest membership. `companies.get/members` return 404 to
non-members (no leaking); channels/messages of another company are 404. Members see only channels they belong to; admin+ see every channel plus
their own DMs; DMs are never visible to a third party. `channels.create` requires `departmentId` (422 otherwise); creator + department head are
auto-members; admin+ or the head manage a channel. Adding someone to a department also adds them to that department's channels; the head can't be
removed (set a new head first); deleting a department deletes its channels. `messages.list` is newest-first, top-level only (thread replies live
in `messages.thread`, oldest-first), `limit` is clamped to 100, `nextCursor` is the last id, `before` is exclusive by `(created_at, rowid)`.
`message.created` fans out: `notifications` rows for mentioned users (`mention`), the DM recipient (`dm`), thread participants (`thread_reply`),
one `notification` event each, and one `unread.changed` per human channel member (unread = top-level messages by others after
`last_read_seq`, mentions = unread mention notifications in that channel). `channels.markRead` bumps `last_read_seq`, marks those notifications
read and emits `unread.changed` for the caller. Directory lists (companies, members, departments, channels, invites) return everything and
ignore `cursor`/`limit`; message lists paginate.

**Try it** (`pnpm --filter @taut/server dev`, then):

```sh
J=/tmp/taut.jar
curl -c $J -X POST localhost:3000/api/auth/signup -H 'content-type: application/json' \
  -d '{"email":"owner@taut.local","password":"password123","name":"Owner"}'
curl -c $J -X POST localhost:3000/api/auth/login -H 'content-type: application/json' \
  -d '{"email":"owner@taut.local","password":"password123"}'
curl -b $J -X POST localhost:3000/api/companies -H 'content-type: application/json' \
  -d '{"slug":"acme","name":"Acme","avatar":{"kind":"emoji","value":"🏢"}}'
curl -b $J localhost:3000/api/auth/me                       # { user, memberships, activeCompanyId }
ME=$(curl -sb $J localhost:3000/api/auth/me | jq -r .user.id)
curl -b $J -X POST localhost:3000/api/departments -H 'content-type: application/json' \
  -d "{\"name\":\"Engineering\",\"slug\":\"engineering\",\"headUserId\":\"$ME\"}"   # also creates #engineering
CHN=$(curl -sb $J localhost:3000/api/channels | jq -r '.items[0].id')
curl -b $J -X POST localhost:3000/api/messages -H 'content-type: application/json' \
  -d "{\"channelId\":\"$CHN\",\"body\":\"hello @dana\"}"
curl -b $J "localhost:3000/api/messages?channelId=$CHN&limit=20"
websocat -H "Cookie: $(awk '/taut_session/{print "taut_session="$7}' $J)" 'ws://localhost:3000/ws?since=0'
```

**Stubbed — Phase 3 must replace (`src/http/stubs.ts`, each marked `// TODO(phase3)`):**
`vault.list` (empty) · `vault.add` (403) · `vault.revoke` (404) ·
`subscriptions.list` (empty) · `subscriptions.add` (403) · `subscriptions.remove` / `setWeight` / `check` (404) ·
`agents.list` (empty) · `agents.create` (403) · `agents.get` / `update` / `delete` / `putSkill` / `deleteSkill` / `listFiles` / `uploadFile` /
`grantFile` / `revokeFileGrant` / `vaultGrants` / `grantVault` / `revokeVaultGrant` (404) ·
`tasks.list` (empty) · `tasks.get` / `cancel` (404).
Also open for Phase 3: agents table rows (only `Users.agentIn/agentsOf` read it today), the scheduler on `message.created` agent mentions,
`agent_done`/`agent_failed` notifications, `TODO(plan)` channel-membership check on `typing` frames.

## `@taut/runtime` — machines (local, docker) + runtime adapters + NDJSON parsers

**Pinned** (exact): `effect 3.22.1`, `dockerode 5.0.1`, `tar-stream 3.2.1`; dev `@effect/vitest 0.30.0`, `vitest 3.2.7`,
`@types/dockerode 4.0.1`, `@types/node 22.20.1`. Depends on `@taut/contract` (types only: `RuntimeKind`, `CredentialKind`, `PermissionMode`).
Sandcastle's command builders / parsers / image lineage are ported, not depended on — attribution in `packages/runtime/NOTICE` (MIT).

**Run:** `pnpm --filter @taut/runtime typecheck && … test && … lint` (52 tests; 10 skipped by default).
Opt-in suites: `TAUT_TEST_CLAUDE=1` runs a **real** `claude -p "reply with exactly: pong"` through LocalProvider + adapter + parser + redactor
(passed on 2026-09-08 with the host login: `session → text_delta("pong") → usage → done{ok:true, reason:"success"}`, 4.5 s);
`TAUT_TEST_DOCKER=1 [TAUT_TEST_DOCKER_IMAGE=…]` runs the docker provider against the local daemon. Image: `pnpm --filter @taut/runtime build:image`
(`docker/agent.Dockerfile`: `node:22-bookworm-slim` + git/ripgrep/procps + `@anthropic-ai/claude-code`, `@openai/codex`, `opencode-ai`, user `agent` uid 1000;
cursor-agent left out — its curl installer unpacks into `$HOME`, which the bind mount hides).

**Export map:** `@taut/runtime` (everything), `./machine`, `./adapters`, `./redact`, `./instructions`, `./run`.

| piece                                                                                                               | what                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MachineProvider` / `Machine` (`src/machine/types.ts`)                                                              | `ensure(spec) → Machine`, `get`, `list`, `destroy`; `Machine.exec(opts) → Effect<ExecResult>` with `onLine`/`onStderr`, `execStream(opts) → Stream<ExecOutput>` (`stdout` \| `stderr` \| final `exit`), `putFile`/`getFile`, `status`/`start`/`stop`/`destroy`. Child processes are `Scope`d: interrupting the fiber sends SIGTERM to the process group, SIGKILL after 3 s. `idleTimeoutMs` / `timeoutMs` → `killedBy`. Errors: `MachineUnavailable`, `ExecFailed` (I/O, not exit codes), `BinaryMissing` (ENOENT / "executable file not found"). `MachineProviderTag` is the `Context.Tag` the server provides via `LocalProviderLive(opts)` or `DockerProviderLive(opts)`.                                                       |
| `makeLocalProvider`                                                                                                 | host spawn, cwd = home (or `opts.cwd`, relative to home), env = **allowlist only** `PATH LANG TERM USER` + `HOME=<home>/.taut/home` + `TMPDIR` + per-exec env (wins). `ensure()` lays out `AGENT.md skills/ memory/ inbox/ work/ .taut/{home,claude,codex,audit.log}` (`ensureHomeLayout`).                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `makeDockerProvider`                                                                                                | container `taut-<slug>-<handle>`, `sleep infinity`, `User 1000:1000`, `CapDrop ALL`, `no-new-privileges`, `PidsLimit` (512), `Memory`/`NanoCpus` from spec, `ReadonlyRootfs` + tmpfs `/tmp`, `NetworkMode taut-<slug>` (bridge created on demand), optional `Runtime`. `spec` stored in label `taut.spec` so `get/list` rebuild machines after a restart. Exec = `container.exec` with per-call `Env` (secrets never on the container, verified by test), demuxed stdout/stderr. Interruption runs a second exec that signals every pid carrying `TAUT_EXEC_ID=<uuid>` in `/proc/*/environ` (Docker has no exec-kill API). Missing image → `docker pull` once. `egress.allowDomains` recorded, **not enforced** (`// TODO(plan)`). |
| `RuntimeAdapter` (`src/adapters/types.ts`)                                                                          | `kind`, `binary`, `detect(machine)` (runs `<bin> --version`), `buildCommand(input) → { cmd, env, stdin?, files? }`, `parseLine(line) → ReadonlyArray<AgentEvent>`, `resumeArgs(sid)`. `adapters` / `adapterFor(kind)`. **Deviation:** `parseLine` returns an array, not `Option` — one claude `assistant` line carries several content blocks and one `result` line yields `usage` + `done`; `[]` means "known noise".                                                                                                                                                                                                                                                                                                             |
| `AgentEvent` (Effect `Schema.Union`)                                                                                | `text_delta{text}` `tool_use{id,name,input}` `tool_result{toolUseId,content,isError}` `file_change{path,kind}` `session{sessionId,model?}` `usage{inputTokens,outputTokens,cacheReadTokens?,cacheWriteTokens?,costUsd?}` `done{ok,summary?,reason?,sessionId?,numTurns?,durationMs?,costUsd?}` `error{message,code?}` `raw{line}`.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `claudeCode`                                                                                                        | full; `codex`, `cursor`, `opencode`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `detect()` real; `buildCommand`/`parseLine` per docs, **untested beyond detect** (codex/cursor present on this host, opencode not). |
| `makeRedactor(secrets)`                                                                                             | replaces raw, base64, base64url, URL-encoded and JSON-escaped forms with `••••<last4>` (no last4 under 12 chars; secrets < 6 chars ignored). `runTask` redacts every `command.env` value and `command.files[].content` automatically.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `renderInstructions` / `writeInstructions(machine, workDir, …)`                                                     | `CLAUDE.md` (mandate + `@../../skills/<n>/SKILL.md` + `@../../memory/MEMORY.md` imports), `AGENTS.md` for codex/opencode (flattened bodies), `.cursor/rules/taut.mdc` (frontmatter, `alwaysApply: true`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `runTask({ machine, adapter, command, cwd, secrets?, onStderr?, idleTimeoutMs?, timeoutMs? }) → Stream<AgentEvent>` | writes `command.files`, execs, redacts, parses; synthesises `error` + `done{ok:false, reason:"exit N"\|"killed: idle"}` when the CLI died without a `result`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

**How the server calls it** (scheduler, per task):

```ts
const provider = yield * MachineProviderTag // LocalProviderLive() in dev, DockerProviderLive() in prod
const machine =
  yield *
  provider.ensure({
    agentId,
    companyId,
    companySlug,
    handle,
    homeDir,
    limits,
    network: { egress: 'allow-all' }
  })
const adapter = adapterFor(agent.runtimeKind) // claude-code | codex | cursor | opencode
const cwd = posix.join(machine.paths.home, 'work', task.id) // machine-visible path (/home/agent/… on docker)
yield * writeInstructions(machine, cwd, { kind: agent.runtimeKind, agent, skills, memoryMd })
const { env: secretEnv } = yield * Vault.resolveForSpawn(subscription.credentialId, agent.id) // e.g. { ANTHROPIC_API_KEY }
const command = adapter.buildCommand({
  prompt,
  cwd,
  home: machine.paths.home,
  permissionMode: agent.permissionMode,
  credential: { kind: item.kind, secret: secretEnv.ANTHROPIC_API_KEY },
  model: agent.model,
  resumeSessionId,
  mcp: { configPath }
})
yield *
  Stream.runForEach(runTask({ machine, adapter, command, cwd, idleTimeoutMs: 300_000 }), (event) =>
    Effect.gen(function* () {
      /* text_delta → append to streaming message; session → store sid; done → finalize; error → fail */
    })
  )
```

**Claude Code: flags verified against `claude 2.1.263` on this host** (`/Users/tedyeng1/.orchestra/bin/claude`) — all of
`-p --output-format stream-json --verbose --resume --model --permission-mode {plan,acceptEdits} --mcp-config --strict-mcp-config
--allowedTools --add-dir --max-budget-usd` exist as written. Differences / gotchas found:

- `--append-system-prompt-file` is **not listed** in `--help` (only `--append-system-prompt` is; the `--bare` text mentions `[-file]`), but it is
  accepted and validated ("Append system prompt file not found") — used as specified.
- Prompt goes on **stdin** by default (agent-model §6, 128 KB argv cap). `promptVia: 'argv'` puts it immediately after `-p`, before
  `--allowedTools` (variadic — a trailing positional would be swallowed). Sandcastle passes `-p -`; here plain `-p` + piped stdin works.
- `result.is_error: true` arrives with `subtype: "success"` on auth failures (`terminal_reason: "api_error"`); `done.ok` uses `is_error`.
  The preceding `assistant` line then carries `error: "authentication_failed"` and a synthetic "Not logged in" text → emitted as `error`.
- **Host login on macOS needs `HOME` _and_ `USER`.** Without `USER` the keychain lookup misses and claude reports
  "OAuth session expired and could not be refreshed" (misleading). With `CLAUDE_CONFIG_DIR` pointed elsewhere the login is not found at all,
  even if `.claude.json` is copied: the keychain entry is tied to the default config dir. Hence `USER` is in the local allowlist and
  `credential: { kind: 'host-login' }` leaves `CLAUDE_CONFIG_DIR` unset (dev only; callers add `HOME: os.homedir()` to the exec env).
  Production path is unchanged: `CLAUDE_CONFIG_DIR=<home>/.taut/claude` + `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`.
- `stream_event` (needs `--include-partial-messages`) and `rate_limit_event`/hook `system` lines are ignored; `--bare` is never used.
- Adapter env also sets `DISABLE_AUTOUPDATER=1` and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`.
- Codex 0.151.0: `codex exec` has `--json --sandbox --skip-git-repo-check -C --add-dir`, **no `-a/--full-auto`**; `codex exec resume <sid>`
  accepts `--json`/`-m` but not `--sandbox`. Cursor binary is `cursor-agent` (help calls it `agent`), `--force` applies edits, `--mode plan` is read-only.

## `@taut/web` — wired to the real API (Phase 2)

Every stub from the `@taut/web` table above is gone: `src/lib/stub-data.ts`, `src/lib/types.ts`
and `src/lib/not-implemented.ts` are **deleted**, and no `notImplemented()` call sites remain.

**Added deps:** `@effect/platform 0.97.1` (exact) + `@taut/contract` (workspace).

**Run it:** `pnpm --filter @taut/server dev` · `pnpm --filter @taut/server seed`
(`owner@taut.local` / `password123`) · `pnpm --filter @taut/web dev` → http://localhost:5173.
Gates: `pnpm --filter @taut/web typecheck && … lint && … build`, plus root `pnpm typecheck` — all green.

### The client

| file                         | what it is                                                                                                                                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/api-client.ts`      | the one `HttpApiClient.make(TautApi, { baseUrl: '' })`, over `FetchHttpClient.layer` with `credentials: 'include'`; `Api` tag + `ApiLive`; `ApiError` (`{ tag, message }`) that every contract `TaggedError` collapses into |
| `src/lib/runtime.ts`         | the single `ManagedRuntime<Api>`; `useEffectQuery` / `useEffectInfiniteQuery` / `useEffectMutation` bridges (React Query's `AbortSignal` passes through)                                                                    |
| `src/lib/api.ts`             | one typed hook per endpoint — auth, companies, invites, departments, channels, messages, agents, vault, subscriptions                                                                                                       |
| `src/lib/error-toast.ts`     | `QueryCache`/`MutationCache` funnel: toast the error's own `message` (sonner); `Unauthorized` → `/login`                                                                                                                    |
| `src/lib/message-cache.ts`   | id-deduped surgical edits (channel pages newest-first, thread pages oldest-first, `agent.task.delta` appends in place)                                                                                                      |
| `src/lib/realtime-cache.ts`  | `Event` → cache edit, one `case` per `EventType`                                                                                                                                                                            |
| `src/lib/live.ts`            | `useSyncExternalStore` slices the REST contract does not model: presence, unread, typing, failed-run error text                                                                                                             |
| `src/lib/ids.ts`             | `Schema.decodeUnknownOption` guards for ids that arrive from the URL                                                                                                                                                        |
| `src/hooks/use-directory.ts` | contract → UI view models (one `@mentionable` list of humans + agents; DM counterparts from `channels.members`)                                                                                                             |

`src/lib/ws.ts` now decodes with `ServerSocketMessage` from `@taut/contract/events`, keeps
`lastSeq` **per company** (`taut.lastSeq.<companyId>`), handles `resync`, and exposes a
`useSyncExternalStore` snapshot for status + seq.

### What works against the running server

Signup / login / logout / `me`; route guards in `_app` (no session → `/login`, session with no
company → `/onboarding`, session that has not picked one adopts its first membership); invite
create → copyable `/invite/<token>` → accept → revoke; members list with role badges and
`setRole`; departments crud + `setHead` + add/remove members (humans **and** agents); channels
crud, members sheet, `openDm`, `markRead`; messages list (reverse infinite scroll, day
separators, 5-minute author grouping, hover edit/delete on your own), send, edit, delete,
thread panel on `?thread=<messageId>` (Escape closes); `typing` frames from the composer
throttled to 1/2s; company rail + switcher (clears the query cache, `realtime.reset` reopens the
socket at `since=0`); Cmd/Ctrl+K palette over channels, DMs, people and agents (picking a person
or agent calls `channels.dm` and navigates); empty states with a primary action everywhere.

Realtime was verified end to end: all 45 replayed frames from a seeded company decode against
`ServerSocketMessage` with zero failures, through the Vite `/ws` proxy.

### Untested against the server

The server still serves Phase-3 stubs for these, so the UI is built against the contract only:

- **agents** — `list` returns `{items:[]}`; `create` is `Forbidden`, everything else `NotFound`.
  So `/agents`, `/agents/new`, `/agents/$agentId` (profile · mandate · skills · files · vault
  grants · runtime) are wired but unexercised. File **upload** (`agents.uploadFile`, multipart)
  is not wired at all — `// TODO(plan)`.
- **vault** `add`/`revoke` and **subscriptions** `add`/`remove`/`setWeight`/`check` — `Forbidden`/`NotFound`.
- **tasks** — no UI consumes them yet.
- **Events never emitted yet**: `agent.task.started|delta|done|failed`, `presence.changed`,
  `notification`, `unread.changed`, and the `typing` rebroadcast. The handlers, the streaming
  `MessageBubble`, the "X is typing…" line, presence dots and unread badges are all in place and
  type-check against the contract, but only the directory/message events have actually flowed.
- **`companies.create`** — the server ships with `TAUT_MULTI_COMPANY` off, so the rail's "+" and
  the create-company dialog return `Conflict` (the toast shows the server's message). `/onboarding`
  works for the first company.
- **`invites.accept`** — needs a second, logged-out browser session; the endpoint itself returns 200.

### Contract defects found (not fixed — `packages/contract` untouched)

1. `AcceptInviteResult` (`api/invites.ts`) exports no `type` alias, unlike every neighbouring
   result schema; consumers must write `typeof AcceptInviteResult.Type`.
2. No public **invite preview**: `invites` has `accept` but nothing that resolves a token to its
   company/inviter, so `/invite/$token` cannot say _who_ invited you until after you accept.
3. `companies` has no `update` or `delete`, yet `events.ts` defines `company.updated`.
   `/settings/company` is therefore read-only.
4. `Message` carries no `seq`, but `channels.markRead` takes an `EventSeq`. The client marks read
   at the socket's current head, and skips the call while the head is still `0`.
5. `Page.nextCursor` is a plain `Schema.String` while `messages.list.before` is a branded
   `MessageId`, so a cursor has to be re-branded to be fed back. (The server does return a
   `msg_…` id, so the round-trip works.)
6. The `notification` payload has no `channelId` — only `eventSeq` — so "toast unless that
   channel is open" needs a client-side `seq → channelId` map (`live.rememberSeq`).
7. `Message` has no `error` field, though `MessageStatus` has `failed`; the text only exists on
   `agent.task.failed.payload.error`, so the client holds it in `live.setMessageError`.
8. `ClientSocketMessage` is only `typing | ping`: there is no way for a client to _report_
   presence, so `presence.changed` is receive-only and a human never goes `online`.
9. **Server/contract mismatch:** `channels.create` rejects a missing `departmentId` with
   `Validation`, although `CreateChannelPayload.departmentId` and `Channel.departmentId` are both
   optional. The web now requires a department when creating a channel and hides the
   company-wide section when it is empty — but one of the two sides should move.

## `@taut/server` — Phase 3 domain layer (vault · subscriptions pool · agents · tasks)

**What works.** `src/http/stubs.ts` is gone; every `TautApi` group is real. New services in `src/services/*`, wired in
`src/layers.ts` (core: `AgentHomes`, `RuntimeDetector` · tier 1: `Vault`, `Tasks` · tier 2: `Subscriptions`, `Agents`):

- **Vault** (`vault.ts`): `list` (any member, metadata + `hint` only) · `add` (admin+; AES-256-GCM via `vault/crypto.ts`,
  key = HKDF(master, `companyId`), **AAD = item id**, `hint` = last 4 chars) · `revoke` (admin+; deletes the item, every
  subscription using it — `subscription.deleted` each — grants cascade, `audit_log(purpose:"revoke")`). Plaintext never
  appears in a response, event or log: the only way out is the server-internal
  `Vault.resolveForSpawn(vaultItemId, agentId, { subscriptionId?, taskId? })`, allowed when the agent holds an
  `agent_vault_grants` row **or** `subscriptionId` is a company subscription whose `credentialId` is that item. It returns
  `{ item, secret: Redacted<string>, injection }` (`injection` = `{ via:'env', envVar:'ANTHROPIC_API_KEY' }` etc. per
  agent-model §4), writes `audit_log(purpose:"spawn")`, bumps `last_used_at/by` and appends to `<home>/.taut/audit.log`.
  Wrong AAD / company / key → `VaultLocked`.
- **Subscriptions** (`subscriptions.ts`): `list` · `add` (admin+; credential kind must be in `RuntimeCredentialKinds[runtime]`
  else 422 `Validation`; runs `detect` and stores `ok | binary-missing` + `lastCheckedAt`) · `remove` · `setWeight` · `check`.
  `RuntimeDetector` (`runtimeDetector.ts`) = `which <binary>` + `<binary> --version` on the server host, 5 s timeout
  (binaries: `claude`, `codex`, `cursor-agent`, `opencode`). Pool rules (§4): `pick(companyId, runtime, pinnedId?)` →
  `status = 'ok' ∧ weight > 0 ∧ (cooldown_until ≤ now)` ordered by `tasks_today ASC, weight DESC, created_at ASC`;
  `weight 0` drains; a pinned seat skips rotation but must itself be eligible; empty pool → `RuntimeUnavailable`.
  `markUsed(companyId, id)` bumps `tasksToday`; `markRateLimited(companyId, id, cooldownMs = 1h)` sets `cooldownUntil`
  (`CLAUDE_COOLDOWN_MS` = 5 h exported). `tasksToday` is per **UTC day**: migration `0003` adds
  `subscriptions.tasks_today_date`; a stale row reads as 0 and is reset on the next `pick`/`markUsed`.
- **Agents** (`agents.ts`): crud (`handle` unique per company, contract `Handle` regex; `pinnedSubscriptionId` must exist
  and match `runtimeKind`, else 404/422), `putSkill`/`deleteSkill`, `listFiles`/`uploadFile`, `grantFile`/`revokeFileGrant`
  (absolute paths only), `vaultGrants`/`grantVault`/`revokeVaultGrant`. **Departments:** agents belong via
  `department_members` only (no column — decided). `CreateAgentPayload.departmentId?` (contract, additive): set → admin+ or
  that department's head may create; the agent joins the department **and its channels** (`Channels.addToDepartmentChannels`,
  same path `Departments.addMember` already uses for `memberKind: 'agent'`); unset → admin+ only. Manage (update/delete/
  skills/grants/upload outside `inbox/`) = admin+ or head of a department the agent is in; any member lists, reads detail,
  lists files, DMs the agent (`channels.dm` with `memberKind: 'agent'` verified) and uploads into `inbox/`.
  **Home** (`homes.ts`, `AgentHomes`): `<TAUT_DATA_DIR>/companies/<slug>/agents/<handle>/` with `AGENT.md` (rendered from
  name/role/mandate; rewritten on update), `skills/<name>/SKILL.md` (frontmatter `name` + `description`), `inbox/`, `work/`,
  `memory/`, `.taut/agent.json` + `.taut/audit.log`. Delete removes rows (+ its `department_members`/`channel_members`) and
  renames the folder to `<handle>.deleted-<epoch ms>`. Path safety: `AgentHomes.resolveInside(home, rel)` rejects absolute
  paths, `..`, and symlinks whose real path leaves the real home → `Forbidden` (tested incl. a symlink to `/tmp`).
- **Tasks** (`tasks.ts`): `list(agentId?, channelId?, status?, cursor, limit≤100)` newest first · `get` · `cancel`
  (`Conflict` once ended; sets `cancelled` + `endedAt`, emits `task.updated`; Phase 4 also kills the process). Visibility =
  the task's channel: admin+ see all, members only channels they belong to.

**Contract changes (additive, `packages/contract`):** events `vault.item.created { item }`, `vault.item.revoked { vaultItemId }`,
`subscription.created/updated { subscription }`, `subscription.deleted { subscriptionId }`, `task.updated { task }`;
`CreateAgentPayload.departmentId?: DepartmentId`. (`realtime-cache.ts` in the web has no `default` branch, so the union grows safely.)

**Migrations:** `0003_phase3` (`subscriptions.tasks_today_date`, indexes), `0004_message_seq_error` (below).
**Seed** (`pnpm --filter @taut/server seed`, idempotent): + vault item `anthropic.api_key` "Acme Anthropic key" (fake key),
subscription "Claude Code — Acme" on it (`status` = whatever `which claude` says on your host), agents `bruno` (Engineering,
skill `review-pr`), `mila` (Design), `ops` (no department); none pinned.
**Tests:** `test/phase3.test.ts` (12) + `test/contractFixes.test.ts` (4) — 48 server tests, 17 contract tests.

**Try it** (after the Phase 2 curl block, `J` holds the owner cookie):

```sh
V=$(curl -sb $J -X POST localhost:3000/api/vault -H 'content-type: application/json' \
  -d '{"kind":"anthropic.api_key","label":"Acme Anthropic key","secret":"sk-ant-api03-…"}' | jq -r .id)   # → meta + hint only
S=$(curl -sb $J -X POST localhost:3000/api/subscriptions -H 'content-type: application/json' \
  -d "{\"runtime\":\"claude-code\",\"label\":\"Claude Code — Acme\",\"credentialId\":\"$V\"}" | jq -r .id)
curl -b $J -X POST localhost:3000/api/subscriptions/$S/check                              # status ok | binary-missing
DEP=$(curl -sb $J localhost:3000/api/departments | jq -r '.items[0].id')
A=$(curl -sb $J -X POST localhost:3000/api/agents -H 'content-type: application/json' \
  -d "{\"handle\":\"bruno\",\"name\":\"Bruno\",\"avatar\":{\"kind\":\"emoji\",\"value\":\"🦫\"},\"role\":\"Backend engineer\",\"mandate\":\"# Mandate\\n\\nReview PRs.\",\"runtimeKind\":\"claude-code\",\"permissionMode\":\"plan\",\"departmentId\":\"$DEP\"}" | jq -r .id)
curl -b $J -X PUT localhost:3000/api/agents/$A/skills/review-pr -H 'content-type: application/json' \
  -d '{"description":"Review a pull request","body":"# Steps\n1. Read the diff."}'
curl -b $J -X POST localhost:3000/api/agents/$A/vault-grants -H 'content-type: application/json' -d "{\"vaultItemId\":\"$V\"}"
curl -b $J "localhost:3000/api/agents/$A/files?path=skills/review-pr"
curl -b $J -F path=inbox -F file=@README.md localhost:3000/api/agents/$A/files              # multipart upload
cat data/companies/acme/agents/bruno/AGENT.md
```

**Hooks Phase 4 (scheduler + `@taut/runtime`) plugs into — all server-internal, no session:**

- `Subscriptions.pick(companyId, agent.runtimeKind, agent.pinnedSubscriptionId)` → `Subscription | RuntimeUnavailable`;
  then `Subscriptions.markUsed(companyId, sub.id)`; on 429/usage-cap `Subscriptions.markRateLimited(companyId, sub.id, ms)`
  and retry once with a fresh `pick`.
- `Vault.resolveForSpawn(sub.credentialId, agent.id, { subscriptionId: sub.id, taskId })` → `{ secret, injection }`;
  build `env = { [injection.envVar]: Redacted.value(secret) }` at `exec` time only (`openai.oauth` is `via:'file'` →
  write `CODEX_HOME/auth.json`); redact `secret` from every output line.
- `Agents.byId(companyId, agentId)` · `Agents.homeOf(companyId, agentId)` (absolute home = `MachineSpec.homeDir`) ·
  `Agents.skillsOf(agentId)` · `Agents.fileGrantsOf(agentId)`; pure `agentHomePath(dataDir, slug, handle)` in `services/homes.ts`.
- `Tasks.create(companyId, { agentId, channelId, threadId, messageId, subscriptionId?, status? })` and
  `Tasks.update(companyId, taskId, { status?, subscriptionId?, endedAt?, error? })` — no events of their own: call them
  inside your `EventPublisher.transact` and emit `agent.task.started/delta/done/failed` (with the streaming message) yourself;
  `tasks.cancel` over HTTP already flips the row — Phase 4 should watch `task.updated` (or poll `Tasks.byId`) to kill the process.
- Still open: `vault.revoke` does not yet kill running tasks that resolved the item; credential validity checks in
  `subscriptions.check` (today it is binary detection only); `agents.memory(search)`.

### Contract defects from the web's Phase 2 list — fixed (additive; nothing renamed)

1. `Message` now has `seq: EventSeq` (the `seq` of its `message.created` event — pass it to `channels.markRead`) and
   `error?: string` (for `failed` agent messages). Populated on create (the event payload's `message.seq` is final too),
   list and thread; migration `0004_message_seq_error` adds `messages.seq`/`messages.error` and backfills `seq` from the event log.
2. `GET /api/invites/preview/:token` (public, `NotFound`) → `InvitePreview { email, role, company, inviterName, expiresAt, acceptedAt? }`.
   Also `export type AcceptInviteResult`.
3. `PATCH /api/companies/:companyId` (`UpdateCompanyPayload { name?, avatar? }`, admin+, emits `company.updated`) and
   `DELETE /api/companies/:companyId` (owner only; `Forbidden` unless `TAUT_MULTI_COMPANY=true`; emits the new
   `company.deleted { companyId }` then cascades).
4. `notification` event payload: `{ notification, channelId?, messageId? }` — both set for every kind the server emits today.
5. `channels.create`: **departments are required** (DMs go through `dm`). The server keeps answering 422 `Validation`, the
   endpoint now declares `Validation`, and the payload field is documented as required — but it stays `Schema.optional` in the
   schema because `apps/web/src/lib/api.ts` `useCreateChannel` still types `departmentId?`; the moment the web drops that `?`,
   flip `CreateChannelPayload.departmentId` to `DepartmentId` (one line) and nothing else moves.
6. `messages.list`/`messages.thread` return `MessagePage` whose `nextCursor` is a `MessageId` (feed it straight back as `before`).
   Other lists keep the generic `Page`.

## `@taut/web` — Phase 3 (agents · vault · subscriptions · tasks)

Every Phase-3 group now has a real UI, built against `@taut/contract` and exercised against a running
server. **Run it:** `pnpm --filter @taut/server dev` · `pnpm --filter @taut/server seed`
(`owner@taut.local` / `password123`, `dana@taut.local` is a member and head of Design) ·
`pnpm --filter @taut/web dev` → http://localhost:5173.
Gates: `pnpm --filter @taut/web typecheck && … lint && … build`, plus root `pnpm typecheck` — all green.
No new dependencies.

### New files

| file                                | what it is                                                                                                                                                                                                     |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/runtime-meta.ts`           | the words an operator reads: runtime labels/binaries/install hints/model suggestions, credential labels + one helper line per kind, the rotation rule, `isRuntimeKind`/`isCredentialKind`/`isSubscriptionSeat` |
| `src/components/secret-fields.tsx`  | kind (grouped select) · label · secret (password + reveal toggle), shared by `/vault` and the connect dialog                                                                                                   |
| `src/components/confirm-dialog.tsx` | one destructive-confirm dialog; `confirmWord` makes it type-to-confirm                                                                                                                                         |
| `src/components/markdown.tsx`       | ~150-line markdown → React renderer for mandate/skill previews. No `dangerouslySetInnerHTML`, no new dep                                                                                                       |
| `src/components/task-status.tsx`    | `TaskStatusBadge`, `TASK_STATUSES`, `isLiveTask`                                                                                                                                                               |
| `src/components/agent-skills.tsx`   | Skills tab: list + add/edit dialog (frontmatter explained, write/preview) + delete confirm                                                                                                                     |
| `src/components/agent-files.tsx`    | Files tab: home browser with breadcrumbs, multipart upload to `inbox/`, path grants (`ro`/`rw`) add + revoke                                                                                                   |
| `src/routes/_app.tasks.tsx`         | `/tasks`                                                                                                                                                                                                       |
| `src/hooks/use-ticker.ts`           | `Date.now()` as state on an interval — only installed while something is actually counting                                                                                                                     |

### What each screen does

- **`/vault`** — table (label · kind · `••••ab12` · created · last used, with the agent handle that used it).
  "Add secret" groups the six kinds into API keys / subscription seats / other, and each kind carries its own
  helper line (`claude.oauth`: "Run `claude setup-token` and paste the token. Subscription seat — check your
  provider's terms."). The secret is a password input with a reveal toggle, lives only in the dialog component
  (Radix unmounts it on close), and is never echoed back. Revoke is a confirm dialog that **names the seats that
  will go with it**. Add/revoke hidden for members.
- **`/subscriptions`** — one card per runtime, all four always shown. Rows: label, credential hint, status pill,
  weight stepper (0 renders as "Draining"), tasks today, live cooldown countdown, Check, remove. "Connect" opens a
  dialog that either picks a vault secret of an accepted kind **or adds a new one inline** (same fields), plus label
  and a free-text default model with per-runtime suggestions. Rotation rule as a one-line info bar; a pool whose
  seats all report `binary-missing` shows the install hint on the card header.
- **`/agents`** — cards with avatar, handle, role, department chips, runtime badge, status and a live presence dot,
  plus a banner linking to `/subscriptions` when the pool is empty. **`/agents/new`**: handle auto-derived from the
  name until edited by hand and validated against the contract's `Handle` regex, department select, runtime radio
  cards (a runtime with no seats renders as a signpost to `/subscriptions`, not a dead control), pinned subscription
  filtered by runtime, model suggestions, and a mandate starter template ("You are …/You must …/You must never …/
  Report format …"). **`/agents/$agentId`** tabs: Profile (avatar/name/role, pause/resume, department add/remove) ·
  Mandate (write/preview) · Skills · Files · Vault access (with the note that seat credentials resolve automatically) ·
  Runtime (kind, pinned seat, model, permission mode, read-only "local (dev)" machine row, recent tasks with cancel) ·
  Danger (delete, confirmed by typing the handle).
- **`/tasks`** — agent · where · status · started · duration, status filter, cancel on live rows, a row opens the
  channel _or DM_ at the task's thread.
- **Sidebar** — Agents / Tasks / Vault / Subscriptions with counts; Vault and Subscriptions hidden from members, and
  their count queries are `enabled: false` for them so nothing is fetched. A running-task count pulses next to Tasks.
- **DMs** — an agent DM header shows role + runtime and links to the agent's page; message bubbles already carry the
  bot glyph (`EntityAvatar`), the "agent" label and the "working" pill while `status: 'streaming'`.

**Permissions mirror the server exactly.** `canManage` = company admin+ **or** the head of a department the agent is
in; everyone else gets read-only fields and a one-line note, keeps DM and inbox upload, and never sees the Danger tab.
Verified both ways: `dana` (member, head of Design) gets 403 on `bruno` (Engineering) and 200 on `mila` (Design).

**Realtime** (`realtime-cache.ts`): new cases for `vault.item.created|revoked` (also invalidates subscriptions, since
revoking a credential removes its seats), `subscription.created|updated|deleted`, `task.updated`, and
`agent.task.started|done|failed` now flip the agent's presence and invalidate the task lists.

### Verified against the running server

Login, then every call the new hooks make: `vault.list/add/revoke` · `subscriptions.list/add/setWeight/check/remove`
(including the 422 when a credential kind does not match the runtime) · `agents.list/get/create/update/delete` with
`departmentId` (the server does join the department — the web does **not** double-add) · `putSkill`/`deleteSkill` ·
`listFiles` at root and at `path=skills` · **multipart `uploadFile`** (`FormData` through the derived `HttpApiClient`,
which types a `Multipart` payload as `FormData` — no hand-written fetch) · `grantFile`/`revokeFileGrant` ·
`grantVault`/`revokeVaultGrant` · `tasks.list` with `agentId` and `status`.

### Untested against the server

- **Everything task-shaped is unexercised**: there is no scheduler yet, so `@mention`ing `@bruno` in a seeded channel
  creates the message but no task (`tasks.list` stays empty). `/tasks`, the cancel button, the running-count pulse,
  the agent's "Recent tasks" list and the `agent.task.*` → presence/invalidate handlers all type-check and are wired,
  but have never seen a real row.
- `presence.changed` is still never emitted, so agent dots only move via our own `agent.task.*` handling.
- **No browser pass.** The Claude in Chrome extension is connected but `tabs_context_mcp` timed out on every attempt,
  so no page was clicked through. Every route module was fetched through Vite's transform (200) and the production
  build is green, but rendering and interaction are unverified.
- `subscriptions.check` only reports binary detection today, so `auth-failed` styling has never been seen.

### Contract defects found (not fixed — `packages/contract` untouched)

1. **A skill's body cannot be read back.** `AgentDetail.skills` is `{ agentId, name, description }` and there is no
   `getSkill`, so the Skills editor opens on a fresh `SKILL.md` template and a save overwrites the file. The dialog says
   so, but a `body` on `AgentSkill` (or a `getSkill` endpoint) would make editing honest.
2. **`Agent` has no `departmentId`**, although `CreateAgentPayload` takes one and agent-model §5 puts it on the entity.
   To render department chips the web fans out one `departments.get` per department and folds the member lists
   (`useDepartmentMembers` in `use-directory.ts`). A `departmentIds` on `Agent`, or a `memberKind`/`memberId` filter on
   `departments.list`, would delete that hook.
3. **`Agent` has no `machine`** (agent-model §5 has `machine: { provider, limits }`), so the Runtime tab's provider row
   is hard-coded to "local (dev)" instead of reading it.
4. `FileEntry.size` is the raw dirent size for directories (96, 64 …), which means nothing to a reader; the web hides
   the column for `kind: 'dir'`.
5. `Task` carries `channelId` but nothing that says whether that channel is a DM, so both `/tasks` and the agent's
   recent-task list cross-reference `channels.list` to pick between `/c/$channelId` and `/dm/$channelId`.
6. `vault.list` and `subscriptions.list` declare `Forbidden`, but the server answers 200 for members (only writes are
   admin-gated). The web hides both from the sidebar for members anyway — worth deciding which side is authoritative.

### Follow-ups the server's Phase 3 fixes now make possible (not taken)

`Message.seq` means `markRead` no longer needs the socket head, and the `notification` payload's `channelId` makes
`live.rememberSeq` in `live.ts` unnecessary — both are Phase-2 workarounds still in place. `companies.update/delete`
would make `/settings/company` writable, and `invites.preview` would let `/invite/$token` name the inviter.

## `@taut/server` — Phase 4: agents answer (scheduler · task runs · streaming replies · agent-runtime API · memory ingest)

**What works.** @mention an agent in a channel, or DM it, and it answers: a `Task` runs on its machine through
`@taut/runtime`, the reply streams into the conversation as one growing message, the run is indexed into the agent's
memory, and the agent can call `taut_*` / `memory_*` tools back into the server. New modules under `src/agents/`
(`scheduler.ts`, `runTask.ts`, `prompt.ts`, `agentApi.ts`, `memoryIngest.ts`, `tokens.ts`, `sessions.ts`, `provider.ts`)
plus `src/http/agentRuntime.ts`; wired in `src/layers.ts` as `AgentsLive` (`appLive(provider)` takes the machine
provider so tests inject a fake). Migration `0005_phase4`: `agent_sessions`, `task_tokens`, `asks`,
`tasks.{parent_task_id, handoff_depth, trigger_message_id, trigger_user_id}`.

**Scheduler in ten lines** (`src/agents/scheduler.ts`):

1. One consumer on `Bus.streamAll()` (new: a second PubSub that sees every company) handles `message.created` and `task.updated`.
2. Targets of a message = `mentions[memberKind=agent]` ∪ the agent side of a DM (when a human wrote it); the author is never a target; paused agents and agents that are not channel members are skipped (logged).
3. Agent-authored messages only reach an agent of the **same department inside a thread of a department channel** (§9); anything else gets an agent-attributed `_(system)_ cross-department messaging requires a gate (not yet available)` note in the thread and no task. The author's live task in that thread becomes the parent (`handoff_depth + 1`, cap 2 → note).
4. Turn cap: ≥ 20 agent-authored messages in a channel thread → note, no task (DMs are not capped).
5. `Tasks.byTrigger(agent, message)` makes dispatch idempotent: one task per (agent, trigger message), so the handoff endpoint and the bus path cannot double-schedule.
6. One `EventPublisher.transact`: `Messages.createStreaming` (empty `streaming` reply — top-level in a DM, in the mention's thread in a channel) + `Tasks.create(queued, trigger*, parent*)` + `agent.task.started`.
7. The run is forked into a `FiberSet` behind two semaphores: per agent (1 permit — FIFO, so an agent answers in order) and per company (`TAUT_MAX_CONCURRENT_TASKS`). `Map<TaskId, Fiber>` holds live runs.
8. `task.updated{status: cancelled}` (what `POST /api/tasks/:id/cancel` emits) → `Fiber.interruptFork`; the runner's `onInterrupt` finalizes the reply as `failed: Cancelled.` (also when cancelled while still queued).
9. `TaskRunner.run` (`runTask.ts`): flip to `running` + `presence.changed{working}` → `Subscriptions.pick` → `Vault.resolveForSpawn` (+ `markUsed`) → `MachineProvider.ensure` → `renderInstructions` into `<home>/work/<taskId>/CLAUDE.md` (mandate + skills + `@memory/MEMORY.md` + a `## Taut` section: who you are, your head, how replies work, the tools) → task token + MCP config (`.taut/mcp.json` for claude; codex/cursor/opencode files written too) → `adapter.buildCommand` (`--resume <sid>` from `agent_sessions` per channel) → `runTask` from `@taut/runtime` (every line through the `Redactor` seeded with the resolved secret; secrets only in the exec env) → `text_delta` coalesced ≤ 10/s into `agent.task.delta` (+ `message.updated` on finalize) → `done` ⇒ `agent.task.done` + `notification{agent_done}` to the human who asked; anything else ⇒ `agent.task.failed` + `notification{agent_failed}`; then `presence.changed{idle}`, token expiry (`ended + 10 min`).
10. Retries, each once per task: 429 / "rate limit" / "usage limit" text (stdout, stderr or `result`) → `Subscriptions.markRateLimited` (5 h for claude-code, 1 h otherwise) + fresh pick; auth failure (`authentication_failed`, "Not logged in", invalid key, 401) → new `Subscriptions.markAuthFailed` + fresh pick; a failed `--resume` → clear the stored session, rerun fresh. Pool exhausted → `failed` with "No usable claude-code subscription (…). Ask the department head or an admin to connect one under Subscriptions." — unless `TAUT_DEV_HOST_LOGIN=true` and the runtime is claude-code, in which case the run uses the host user's own `claude` login (`credential: { kind: 'host-login' }`, `HOME` = the real home; loud warning). On boot, tasks left `queued`/`running` by a previous process are failed ("server restarted while the task was running").

**Prompt** (`prompt.ts`): `Context (<where>, last N messages, oldest first):` + up to 20 `[HH:MM] @handle: body` lines (the thread, or the channel/DM top level), `---`, `[#channel] @author: <trigger>`, `---`, a one-paragraph footer ("Reply as @bruno. Your reply text becomes your message…"). The system-ish part lives in the instructions file (`InstructionsInput.extra`, additive in `@taut/runtime`).

**Agent-runtime API** (`src/http/agentRuntime.ts` + `src/agents/agentApi.ts`) — every route of `AgentRuntimeRoutes` under
`/api/agent-runtime/*`, `Authorization: Bearer <TAUT_TOKEN>` (32 random bytes, sha-256 stored in `task_tokens`, valid until
10 min after the task ends), a plain `HttpRouter` mounted next to the `TautApi` groups (`HttpApiBuilder.Router.use(router.mount(…))`;
the web contract is untouched). Errors are `{ error: { code, message } }`: `401 unauthorized`, `403/429 needs_gate`, `404 not_found`,
`409 task_mismatch`, `422 validation`. Routing (`send`/`ask`/`handoff`): `@user` allowed when the user heads one of the agent's
departments, is the other side of the task's DM, or is the human who triggered the task; `@agent` only same department and only
inside a department-channel task thread; `#channel` only when the agent is a member; otherwise `403 needs_gate`. Posting into a
channel thread with ≥ 20 agent turns → `429 needs_gate`. `inbox` = `message.created` events after `since` (default: the task's
trigger) that mention the agent, are in a DM with it, or are replies in the task thread — with `askId` when they answer an ask.
`ask` posts `@handle question` and creates an `asks` row; `GET /ask/:id?wait=` long-polls (≤ 45 s, 500 ms steps) for the first
message by the addressee after the ask in that thread. `done` flips the task to `done|failed` (`409` once ended) and, if the
streaming reply is still empty, appends the summary. `handoff` posts `@target spec` in the thread and waits ≤ 3 s for the
scheduler's child task (depth cap 2 → `403`). `memory/*` resolve token → agent → the one `AgentMemory` handle the ingest holds
(never a path from the client).

**Memory ingest** (`src/agents/memoryIngest.ts`): one fiber per agent (all companies; `agent.created` starts one, `agent.deleted`
stops it): open `<home>/memory/memory.db`, subscribe to the company bus first, replay `events` with `seq > cursor` in batches of
500 via `eventToMemoryOps` + `AgentMemory.apply` (rows + cursor in one transaction), then follow live. Visibility = the agent is a
`channel_members` row of the message's channel; names come from channel/user/agent lookups (cached). The agent's own final
replies are indexed through `message.updated` and `agent.task.done`. `restart(agentId)` replays from the stored cursor.

**Config** (all optional; `.env.example` documents them):

| variable                    | default                                                                          | meaning                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `TAUT_MACHINE_PROVIDER`     | `local`                                                                          | `local` spawns runtimes on this host (dev); `docker` = one container per agent            |
| `TAUT_PUBLIC_URL`           | `http://127.0.0.1:<port>` / `http://host.docker.internal:<port>` (docker)        | `TAUT_URL` the `taut` MCP server inside the machine calls back to                         |
| `TAUT_MAX_CONCURRENT_TASKS` | `4`                                                                              | company-wide cap on concurrently running tasks (per agent it is always 1)                 |
| `TAUT_SHOW_TOOLS`           | `false`                                                                          | stream a `_(using X)_` line into the reply for every tool call                            |
| `TAUT_AGENT_IMAGE`          | `@taut/runtime` `DEFAULT_IMAGE`                                                  | docker image for agent machines                                                           |
| `TAUT_DEV_HOST_LOGIN`       | `false`                                                                          | DEV ONLY: no usable claude-code seat → run `claude` with this host user's login (warns)   |
| `TAUT_MCP_COMMAND`          | built `packages/taut-mcp/dist/mcp.js` (local) / `node /opt/taut/mcp.js` (docker) | command that starts the `taut` MCP server; unset + not built → run without tools (warned) |

**Other changes.** `Messages`: author generalised (`Author {kind,id}`), new internals `postAsAgent` (mentions resolve, humans get
notified, `requireMembership` option for system notes), `createStreaming`, `appendDelta`, `finalizeAgentMessage`, `notifyUser`,
`recent`, `agentTurnCount`, `threadRoot`, `byId`. `Channels`: `find`, `isMember`, `agentMembers`, `channelIdsOf`. `Agents`:
`byHandle`, `all`, `departmentsOf`. `Tasks`: `create` takes `parentTaskId/handoffDepth/triggerMessageId/triggerUserId`; `internal`,
`byTrigger`, `liveInThread`, `live`. `Subscriptions.markAuthFailed`. `Bus.subscribeAll/streamAll`. `@taut/runtime`
`InstructionsInput.extra` (additive). `apps/server` now depends on `@taut/runtime`, `@taut/memory`, `@taut/taut-mcp` and
`dockerode` (direct, so the bundled runtime resolves it); `tsup.config.ts` bundles the workspace packages, keeps
`dockerode ssh2 cpu-features better-sqlite3` external and adds a `require`/`__filename`/`__dirname` banner — `pnpm --filter
@taut/server build && node dist/main.js` boots and serves `/api/health`. `turbo.json` `globalEnv` lists the new variables.
`test/phase3.test.ts`: the hand-made task's message no longer @mentions bruno (a real mention now schedules a task).

**Tests** (`test/phase4.test.ts`, 10 + 1 opt-in; 58 server tests + 1 skipped): a fake `MachineProvider` (`test/_fakeRuntime.ts`)
plays scripted claude `stream-json` through the real adapter/parser/redactor. Covered: DM → task → streaming message → ordered
deltas → done → `agent_done` notification, presence `working → idle`, prompt/CLAUDE.md/MCP-config contents, secret only in env;
rate-limit on seat A → cooldown + retry on seat B; deltas in order; cancel interrupts the exec and fails the reply, the queue
frees; `send` 403 `needs_gate` to another department's agent, to a foreign `#channel`, to a non-head human, 200 to the head;
inbox; memory notes; memory ingest indexes only visible channels + own replies and replays from the cursor after a restart;
scheduler notes for cross-department mentions and the 20-turn cap; channel mentions reply in a thread; token expiry.
`TAUT_TEST_CLAUDE=1 pnpm --filter @taut/server test -- phase4` runs a real `claude` through the LocalProvider with the host login.

**Try it** (`TAUT_DEV_HOST_LOGIN=true pnpm --filter @taut/server dev`, then `pnpm --filter @taut/server seed`, then with the
Phase 2 cookie jar `J`):

```sh
BRUNO=$(curl -sb $J localhost:3000/api/agents | jq -r '.items[] | select(.handle=="bruno") | .id')
DM=$(curl -sb $J -X POST localhost:3000/api/channels/dm -H 'content-type: application/json' \
  -d "{\"memberKind\":\"agent\",\"memberId\":\"$BRUNO\"}" | jq -r .id)
curl -sb $J -X POST localhost:3000/api/messages -H 'content-type: application/json' \
  -d "{\"channelId\":\"$DM\",\"body\":\"reply with exactly: pong\"}"
curl -sb $J "localhost:3000/api/tasks?agentId=$BRUNO"          # queued → running → done
curl -sb $J "localhost:3000/api/messages?channelId=$DM&limit=3" # the agent's message: streaming → sent "pong"
```

**Verified live (2026-09-08, this Mac, `claude 2.1.263` host login).** `TAUT_DEV_HOST_LOGIN=true` dev server on the existing
`apps/server/data` (seeded), login as `owner@taut.local`, `POST /api/channels/dm {agent bruno}`, `POST /api/messages
"reply with exactly: pong"`:

1. First run — the seeded seat carries a fake `anthropic.api_key` and `which claude` had marked it `ok`: the task went
   `queued → running`, `claude` retried the invalid key for ~3 min (its own backoff) and exited without a `result`; the runner
   logged `subscription … rejected its credential; marking auth-failed and retrying`, re-picked → pool exhausted → host login,
   and 7 s later the DM held bruno's message `status: sent`, body exactly `pong`; task `done`, `GET /api/subscriptions` shows
   the seat `auth-failed`. (Streaming placeholder was visible in `GET /api/messages` as `status: streaming, body: ""` meanwhile.)
2. Second run (server restarted, seat already `auth-failed`): `done` after 3 s, body `pong`, `subscriptionId: null`
   (host login). Memory consumers started for all 3 agents on that legacy DB (the first boot had killed them on Phase-2
   events without `message.seq` — `EventLog.since(…, { lenient: true })` now skips such rows with a warning).
3. `TAUT_TEST_CLAUDE=1` opt-in test (fresh temp dir, no subscription, host login) passed in 12 s.
4. `pnpm --filter @taut/server build` (tsup) is green again and `node dist/main.js` serves `/api/health`; `docker build -t
taut:dev .` completed (`EXIT 0`, image exported).

Gates: root `pnpm typecheck && pnpm test && pnpm lint` green (server 58 + 1 skipped; `@taut/memory` `test/ingest.test.ts` needed
`seq: 1` in its message fixture — the Phase 3 contract made `Message.seq` required, that suite had been red since).

**Known gaps.**

- Cross-department messaging posts a note instead of a gate; `needs_gate` never creates the `intent=ask` gate for both heads (§9), and
  `taut_ask` does not park the task (`TaskStatus` has no `waiting`; the process keeps running while `askStatus` long-polls ≤ 45 s).
  `messages.intent` / `task_id` columns from §9 do not exist; intents are implied.
- An invalid API key makes `claude` retry for minutes before the seat is marked `auth-failed`; `subscriptions.check` still only detects the binary.
- `vault.revoke` still does not kill running tasks; idle machine stop (`docker stop`) is not scheduled; `egress.allowDomains` unenforced.
- The `taut/agent` image does not yet contain `/opt/taut/mcp.js` — set `TAUT_MCP_COMMAND` or add the bundled `packages/taut-mcp/dist/mcp.js` to the image.
- Replies to a DM are top-level (a thread inside a DM would be unreadable); channel replies always open a thread under the mention.
  `--resume` per (agent, channel) reuses claude sessions across task work dirs — a resume failure falls back to a fresh run once.
- Codex / Cursor / OpenCode: MCP config files are written and the adapters' commands run, but nothing beyond claude-code was exercised.
- `inbox` scans the event log from the trigger (or `since`) — fine at MVP volumes, no index; per-pair rate limits and duplicate suppression (§9) are not implemented.

## Integration pass — contract fix-ups from the web's Phase 3 list, `pnpm e2e`, fresh-user path

All additive (`packages/contract`, server, web changed together); root `pnpm typecheck && pnpm test && pnpm lint && pnpm build` green.

1. **`GET /api/agents/:agentId/skills/:name`** (`agents.getSkill`, any member, `NotFound`) → `AgentSkillDetail { agentId, name, description, body }`; `body` is `SKILL.md` with the frontmatter stripped (`AgentHomes.readSkill` / `stripFrontmatter`). The web's Skills edit dialog now loads it first (`useSkill`, skeleton while loading) so saving edits the file instead of replacing it with the template.
2. **`Agent.departmentIds: DepartmentId[]`** (decodes to `[]` when absent), populated from `department_members` on `list`, `get`, `create` (the department row is inserted before the agent is loaded, so `agent.created` carries it too), every `agent.updated`, `byHandle`, `all`. One query per call, not per row. The web's `useDepartmentMembers` fan-out is gone (`useAgentDepartments(agent)`); `department.*` events and the department-member mutations also invalidate `agents`.
3. **`FileEntry.kind`** was already there; confirmed the server sets it from the dirent and the Files tab hides the size column for `dir` — no change.
4. **`Task.channelKind: 'channel' | 'dm'`** (default `'channel'`) joined from `channels` in every task query; `/tasks` and the agent's recent-task list route on it instead of cross-referencing `channels.list`.
5. **`vault.list` / `subscriptions.list`** no longer declare `Forbidden` — members may list (metadata only; the server already answered 200). The sidebar shows Vault and Subscriptions to everyone; the pages hide add/revoke/connect for members as before.

Tests: `phase3.test.ts` covers `getSkill` (body round-trip + `NotFound`), `departmentIds` on list/get/create, `channelKind` on create/list; `phase4.test.ts` asserts `channelKind: 'dm'`; `packages/contract/test/api.test.ts` lists `getSkill`.

**`scripts/e2e.sh` / `pnpm e2e`** — bash + curl + jq against a temp `TAUT_DATA_DIR` on port 3901 (`TAUT_E2E_PORT`), server started in-process with `node --import tsx` and `TAUT_DEV_HOST_LOGIN=true`; 17 steps, PASS/FAIL each, non-zero exit on any failure, `TAUT_E2E_KEEP=1` keeps the dir + log. The fake-key seat is drained (weight 0) right after it is created so the run falls through to the host login instead of waiting out `claude`'s invalid-key retries.

**Fresh-user path.** Root `pnpm dev` now runs only `@taut/server` + `@taut/web` (`pnpm dev:desktop` for Electron — before, `turbo run dev` also opened the desktop app). With an empty data dir: `localhost:5173/signup` → 200 SPA, `/api/auth/me` → 401 `Unauthorized`, `/api/health` → ok; `pnpm build && node apps/server/dist/main.js` serves `apps/web/dist` at `/` (`/agents` falls back to the SPA, hashed assets 200). `.gitignore` additionally ignores `*.db`, `*.db-shm`, `*.db-wal`, `master.key` anywhere.

**Browser:** the Claude-in-Chrome extension is connected but `tabs_context_mcp` timed out on the one allowed attempt; no other driver was used, no screenshots exist.

## Desktop shell — `apps/desktop` becomes the Taut client (instance picker, OS notifications, dock badge)

The Electron scaffold is now the desktop app, shaped like Slack's: a shell that loads a Taut instance's
own web client, plus the two things a browser tab cannot do — notifications when the window is hidden,
and a dock badge.

1. **Instance selection.** First launch renders the shell's own `Connect to your Taut` screen
   (`src/renderer`, `@taut/ui`). The URL is normalised to an origin, checked with `GET <url>/api/health`
   (5 s timeout, decoded against the server's `Health` schema so "answers, but is not Taut" is its own
   message), and stored as `{ instanceUrl, lastSeq }` in `app.getPath("userData")/instance.json` — a
   plain JSON file behind an Effect `Store` service, not `electron-store`. **Switch instance…**
   (`⌘⇧O`, app/File menu) returns to it and drops the socket. Dev default `http://localhost:5173`
   (Vite, so the web app hot reloads inside the shell), packaged default `http://localhost:3000`.
2. **Two preloads, two trust levels.** `src/preload/setup.ts` (`window.tautSetup`) only rides on the
   local Connect screen, so a page served by an instance can never repoint the shell at another server.
   `src/preload/index.ts` exposes `window.taut = { platform, version, setBadge, notify, onNavigate }`
   on the instance window and adds `.desktop` to `<html>`. The interface lives in
   `@taut/contract/desktop` (new subpath export, plain TS — it crosses `contextBridge`), which is how
   `apps/web` typechecks it without depending on the Electron package.
3. **Window security.** `contextIsolation`, `sandbox`, no `nodeIntegration`, `partition: 'persist:taut'`
   (cookies survive restarts — verified), `titleBarStyle: 'hiddenInset'` on macOS. A default-deny
   `session.webRequest.onBeforeRequest` allowlist on the partition passes only the configured origin
   (`ws://`/`wss://` normalised to it) plus `file:`/`devtools:`/`data:`/`blob:`; `will-navigate` and
   `setWindowOpenHandler` send everything else to the OS browser. `taut://c/<id>?thread=…` is
   registered (`open-url`, `second-instance`) and routes like a notification click.
4. **`src/main/realtime.ts` (Effect).** The main process opens its own `/ws?since=<lastSeq>` with the
   cookies read from the window's partition (`session.cookies.get` → `Cookie` header), decodes
   `ServerSocketMessage` with the contract schema, advances `lastSeq` and pushes events into a `Queue`.
   One connection attempt is a scoped Effect that fails when the socket closes; `Effect.retry` with a
   jittered `exponential ∪ spaced(30s)` schedule reconnects forever, so a 401 before login is just
   "not yet". `src/main/notifier.ts` consumes the queue: `notification` → OS `Notification` (body
   recovered from a 300-entry seq→message ring, click → focus + `taut:navigate`), `unread.changed` →
   `app.dock.setBadge`. In dev the runtime logs at `Debug`.
5. **Web side (additive, 2 files + 4 lines).** `apps/web/src/lib/desktop.ts` (is this the shell?),
   `apps/web/src/hooks/use-desktop.ts` (`onNavigate` → `router.history.push`, rewriting `/c/<id>` to
   `/dm/<id>` for DM channels, which is the one thing the main process cannot know); the `notification`
   toast in `realtime-cache.ts` is suppressed inside the shell; `.taut-shell` on the `_app`/`_auth`
   layouts gets a draggable, padded titlebar strip under `html.desktop`.
6. **Packaging.** `appId dev.taut.desktop`, `productName Taut`, `mac.category public.app-category.business`,
   `identity: null` (no signing), `protocols: taut`. `pnpm --filter @taut/desktop build` and
   `electron-builder --dir` are both green.

**Verified live (2026-09-08, this Mac, Electron 44.2.0, driven over the Chrome DevTools protocol).**
A throwaway seeded instance (`TAUT_DATA_DIR=/tmp/taut-desktop-data PORT=3100`, `pnpm --filter
@taut/server seed`) plus a shell with its own `--user-data-dir`:

1. Built app (`electron-vite preview` / `electron .`) opens the Connect screen from `file://…/out/renderer`,
   `window.taut` absent, `window.tautSetup` present, input pre-filled `http://localhost:5173` (dev) and
   `http://localhost:3000` in the packaged build. Left alone it stays there.
2. `connect('localhost:3100')` → probe → store → window replaced → `http://localhost:3100/login`; login
   as `owner@taut.local` routed into a channel. On the instance page `window.taut` is exactly
   `[platform, version, setBadge, notify, onNavigate]` (`darwin`, `0.1.0`), `<html class="dark desktop">`,
   `.taut-shell` computed `padding-top: 36px`. Restarting the packaged app reopened the instance already
   logged in (cookie persistence).
3. Socket: `ws: closed (401) upgrade rejected — retrying` at 1 s → 1.8 s → 3.9 s → 7.9 s while logged out,
   then `ws: connected ws://localhost:3100/ws?since=0` within a second of login. Replay produced
   `notifier: mention → /c/chn_…` and `notifier: badge 1 → … → badge 0`. A live DM from `dana@taut.local`
   produced `notifier: dm → /c/chn_…` + `badge 1`; a DM to `@bruno` queued a task and moved the badge.
4. OS banner: the **unsigned** bundle (and a bare `Electron .` run) is refused by macOS —
   `notification.on('failed')` now logs `the OS refused a notification: UNErrorDomain error 1`. After
   `codesign --force --deep --sign - Taut.app` the same DM produced macOS's own
   **"Taut" Notifications — Notifications may include alerts, sounds, and icon badges** authorisation
   prompt (screenshot taken); granting it is a user gesture, so the banner itself was not clicked through.

Gates: root `pnpm typecheck && pnpm lint && pnpm test` green, `pnpm --filter @taut/desktop build` green.

**Known gaps / found on the way.**

- **Pre-existing server bug, not desktop:** `/ws?since=0` against the repo's dev DB closes with 1011.
  27 of 160 rows in `apps/server/data/taut.db` are `message.created` events written by an older `Message`
  schema; `EventLog.since` is strict for the socket replay (`lenient` is only used by memory/inbox), so
  `SqlSchema.findAll` fails the whole 500-row page before a single frame is sent. Any client with an empty
  `lastSeq` — the web app in a fresh browser profile too — gets a socket that connects and immediately dies.
  Either make the WS replay lenient or migrate/prune the legacy rows.
- The dock badge sums per-channel `mentions`, plus `unread` for channels the shell has seen a `dm`
  notification for; `unread.changed` carries no channel kind, so a DM only starts badging after its first
  notification in this session.
- Switching instances recreates the window (the two preloads cannot share one), so position/size are lost.
- No tray icon, no auto-update (`publish` was removed from `electron-builder.yml`), no Windows/Linux run.

## `@taut/server` — `/ws?since=0` no longer dies (1011) on legacy event rows

- `EventLog.since` decodes row-by-row and skips rows that no longer match the contract `Event` (one `WARN` per row: seq, type, `payload.message.seq: is missing`); the `lenient` option is gone because every replay (socket, memory ingest, agent inbox) is now lenient. `append` stays strict.
- `EventLog.validate()` runs at boot, counts undecodable rows and logs one summary `WARN` — `N legacy events will be skipped on replay (type×n …)`.
- Migration `0006_backfill_message_seq` repairs the known shape: any payload with a `message` object lacking `seq` gets the `seq` of that message's `message.created` event (its own `seq` for a `message.created` row); optional `Message.error` is left absent. Verified on a legacy-shaped copy of the dev DB: 38 undecodable → 0; the real `apps/server/data/taut.db` was migrated the moment the file landed (a `tsx watch` dev server picked it up).
- Tests: corrupt row between two valid ones → `since()` yields `[1, 3]`, `validate()` reports 1, and a `/ws?since=0` client receives the valid event with the socket still `OPEN`; the migration test covers created/updated/already-repaired rows and idempotence. Live: `ws://localhost:3101/ws?since=0` as `owner@taut.local` streamed the whole log with no close.

## `@taut/web` + `@taut/contract` + `@taut/server` — rich text everywhere, and Slack's reply bar

Two things the screenshot made obvious: agent replies arrived as literal `**bold**`, and a thread was invisible from the channel it lived in.

**Rich text — `react-markdown` (`^10.1.0`).** The library choice: ~2M weekly downloads, actively maintained by the `unified`/`remark` team, React 19 ready, and — the reason it wins here — it builds React elements from an mdast/hast pipeline instead of `dangerouslySetInnerHTML`, so agent output cannot inject markup. Raw HTML in a body is escaped, not parsed (no `rehype-raw`). It is renderer-only: the wire format stays plain markdown, so nothing about how agents read or write a channel changes. Plugins pinned alongside it: `remark-gfm@^4.0.1` (tables, task lists, strikethrough, autolinks), `remark-breaks@^4.0.0` (a single newline is a line break — chat, not prose), `rehype-highlight@^7.0.2` + `highlight.js@^11.12.0` (fenced code), `unist-util-visit@^5.1.0` (for the mention plugin).

- `components/rich-text.tsx` is now the only renderer in the app. `message-bubble` uses it for every message in every channel, DM and thread; `components/markdown.tsx` (mandate + skill previews) delegates to it, so a preview looks like what the channel will show. The old hand-rolled block parser is gone.
- `lib/remark-mentions.ts` lifts `@handle` out of text into `<span data-mention>` before hast, mirroring the server's `parseHandles` — so `ted@example.com` stays a mailto autolink and `` `@handle` `` inside inline code stays literal. That was not true of the old `body.split(/(@[a-z0-9_-]+)/)`.
- `lib/highlight-languages.ts` registers 17 grammars instead of highlight.js' ~40-grammar "common" bundle; auto-detection is limited to a 12-language subset. The `rich-text` chunk is 395 kB / 119 kB gzip and code-splits away from the app shell.
- highlight.js is themed from the app's own tokens in `apps/web/src/styles/globals.css` (one palette, `.dark` overrides) rather than shipping two vendor stylesheets. The streaming caret moved there too: `.taut-caret > *:last-child::after` rides the end of the last block, so a growing agent reply no longer pushes the caret onto its own line.
- The composer grew a formatting rail (bold · italic · strike · link · bulleted · numbered · quote · code · code block) plus ⌘B / ⌘I / ⌘⇧X / ⌘⇧C / ⌘K. `lib/markdown-input.ts` holds the selection maths as pure functions: markers toggle off on a second press, list prefixes apply per line and convert between families, and `⌘K` drops the caret on `url`. The list shortcuts Slack puts on ⌘⇧7/8/9 are buttons only — `KeyboardEvent.key` for those depends on the layout.

**Thread reply bar.** `Message` gained `thread?: ThreadSummary` (`replyCount`, `lastReplyAt`, `participants`), set only on a root that has replies and never on a reply.

- `Messages.list` attaches summaries with two grouped queries per page over the existing `messages_thread_id` index; `loadMessage` attaches one for a single root, so editing a root does not drop its reply bar.
- A reply now re-publishes its root as `message.updated` — from `create`, `postAsAgent`, `createStreaming` (an agent's streaming placeholder counts immediately) and `delete`. No new event type: the web client's `updateMessage` already patches every loaded cache, so an open channel's "3 replies" moves the moment someone answers.
- `MessageBubble` renders the bar under a root: the facepile of up to 5 repliers (most recent first), "N replies", and "Last reply 2h ago" that swaps to "View thread →" on hover. It only appears where a thread can be opened, so the root inside the thread panel stays clean. The panel header now reads its count from the root's summary instead of counting loaded pages.

Gates: root `pnpm typecheck && pnpm lint && pnpm test` green (61 server tests). `domain.test.ts` now asserts the summary on the root, its absence on the reply and on a reply-less message, that an edit preserves it, and that a reply emits `message.updated` for its root. The pipeline was verified by rendering a message through `react-markdown` under Node: bold/italic/strike, `<br/>` from a single newline, tables, task lists, `class="hljs language-ts"` on the fence, two mention spans, `ted@example.com` as `mailto:`, `@notamention` untouched inside inline code, and `<script>` escaped to text.

**Not verified:** rendering in a browser — the Claude-in-Chrome extension timed out on three attempts, so nobody has looked at the reply bar or a highlighted code block with their eyes.

## Default skills — every agent is born with `no-ai-slop`

**What it is.** `apps/server/src/agents/defaultSkills.ts` holds the skills every agent starts with. `AgentsService.create` writes each one to `<home>/skills/<name>/SKILL.md` and inserts the `agent_skills` row, so it renders into `CLAUDE.md` / `AGENTS.md` through the existing `renderInstructions` path with no runtime change. The first (and so far only) default is `no-ai-slop`.

**Why it is scoped to chat.** Taut is a chat product; the loudest way an agent reads as a bot is how it writes in a channel. The skill's frontmatter and its first section confine it to text an agent sends with the `taut` MCP tools — channel messages, thread replies, DMs, and the summary posted when a task finishes. It explicitly excludes code, comments, commit messages, PR descriptions and files written to disk, and tells the agent to leave quoted logs, errors and other people's words untouched. Without that fence a "cut the filler" skill will happily rewrite a codebase.

**Provenance.** Adapted from the MIT-licensed [no-ai-slop](https://github.com/petergyang/no-ai-slop) skill by Peter Yang — attribution in `apps/server/NOTICE`, alongside `packages/runtime/NOTICE` for Sandcastle. The word list, pattern catalogue and closing checklist follow upstream. Two changes: the framing moves from "edit the draft the user pasted" to "constrain your own outgoing message", and upstream's separate `eval.md` is folded into a six-item **Before you send** section, since an agent mid-task will not open a second file.

- `create` seeds the defaults, so a new agent has the skill before its first task.
- `Agents.ensureDefaultSkills()` backfills agents created earlier. `DefaultSkillsLive` in `layers.ts` runs it once at startup, before anything serves traffic, and logs only when it wrote something. An agent that already has an `agent_skills` row is skipped, so an owner's edit to the body survives restarts. A deliberate delete comes back on the next boot — these are defaults, not policy; deleting one for good means removing it from `DEFAULT_SKILLS`.

Gates: `pnpm --filter @taut/server test` green (62 tests) at the time of writing. `phase3.test.ts` asserts the file lands with the right frontmatter on create, that `agents.get` lists it, that `ensureDefaultSkills` is a no-op when nothing is missing, that it leaves an owner-edited body alone, and that it restores the skill after a delete.

**Caveat.** The run above predates a concurrent edit in this working tree (`0007_agent_vaults_browser.ts`, `services/agentAccess.ts`, and the removal of `AgentVaultGrantRow` from `db/rows.ts`), which broke five suites for unrelated reasons. Re-run the server suite once that work lands.

## PWA — installable on a phone, with push notifications

**What now works.** The web client installs to a Home Screen and gets a notification when someone messages you, with the app closed. `pnpm --filter @taut/web build`, start the server with a VAPID keypair, open it over HTTPS on the phone → Add to Home Screen → avatar menu → _Turn on notifications_.

**Pinned versions** (`pnpm add --save-exact` where the repo pins; the workbox trio must match `vite-plugin-pwa`'s peers):

| package                                                  | version | where      | note                                                              |
| -------------------------------------------------------- | ------- | ---------- | ----------------------------------------------------------------- |
| `web-push`                                               | `3.6.7` | server dep | RFC 8291 aes128gcm + RFC 8292 VAPID; the reference implementation |
| `@types/web-push`                                        | `3.6.4` | server dev |                                                                   |
| `http_ece`                                               | `1.2.0` | server dev | test only — decrypts a captured push the way a browser would      |
| `vite-plugin-pwa`                                        | `1.3.0` | web dev    | peers vite `^7`                                                   |
| `workbox-build` / `-window` / `-precaching` / `-routing` | `7.4.1` | web dev    | exactly the version `vite-plugin-pwa@1.3.0` peers on              |

**Client.** `strategies: 'injectManifest'`, so `apps/web/src/sw.ts` is ours and Workbox only injects the precache list (74 entries, 1.5 MiB). The worker precaches the shell, falls navigations back to `index.html` (denylisting `/api/*` and `/ws`), `skipWaiting`s on install — a chat client must not run a week-old bundle against a moved API — and owns `push` / `notificationclick`. A click into an already-open window posts `taut:navigate` and the app routes it, so the SPA never reloads. `scripts/make-icons.mjs` generates the icon set (192/512, maskable, apple-touch, favicon) as raw PNGs with zlib, no image dependency; re-run it after changing the mark.

**Server.** `PushNotifier` (`src/push/notifier.ts`) subscribes to `Bus.streamAll()` and turns each `notification` event into one push per registered endpoint. It reads the message with its own join rather than through `Messages`: the recipient's membership was already checked when the notification row was written, and a daemon has no session to act as. Payload is `{ title, body, tag, url }` and nothing else — the worker runs with the app closed. `tag` is `taut:<channelId>`, so a second message replaces the first instead of stacking. Bodies are flattened and cut at 140 characters.

- `push_devices` (migration `0008`) is keyed on `endpoint`, so a browser that re-subscribes updates in place. Rows are **user**-scoped, not company-scoped: a phone follows its user across companies. A 404/410 from the push service deletes the row — the only thing that ever prunes dead installs.
- `/api/push`: `key` (the VAPID public key, or `{}` when unconfigured), `devices` (subscribe / list), `devices/remove`. Subscribe rejects any endpoint that is not `https:`.
- `TAUT_VAPID_PUBLIC_KEY` + `TAUT_VAPID_PRIVATE_KEY` (+ `TAUT_VAPID_SUBJECT`, default `mailto:admin@taut.local`). Unset → push disabled, one debug line, and the UI hides the toggle. **Invalid** → `web-push` throws on `setVapidDetails`; that is caught and degraded to disabled with an `ERROR` line, because a typo in an env var must not stop the server from booting (it did, once, during this work).

**Verified for real, not by inspection.** `test/phase8.test.ts` stands up an HTTPS "push service" the test owns, registers a device with a genuine P-256 ECDH keypair, posts `@dana can you take a look at the deploy?` in `#general`, and asserts on what actually arrived: `content-encoding: aes128gcm`, `TTL: 600`, `Urgency: high`, an `Authorization: vapid t=…, k=<public key>` header, a body that does **not** contain the plaintext, and — decrypting with `http_ece` and the receiver's private key — exactly `{ title: 'Owner in #general', body: …, tag: 'taut:<id>', url: '/c/<id>' }`. A DM gives `title: 'Owner'` and `/dm/<id>`. A `410` from the service deletes the row, and the next message pushes nowhere. Serving was checked against the built server: `/manifest.webmanifest` → `application/manifest+json`, `/sw.js` → `application/javascript`, `/icons/icon-192.png` → `image/png`.

Gates: `pnpm --filter @taut/server test` green (81 passed, 1 skipped, 12 files), `typecheck` and `lint` green across contract, server and web. `migrations.test.ts` updated to 8 migrations and the `push_devices` table.

**Known gaps.** (1) A push is sent even when you are looking at that channel in an open tab — the notifier does not consult presence or focus, so a laptop with Taut open will still buzz your phone. (2) Nothing marks a notification read from the phone; opening the app clears it the normal way. (3) No settings screen lists your registered devices, though `GET /api/push/devices` returns them with labels like `iPhone · Safari`. (4) **Not verified in a browser** — the Claude-in-Chrome extension timed out on three attempts again, so no one has watched a real notification arrive on a real phone; the crypto and the wire format are proven by the test above, the browser half (`sw.ts`, the permission flow) is not.

## Browser access + agent vaults — Phase 2A (server task wiring · agent-runtime `vault_list`/`vault_get` · e2e · docs)

Closes docs/build-plan-browser-vaults.md on the server side: Phase 1A (contract + services) and 1B (`@taut/runtime` browser spec + redactor, `@taut/taut-mcp` tools/protocol/inject) had landed; this wires them into the task runner and the agent-runtime API, and proves the vault path with a real `claude`.

**What works.**

- **Per-task redactor.** `TaskRunner` owns a `Map<TaskId, Redactor>`: one `makeRedactor()` per task, registered at the top of `run` (before the token exists), seeded with the seat secret + env/file secrets by `runtimeRunTask({ redactor })`, removed in the `ensuring` of `run` on every exit path (done, failed, crashed, cancelled). `registerSecret(taskId, secret)` returns `false` once the task is over.
- **Browser MCP wiring** (`agent.browserAccess`). `writeMcpConfig` passes `extraServers: { browser: browserMcpSpec({ provider: provider.name, homeDir: machine.paths.home }) }` — the home _as the machine sees it_ (`/home/agent` on docker, the host path on local) — so every runtime's config carries the second server: `mcpServers.browser` in claude-code's `.taut/mcp.json` and cursor's `.cursor/mcp.json` (+ `Mcp(browser:*)` in `.cursor/cli.json` via `cursorCliJsonFor`), `[mcp_servers.browser]` `required = false` in codex's `config.toml`, `mcp.browser` in `opencode.json`. claude-code's command gets `--allowedTools mcp__taut__* mcp__browser__*`; the instructions file gains `browserPromptLine(...)` under Tools; `<home>/.taut/browser/{profile,out}` are `mkdir -p`'d on the host side of the home before exec (Playwright does not create `--user-data-dir` parents).
- **Agent-runtime API.** `GET /api/agent-runtime/vault` → `Vault.listForAgent` mapped to `VaultItemSummary` (`scope: agentId ? 'agent' : 'company'`); `POST /api/agent-runtime/vault/get { vaultItemId }` → `Vault.resolveForTool` (audit purpose `tool`, `<home>/.taut/audit.log` line — written once, by the service), `Forbidden` → 403 `forbidden`, `NotFound`/malformed id → 404, `VaultLocked` → 503, and **409 `task_mismatch` when the task is no longer running** (no redactor left to mask the value — the still-valid token gets nothing). The plaintext is `registerSecret`ed before the response is written.
- **`taut_done` no longer doubles the reply.** First real MCP run showed `pongpong` / `4141`: claude-code calls `taut_done(summary)` and _then_ prints its answer; `AgentApi.done` used to append the summary to the empty streaming reply. Now `done` records it with `TaskRunner.noteDoneSummary` and the runner uses it only as the fallback body when the runtime printed nothing (then claude's own `result` text; the eager append survives only for a task not running in this process).
- **`pnpm e2e` gains 18 steps** (34 total; the last 8 — agent vera with browser access, a real `browser_navigate` + `browser_snapshot` of this server's own `/api/health` on loopback with the `version` field read back, `mcp.json`/CLAUDE.md checks, bruno without a browser — were added by the parallel session): dana (head) adds an agent-scoped `generic.secret` for bruno → absent from `/vault`, present in `/vault?agentId=` → DM "use vault_list, then vault_get on <label>, reply with only the length" → reply carries the length, the value appears in **no** message body and nowhere in the server log, `<home>/.taut/audit.log` has the `tool` resolve. Polling is now `wait_reply <after-seq>` so several agent turns fit in one DM.

**How to try.** `TAUT_DEV_HOST_LOGIN=true pnpm dev` → create an agent (either permission mode works since the `plan` → `default` remap, see gap 0) → `/agents/<id>` → Agent vault → Add secret → DM it "call vault_list, then vault_get on <label>, reply with the length of the value". For the browser: Browser access on, `npx playwright install chromium` once on the host, DM "open https://example.com and tell me the h1". Or `pnpm e2e`.

**Tests** (`apps/server/test/phase7b.test.ts`, fake provider): `browserAccess` on → `mcp.json` has `taut` then `browser` (node + `@playwright/mcp/cli.js`, `--headless`, no `--no-sandbox` on local, profile/out under the agent home, `PLAYWRIGHT_BROWSERS_PATH` set), `--allowedTools mcp__taut__* mcp__browser__*`, CLAUDE.md mentions `mcp__browser__*`; off → none of it; `/vault` lists seat + company + own agent item, never another agent's; `/vault/get` own + company items 200 with an `audit_log` row `tool` per call, another agent's 403 with no audit row, unknown 404, no token 401; after `vault_get` the fake runtime prints all three secrets and the message body / every event carries `••••<last4>` instead; after the task ends the same token gets 409; cancel drops the redactor. Server suite: **12 files, 81 passed, 1 skipped** (`phase8` web push landed meanwhile). `pnpm e2e` on this Mac with the host `claude` login (2.1.263): **34/34 PASS** — every vault step (the reply was exactly `41` for a 41-char secret, value in no message body, `tool` audit line present), every browser wiring step (`mcp.json` carries `browser` next to `taut`, CLAUDE.md mentions `mcp__browser__*`, bruno has none), and the browser round-trip itself: vera answered `0.0.0`, the `version` field of `/api/health`, read through headless Chromium. Getting there took four causes, peeled one per run: (1) vera in `plan` mode (`rejects browser_navigate`) → `auto-edit`; (2) Chromium refused to start — `socket directory path is too long (126 bytes); set PWTEST_SOCKETS_DIR to a shorter location` — because the local provider points the child's `TMPDIR` inside the agent home, so Playwright's default sockets dir (`$TMPDIR/pw-<hash>/browser/<guid>.sock`) blew the 103-byte Unix socket cap; `browserServer` now sets `PWTEST_SOCKETS_DIR=<os tmp>/taut-pw` on the local provider (~85 bytes total) and `ensureBrowserDirs` clears Chromium's stale `SingletonLock/Socket/Cookie` (the follow-up failure was `browser is already in use`); (3) one run was killed from outside by the parallel session (a `pkill` aimed at its own e2e) ~18 s after Chromium had launched into `<home>/.taut/browser/profile`; (4) the page: `https://example.com` gave `net::ERR_NAME_NOT_RESOLVED` — this Mac cannot resolve it (`curl` fails identically; see below), so the step now opens the server's own `/api/health` on 127.0.0.1, which needs no DNS and still proves the launch + navigation.

**Versions added.** `@playwright/mcp` `0.0.80` (dependency of `@taut/runtime`, Phase 1B). Nothing new on the server.

**Found on the way (not fixed here).**

- **claude-code `plan` mode refuses every MCP tool**: `Cannot call mcp__taut__vault_list while in plan mode` — whatever `--allowedTools` says. Until tonight no real task had ever called a `taut_*` tool (`pong` needs none), so the "verified only by tests" agent-runtime API had never been exercised by a real runtime. The e2e agent is now `auto-edit`. The proper fix is in `@taut/runtime`'s claude adapter (map Taut `plan` to `--permission-mode default` + the MCP allow-list; headless `-p` denies non-allowed tools without prompting), which is Phase 1B's file, not this phase's.
- `taut_inbox` schema: claude passed `{"since":"20"}` (a string) and got `invalid arguments: NonNegativeInt`; it retried without `since`. `@taut/taut-mcp` could accept a numeric string.
- A resumed session (`--resume`) keeps appending to the _first_ task's `~/.claude/projects/<first cwd>/…jsonl`, so per-task transcripts are not where the task's cwd suggests.
- **This Mac cannot resolve most public hosts right now**: `curl https://example.com` → `Could not resolve host` (DNS goes through a Tailscale resolver, `100.100.100.100`; `api.anthropic.com` answers, `example.com` does not). Chromium reported the same as `net::ERR_NAME_NOT_RESOLVED`. Not a wiring fault; the acceptance click "open https://example.com and tell me the h1" needs a machine with working DNS.

**Untested.** The docker `taut/agent` image with Playwright + `/opt/taut/mcp.js` is unbuilt and unrun (no docker tonight) — the `--no-sandbox` / `/opt/pw-browsers` path is covered only by `browserMcpSpec` unit tests; codex/cursor/opencode carry the `browser` server in their config files but no such runtime ran; nothing browsed a public site (DNS, above) — the local Playwright round-trip is proven against a loopback page only.

## The department boundary is hard — no cross-department gate

Reverses the §9 decision that a cross-department agent message posts a gate for two heads to approve. There is no gate. **An agent reaches only its own department**; anything beyond it is the head's job, human to human.

**What changed.**

- **`403 cross_department`** — a new error code next to `needs_gate`, meaning "there is nothing to wait for and retrying will not help". `AgentApi.route` returns it for `send`/`ask`/`handoff` to an agent outside the sender's departments, and the check now runs **before** the "only inside a task thread" rule, so an agent is never told to find a thread for a message no thread can carry (`apps/server/src/agents/agentApi.ts`).
- **Mentions are checked on the text**, not just on `to`. A mention is a task trigger, so `@ana` typed inside a message to a shared channel would have started a task in Ana's department. `post` now refuses any body whose `@handle`s resolve to a foreign-department agent (`foreignMention`, reusing `parseHandles`).
- **The inbox is symmetric.** `taut_inbox` drops every message authored by an agent outside the reader's departments, so a channel shared with another department cannot deliver one either (memoised per author, one `departmentsOf` per agent per call).
- **Scheduler note reworded**: `CROSS_DEPARTMENT_NOTE` (was `GATE_NOTE`) — "take it to your department head" instead of "requires a gate (not yet available)". The dispatch rule itself was already correct.
- **Tool descriptions** for `taut_send` / `taut_handoff` say the boundary is hard and name the head as the route; `describeToolError` renders `cross_department` as do-not-retry (`packages/taut-mcp`).

**Why.** A gate makes every cross-department exchange a click, and a click is not accountability: nobody owns the work on the other side. Routing through the head gives each side a named human, and it makes an agent's blast radius exactly one department — which is also what makes a loop cheap to kill (`pause` one agent, in one thread, in one department).

**How to try.** DM an agent in engineering: "send a message to @<a design agent>". The tool comes back `cross_department: … tell your department head instead`, no gate appears, and nothing lands in the other agent's inbox. Same for `taut_handoff`, and same if the handle is only mentioned in the body of a message addressed elsewhere.

**Tests** (`apps/server/test/phase4.test.ts`): `/send` to `@mila` (design) → 403 `cross_department`; `/send` to `@owner` with "looping in @mila" → 403 `cross_department`; a message posted as mila into bruno's DM never appears in bruno's `/inbox`. Server suite **12 files, 81 passed, 1 skipped**; `@taut/taut-mcp` **28 passed**.

**Still open.** The head's side is manual — a refused attempt leaves an agent-authored note in the thread, with no affordance for "raise this with @otherhead" (docs/agent-model.md, open questions).

## Handovers — the head's side of the boundary

The previous entry made cross-department agent messaging a hard block and left the head with nothing but a note in a thread. This gives them the queue and the one click: **`/handovers`**.

**What works.**

- **`handovers` table** (migration `0009_handovers.ts`). Every refused attempt — `taut_send` / `taut_ask` / `taut_handoff` to a foreign agent, an `@handle` of one inside a body, and the scheduler's own dispatch refusal — is recorded against the **sending agent's department head**, with the text the agent tried to send, the channel/thread it happened in, both departments and both heads. Repeat attempts collapse onto the first `open` row for the same (from, to, thread), so a looping agent cannot flood its head. Recording is best-effort: if it fails the agent is still refused (`Effect.catchAllCause` → a log line).
- **`GET /api/handovers`, `POST /api/handovers/:id/raise`, `POST /api/handovers/:id/dismiss`** (`services/handovers.ts`, `http/handovers.ts`). Rows are visible to the head of the department the attempt came from, and to admins — everyone else lists an empty queue. `raise` opens a DM with the **other** head and posts as the caller (the agent's words quoted, or a note the head wrote), then marks the row `raised`; `dismiss` closes it. Both 409 on an already-resolved row, 409 when the target department has no head, and 409 when the caller heads both departments (assign it yourself).
- **`/handovers` in the web shell** — a card per attempt (who → who, which department, the agent's text, "Open the thread"), a status filter, **Raise with @otherhead** behind a dialog whose empty textarea means "send the default note", and **Dismiss**. The sidebar entry shows up only when the queue has an open row, with a count badge; a member with no rows never sees it.
- **The refusal now says so.** `cross_department` and the scheduler's thread note both end with "the attempt is queued for your department head, who decides whether to raise it" instead of a flat no.

**Why not a gate.** A gate would let an agent's request reach another department once a human clicks approve. A handover cannot: resolving one only sends a DM between two humans, and the other head still has to assign the work to their own agent. The boundary is unconditional; the queue is only how a human hears about it.

**How to try.** DM an engineering agent "send a message to @<a design agent>". The tool comes back `cross_department`; open `/handovers` as Engineering's head → **Raise with @dana** → the DM lands in Dana's inbox with the agent's words quoted, the row moves to `raised`. Design's head sees only handovers their own agents caused.

**Tests** (`apps/server/test/phase4.test.ts`, `packages/contract/test/api.test.ts`, `apps/server/test/migrations.test.ts`): two refusals in one thread → exactly one open row; Design's head sees mila's attempts and never bruno's; a non-head's `raise` → 403; `raise` → `raised` + a DM whose body quotes the agent; a second resolve → 409; the new table and endpoint group. Server suite **12 files, 82 passed, 1 skipped**; whole monorepo `typecheck lint test` green (21 tasks).

**Not done.** No realtime badge and no notification of its own — the head learns about a handover from the thread note and sees the count when the page or sidebar refetches.

## Search — ⌘K over messages, agent notes, and "ask an agent" (2026-09-08, evening)

**What works.** `GET /api/search?q=&channelId?&limit?` (contract group `search`, `packages/contract/src/api/search.ts`) returns `{ messages: MessageHit[], notes: AgentNoteHit[] }`. Messages come from `messages_fts`, an FTS5 external-content index over `messages.body` (migration `0010_messages_fts.ts`, `porter unicode61` — the same tokenizer as each agent's `memory.db`, triggers on insert/delete/`UPDATE OF body`, `rebuild` backfills existing rows). The query is never raw FTS syntax: `toSearchQuery` quotes every token (AND) and prefix-matches the last one, so results appear while typing (`semv` → `Semver`). Visibility mirrors `Channels.canView` in SQL: admin+ see every `channel` plus their own DMs, members only what they belong to; `streaming`/`failed` bodies never match; `channelId` is checked with `load` + `requireView` (403 for outsiders). Ranking is `bm25()` then newest first; each hit carries the channel `{id,name,kind}` and a `snippet()` with matches between `\u0001`/`\u0002` (`SNIPPET_OPEN`/`SNIPPET_CLOSE`). Notes: for every company agent the caller may manage (`canManageAgent` — admin+ or the agent's department head, the vault/files rule), `MemoryIngest.memoryOf(agent)` → `search(q, { kind: 'note' })`, merged by memory score. `Search` lives in `AgentsLive` because of that dependency (`apps/server/src/services/search.ts`, `http/search.ts`).

**Web.** `command-palette.tsx`: the input is controlled; from 2 characters (`SEARCH_MIN_CHARS`) a 180 ms-debounced `useSearch(q)` (`placeholderData: keepPreviousData`, so the list does not flicker) adds three groups above the local fuzzy ones — **Messages** (channel · author · relative time · `reply` badge · highlighted snippet), **Agent notes** (@handle · tags · body → `/agents/:id`), **Ask an agent** (one row per agent: `openDm` + `messages.create` with a memory-search prompt, then the DM opens; the agent already has `memory_search`/`memory_recall_thread`). Server rows pass `keywords={[query]}` so cmdk's own filter never hides them. Picking a message navigates to `/c/:id?at=<msg>` (or `/dm/:id`; a reply opens `?thread=<root>` instead): `MessageList` gets `focusId`, pulls older pages (≤ 12) until the message is loaded, `scrollIntoView`s it, flashes `bg-primary/10` for 2.5 s and `ChannelView` drops `?at=` with `replace: true`.

**Tests.** `apps/server/test/search.test.ts` (2 tests, real HTTP): owner sees the `#atlas` hit + the DM hit + bruno's note (tags, agentId, snippet markers); `semv` prefix; `channelId` filter; a plain member sees only her DM, no notes, and 403 on a channel she is not in; an edit re-indexes, a delete drops the row; `*` → empty. `migrations.test.ts` now expects 10 migrations and the five `messages_fts*` tables. `pnpm --filter @taut/server test`: **84 passed, 1 skipped**; contract/server/web `typecheck` and `lint` clean.

**Not done / decisions.** No embeddings — "fuzzy" here is stemming + last-token prefix (per §10 MVP cut; sqlite-vec/RRF stay deferred). Notes search only reaches agents whose memory consumer is running (`memoryOf` is `None` for a stopped one). Hits inside a thread open the thread panel but are not flashed there. No "see all results" page — the palette shows the top 20. The Claude-in-Chrome extension timed out twice on `tabs_context` tonight, so the UI path is verified by typecheck/lint and the live server (`/api/search` → 401 unauthenticated, `messages_fts` present in `apps/server/data/taut.db`), not by a click-through.

## Agent avatars — one face everywhere, no frame, motion while working (2026-09-08, evening)

**Bug.** A DM header showed Bruno with a different face than his messages. `EntityAvatar` draws agents with a blobatar seeded from `seed` and falls back to `name` when none is passed; the DM route, the ⌘K palette, `/agents`, `/handovers` and the department settings list never passed one, so those surfaces hashed `"Bruno"` while the bubbles hashed `seedOfAgent(agent)`. Every agent call site now passes `seed` (`partner.avatarSeed`, `agent.avatarSeed`, `seedOfAgent(agent)`); the component's doc says why it is mandatory.

**Look.** Agents render `background={false}`: the character stands free, the framed tile is reserved for humans. Motion: `blobatar/motion.css` is imported once in `entity-avatar.tsx`; when an agent's `presence` is `working` the blobatar switches to `animate="always"` (inline SVG) and the corner bot glyph turns amber — the DM header, sidebar and `/agents` cards already feed `usePresence`, and a streaming message bubble passes `working` for its author. `prefers-reduced-motion` keeps it static (library behaviour).

**Verified:** web `typecheck` + `lint` clean. Not clicked through (Claude-in-Chrome still timing out).

## Runtime parity — file grants and the browser hint on every runtime (2026-09-08, afternoon)

**Question answered.** An agent's home (`AGENT.md`, `skills/`, `memory/`, `inbox/`, the browser profile), its vault access and its MCP tools were already provider-independent: `instructions.ts` renders the same mandate + skills + memory into `CLAUDE.md` / `AGENTS.md` / `.cursor/rules/taut.mdc`, and `inject.ts` mounts `taut` + `browser` into all four runtimes. Two things were Claude-only and are now not:

- **File grants reach every runtime.** `renderInstructions` gained `fileGrants` → a `## File access` section (path + read-only/read-write) rendered for all four kinds (`packages/runtime/src/instructions.ts`). It was the only channel missing on cursor (`cursor-agent` has no `--add-dir`; `--force` scopes nothing) and on opencode. OpenCode additionally gets a `permission` block in `opencode.json` from `opencodePermission(grants)` (`adapters/opencode.ts`): `external_directory` allows each granted dir (`<dir>`, `<dir>/**`), and `ro` grants deny `edit` under them — the one runtime where read-only is enforced rather than stated. `runTask.ts` now loads the grants before `writeMcpConfig` and passes them to both. claude-code / codex keep `--add-dir`; the per-runtime table lives on `BuildCommandInput.addDirs`.
- **Browser hint names the tools the way the runtime does.** `browserPromptLine(homeDir, kind)`: `mcp__browser__*` on claude-code, `browser_*` (`browser_browser_navigate`) on opencode, "the `browser` MCP server's tools" on codex and cursor (`packages/runtime/src/browser.ts`, `BROWSER_TOOL_EXAMPLES`).

**Tests.** `packages/runtime/test/{browser,instructions,otherAdapters}.test.ts` (21 pass): per-runtime hint wording, the file-access section before the Taut section on all four kinds and absent without grants, the permission block shape, and `addDirs` ignored by the cursor/opencode builders.

**Still unverified.** Codex/cursor/opencode remain config-only (no live account run from Taut). The `permission` object form follows the published schema at https://opencode.ai/config.json (2026-09-08); the older SDK typings (1.14.21) only show the plain-string form, so an old `opencode` may reject the map. Switching an agent's runtime keeps its home but starts fresh sessions: resume ids are keyed per runtime.

## Agent avatars — a busy agent becomes its orb (2026-09-08, evening)

**What works.** While an agent's presence is `working`, its blobatar morphs into a thinking orb in the agent's own colour, and morphs back into the creature when the run ends. The orb is `thinking-orbs` (pinned exact: `thinking-orbs 0.3.1`, MIT, React ≥18, plain 2D canvas) — but that library paints strictly greyscale, so `apps/web/src/components/agent-orb.tsx` takes its geometry (`MODE_FRAMES` + `resolvePreset` from `thinking-orbs/engine`, the portable half it exposes for its native ports) and paints it itself, mapping the dots' ink value onto a ramp built from the blobatar's `head` colour (`_layout(seed, { background: false, traits })` from `blobatar` — the same resolver `<Blobatar>` runs on the same inputs, so the colour matches by construction). Depth still reads: near dots go toward the page's ink, far dots fade toward the page; `.dark` on `<html>` flips the ramp (one shared `MutationObserver`). Orbs run at the library's tuned preset (`20` for `size="sm"`, `64` otherwise, DPR ≤ 2) and CSS scales the bitmap. `prefers-reduced-motion` freezes on the library's still frame; offscreen or hidden-tab orbs stop their rAF (`IntersectionObserver` + `visibilitychange`); every orb reads `performance.now()`, so several working agents spin in phase.

**The morph.** `entity-avatar.tsx` stacks the face and the orb; on a presence flip both are mounted for 380 ms while the leaving layer shrinks/blurs/fades (`taut-morph-out`) and the arriving one grows out of the same point (`taut-morph-in`, `styles/globals.css`), then the leaving layer unmounts. Keyframes, not transitions, because an entering layer has no prior style to transition from; nothing animates on mount, so an avatar born busy is born an orb. Reduced motion → instant swap. The `working` blobatar idle animation (`animate="always"` + `blobatar/motion.css`) is gone — the orb is the motion now.

**Everywhere.** `EntityAvatar` gained `id?` (the member id) and subscribes agents to `usePresence(id, 'idle')` itself; an explicit `presence` still wins (a streaming reply is `working` regardless, and now shows the `composing` orb via the new `orb?: OrbState` prop). Every agent surface passes one or the other: message rows and thread reply-bar faces, ⌘K (DMs + agents), DM sidebar rows and header, member picker, channel members sheet, department settings members, `/agents` cards, the agent page header + avatar preview, `/members`, `/tasks` rows, `/handovers`, the forward dialog, profile cards and the composer's @mention list. Humans are untouched (no auto-presence; the dot still needs `presence`).

**Verified:** web `typecheck` (no new errors; the eight pre-existing ones in `src/lib/api.ts:985` and `src/lib/message-actions.ts` belong to the in-flight message-actions/routines work) + `lint` clean; engine + palette resolution checked under Node (`working@64` → 516 dots, `composing@20` → 208 dots, `_layout(seed).palette.head` stable with and without a shape trait). Not clicked through — Claude-in-Chrome timed out twice on `tabs_context`. A temporary harness is left in place for the pass: http://localhost:5173/orb-preview.html (`apps/web/orb-preview.html` + `src/dev/orb-preview.tsx`) toggles four agents idle↔working at every size in both themes and shows four orb states side by side; **delete both files once seen**.

## Message actions — reactions · forward · copy (2026-09-08, afternoon)

Slack's hover bar on every message (`docs/build-plan-message-actions.md`): **✅ 👀 🙌** quick
reactions · add reaction (our own picker: recent row + ~120 curated emoji, searchable, keyboard) ·
reply in thread · forward · ⋮ (copy text, copy link, edit, delete — the last two author/admin only).
Reaction chips sit under the body: click toggles, `title` names who reacted, `+` opens the picker.
Everyone in the channel sees a reaction land live.

**How:** `Message.reactions` (always an array, like `attachments`), table `message_reactions`
(migration `0013`), `PUT|DELETE /api/messages/:id/reactions/:emoji` → plain `message.updated`.
Anyone who can view the channel may react; 1–8 code points, no letters/digits/whitespace, at most
20 distinct emoji per message (`422` beyond). Forward is client-side: the original lands in the
target channel/DM as a `>` quote with `— Forwarded from @handle in #channel · view original`;
copy link gives `/c/<channel>?at=<msg>` (`/dm/...` for DMs, `?thread=<root>&at=<msg>` for replies),
which scrolls-and-flashes like a search hit.

**Try it:** hover any message → ✅; open a second tab, watch the chip appear; `+` → type "party"
→ 🎉; ⋮ → Copy link → paste into the composer → send → click it.

**Verified:** `apps/server/test/reactions.test.ts` (13 tests: hydration on `messages.list`, count/
order, idempotent PUT, own-only DELETE, 403/404/422s, 20-emoji cap, `/ws` frame, delete cascade)
and `packages/contract/test/{api,schema}.test.ts`; workspace typecheck + lint clean. Browser pass:
see the end of this entry.

**Gaps (`TODO(plan)`):** save/bookmark, mark unread, remind me; agents cannot react yet (the
table already has `member_kind`); attachments are not forwarded; no skin tones / full emoji set.

## `@taut/contract` · `@taut/server` · `@taut/web` — Routines (scheduled agent prompts)

Contract doc: `docs/build-plan-routines.md` (D1–D12, frozen before any code was written).

A **routine** is a named prompt, owned by one agent, that runs on a schedule. Firing does not
create a task directly: the server posts `@handle <prompt>` into a channel **as the routine's
owner**, and the existing `Scheduler` picks the mention up. One dispatch path, so every §9 gate
still applies and the run appears in the channel as an ordinary turn — threads, notifications,
unread counts, turn caps, handoff depth, cancel and `byTrigger` idempotency all come for free.

**Schedule is structured, not a cron string** (`packages/contract/src/domain/schedule.ts`):
`interval` (every N min) · `daily` (every N days from an anchor) · `weekly` (weekdays) ·
`monthly` (days of month, incl. `'last'`) · `cron` (escape hatch, `effect/Cron`). Three pure
functions — `nextRuns` / `describeSchedule` / `validateSchedule` — live in the contract so the
"next 3 runs" the human approves in the editor is computed by the same code the daemon fires on.
Times are wall-clock in the routine's IANA zone; `Timezone` and `CronExpression` reject bad
values at decode, so a typo cannot produce a routine that silently never runs.

**DST rule** (`disambiguation: 'compatible'`): a wall time that does not exist on spring-forward
fires once, shifted forward by the gap — 02:30 → 03:30 EDT, the same UTC instant as the previous
day's 02:30 EST, so runs stay exactly 24 h apart. An ambiguous fall-back time fires once, at its
first occurrence. Instants are deduped per day, so `['02:30','03:30']` yields one run, not two.

**Server**: migration `0012_routines.ts` (`routines` table + `tasks.routine_id`); `Routines`
service (writes take `requireManageAgent`; `nextRunAt` recomputed from _now_ on every write and
every tick, `NULL` when disabled, so `due` is one indexed range scan); `RoutineRunner`, a 30 s
daemon whose `tick(now)` takes an explicit clock so tests never sleep; `Messages.postAsUser`, a
standalone sibling of `postAsAgent`. `Scheduler.postAndDispatch` holds the dispatch lock across
post + dispatch so the bus consumer cannot race it — the task is created once and carries
`routineId` from the start.

Four policies, each with its own test: **missed runs collapse to one** (a server down for three
days fires once, not 72 times) · **no overlap** (previous run still live → `skipped`, slot
advanced) · **default target is the owner↔agent DM**, opened on first fire · **a paused agent
skips and still advances**, so unpausing never releases a burst.

**Web**: a `Routines` tab between Skills and Files. The picker is the point — five modes, seven
weekday chips with Every day / Weekdays / Weekends presets, a 31-cell month grid with
**All · Odd · Even · Clear**, multiple times per day as a chip row, timezone select, and a live
preview showing the sentence plus the next three runs in the routine's zone. Both grids are
roving-tabindex (←/→ ±1, ↑/↓ ±7, Home/End); switching modes is lossless.

**Verified:** `packages/contract/test/schedule.test.ts` (19 tests: all five kinds, `everyNDays`
across a month boundary, day 31 skipping February, `'last'` in a leap February, real Toronto
spring-forward and fall-back, cron parity with `Cron.next`) and `apps/server/test/routines.test.ts`
(10 tests: the four policies isolated, Forbidden for a non-head member on all four writes,
`runNow` + `Conflict`, a deleted agent's routine not wedging the tick). Workspace-wide
`pnpm -r typecheck` clean across all 10 projects; `apps/server` 117 passed / 2 skipped;
`apps/web` typecheck + build clean. `/api/routines` answers `401` (mounted, auth-guarded) on the
running dev server.

**Not verified:** no browser pass — the Claude-in-Chrome extension was connected but timed out on
two attempts, apparently waiting on a permission prompt in its side panel. Every claim about
rendering and interaction above rests on typecheck, lint and build only.

**Gaps (`TODO(plan)`):** no run history beyond `lastRunAt`/`lastTaskId`/`lastStatus` (task history
already exists and is filterable); no retry on a failed run; no per-routine concurrency beyond the
skip; agents cannot create their own routines; "Deliver to" resolves the agent's channels
client-side because no "channels this agent is in" endpoint exists.

## Attachments (images + files in chat) (2026-09-08, evening)

**What works — both directions.** Humans and agents exchange images and any other file in channels, DMs and threads, Slack-style (`docs/build-plan-attachments.md`). A human attaches through the composer's paperclip (`<input type="file" multiple>`), by dropping files onto the composer (highlight ring while dragging) or by pasting an image from the clipboard; a **pending strip** above the format rail shows each file (image thumbnail or icon + name + size), its upload spinner, an error state with retry and a remove ×. Send is enabled with text **or** at least one uploaded file, never while an upload is running; Enter sends as before. In the channel, the thread panel and the desktop app (which loads this bundle) images render in a responsive grid (click → lightbox with the full image and a Download link), other files as a card with type icon, name, human size and Download (`apps/web/src/components/attachment-list.tsx`, rendered by `message-bubble.tsx`; failed messages keep their attachments). An agent that is @mentioned or DM'd **sees** the file: when the task is built (and whenever `taut_inbox` returns the message) the bytes are copied into its home at `inbox/<messageId>/<name>` and the prompt line reads `[10:01] @owner: <body or "(no text)"> [attachments: /home/agent/inbox/msg_x/shot.png (image/png, 120 KB)]`; Claude Code reads PNG/JPEG natively, so "what is in this screenshot?" works. An agent **sends** files back by passing `attachments: ["<path inside its home>"]` (machine-absolute or home-relative, max 10) to `taut_send` or `taut_done`; the server copies the bytes into the blob store, links them to the posted message and the human sees them exactly like an upload.

**Try it.** `TAUT_DEV_HOST_LOGIN=true pnpm dev` → any composer → paperclip / drop / paste, add text or not, Send. DM an agent a screenshot with "what does this show?" — the reply describes it. Then "create `work/notes.csv` with three rows and send it to me with taut_send attachments" — a file card appears in the DM, Download works. Env: `TAUT_ATTACHMENT_MAX_BYTES` (default 25 MiB per file).

**Contract.** `@taut/contract`: `AttachmentId` (`att_`), `Attachment` (`id, companyId, channelId, messageId?, uploaderKind, uploaderId, name, mimeType, size, createdAt`), `Message.attachments` (always an array in memory, absent-or-array on the wire), `CreateMessagePayload.body` may be empty when `attachmentIds` (≤ 10) is present. Endpoints, all behind the session cookie: `POST /api/attachments` (multipart `channelId` + `file`, needs post rights on the channel → `Attachment` 201, an _orphan_ until sent) · `POST /api/messages` with `attachmentIds` (links atomically inside the message transaction) · `GET /api/attachments/:id` · `GET /api/attachments/:id/content` (streams the bytes; `Content-Disposition: inline` only for `image/png|jpeg|gif|webp`, `application/pdf`, `text/plain`, `video/mp4`, `audio/*`, `attachment` for everything else including SVG; `X-Content-Type-Options: nosniff`; `Cache-Control: private, max-age=31536000, immutable`; `?download=true` forces `attachment`). `@taut/taut-mcp`: `SendRequest`/`DoneRequest.attachments?: string[]`, `InboxMessage.attachments?: { name, mimeType, size, path }[]`, `SendResponse.attachments?: { id, name }[]`; a path outside the home, missing, or over the limit is a 422 `validation` naming the path. Server: migration `0011_attachments` (table `attachments`, indexes on message and on orphans), bytes at `<dataDir>/companies/<slug>/attachments/<attachmentId>` (no extension; the name lives in the row), `services/attachments.ts` (`upload · get · openContent · listForMessages · link · deleteForMessages · materialise · sweepOrphans`), `http/attachments.ts` (`content` is a raw handler streaming with an explicit content type), `agents/agentApi.ts` (`resolveAttachments`: strip the machine home prefix or treat as home-relative, must resolve inside the host home, regular file under the limit), `agents/runTask.ts` (`materialise` for the trigger and every context message, best effort per file). Home layout (agent-model §5): `inbox/<messageId>/<name>`, one folder per message. Decisions D1–D9 hold, with these deviations: **D5** the download switch is `?download=true` (`Schema.BooleanFromString`), not `=1`; **D6** the transport backstop refuses a multipart request whose declared `Content-Length` exceeds the limit **+ 4 KiB** of headroom for boundaries and part headers, and the exact per-file check (`"x.bin" is 98 KB; the limit is 98 KB`) is `Attachments.store`; **D7** deleting a thread root also removes the files of its replies; **D3** the task runs with `--add-dir <home>/inbox` (claude-code, codex) — see the first fix below. **D9** unchanged: search and memory ignore attachment bytes and names (`TODO(plan)`).

**Two fixes from the verification pass.** (1) `apps/server/src/agents/runTask.ts`: the runtime's cwd is `work/<taskId>`, so `inbox/` was outside claude-code's permitted roots and headless `acceptEdits` auto-denied the Read — the first `pnpm e2e` run "passed" with bruno answering _"Can't read the attachment: every read of the inbox file … is permission-denied"_ because the step only asserted a non-empty reply. Every task now passes `addDirs: [<home>/inbox, ...fileGrants]` and the e2e step asserts the reply names the colour (`scripts/e2e.sh`, a 64×64 solid-red PNG built inline — a 1×1 image is too small for the model to name a colour reliably). (2) `apps/server/src/http/server.ts`: the per-file cap was `Multipart.MaxFileSize`; with platform 0.97.1 a part that trips that cap mid-file leaves its channel waiting on an already-ended mailbox and the request **hangs with no response** (curl: 0 bytes received after 8 s, server at 0 % CPU; `Multipart.makeChannel` never marks the part finished on `ReachedLimit`). Replaced by `MultipartLengthBackstopLive`, an API-level middleware that answers 422 `Validation` from the declared `Content-Length` before parsing (browsers' `fetch` + `FormData` and curl always send it); a chunked body with no length spools to the temp dir and gets the same 422 from `Attachments.store`. `agents.uploadFile` (Files tab) shares the backstop. The test file gained the far-over-the-cap case with a 5 s timeout.

**Verified.** `pnpm typecheck` / `pnpm test` green for every attachments package (contract 39, taut-mcp 30, server 118 + 1 skipped, runtime 60 + 13 skipped, memory 14). `apps/server/test/attachments.test.ts` (11): _upload → create with ids → list and thread carry attachments_ · _content: bytes round-trip with the D5 headers; ?download and non-inline types_ · _authorization (D8): non-member 403, another user's orphan cannot be linked, empty message 422_ (+ the far-over-limit 422 without a hang) · _lifecycle (D7): deleting a message removes rows and files; the sweep removes old orphans_ · _agent (D3): a DM with a file is materialised into inbox/<messageId>/ and named in the prompt_ · _agent: taut_inbox lists the file with its machine path_ · _agent (D4): taut_send with a home-relative or machine-absolute path posts the file; outside → 422_ · _agent (D4): taut_done attachments land on the reply; the reply keeps them once finalised_ · pure mime/disposition cases. `pnpm e2e` **44/44** three times tonight (steps 16–17: upload `pixel.png` → send with `attachmentIds` → content streams the same bytes inline → bruno replies `red` → file at `<home>/inbox/<messageId>/pixel.png`; bruno creates `hello.txt`, `taut_send` with `attachments`, a DM message from him carries `hello.txt`, its content endpoint returns `hi` as `text/plain`). curl smoke on a seeded throwaway data dir (dev server, `TAUT_ATTACHMENT_MAX_BYTES=100000`): login → DM → 64×64 PNG upload 201 orphan → message with empty body + id 201 → list carries it → content 200 with exactly the D5 headers and identical bytes → `?download=true` → `attachment` → SVG upload served `attachment` → declared `octet-stream` named `.csv` becomes `text/csv` → whitespace body without files 422 → 200 000 B 422 in 12 ms, 103 000 B 422 (backstop), 100 500 B 422 (exact check), chunked 200 000 B 422, 100 000 B 201 → dana (not in the owner↔bruno DM) 403 on metadata and content → dana linking the owner's orphan 403 → anonymous 401. Built server (`pnpm --filter @taut/web build`, `pnpm --filter @taut/server build`, `node apps/server/dist/main.js`): `/` and `/channels/x` serve the SPA, the hashed asset loads and references `api/attachments` + `download=true`, and `/api/attachments/:id/content` returns the bytes with the same headers.

**Browser pass (Claude-in-Chrome, 16:34, seeded instance on :3907).** Uploaded `red-square.png` + `notes.txt` through the composer's file input: both showed in the pending strip (red thumbnail, file card with size), Send posted one message with both attachments, the image rendered inline and the text file as a card, bruno (auto-edit) replied "Red / hello from the owner" and posted `reply.txt` back via `taut_send attachments`, which rendered as a card and downloads as `sent by bruno`. The lightbox opened on click with name, size, mime and Download. Not exercised in the browser: drag-and-drop, clipboard paste, the "New message" / ⌘K dialogs (synthetic clicks did not open them — worth a human look), the desktop app.

**Not verified.** The desktop's own `index.html` CSP already allows `img-src 'self' data:` and the chat bundle comes from the server, so no change was needed but it was not opened. Docker provider untouched (the inbox path inside the container is `/home/agent/inbox`, passed as `--add-dir`, unrun). Codex uses `--add-dir` too; cursor/opencode ignore it, so on those runtimes reading `inbox/` depends on their own permission model. No thumbnails or image dimensions (D6 `TODO(plan)`); D9 text extraction into memory still `TODO(plan)`; a multipart body with no `Content-Length` is bounded only by disk until `Attachments.store` rejects it.

## Agent workspace — terminal · processes · browser live view · take control (2026-09-08, evening)

Contract doc: `docs/build-plan-workspace.md` (D1–D18). One new **Workspace** tab on the agent page
(managers only, D3) with the agent's box: a machine card (status, Start/Stop, **Connect**), a
terminal, the process list, and — for agents with `browserAccess` — a live view of their Chromium
with **take control**.

**Pinned** (exact, `pnpm add --save-exact`): `@xterm/xterm 6.0.0`, `@xterm/addon-fit 0.11.0` (web
only; lazy-loaded, so the agent page's bundle is unchanged for anyone who never opens the tab, D14).
No other new dependency: the CDP client is ~150 lines over the already-pinned `ws 8.21.3`, and the
relay into the box is `node -e`, which the agent image already carries.

**How.** `@taut/runtime`'s machine seam gains three methods, all refused on `local` with
`MachineUnavailable` (D2): `openPty` (docker `exec` with `Tty: true`, no `demuxStream`,
`TERM=xterm-256color` forced over the image's `TERM=dumb`, `exec.resize`; the child lives in the
caller's `Scope`), `openTunnel(port)` (a byte relay through `docker exec node -e …` to a loopback
port _inside_ the container — how the server reaches Chromium's debug port without that port ever
leaving the container's network namespace, D18), and `signalTasks('STOP' | 'CONT')` (every process
carrying a `TAUT_EXEC_ID` without the `TAUT_WORKSPACE=1` marker, D15). `browser.ts` gains
`ensureBrowserDaemon` — an idempotent bash script that starts one headless Chromium on
`127.0.0.1:9222` with the persistent profile — and `browserMcpSpec({ cdpEndpoint })`, which makes
`playwright-mcp` attach to that Chromium (`--cdp-endpoint`) instead of launching its own; with the
endpoint it binds `browser.contexts()[0]`, the profile's default context, so a login done by hand
in the live view is the one the agent's tools see. The `local` provider keeps the old
self-launching spec byte for byte.

Server: `GET/POST /api/agents/:id/machine[/start|/stop]` → `MachineInfo`, `GET …/machine/processes`
(`ps -eo pid,ppid,etimes,pcpu,pmem,args`, parsed), `GET …/files/content?path=` (bytes of one home
file, for the gallery). `/ws/terminal?agentId=…` is a second WebSocket path next to `/ws` (D6) with
JSON frames from `@taut/contract/terminal` (`data` base64, D7): PTY both ways, `frame` (JPEG,
8 fps, q60, ≤1280 wide via `Page.startScreencast`), `browser` state, `control` hand-over, `input`
(whitelisted mouse/key shapes, mapped server-side to `Input.dispatch*Event` — never a raw CDP
command). Limits (D10, each tested): one PTY per (agent, viewer), 4 per agent, 15 min idle, 2 h
cap, 1 MB/s output with one `[output truncated]` marker per episode. Take control (D12) is off by
default and exclusive across viewers; with a running task the button reads "Pause agent & take
control" and the runtime is `SIGSTOP`ped for the hold, `SIGCONT`ed on release, disconnect or idle
(D15). `input` frames and screencast data are never logged (D17). Sessions are memory only (D4,
no migration).

**CDP reachability (the plan's blocking risk):** option (c), the exec relay. (a) — binding the
debug port to the container's `taut-<slug>` address — is unreachable from a macOS dev host (bridge
IPs do not route) and would expose every agent's browser to its sibling containers on the same
company bridge; (b) needs `socat` in the image for what `node` already does.

**Try it** (docker provider): agent page → Workspace → _Start & connect_: a bash prompt as
`agent` in `/home/agent`; `ps` / `top` work in colour. Turn _Browser access_ on (Runtime tab or the
Browser pane's switch), reconnect: the live view starts; _Take control_ → click into the page,
type, scroll; _Release control_. With a task running the button pauses the agent first.

**Verified:** `packages/runtime/test/docker.test.ts` behind `TAUT_TEST_DOCKER=1` (PTY: TERM /
COLUMNS / LINES / uid, resize, exit code, scope kill; tunnel echo + refused port; STOP/CONT with the
PTY shell left alone), `local.test.ts` (all three refusals), `browser.test.ts` (cdp spec, daemon
script flags); `apps/server/test/{terminalLimits,workspace,browserLive}.test.ts` (registry,
throttle, `ps` parsing; endpoints + D3 gate, gallery read with traversal/404/403, socket 400/401/
403/404, echo/resize/exit, 4409/4429, idle 4408, cap 4410, throttle marker, `local` refusal;
`browser: off` without the flag, starting → live with ≤ 8 fps pacing and acks, input dropped
without control and scaled with it, exclusivity and release on disconnect, pause → STOP / CONT).
`packages/contract/test/api.test.ts` lists the new endpoints.

**Gaps (`TODO(plan)`):** no kill button in Processes (D13); no system message in the agent's
channel when a shell is opened (D10); `runTask.ts` still builds its `MachineSpec` inline next to
`services/workspace.ts`'s `machineSpecFor`; a long hold on a paused task can trip that task's own
5-minute idle timeout.

## Same-department agents talk in any channel they share

`@pablo` was told to ask `@bruno` something. Both are agents in Engineering, both are in
`#engineering`, and pablo did the obvious thing: `taut_send(to: "#engineering", text: "@bruno …")`.
Bruno answered with the department-boundary note — _"cross-department agent messaging is blocked"_ —
which was wrong twice: they are in the same department, and the reason was not the department at all.

**The cause.** `Scheduler.dispatchTo` required `threaded && together`: a same-department mention only
became a task **inside an existing thread**. A top-level post in a shared channel has no `threadId`,
so it fell through to the same `else` branch as a cross-department attempt and reused its note.

**The rule now** (docs/agent-model.md §9, `agents/scheduler.ts`, `agents/agentApi.ts`):

| from → to                                                   | rule                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- |
| agent → agent, same department, in a channel both belong to | **allowed**, thread or top level                                              |
| agent → agent, same department, DM                          | refused — a DM belongs to the human in it; the agent is told to use a channel |
| agent → agent, other department                             | unchanged: `403 cross_department`, a handover row for the sender's head       |

Channel membership already _is_ the visibility contract — everyone in `#engineering` sees the
exchange — so a thread added nothing the channel did not give. What stays hard is the boundary
(department) and the shape (never a DM).

Three secondary fixes rode along:

- **The note now matches the reason.** `AGENT_DM_NOTE` for a DM, `CROSS_DEPARTMENT_NOTE` only for the
  boundary. A handover row is recorded only for a real cross-department attempt.
- **Depth still counts across channels.** The parent used to be "the author's live task _in this
  thread_", which a top-level post never has, so a handoff chain could reset its depth by posting at
  the top of a channel. `Tasks.liveOf` falls back to the author's live task anywhere, so
  `MAX_HANDOFF_DEPTH` holds.
- **Better refusals.** `taut_send` to a teammate from a DM, or to a teammate who is not in this
  channel, now says which channel move to make instead of "only allowed inside a task thread".

**Verified:** `apps/server/test/phase4.test.ts` — "same-department agents reach each other anywhere
they are both members; never in a DM": bruno posts `@nina …` at the top of `#engineering` with no
thread and no live task → nina gets a task and no note; the same mention in the owner's DM → the DM
note and no task. The existing cross-department and turn-cap tests are unchanged and still pass
(phase4 12/12).

## The composer: mention anyone, and see the chip before you send

Two things the `@` picker got wrong, both found in a DM with an agent.

**You could not name someone who is not in the channel.** The picker offered only the
channel's own membership, so in a DM with `@pablo` the whole list was `teste` and `pablo` — and
"go ask `@bruno` in #engineering" was untypeable. Membership is the right answer to _who does a
mention notify_, not to _whose name may appear in a sentence_. The picker now has two lists:
**In this conversation** first (the ones a mention actually wakes), then **Elsewhere in the
company — not notified here**, up to four more (`useMentionGroups`, `hooks/use-directory.ts`).

**A handle you typed or pasted looked like nothing until it was sent.** The composer is a
textarea, which cannot style its own content, so a picked mention and a typo were the same grey
text. The draft is now mirrored into a backdrop div behind the textarea with the same
typography, padding and wrapping; the mention chips are painted there and the real text sits on
top of them. A handle chips only once it resolves to someone in the directory, so `@dana` and
`@nope` finally look different — and the splitting rule is `lib/mentions.ts`, shared with
`remark-mentions`, so a draft's chips are exactly the sent message's chips.

**Verified in Chrome** (`localhost:5173`, DM with @bruno): typing `@` shows `owner`/`bruno` under
"In this conversation" and `dana`/`mila`/`ops`/`webby` under "Elsewhere in the company"; typing
`@mila please help, and @nope is nobody, but @dana is real.` chips `@mila` and `@dana` and leaves
`@nope` plain, aligned to the glyphs, and still aligned after the text wraps to a second line.

## A reply in a thread wakes the agent that opened it

Bruno asked Pablo a question in `#engineering` and Pablo answered — in the thread, four minutes
later, without writing `@bruno`. Bruno never heard it, and kept telling its human "I'll report
back when Pablo replies." It never would: the scheduler's targets were `@`-mentions plus the
agent side of a DM, and nobody writes the handle when they are _answering_ a question.

**Now:** a message with a `threadId` also targets the agent who wrote the thread's root
(`Scheduler.dispatchAll`). It applies to a human's reply too — the thread under an agent's
message is where that agent is listening.

This target is **implicit**, which changes one thing versus a mention: a cross-department
replier is dropped in silence, with no note and no `handover` row. Someone answering in a shared
channel's thread is usually talking to the human in it, not reaching across the boundary, and
filing that as an attempted breach would fill a head's queue with other people's conversations.
An explicit `@mention` across departments is still refused loudly, exactly as before.

The loop controls already cover the new edge: the 20-turn cap per thread ends a two-agent
ping-pong, `MAX_HANDOFF_DEPTH` bounds the chain, and an agent is never woken by its own message.

The agent prompt now says so, so an agent asks and ends its turn instead of waiting: _"A reply in
a thread you opened comes back to you as a new turn, even without an `@`."_

**Verified:** `apps/server/test/phase4.test.ts` — nina replies `Terminal green.` in the thread
bruno opened, with no handle in the body, and bruno gets a task on it in the same thread. Full
server suite 145/146 (1 skipped).

## The answer comes back to the person who asked

"Go ask Bruno his favourite colour and come back to me" is one errand spread across three
conversations. The person asks in a DM. The agent asks its colleague in `#engineering`. The
colleague's reply wakes the agent — in `#engineering`, not in the DM.

**Before:** a `taut_send(to: "@someone")` always posted in whatever channel the task was running
in. So the last step of the errand landed under the colleague's reply, in a channel thread the
person who asked never opens. From the DM it looked like the agent had gone quiet, and the agent,
asked again, truthfully answered that it was "still waiting" — it had never been told the answer
had a home to go to.

**Now:** a send addressed to a person follows the person (`agents/agentApi.ts` `route`). It stays
in the current conversation when they are actually in it — their DM with the agent, or the message
that triggered this task — and otherwise goes to that person's DM with the agent, wherever the
agent happens to be working. With no DM ever opened between them, it still posts where the agent
stands: somewhere beats nowhere. `Channels.dmOf` is the lookup, and it opens nothing new.

Permission is unchanged: head, the human of this DM, or the human who triggered the task. Only the
destination moved.

Two prompt lines followed, because the agents had learned the old shape and were narrating it back
at people:

- _"…answer when the reply wakes you. Do not sit and wait, and never say you are still waiting:
  nothing happens during your turn."_
- _"When someone asked you to find something out and report back, `taut_send(to: "@them", …)` once
  you have it. It lands in your DM with them, wherever you happen to be working — that is how you
  close the loop."_

**Verified:** `apps/server/test/phase4.test.ts` — nina's threaded reply wakes bruno in
`#engineering`, and bruno's send to `@owner` from that task comes back with the DM's channel id.
Full server suite 157 passed.

## Codex agents could not call a single Taut tool

`MCP tool call requires approval, but approval policy is never.` Every `taut_*` call from a
codex-runtime agent died on that, and so did every browser call — the question was never sent, and
the agent could only report that it had failed.

Nothing to do with routing. Taut wrote `default_tools_approval_mode = "auto"` for each server in
the per-task `$CODEX_HOME/config.toml`, and in codex-rs `auto` means _decide from the tool's own
MCP annotations_ (`requires_mcp_tool_approval_for_mode`). An unannotated tool is assumed
destructive, so it asks for approval. `codex exec` runs with approval policy `never` and has
nobody to ask, so the call is refused rather than queued. The tools carry no annotations, so this
hit all of them, every time.

**Now:** `default_tools_approval_mode = "approve"` — the one value that means _never ask_. It
applies to `taut` and to every extra server such as `browser`. The blast radius is unchanged:
these are Taut's own tools, the server checks routing on each call, and the real sandbox is the
machine plus the `--sandbox read-only|workspace-write` flag the permission mode already sets.

The four accepted values, for whoever meets this next: `prompt` always asks, `auto` asks unless
the tool's annotations say read-only, `writes` asks for anything without `readOnlyHint`, and
`approve` never asks.

**Verified** against the installed `codex-cli 0.153.4`: the config Taut generates now loads, and
`codex mcp get taut` and `codex mcp get browser` both report `default_tools_approval_mode:
approve`. An invalid value is rejected at load, which is how the accepted set was confirmed.
`packages/taut-mcp` 30 tests, `@taut/runtime` 64, workspace typecheck 8/8.

---

## Take over an agent's browser without Docker (2026-09-08)

The Workspace tab on the `local` provider said "No box on the local provider" and offered nothing
but a link to the Files tab, so there was no way to start a browser session, let alone take one
over. That was decision D2 of `docs/build-plan-workspace.md` applied wholesale, but D2's reason is
about a **shell**: a PTY on `local` is a shell on the owner's own machine. The browser is not that.
What a viewer drives is a headless Chromium Taut starts on the agent's own profile — the same thing
the docker path shows, minus the container.

**Now:** the Workspace tab on `local` renders the machine card, a short explainer where the
Terminal pane would be, and the full Browser pane. `Start & watch the browser` creates the home
layout, brings Chromium up and opens the live view; `Take control` gives the viewer the mouse and
keyboard, and what they type lands in `<home>/.taut/browser/profile`, so a login done by hand
sticks for the agent's own later tasks.

- `MachineInfo` gained `liveView`. `terminal` stays `docker`-only; `liveView` is true everywhere.
- `/ws/terminal?…&pty=0` is the same socket without a PTY: live view and take-control only. On a
  browser-only socket, screencast frames count as activity, so watching an agent browse for an
  hour does not trip the 15-minute idle close.
- `local` now implements `Machine.openTunnel` (a plain loopback socket — the "box" is the host) and
  `Machine.signalTasks` (`SIGSTOP`/`SIGCONT` on the process groups of execs carrying a
  `TAUT_EXEC_ID` without the workspace marker), so the D15 pause interlock works here too.
  `openPty` still refuses, and that is the whole of D2.

**The port is per agent and the browser must be headless.** A developer Mac very often already has
a Chrome on the conventional debug port — this one did, on 9222, with the owner's real tabs.
Attaching to it would have put those tabs on screen and under an agent's hands. So on `local`
Chromium gets a free ephemeral port, recorded in `<home>/.taut/browser/cdp-port`, and Taut only
attaches to an endpoint whose `/json/version` **user agent** says `HeadlessChrome`. The `Browser`
field does not: since `--headless=new` it reads `Chrome/153…`, exactly like a headed one (checked
against Chrome for Testing 153.0.8010.12).

Tasks never launch that browser. `localBrowserEndpoint` gives the task runner an `--cdp-endpoint`
only when the agent's Chromium is already answering; otherwise `playwright-mcp` launches its own,
as it always did. So a browser-enabled task never waits on a browser start, and once the owner has
opened the live view the agent shares that one browser and its profile.

**Two bugs this uncovered, both of which also affected the docker path:**

- The Workspace tab created its `WorkspaceSocket` _inside_ a `setSocket` updater. React invokes an
  updater twice in development, so every Connect opened two sockets; the server's one-per-viewer
  limit refused the second, and the tab waited forever on the refused one while the toast said
  "You already have a terminal open on this agent."
- `Target.setDiscoverTargets` announces every existing target as `Target.targetCreated` before it
  answers. The live view treated each of them as a new page and re-attached, which detached the
  session that had a `Page.startScreencast` in flight; that call never came back and the pane died
  with `CDP Page.startScreencast timed out`. Headless Chromium keeps several `about:blank` pages
  around, so it lost this race every time. Events are now ignored until the discovery burst is
  over, `chrome://` targets are never candidates (their screencast never starts), and the page is
  brought to the front before the screencast begins.

**Verified in the browser** (Claude in Chrome, 2026-09-08): Bruno on `local`, Workspace →
`Start & watch the browser` → the live view painted the agent's real page → `Take control` → the
amber "you are driving" ring → a click inside the view expanded that page's own details section,
so input reached the page. Killing the agent's Chromium showed `Live view unavailable: Chromium
closed.` `@taut/runtime` 64 tests, `@taut/server` 158, workspace typecheck 8/8.

## Same-department agents talk freely, DMs included

The department is now the only boundary between agents. Inside it there is nothing left to gate:
a teammate is reachable in a shared channel, in a thread, or in a DM between the two agents.
Across a department nothing passes, with no gate to ask for. That is the whole rule.

The agent-to-agent DM ban is gone. `taut_send(to: "@handle")` lands in the current channel when
the teammate is in it, and otherwise in the two agents' own DM, which `Channels.ensureDm` opens on
first use. A human's DM is never joined to make this work — the agents get their own room.

**Why it had to go.** It kept failing the plainest errand there is. A head DMs an agent, says "go
ask her what her favourite colour is and come back to me", and the agent replies that this is
structurally impossible. Worse, each refusal taught the agent, in its own words in its own visible
history, that the thing was forbidden. It stopped calling the tool at all. One run we traced spent
seven seconds, emitted a confident sentence about a block, and made zero tool calls — the server
never heard from it. A rule that the model narrates instead of obeying is not a rule, it is a
recurring conversation.

**Two loop guards had to come first**, because removing the wall opens a room with no human in it:

- The parent of an agent-triggered task is now the task that _wrote_ the message
  (`Tasks.byMessage`), not whatever that agent happens to be running (`liveOf`). The old guess
  reset the handoff depth to zero whenever a task finished quickly, so the depth cap never fired.
- The turn cap applies to any agent-authored trigger, not only ones in a channel. A DM has no
  thread and no human, so nothing else ends a ping-pong.

**One asymmetry is load-bearing.** In a DM a human's message wakes the agents in the room with no
`@` needed; an agent's message must carry the mention, which `taut_send` always prepends. Waking
agents on _any_ agent message in a DM deadlocked the server in testing: every task opens a
placeholder reply, that placeholder is an agent-authored message in the channel, and each one
spawned the next task until the event bus wedged. The mention is what separates a message an agent
meant to send from the bookkeeping of it having spoken.

**Verified:** `apps/server/test/phase4.test.ts` — bruno, working in the human's DM where nina is
not a member, sends to `@nina`; the reply opens a two-member bruno↔nina DM, nina gets a task in it,
and a second send reuses the same channel rather than opening another. 12 tests in that file, full
server suite green.

## `taut_ask` answered with an empty string

`taut_ask` came back `answered: true` and an answer of `""`. Reproducible, twice in a row against
the same agent, which is how it was caught.

Every agent task opens its reply as an empty row with `status: "streaming"` the moment the task
starts, and fills it in as the run produces text. The query behind an ask looked for the first
message by the addressee after the question and did not care what state it was in, so it matched
that empty placeholder. The asker got a blank answer, and the ask was then recorded as answered
against that message id — permanently, so even a later re-read returned the blank.

**Now** the query requires `status = 'sent'`. It is the same row a moment later, once the reply is
finished, so the answer arrives whole. A reply that ends `failed` never matches and the ask parks
at its timeout, which is the honest outcome: there is no answer to give.

**Verified:** `apps/server/test/phase4.test.ts` — a paused agent gets an ask, a `streaming` row is
opened in that conversation, and the ask stays `pending`. Finalising that same row to `sent` with
a body flips the ask to `answered` carrying `Green.` and that row's id. Removing the one line
`AND status = 'sent'` fails the test with `expected 'answered' to be 'pending'`.

## A Claude seat can read its own usage

The subscriptions page showed a limits strip for the Codex seat and a sentence
of apology for the Claude one: "the stored credential cannot read usage — a
`claude setup-token` is inference-only". That sentence was accurate. Taut
injects the seat's credential as `CLAUDE_CODE_OAUTH_TOKEN`, so it has to be the
bare `claude setup-token` line, and that token carries `user:inference` alone.
`api.anthropic.com/api/oauth/usage` refuses it every time. Codex never had the
problem: one `auth.json` both runs `codex` and reads its quota.

**Now** a seat may carry a second credential that only the probe reads.
`claude.login` is a new credential kind holding the record `claude /login`
leaves behind — the one whose `user:profile` scope the usage endpoint accepts.
It is read-only by construction, not by convention: `injectionFor` returns
`{ via: 'none' }`, so no runtime can be handed it. `RuntimeUsageCredentialKinds`
sits beside `RuntimeCredentialKinds` and the two never overlap, so the seat's
own token cannot be attached as a reader and a login cannot be attached as a
seat.

A `claude login` access token lives hours and its refresh token weeks, so the
probe renews it in place before each read that needs it and writes the result
back under the same vault item. The paste is checked once, at the field: a
login with no refresh token is refused there rather than working for one
afternoon, and everything but `claudeAiOauth` is dropped — the Keychain record
also carries whatever MCP servers that machine has signed into, which is not
the seat's business.

**Try it:** `/subscriptions` → the Claude seat now reads "no usage credential
on this seat" with a picker under it. `/vault` → Add secret → **Claude usage
login**; the dialog gives you the line to run on a Mac signed in to Claude:

```
claude auth status >/dev/null 2>&1 || claude /login
{ security find-generic-password -s 'Claude Code-credentials' -w 2>/dev/null || cat ~/.claude/.credentials.json; } | base64 | tr -d '\n' | pbcopy
```

Paste it, go back to the seat, pick it in the dropdown. The page presses Check
for you and the strip fills in.

**Verified:** `apps/server/test/usageCredential.test.ts` (8 tests) — attach,
detach, list round-trip, both validation refusals, the injection is `none`, and
a seat with no usage credential reports why instead of showing an empty strip.
`test/usageLimits.test.ts` covers `supports()` now rejecting `claude.oauth` and
the rotation window; `packages/contract/test/credentials.test.ts` covers the
paste. Migration `0019_subscription_usage_credential` applied to the running
dev database.

**Not verified:** the refresh call has never met Anthropic's token endpoint.
There was no usable `claude login` record on this machine — the Keychain
entry's `accessToken` was empty — so both the read and the rotation are unit-
tested only. Nothing about the Codex seat changed.

## `@taut/contract` · `@taut/server` · `@taut/runtime` · `@taut/taut-mcp` · `@taut/web` — Repositories (GitHub App · company repos · per-agent read/write · worktrees)

Closes docs/build-plan-repositories.md (D1–D14). A company connects to GitHub, picks the
repositories that belong to it, and each agent is granted each of those repositories read-only or
read-write — exactly the owner's ask: "select repositories… read-only or read-write which means it
can push PRs."

**What works.** A company connects to GitHub through a GitHub App created by the manifest flow: an
admin+ starts it from `/settings/repositories`, GitHub asks them to name the App and click Create,
then to install it on an account and tick repositories — GitHub's own picker, the left half of D3.
Taut's list is the right half: the settings page shows what the installation can see against what
is already attached, and attaching (or detaching) is a separate, admin+ click. Granting is per
agent, on its Repositories tab — a three-way **No access · Read-only · Read & write** control,
gated by whoever may manage that agent, the same split the vault already uses. Every task that has
a grant gets a git worktree: a pristine clone kept on the default branch is cloned once and only
fetched after; `rw` gets its own branch off `origin/<default>` and a `pre-push` hook refusing the
default branch by name; `ro` gets a detached checkout of `origin/<default>` and nothing to push
with anyway. Git inside the box never sees a token: a credential helper calls back to Taut with the
task's own bearer token, and the server maps the repository path in the request to a grant and
mints a token scoped to that one repository at that grant's permission — `contents: read` for `ro`,
`contents: write` + `pull_requests: write` for `rw`, cached until a minute before GitHub's own
hour-long expiry. Read-write agents open pull requests through a new `github_open_pr` MCP tool,
which the server refuses outright for a `ro` grant or a repository the agent holds no grant on; the
agent pushes its branch itself, the tool only calls the GitHub API to open the PR. A repository the
agent has no grant on does not exist for it anywhere — not in its worktrees, not in its
instructions, not in `github_open_pr` — and the agent API answers `NotFound`, never `Forbidden`
(D14). An agent with no grants runs exactly as it did before this feature.

**Verified.** Full workspace typecheck passes, 8/8. Every package's test suite passes; the server
suite is 188 passed, with one pre-existing failure in `test/phase3.test.ts` that belongs to the
concurrent archive feature (migration `0018_archive`), not this one. The server boots with
migration `0020` applied and, over real HTTP: `/api/repositories/github` is 401 with no session,
`/api/agent-runtime/git-credential` is 401 with no task token, and both legs of the manifest flow
redirect 302 to `/settings/repositories` carrying the outcome in its own query parameter and, on
failure, the reason in its own separate parameter.

**Deviations from the plan.** Three, all deliberate.

- Migration is `0020`, not `0017`: `0017` through `0019` were taken by other sessions mid-build.
  D12 anticipated exactly this; nobody else's migration number was touched.
- The git config injected into the box is two entries, not the plan's one:
  `credential.https://github.com.helper` plus `credential.https://github.com.useHttpPath=true`.
  Without the second, git never sends the credential helper the repository path — only the protocol
  and the host — and the server maps that path onto a grant, so one entry would make every
  credential request unmappable.
- The pre-push hook is shared per clone rather than per worktree. A linked worktree's `.git` is a
  file pointing back at the primary clone's `.git/worktrees/<name>`, and git resolves a hook against
  the **common** directory, not the worktree it was written for. The hook's body depends only on
  the default branch name, so writing it once per clone is idempotent; the effect is stricter than
  planned — every worktree of that repository is guarded, not only the one this task is using —
  never weaker.

**Found and fixed on the way.** The `taut` CLI was missing from the agent image: the Dockerfile
copied the bundled MCP server but no CLI binary, so `!taut git-credential` would have failed
"command not found" on every clone. It now also copies the CLI and installs a `/usr/local/bin/taut`
wrapper for it. And the failure leg of the redirect originally folded its reason into the outcome
parameter, producing a value the web page's known states would never match; it now carries its own
`reason` parameter, separate from the outcome.

**Gaps.** No live GitHub call has ever been made. The manifest conversion, installation-token
minting, repository listing and pull-request creation are exercised only against stubs. The central
property of the whole design — a read-only agent's push refused _by GitHub itself_, not by a local
check — is untested and needs a real App and a real installation to prove. The worktree lifecycle
has been run against real `git` on the host through the `local` provider only, never through the
docker provider. No webhooks in this phase (D9). github.com only, no GitHub Enterprise Server
(D10). Listing an installation's repositories pages up to 1000 of them; a company with more loses
the tail silently.

**Versions added.** None — this feature added no new dependency.

## Skills an agent absorbs, authors, and keeps current

Contract: `docs/build-plan-skills.md` (D1–D13). Owner requirement, 2026-09-08 evening: hand an agent
a skill in chat and it absorbs it; agents write their own skills; installed skills stay current.

**What now works.** On `/agents/<id>` → Skills, **Add skill** is now two things. _Write one_ is the
editor that was already there. _Install from a source_ takes one field and accepts every shape a
skill actually arrives in: `mattpocock/skills`, `mattpocock/skills#grill-with-docs`, a GitHub repo,
folder or `SKILL.md` link, a `skills.sh` link, the literal
`npx skills@latest add mattpocock/skills --skill=grill-with-docs` command copied off a page, any
other web page that mentions the skill, or the `SKILL.md` markdown pasted in full. Press **Look** and
Taut reads the source and lists what is installable; a repo with thirty-seven skills asks which one.
Rows now carry badges — Built-in, Installed (with the source), Waiting for you, Changed upstream —
and an installed skill gets a policy control (Tell me / Auto-update / Never check) plus a
check-now button. **Review change** shows the body in use beside the upstream body and updates only
if you say so.

Agents got five MCP tools, all scoped to their own skills the way the vault already is:
`skill_list`, `skill_write` (author a `SKILL.md` from what they learned), `skill_install`,
`skill_update`, `skill_remove`. Drop a link into a DM, ask the agent to learn it, and it installs.

**Try it.** DM an agent a `SKILL.md` (frontmatter included) and ask it to install that as a skill;
or on its Skills tab press Add skill → Install from a source and paste
`https://www.aihero.dev/skills-grill-with-docs`.

**The two decisions worth knowing.** An agent installing an external skill for itself lands
**pending**: the files go to `<home>/.taut/pending-skills/<name>/`, the row is excluded from the
query that renders `CLAUDE.md`, and a human approves it on the agent page. A skill body becomes part
of the agent's system prompt, so an unguarded install is a prompt-injection path — a page the agent
reads could talk it into rewriting its own instructions. Company setting
`skills_agent_install_policy` flips it to `auto`. Separately, an installed skill's update policy
defaults to **notify**: the daily check records that upstream moved and the agent says so in its
owner's DM, and the copy on disk is left byte-identical until someone presses Update.

**How it is built.** No shell-out anywhere: `npx skills@latest …` is _parsed_ as a source string
(`parseSkillSource`, `@taut/contract`, pure and total), never executed. `SkillRegistry`
(`apps/server/src/services/skillRegistry.ts`) is the only module that touches the network and does
everything over GitHub's REST API — no `git`, no `npm`. A skill is now a **directory**, not a file:
sibling `references/`, `scripts/` and per-agent config come with it, capped at 40 files / 1 MB /
256 KB per file, text extensions only, symlinks refused, every path checked twice (once in the
registry, once by `AgentHomes.resolveInside`). Migration `0021` adds provenance to `agent_skills`
(origin, state, source, resolved commit, content hash, update policy, checked-at) and
`skills_agent_install_policy` to `companies`; the rows are the lockfile, there is no
`skills-lock.json` on disk. `SkillUpdater` (`apps/server/src/agents/skillUpdater.ts`) ticks every 6 h
over skills unchecked for 24 h, four at a time, each isolated. Two new events,
`agent.skill.changed` and `agent.skill.removed`.

**Verified.** `pnpm typecheck` clean across all eight packages. 445 tests pass workspace-wide
(contract 109, server 206, taut-mcp 33, runtime 83, memory 14). New: 50 cases over
`parseSkillSource` covering every accepted form including the owner's two verbatim inputs, and 18
in `apps/server/test/skills.test.ts` — the approval gate (pending is on disk, absent from
`skillsOf`, absent until approved, then present), agent self-authoring, every built-in refusal,
policy changes, rejecting a pending install, and non-managers refused. `parsePage` is tested against
a captured copy of the owner's aihero.dev page in `apps/server/test/fixtures/`.

Ground truth taken from running the real CLI (`apps/server/test/fixtures/` holds the artifacts): the
npm package `skills` is **vercel-labs/skills**, not mattpocock's; it writes
`.claude/skills/<name>/` with sibling files plus a root `skills-lock.json`; `--agent claude` is
rejected and the id is `claude-code`.

**Gaps.** No live GitHub fetch has ever run — `preview`, `fetch` and `upstreamHash` are exercised
only through the `inline` source and pure unit tests, so the tree walk, the sibling fetch and the
`raw.githubusercontent.com` path are untested against the real API. The `SkillUpdater` tick has not
been run against a skill that actually changed upstream; its notify and auto legs are unproven end
to end. Nothing has been seen in a browser: the install dialog, the badges and the diff view are
typechecked and not looked at. The private-repo fallback (D11) only works for a repository already
attached to the company, because that is the only thing an installation token can be minted for.
Deferred as planned: the company-wide skill library, agent-to-agent sharing, non-GitHub forges,
rollback beyond the single tracked upstream, and `skills find`.

**Versions added.** None — this feature added no new dependency.

## Calls — huddles, screen share, self-hosted LiveKit (2026-09-09)

**Try it.** `docker compose --profile calls up -d` after setting the five variables in the new
"Calls / huddles" block of `.env.example`; without them nothing changes and `docker compose up -d`
still starts exactly one container. In the app, open any channel or DM and press the headphones
button in the header: one huddle per channel, so the first person starts it and everyone after
joins the same room. The bar docks under the conversation with mic, screen share, camera and
leave; tiles appear only once somebody shares a screen or turns a camera on. Contract in
`docs/build-plan-calls.md` (D1–D16).

**Shape.** LiveKit is the SFU, Redis backs it so a second node is a `--scale` away, and eturnal is
the TURN server (owner's call; LiveKit's own embedded TURN is deliberately left off so only one
thing owns 3478). The room name is derived from the channel id, which is why start and join are
one endpoint. Who is in a room is decided by LiveKit's webhooks, never by the browser, so a
crashed tab or a slept laptop still leaves the huddle — `POST /api/hooks/livekit` verifies the JWT
LiveKit signs the raw body with, and drives `call.started` / `call.updated` / `call.ended`.
Migration `0023` adds `calls` (partial unique index: at most one open per channel) and
`call_participants` (`member_kind` present from day one so agents join later without a migration).
When the last person leaves, the starter posts `🎧 Huddle · 12 min · Ana, Bruno` — display names,
not `@handles`, so ending a huddle does not notify everyone who was in it. DM huddles raise the new
`huddle` notification; channel huddles stay quiet.

**Traps found while building.** livekit-server does **not** expand `${VAR}` inside its own config
(only in `key_file`), so a mounted config file with placeholders would have started with a literal
`${TAUT_TURN_SECRET}` as the TURN secret — calls would connect and silently fail to relay. The
config now lives in the top-level `configs:` block of `docker-compose.yml`, which compose
interpolates. LiveKit also runs with `rtc.udp_port: 7882` (single-port mux) rather than a port
range: a published 50000-60000 range spawns one docker-proxy per port and is unusable on Docker
Desktop. And the Electron shell is default-deny per origin, so a self-hosted SFU on its own host
was unreachable from the desktop app; `TautBridge` gained `allowMediaOrigin`, narrowed to
WebSocket, XHR and media resource types and capped at four origins.

**Verified.** `pnpm typecheck` clean across all eight packages. `pnpm test`: 110 contract, 217
server (11 new in `apps/server/test/calls.test.ts`), 33 taut-mcp, 83 runtime, 14 memory. The new
cases cover a non-member refused a token, the participant cap, a webhook signed with the wrong
secret and one signed for a different body, and the full join → participant_joined →
track_published(screen_share) → leave → participant_left → room_finished sequence asserting exactly
one `call.started`, three `call.updated`, one `call.ended`, the summary message, and the DM
notification. `docker compose config` renders `taut` alone; `--profile calls` renders four services
with the secrets substituted.

**Gaps.** No LiveKit server has ever been started — every server test drives the webhook path
directly, so nothing has produced or consumed a real WebRTC connection, and no browser has been in
a huddle. eturnal has not been contacted; the shared-secret handshake between it and LiveKit is
configuration only. TURN over TLS is documented, not shipped (needs certificates). Not built, as
planned: recording/egress, agents in rooms, speaker view and pinning, background blur, captions,
and loopback audio on desktop screen share.

**Pre-existing failure, not from this build.** `test/phase3.test.ts > vault.revoke cascades…` fails
in `channels.dm` with `Forbidden: Not a member of this channel`. It reproduces with the calls code
fully unwired, and `services/channels.ts` and `services/agents.ts` were last modified hours before
this build ran — the other session working in this repo owns it.

**Developing against it.** `pnpm dev` is unchanged and leaves calls off. `pnpm dev:calls` is the
same turbo task wrapped in `scripts/dev-livekit.sh`: one LiveKit container, no Redis, no TURN,
started before turbo and removed after it, with a route back to the dev server so the webhooks
land. `pnpm dev:ts --calls` does it over Tailscale, where the SFU gets its own `tailscale serve`
port (an https page cannot open a `ws://` socket) and LiveKit advertises the tailnet address for
media. `pnpm calls:up` / `pnpm calls:down` run the SFU alone. Note that `turbo.json` is in strict
env mode: the six `TAUT_LIVEKIT_*` / `TAUT_CALL_*` variables had to be added to `globalEnv` or the
dev server never sees them, however the shell is set up.

**Versions added.** `livekit-server-sdk` `2.19.0` (server), `livekit-client` `2.22.3` (web).
Images: `livekit/livekit-server:v1.13.6`, `redis:8.8-alpine`, `eturnal/eturnal:1.12.2-alpine`.

## Huddle window — pre-join dialog, its own Electron window, a huddle thread, four sounds

Contract: `docs/build-plan-huddle-window.md` (D1–D14a). Built 2026-09-09 by three agents on
disjoint directories. **Amends `docs/build-plan-calls.md` D7**: the huddle message is now posted
when the call opens, not when it ends. No migration — `calls.summary_message_id` already existed
and its meaning widened.

**What now works.** Pressing Huddle on a channel or DM no longer joins anything: it opens a
pre-join dialog with a live self-preview, mic and camera toggles, and microphone / speaker /
camera pickers whose choice is remembered in `localStorage` (`taut.huddle.devices`). Only **Start
Huddle** reaches the server. Inside the Electron shell the dialog then hands the call to a
dedicated 480×720 window (`/huddle/<channelId>?mic=&cam=`) that owns the LiveKit room; the main
window never connects, keeps a "Return to huddle" bar, and its button focuses the window rather
than opening a second one. A plain browser stays in-page as before. The window closes itself when
the call ends, by leaving or by the room emptying.

Every huddle now has a real thread. The server posts `🎧 Huddle in #general` the moment the room
opens, stores its id on the call, and **edits that same message** into `🎧 Huddle · 12 min · Ana,
Bruno` when the last person leaves — so the huddle window's chat is that message's thread and the
channel shows both in ordinary history. `Messages.editAsSystem(companyId, messageId, body)` is the
new actor-less edit that end-of-call rewrite uses. A huddle whose message could not be posted
(archived channel) still runs and still summarises through the old post-at-end path.

**Four sounds**, owner-supplied, in `apps/web/public/sounds/`: `pop.mp3` for a notification
addressed to you, `ring.mp3` looping on an incoming DM huddle (with Join / Decline; Decline is
local, there is no declined state on the server), `pop-in.mp3` and `pop-out.mp3` for somebody else
arriving in or leaving a huddle you are in. All four go through `lib/sounds.ts`: unlocked on the
first gesture, silenced by `taut.sounds.muted`, and never played for something you did yourself —
the roster diff is seeded on connect so walking into a room of five pops nothing. The desktop
shell now raises its OS notification `silent` and lets the page play the pop, so the owner's sound
is the one heard on every platform.

**Try it:** `pnpm dev`, open a channel, press Huddle — the dialog appears with your camera. With
`pnpm dev:desktop` running, Start Huddle opens the second window.

**Verified:** root `pnpm typecheck`, `pnpm lint` and both builds are clean; `apps/server`'s calls
suite is 13/13 including "starting posts one message", "ending edits that same message" and "a
retried `room_finished` changes nothing". The emitted preloads each `require("electron")` and
nothing else.

**Not verified — say so rather than claim otherwise:** no LiveKit server exists here, so no room,
no token, no audio and no screen share have ever run. Nothing in this build has been seen in a
browser or in Electron: the dialog's match to the Slack reference, the camera light going out on
Cancel, `setSinkId`, the window geometry, and the close-runs-unload leave are all unexercised.

**Known deviations.** The shared preload module the plan asked for builds into a rollup chunk, and
a sandboxed preload can only `require` Electron built-ins, so `preload/huddle.ts` is a deliberate
commented copy of `preload/index.ts` (both typed `TautBridge`, so a missing member fails to
compile). `apps/web/src/routes/_auth.invite.$token.tsx` had a pre-existing `react-hooks/purity`
lint error (`Date.now()` during render) fixed in passing. `apps/server/test/phase3.test.ts >
vault.revoke cascades…` fails and **failed before this build** — another session is editing this
repo concurrently; it is not huddle-related and was left alone.

### Pre-join preview: a black rectangle now explains itself

Reported 2026-09-09: the pre-join dialog showed a black preview with the device pickers correctly
filled in — so permission was granted and a stream existed, and nothing on screen said why there
was no picture.

Diagnosed in Chrome by feeding the dialog a synthetic `canvas.captureStream()`: a stream with real
frames renders correctly and mirrored, so the React and `<video>` wiring was never the problem.
The camera was handing back a track that is `live` and blank — what macOS does when another app
(Slack's own huddle preview, say) already holds the device. Nothing in the dialog could tell.

Three fixes in `components/huddle-prejoin.tsx`:

1. **A live-but-blank camera is detected and named.** The video track's `muted` flag and the
   element's `videoWidth` are checked 2.5s after attaching and on every `mute`/`unmute`, and the
   dialog says "Your camera is on but sending no picture. Another app may be using it." over the
   frame rather than showing black. Verified with a `captureStream(0)` canvas.
2. **`getUserMedia` failures are reported for what they are** — blocked in site settings, busy in
   another app, no camera found — instead of one "No camera available" for every error.
3. **A remembered camera that no longer exists no longer kills the preview forever.** `deviceId:
{exact}` fails permanently once the device is unplugged, so a failed attempt now retries with
   no device constraint before giving up on the picture.

`play()` is also called explicitly after `srcObject` is assigned, since `autoplay` is not reliable
for a stream attached from an effect.

**Still unverified:** no real camera has ever been in this preview — every check above used a
synthetic stream, and the automated Chrome tab could not be granted a camera permission.

## Projects — a read-only Linear mirror in the sidebar

Contract: `docs/build-plan-projects.md`. Owner requirement, 2026-09-09: _"a new feature that is
gonna be visible on the side bar which are projects. Projects are not a native entity here, we need
linear connected to the organization like github and we will mirror projects from linear here. No
mutations for now, just have them there."_

**What now works.** An admin pastes a Linear personal API key at `/settings/linear`; Taut validates
it against Linear before storing anything, encrypts it under the company key with the company id as
AAD, and pulls every project the key can see with its milestones. The sidebar grows a **Projects**
group above **Company** listing up to eight projects with a state dot, then "N more"; `/projects`
is the full list with a filter and a Refresh button; `/projects/$projectId` shows state, progress,
lead, dates, description and milestones, with a link out to Linear.

**Try it.** `/settings/linear` → paste a key from Linear · Settings · Security & access · Personal
API keys → Connect. The first sync runs inside that request, so the sidebar fills immediately.

Corrected the same day, twice. The group first hid itself until Linear was connected, which made the
whole feature invisible to the one person who has to turn it on. Anyone who may connect Linear now sees
the group with a **Connect Linear** row in it; a plain member of a company with no connection still
sees nothing, since for them it would never fill. It then moved from just above **Company** to the
top of the sidebar, ahead of **Channels** and **Departments** (owner, 2026-09-09).

**Shape.** Six endpoints under `/api/projects` (`GET /linear`, `POST /linear`, `DELETE /linear`,
`POST /sync`, `GET /`, `GET /:projectId`); reading is any member, the other three are admin+.
Migration `0024_projects.ts` adds `linear_connections`, `projects` and `project_milestones`.
Services `Linear` (the key and the GraphQL client) and `Projects` (the mirror) follow `GitHubApp`
and `Repositories` line for line. Two events, `project.synced` and `project.linear.changed`.

**Decisions worth knowing.** A personal API key, not OAuth: Linear has no manifest flow, and OAuth
needs a public redirect URL a self-hosted box usually lacks. A sync is a _reconcile_, not a
replace — a project keeps its `prj_…` id when Linear renames it, so a sidebar link and a bookmark
survive. A sync that fails leaves the previous mirror standing and records why on the connection.
Sync fires on the Projects page when the mirror is over five minutes old, and on the button; there
is no poller and no webhook.

**Verified.** `apps/server/test/projects.test.ts`, 11 tests against a stubbed Linear: a refused key
stores nothing, a connection never carries the key, milestones come across ordered, a second sync
keeps the id across a rename and drops what Linear no longer returns, a failed sync leaves the
mirror intact with the error recorded, and connect/sync/disconnect are refused for a plain member.
Workspace `typecheck`, `lint` and `build` are clean.

**Not verified.** No request has ever gone to the real Linear API — the field names in
`PROJECTS_QUERY` are from Linear's published schema, not from a live response, so the first real
connect is where a renamed field would show up. Nothing here has been seen in a browser.
`apps/server/test/phase3.test.ts > vault.revoke cascades…` still fails and still failed before this
build; it is another session's, and was left alone.

## Run overrides — the model picker is a real dropdown, and the composer can change it per message

**What now works.** Every model field in Taut is a dropdown of models read from the provider, not a
free-text box with three hard-coded hints. `GET /api/subscriptions/models?runtime=…` asks Anthropic
(`/v1/models`, API key or the seat's OAuth access token), OpenAI (`/v1/models`, API key only —
a ChatGPT login has no such endpoint) or models.dev (for OpenCode, flattened to `provider/model`
and grouped by provider), caches the answer for thirty minutes per credential, and falls back to a
short built-in list with one line saying why when the provider will not answer. The agent's Runtime
tab, the new-agent form and a seat's default model all use it.

**And the composer has run settings.** A gear button sits left of Send whenever the message you are
about to post will actually wake an agent: always in a DM with one, and in a channel or thread the
moment the draft contains an `@handle` that resolves to an agent. It opens four rows — runtime,
seat, model, reasoning effort — each of which can say "whatever the agent is set to", naming that
setting rather than the word "default". The choice sticks per conversation in `localStorage` and
rides on the message; the agent's own settings are never touched.

**Try it.** `pnpm dev` → DM `@bruno` → the gear next to Send → set Model and Reasoning → send. Then
`sqlite3 apps/server/data/taut.db "SELECT body, run_override FROM messages WHERE run_override IS NOT NULL"`.

**Decisions.** docs/build-plan-run-overrides.md, D1–D9. The override is one nullable JSON column on
`messages` (migration `0025`), applied once in `runTask` onto the `Agent` everything downstream
already reads — so seat rotation, the adapter and the session key all follow without knowing an
override exists. Which also means a runtime override resumes nothing: the session key carries
`runtimeKind`. `permissionMode` is not a field of `RunOverride`, so an override can pick a
different brain and never a wider hand. Reasoning effort reaches claude-code as
`MAX_THINKING_TOKENS` and codex as `-c model_reasoning_effort=…`; cursor and opencode expose no
such control, so the row is hidden for them rather than shown and ignored.

**Verified in a browser** (Claude-in-Chrome, seeded `owner@taut.local`). In `#engineering` the gear
is absent on an empty draft and appears on typing `@bruno`; the popup opens with "Agent default ·
Claude Code", "Rotate across the pool", the model list and Reasoning offering exactly
Low/Medium/High/Max — the claude-code set, served by the server, not the client. Picking Haiku 4.5
and Medium marks the button and survives the send: the row in `messages.run_override` reads
`{"model":"claude-haiku-4-5","reasoningEffort":"medium"}`. The agent's Runtime tab now shows a
dropdown where the free-text box was. Workspace `typecheck` and `lint` are clean;
`packages/contract` and `apps/server` tests pass.

**Not verified.** No run has executed with an override applied: Acme's only claude-code seat in this
dev database is `auth-failed`, so the task failed on seat selection before reaching the adapter.
The `MAX_THINKING_TOKENS` and `model_reasoning_effort` mappings are therefore unexercised, and no
request has gone to a live Anthropic, OpenAI or models.dev endpoint with a working credential — the
catalogue has only ever been seen taking its fallback path. `apps/server/test/phase3.test.ts >
vault.revoke cascades…` still fails and still failed before this build; it is another session's,
and was left alone.

## Skills an agent can actually open (2026-09-09)

**The bug.** An agent answered "I couldn't open `skills/grill-with-docs/SKILL.md`, it's outside the
dirs I'm allowed to read, so I ran the interview from its description." It was right. The task runs
in `<home>/work/<taskId>`, headless claude-code scopes itself to that directory plus whatever
`--add-dir` grants, and the only home directory ever granted was `inbox/`. The claude-code
instruction file points at `@<home>/skills/<name>/SKILL.md` and `@<home>/memory/MEMORY.md`, so both
imports landed outside the allowed set — every claude-code and codex agent was running on skill
_descriptions_ only, and a skill that carries its own docs or scripts next to `SKILL.md`
(`grill-with-docs/agents/openai.yaml`) had no way to reach them even where the body was inlined.

**Fix** (`apps/server/src/agents/runTask.ts`). `homeDirGrants(home)` is the set every task gets
whatever the agent's file grants are: `inbox/` (read-write), `skills/` and `memory/` (read-only —
both are written through `skill_write` / `memory_note`, never by hand). It feeds two places: the
`addDirs` the adapter turns into `--add-dir` (claude-code, codex), and `opencodePermission`, which
now receives the home dirs ahead of the grants — opencode has no `--add-dir`, so that block is the
only channel it has. `renderInstructions` is also called with `homeFromWork: machine.paths.home`, so
the imports read `@/…/skills/<name>/SKILL.md` instead of `@../../skills/<name>/SKILL.md`; every other
path in that file was already absolute. Cursor is unchanged: it has neither flag, gets skill bodies
flattened into `.cursor/rules/taut.mdc`, and `--force` scopes nothing.

**Try it.** DM a claude-code agent that has a skill and ask it to follow the skill exactly. The
command now carries `--add-dir <home>/inbox <home>/skills <home>/memory`. Covered by
`apps/server/test/attachments.test.ts` ("a DM with a file is materialised…"), which asserts the three
directories in that order.

**Not verified.** No live run: the only claude-code seat in this dev database is `auth-failed`, so
nothing has re-read a `SKILL.md` through the fix. opencode and codex remain config-only as before.
`test/migrations.test.ts` (27 tables vs 26 expected) and `test/phase3.test.ts > vault.revoke
cascades…` fail here and failed before this change — both are another session's, left alone.

## Linear people — mapping a Linear account to a Taut human (2026-09-09)

`/settings/linear` grows a **People** card under the connection: the Linear avatar and name on the
left, a dropdown on the right that starts at **None** and lists this company's humans. That is the
whole feature, and it is deliberately dumb — no email matching, no guessing at connect time. It
exists because an agent about to grade a ticket, assign a milestone or open a project view has to
resolve "Tedy" to a Linear id, and until now Taut had no place to say which Linear account that is.
Contract in `docs/build-plan-projects.md` **D15** (the mirror) and **D16** (the mapping).

**Server.** `linear_users` (migration `0029_linear_users.ts`, primary key `(company_id, linear_id)`).
Every column is Linear's except `user_id`, which is Taut's: the sync's upsert names the mirror
columns one by one and never touches the mapping, so a rename in Linear cannot quietly unmap
somebody. `Linear.users` pages `users(first: 50, includeArchived: true)`; the reconcile wraps it in
`Effect.option`, so a key that cannot read the member directory logs one warning and leaves the table
exactly as it stands — the projects are the feature, this is a page an admin opens on purpose.
Deactivated accounts stay in the list, greyed, because they still wrote half the tickets.
Disconnecting drops the table with the key.

**One human, one Linear identity.** A partial unique index on `(company_id, user_id)` plus a check in
`Projects.linkLinearUser`, which refuses with a `Validation` naming the Linear person the human is
already mapped to. `member: null` unmaps and is the default. Admin+, like every other path that
spends the company's Linear key (D9), and the same door in the API: a plain member gets `Forbidden`.

**Contract.** `LinearUser` in `domain/project.ts`; `GET /projects/linear/users` (any member) and
`PUT /projects/linear/users/:linearUserId` (admin+). New event `project.linear.member.changed`
carries the row, and the web invalidates the `projects` prefix on it like every other project event.

**Try it.** `/settings/linear` on a connected company → **Sync now** → the People card fills with the
workspace's members → pick a human in any row. Re-sync: the mapping survives, the names update.

**Covered by tests.** `apps/server/test/projects.test.ts` gained five: the people mirror and its
ordering (active first), a mapping surviving a sync that renames the person, the one-to-one refusal
plus None-unmaps plus the re-map that then succeeds, an unknown Linear id as `NotFound`, and a plain
member refused at the endpoint. 19 tests in that file, all green.

**Not verified in a browser.** The People card has never been rendered: the only company with a real
Linear connection in this dev database is `Acme2`, whose owner is `teste@teste.ca`, and logging in is
the owner's step. Everything below the UI is covered by the tests above.

**Migration number.** Took `0029`: another session added `0028_thread_context.ts` while this was in
flight. `test/migrations.test.ts` was two tables and three migrations stale from that same session —
it now lists both `agent_thread_context` and `linear_users` and expects 29 applied, and passes.
`test/phase3.test.ts > vault.revoke cascades…` still fails and is still another session's.

## Live steering + agents reacting (docs/build-plan-steering-reactions.md)

**A message that lands while an agent is thinking now reaches that agent, and an agent can answer
with a reaction instead of a message.** The case that prompted it: two agents mentioned in one
message both wrote out a full answer plus a "cool with that?" round-trip, where one answer and a 👍
was the whole content. Twelve decisions, D1–D12. **No migration** — `message_reactions.member_kind`
(`0013`) and `ReactionMember.kind` were written for exactly this.

**Three injection points, weakest guarantee first.** Every `taut_*` response now carries a `steer`
list of what landed in the run's conversation since it was last drained (D6, every runtime). Then
`taut_send` and `taut_done` **deflect once per run** when that list is non-empty: nothing is posted,
the call returns `posted:false` with the messages and a hint, and the agent decides again (D7). A
hard cap of one deflection per run means an agent that insists is never trapped. Third and behind
`TAUT_STREAM_STDIN`, claude-code gets a streaming stdin so a message arrives mid-turn rather than at
the next tool call (D8).

**`taut_react(messageId, emoji, on?)`** → `POST /api/agent-runtime/react`. Reach is the agent's own
channels: its task's channel, or any channel it is a member of. Same emoji rules and the same
20-distinct-emoji cap as a human. Stored as `member_kind = 'agent'`, which the web already renders —
the chips resolve any member through the directory, so the tooltip says "Clarifier reacted with 👍"
with no client change at all.

**An empty `taut_done` withdraws the reply.** `taut_done("")` after at least one reaction closes the
task and _deletes_ the empty streaming placeholder instead of leaving a blank agent bubble (D4). It
finalizes first, so `agent.task.done` still fires and the shimmer stops, then emits
`message.deleted`. Nothing is withdrawn if the runtime printed any text — that would lose it — and
an empty summary with no reaction is a 422 that says what to do instead. A run whose whole answer
was a 👍 does not ping the human either.

**`posted` is now on the wire.** `SendResponse` and `DoneResponse` gained `posted: true`, and
`Deflected` is `posted: false`; both routes answer a union of the two. `steer` is merged into the
encoded body by the HTTP layer and pulled back off it by the client, rather than being declared on
all twenty-odd response schemas that would each drop it as an excess property.

**Conversation, not channel.** A run is steered by messages in the thread it replies into, which is
how two agents woken by one root message steer each other with no special case (D12). An agent is
never steered by its own message, nor by the one that woke it.

**Try it.** In one channel: `@clarifier @dumb can you agree on a colour and tell me which one?` The
first to finish posts. The second one's `taut_send` comes back `posted:false` carrying that message;
it reacts 👍 and calls `taut_done("")`. The thread holds the question, one answer with a 👍 chip, and
nothing else.

**Covered by tests.** `apps/server/test/steering.test.ts` (4): the deflection and its one-per-run cap,
the agent reaction stored as `agent` and hydrated onto the message, the withdrawal of the empty
reply, the 422 for an empty summary with nothing said, `steer` riding on a response and draining
once, and an agent never steered by itself. Plus `packages/taut-mcp/test/server.test.ts`
(`taut_react`, and `steer` surviving the client's decode). 247 server tests, 92 runtime, 34 taut-mcp.

**D8 was built, measured and deleted.** The plan gated streaming stdin on one unknown: does a user
message written to an open stdin mid-turn reach the model then, or wait for the turn to end?
`scripts/verify-streaming-stdin.mjs` answered it against the pinned `claude` on 2026-09-09 —
**TURN BOUNDARY**, the marker only appeared after the first turn closed. That is useless here,
because by the turn boundary the agent has already posted the answer this build exists to stop it
duplicating. So `TAUT_STREAM_STDIN`, `ExecOptions.stdinLines`, the adapter's
`--input-format stream-json` mode and their two tests were taken back out rather than left
shipped-but-off. The script stays: the answer belongs to a `claude` version, not to Taut, and if a
future one says MID-TURN the plan says how to build it again. **This leaves a real ceiling** — an
agent that thinks for a long stretch without touching a `taut_*` tool cannot be reached until it
does.

**Still failing, still not ours.** `test/phase3.test.ts > vault.revoke cascades…` and
`packages/contract test/api.test.ts > exposes the expected endpoints` (which now wants `channels.context`)
are the other session's in-flight channel work. `@taut/desktop` lint fails on `no-undef` in its
Electron `.js` files, untouched here.

## Project issues, and the ticket an agent files (build-plan-projects D18–D22)

Two features over one gate. The Linear mirror now holds a project's **issues**, and an agent can
**file one** — but only for a human who is mapped to a Linear person.

**Try it.** `/projects` → open any project → the **Issues** tab. Issues arrive on the next sync
(admin: Refresh on `/projects`), grouped by the team's own workflow states in the workspace's
order, each group collapsible with its count, each row Linear's own layout: priority glyph,
identifier, state ring, title, label chips, assignee, date. Rows and the group `+` open Linear,
which is still the only place an issue can be changed. Overview is unchanged; Activity still links
out. The tab lives in the URL as `?tab=issues`, so a link opens on it.

**The agent side.** Two new tools in the `taut` MCP server:

- `linear_projects` — the company's projects, plus `canCreateIssues` and a `reason` when false.
  One call, on purpose: an agent that must ask twice to learn it may not will ask neither.
- `linear_create_issue` — `{ projectId, title, description, priority? }` → the ticket, with the
  identifier to quote back.

**The gate (D21).** An agent files only for the human of the conversation it is answering — the
task's `triggerUserId`, never a tool argument — and only when that human is mapped to a Linear
person on `/settings/linear` (D15/D16). An unmapped human gets a refusal naming the settings page,
not a ticket assigned to whoever owns the API key. A run with no human behind it (a routine, a
schedule) files nothing. The team, the project and the assignee are all resolved from the mirror, so
no Linear id an agent typed is ever forwarded.

A personal API key authors every issue as the key's owner, so the human cannot be the creator in
Linear. `assigneeId` is how they are on it instead: the ticket lands in their Linear inbox, and a
footer Taut appends — not the model's description — says which agent filed it and where.

**Shape.** Migration `0030` adds `project_issues`, keyed on Linear's UUID and cascading from
`projects`, with the workflow state stored flat. `GET /projects/:projectId/issues`. The issues query
rides along with the projects sync and its failure is a warning, not a failed sync — a Linear that
refuses it leaves the previous issues standing. `project.issue.created` carries the whole issue, so
the tab redraws without a sync. The project mirror now also stores each team's Linear id, which is
what an agent's ticket is filed under.

**Tests.** `apps/server/test/projects.test.ts` 26 green, including: issues ordered by workflow
state; a Linear that will not answer for issues leaves the mirror standing; an unmapped human is
refused _before_ Linear is asked; a run with no human files nothing; a mapped human gets a ticket
assigned to them and in the mirror at once; another company's project is a 404, not a ticket
somewhere else.

**Not verified:** never run against real Linear — no issue has actually been created in a
workspace, and no agent has called either tool end to end. The Issues tab has not been rendered in a
browser (login needs the owner's password).

## Triggers and signals — routines that fire on events, and agents that wake themselves

`docs/build-plan-triggers.md`, decisions D1–D28. A routine used to fire when a clock said so. It
now fires when a `Trigger` says so, and a clock is one of two kinds of trigger.

**Try it.** `/agents/<id>` → **Routines** → New routine → the **Trigger** tab → "A huddle ends" →
pick a channel → save. Start a huddle in that channel, leave it, and the agent runs one turn in
your DM with the huddle's channel, duration, participants and chat thread already in its prompt.

Or the timer: DM an agent "remind me in three minutes to buy watermelon". It calls `emit_signal`,
answers, and its process exits. Three minutes later the wake lands **in that same thread**, the
runtime resumes with `--resume <the same session id>`, and the agent finishes what it promised. A
muted "Reminder at 6:32 PM · Cancel" row sits under the composer until it fires.

**Shape.** `Routine.schedule` + `Routine.timezone` collapsed into one `Routine.trigger`, a union of
`{_tag:'schedule'}` and `{_tag:'event'}` (D1). An event trigger calls the very `fire()` the
30-second clock tick calls, so it still posts `@handle <prompt>` as the owner and the ordinary
`Scheduler` makes the Task — one dispatch path, and every §9 gate still applies (D2).

Each `EventTrigger` variant's `_tag` **is** the `EventType` it listens for, so `matchesEvent` is a
switch on the same literal the bus carries (D3). Six of them: `call.ended`, `call.started`,
`message.created`, `agent.task.failed`, `project.issue.created`, `signal.emitted`. Signals add
exactly one bus event; the custom name is data, never a new `EventType`, so the `Event` union stays
closed (D16).

`call.ended` carries only `{callId, channelId, endedAt}`, so a "ignore huddles under a minute"
filter is unsatisfiable from the event alone. `matchesEvent(trigger, event, facts?)` takes the
duration as a fact the runner already holds, and **fails closed** when it is missing.

Loop safety is structural, not heuristic. An event whose actor is the routine's own agent never
fires that routine (D6); a routine fires at most 20 times an hour (D7); an overlapping previous run
skips (D8). Signals get the opposite of D6 on purpose (D27) and three other valves instead: depth
is **time-scoped**, so a signal delivered within 60s of the task that emitted it inherits depth+1
and is refused past 10, while one delivered later resets to 0 (D23) — a watcher re-arming every
three minutes runs forever, ten hops in a minute is stopped. Signal wakes count toward the existing
`TURN_CAP` of 20, and a wake that would exceed it cancels the signal with the existing note rather
than queueing (D24). At most 50 armed signals per agent (D25).

Migration `0031` moves `schedule_json`+`timezone` into `trigger_json`, backfilling in pure SQL, and
adds the denormalised `trigger_kind`/`trigger_event` columns SQLite needs to index the hot path.
`0032` adds `signals` and `tasks.signal_id`. Two new daemons: `triggerRunner` over
`Bus.streamAll()`, and `signalRunner` on a 5-second tick. Broadcast delivery is *only* a publish on
the bus — the trigger runner picks it up through `SignalTrigger`, so the two paths meet at the bus
and nowhere else. Three agent tools: `emit_signal`, `list_signals`, `cancel_signal`, reaching the
agent through `packages/taut-mcp`.

**Tests.** 544 green across the workspace (`@taut/server` 271, `@taut/contract` 132), including the
watermelon case end to end on a stubbed clock: the task emits, the task ends, the tick at +3 min
posts into the same thread, and the wake relaunches the runtime against a single `agent_sessions`
row. Also: a huddle under `minSeconds` fires nothing; an agent's own message never fires its own
`message.created` trigger; eleven immediate hops stopped at ten while the same chain two minutes
apart is never capped; the 51st armed signal refused; a thread at `TURN_CAP` cancelling the signal
with a note; a broadcast waking a second agent through its `SignalTrigger` and not one whose names
do not match.

**Not verified:** nothing has been clicked. No browser ran against the new Routines tab, the
Trigger picker, or the pending-reminder row — the layout, the popovers inside the dialog's scroll
container and the keyboard roving are all unexercised. `call.ended` triggers have never run against
a real LiveKit; the tests insert `calls` rows directly. `Signals.emit` from a human is supported by
the schema and has no caller. There is no `taut signal` CLI subcommand — the MCP surface is
complete, the human shortcut is not.
