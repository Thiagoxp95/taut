# Build plan: agent browser access + agent vaults

Engineering contract for two owner requirements (2026-09-08). Extends `docs/build-plan.md`;
`docs/agent-model.md` §3 (vault), §5 (agents), §7 (machines), §9 (MCP) are the spec being amended.
Effect everywhere, pinned versions from `docs/CHANGELOG.md` (effect 3.22.1 / platform 0.97.1 /
vitest 3.2.7). Migrations are append-only; the next free id is `0007`.

## Owner requirements (verbatim intent)

1. **Browser access is a per-agent toggle.** Off by default. When on, the agent has a browser tool
   inside its machine.
2. **Two vault scopes.**
   - **Company vault** — every agent in the company can use every item. Owner/admin add and revoke
     (unchanged).
   - **Agent vault** — items belong to exactly one agent. Only that agent can use them at runtime.
     Only owner/admin or the head of that agent's department can add / list / revoke them.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                             | why                                                                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | Browser = **Playwright MCP** (`@playwright/mcp@0.0.80`, Apache-2.0, bin `playwright-mcp`) run as a second stdio MCP server **inside the agent's machine**, server key `browser`, headless Chromium, persistent profile at `<home>/.taut/browser/profile`, screenshots to `<home>/.taut/browser/out`. | Standard, maintained, works in Docker, one config key away from the existing `taut` server. Persistent profile = logins survive tasks.           |
| D2  | `Agent.browserAccess: boolean` (column `browser_access INTEGER NOT NULL DEFAULT 0`). Settable on create and update by the same actors that may manage the agent (`requireManage`: admin+ or department head).                                                                                        | It is an agent setting like `permissionMode`.                                                                                                    |
| D3  | Agent-scoped items stay in `vault_items` with a new nullable `agent_id` column (FK agents, ON DELETE CASCADE). `company_id` stays; **crypto is unchanged** (key = HKDF(master, companyId), AAD = item id).                                                                                           | No new key derivation, no version bump; scope is a row-level fact.                                                                               |
| D4  | **`agent_vault_grants` is retired.** Company items are implicitly usable by every agent of the company; agent items only by their agent. The grant endpoints, the "Vault access" tab, and the table go away (migration 0007 drops it).                                                               | Owner: "the company vault where all agents can see". Grants were never consulted at task time anyway (no `vault_get` existed).                   |
| D5  | New MCP tools `vault_list` and `vault_get` in `@taut/taut-mcp`, backed by the agent-runtime API. `vault_get` returns plaintext to the agent's process, is audited (`purpose: 'tool'`), and its value is added to the task's redactor so it can never appear in chat or logs.                         | Without a way to _use_ a secret, an agent vault is decoration. The spec already lists `vault_get` as the missing tool (agent-model.md line ~71). |
| D6  | UI: the agent page's `vault` tab becomes **"Agent vault"** (list / add / revoke agent items, gated on `canManage`). `/vault` stays the company vault. The browser toggle lives in the agent Runtime tab and on `/agents/new`.                                                                        | Mirrors the two scopes one-to-one.                                                                                                               |
| D7  | Playwright MCP is launched with `--no-sandbox` inside Docker (the container is the sandbox: cap-drop ALL, no-new-privileges, read-only rootfs). Chromium binaries live at `/opt/pw-browsers` (outside the bind-mounted home).                                                                        | Chromium's own sandbox needs caps the container deliberately lacks.                                                                              |

| D8 | **Agents write their own vault and nothing else.** New agent-runtime routes `POST /vault/add`, `/vault/update`, `/vault/delete` and MCP tools `vault_add` / `vault_update` / `vault_delete`, backed by `Vault.{add,update,revoke}ForAgent`. The owner is the task token's agent — never a request field — and the UPDATE/DELETE statements carry `agent_id = <the agent>` in their WHERE clause, so a company item (`agent_id IS NULL`) is unreachable. Company items and other agents' items are `403`, as is deleting an item that still backs a subscription. Audited as `agent_add` / `agent_update` / `agent_revoke`; new event `vault.item.updated`. | Owner rule (2026-09-08): "agents can never add, modify, delete or update any vault of the company. They can only crud their own vault. Not other agent vaults as well." An agent that browses and is handed a login needs somewhere to keep it, and that somewhere must be its own vault. |

Out of scope (later): a `web.login` credential kind (url + user + password), egress allow-lists,
browser access for the `local` provider beyond "you ran `playwright install chromium` on the host".

## Interfaces every agent must honour

### `@taut/contract`

```ts
// domain/agent.ts
Agent: + browserAccess: Schema.Boolean            // default false in toAgent/migration
// api/agents.ts
CreateAgentPayload: + browserAccess?: boolean
UpdateAgentPayload: + browserAccess?: boolean
// remove: vaultGrants / grantVault / revokeVaultGrant endpoints, GrantVaultPayload
AgentDetail: { agent, skills, fileGrants }        // vaultGrants removed

// domain/vault.ts
VaultItemMeta: + agentId: Schema.optional(AgentId)   // undefined = company scope
// domain/agent.ts: remove AgentVaultGrant
// api/vault.ts
AddVaultItemPayload: + agentId?: AgentId          // present = agent-scoped item
ListVaultQuery = PageQuery & { agentId?: AgentId } // absent = company items only
vault.list  GET /vault?agentId=…  → Page(VaultItemMeta)
vault.add   POST /vault            → 201 VaultItemMeta   errors Forbidden | NotFound | VaultLocked
vault.revoke DEL /vault/:id        → 204                 errors Forbidden | NotFound
```

Events: `vault.item.created` / `vault.item.revoked` keep their shape (`item` now carries `agentId`);
`agent.updated` carries `browserAccess`. No new event types.

### Server authorization (services, not routes)

| call                                     | company item (`agentId` null)                  | agent item                                                  |
| ---------------------------------------- | ---------------------------------------------- | ----------------------------------------------------------- |
| `vault.list`                             | any member                                     | admin+ or head of that agent's department, else `Forbidden` |
| `vault.add`                              | admin+                                         | admin+ or head of that agent's department                   |
| `vault.revoke`                           | admin+                                         | admin+ or head of that agent's department                   |
| `vault.resolveForSpawn(itemId, agentId)` | any agent of the company (or via subscription) | only `item.agentId === agentId`                             |

`requireManage(who, agentId)` moves out of the `Agents` service closure into
`apps/server/src/services/agentAccess.ts` (`canManageAgent`, `requireManageAgent`, backed by the
existing `headOfAgentDepartment` query) so `Vault` and `Agents` share it.

### Agent-runtime API (task-token authenticated, `apps/server/src/agents/agentApi.ts` + its routes)

```
GET  /api/agent-runtime/vault            → { items: VaultItemMeta[] }   // company items + this agent's items
POST /api/agent-runtime/vault/get  { vaultItemId }  → { id, kind, label, secret }
     403 when the item is another agent's; 404 when unknown; audit purpose 'tool';
     the plaintext is pushed to the task's redactor before the response is written.
```

Protocol schemas (`packages/taut-mcp/src/protocol.ts`): `VaultListResponse`, `VaultGetRequest`,
`VaultGetResponse`.

### `@taut/runtime`

```ts
// redact.ts
interface Redactor { redact(text): string; readonly size: number; add(secret: string): void }
// run.ts  RunTaskOptions
redactor?: Redactor        // caller-owned; env/file secrets are add()ed to it. Default: fresh one.
// adapters/types.ts  McpOptions.allowedTools already exists — pass ['mcp__taut__*', 'mcp__browser__*'] when browserAccess.
// new: src/browser.ts
export const BROWSER_MCP_SERVER_KEY = 'browser'
export const BROWSER_MCP_ALLOWED_TOOL = 'mcp__browser__*'
export interface BrowserMcpSpec { command: string; args: ReadonlyArray<string>; env?: Record<string,string> }
export const browserMcpSpec = (o: { provider: 'local' | 'docker'; homeDir: string /* as seen inside the machine */ }): BrowserMcpSpec
//   docker: command 'playwright-mcp' (global bin in the image), args: --headless --browser chromium --no-sandbox --user-data-dir <home>/.taut/browser/profile --output-dir <home>/.taut/browser/out
//   local : command 'node', args: [require.resolve('@playwright/mcp/cli.js'), same flags minus --no-sandbox]
```

`@taut/taut-mcp` `inject.ts`: every `*McpConfig(o)` / `codexConfigToml(o)` gains
`o.extraServers?: Record<string, { command, args, env? }>` and emits them next to `taut`
(Claude: `mcpServers.<key>`; Codex: `[mcp_servers.<key>]`; Cursor: `mcpServers` + `allow: ['Mcp(<key>:*)']`;
OpenCode: its `mcp` map). `claudeArgs` accepts an optional list of extra allowed tool patterns.

`agent.Dockerfile`: `npm i -g @playwright/mcp@0.0.80`, `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`,
`npx playwright install --with-deps chromium` (as root, before `USER agent`), dirs readable by uid 1000.
Also copy the bundled `mcp.js` to `/opt/taut/mcp.js` (closes CHANGELOG gap 4).

### Server task runner (`apps/server/src/agents/runTask.ts`)

- Build one `Redactor` per task (`makeRedactor([seat.secret])`), keep it in a `Map<TaskId, Redactor>`
  owned by `TaskRunner` (exposed as `registerSecret(taskId, secret)`; entry removed when the task ends).
  Pass it to `runtimeRunTask({ redactor })`.
- When `agent.browserAccess`: `writeMcpConfig` adds `extraServers: { browser: browserMcpSpec(...) }`
  for the agent's runtime kind, and `buildCommand` gets `mcp.allowedTools = ['mcp__taut__*', 'mcp__browser__*']`.
  Add one line to the task prompt/instructions: "You have a headless browser (tools `mcp__browser__*`)."
- Nothing else about spawning changes; company items are **not** auto-injected as env — agents fetch
  them with `vault_get`.

### Web (`apps/web`)

- `useVaultItems({ agentId? })`, `useAddVaultItem` (payload may carry `agentId`), `useRevokeVaultItem`;
  query key `qk.vault(agentId?)`; realtime handler invalidates every vault key.
- Agent page `vault` tab → "Agent vault": table of agent items (label, kind, hint, last used), Add secret
  dialog (reuse `AddSecretForm` with a fixed `agentId`), Revoke; whole tab visible only when `canManage`.
- Runtime tab: `Switch` "Browser access" + one-line help; saved with the existing Save runtime submit.
  `/agents/new`: same switch, default off.
- `/vault`: unchanged except the "used by agents" column no longer reads grants.

## Phases and ownership (disjoint directories)

| phase | agent | owns                                                                                                                             | must not touch                                                                |
| ----- | ----- | -------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| 1A    | Fable | `packages/contract`, `apps/server/src/{db,domain,services,http}`, `apps/server/test` (contract + service tests)                  | `apps/server/src/agents`, `packages/runtime`, `packages/taut-mcp`, `apps/web` |
| 1B    | Fable | `packages/runtime`, `packages/taut-mcp` (tools, protocol, inject, Dockerfile, tests)                                             | everything else                                                               |
| 2A    | Fable | `apps/server/src/agents/**` (runTask wiring, agentApi vault endpoints), `scripts/e2e.sh`, `docs/agent-model.md`, CHANGELOG entry | `apps/web`                                                                    |
| 2B    | Opus  | `apps/web/**`                                                                                                                    | server, packages                                                              |

Each phase ends with `pnpm typecheck && pnpm test` green for the packages it touched and a report:
what works, how to try it, what is untested, exact versions added.

## Acceptance (what the owner will click)

1. `/agents/new` → Browser access on → create. Agent detail Runtime tab shows the switch on; a
   DM "open https://example.com and tell me the h1" gets answered using `mcp__browser__*` (local
   provider needs `npx playwright install chromium` once on the host).
2. As Design head (`dana@taut.local`): agent `mila` → Agent vault tab → Add secret → it appears with
   hint only; as a plain member the tab is absent; the API returns 403 for a non-head member.
3. Agent DM "use vault_list then vault_get on <label> and reply with its length" → reply contains
   the length, never the value; `audit_log` has a `tool` row; `/vault` does not show the agent item.
4. `pnpm e2e` gains: agent-vault add as head, `vault_get` round-trip through the MCP, redaction
   assertion (the secret string never appears in any message body).

## Status (2026-09-08, evening)

| phase | state                     | where to look                                                                                                                                                                 |
| ----- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1A    | done                      | `apps/server/src/{db/migrations/0007_agent_vaults_browser.ts, services/vault.ts, services/agentAccess.ts}`, `test/phase7.test.ts`                                             |
| 1B    | done                      | `packages/runtime/src/browser.ts`, `packages/taut-mcp/src/{inject,protocol,tools}.ts`, `agent.Dockerfile`                                                                     |
| 2A    | done                      | `apps/server/src/agents/{runTask,agentApi,prompt}.ts`, `http/agentRuntime.ts` (two routes), `test/phase7b.test.ts`, `scripts/e2e.sh` steps 13–15 — CHANGELOG "Phase 2A" entry |
| 2B    | in progress (other agent) | `apps/web`                                                                                                                                                                    |

Deviation from the 2A contract worth knowing: `vault_get` answers `409 task_mismatch` (not a secret) when the task
is no longer running — the redactor is gone with the task, so nothing would mask the value; task tokens stay valid
for 10 min after a task ends only for late `taut_done` / memory notes.
