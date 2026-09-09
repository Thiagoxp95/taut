# Build plan: repositories (GitHub App · company repos · per-agent read/write)

Engineering contract for one owner requirement (2026-09-08): **a company connects to GitHub and
picks the repositories that belong to it; every agent is then granted each repository as read-only
or read-write, where read-write means it may push a branch and open a pull request.** Extends
`docs/build-plan.md`, `docs/build-plan-browser-vaults.md` and `docs/build-plan-workspace.md`.
Effect everywhere; pinned versions from `docs/CHANGELOG.md` (effect 3.22.1, @effect/platform 0.97.1).

> Taut says **company** where the owner said "organization". Same thing. Do not rename anything.

## Owner requirement (verbatim intent)

> "When we are creating an organization, we should be able to connect with GitHub and select
> repositories that we want to have for this organization. And when we are creating agents, and when
> we are on the agents page, we can modify the agent to have read-only to the repository or
> read-or-write which means that it can push PRs."

Plus, on the checkout question:

> "I think we should have worktrees for that. Agents should always be working on worktrees for any
> bug fixes, any new feature, anything that is going to modify code, and if the agent is read only
> then only [fetch] from the primary branch which is production or the main or whatever."

## What already exists (do not rebuild)

| thing                  | today                                                                                                                     |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Per-agent box          | `MachineProvider.ensure`, one long-lived container per agent (`packages/runtime/src/machine/`).                           |
| Agent home layout      | `packages/runtime/src/machine/home.ts`, `HOME_DIRS = ['skills','memory','inbox','work','.taut']`.                         |
| Task working dir       | `<home>/work/<taskId>`, set at `apps/server/src/agents/runTask.ts:795`.                                                   |
| Grant precedent        | `AgentFileGrant { agentId, path, mode: 'ro'                                                                               | 'rw' }` (`packages/contract/src/domain/agent.ts`), surfaced through `addDirs`in`runTask.ts`. |
| Manage-agent authz     | `requireManageAgent` (admin+ or the head of the agent's department), `apps/server/src/services/agentAccess.ts`.           |
| Secret encryption      | `apps/server/src/vault/crypto.ts` — `encrypt`/`decryptToString`, AEAD, AAD is the row id, key from `AppConfig.masterKey`. |
| Agent → server channel | `apps/server/src/agents/agentApi.ts` + `tokens.mint` (per-task bearer token), consumed by `packages/taut-mcp`.            |
| Public URL             | `TAUT_PUBLIC_URL` already in `apps/server/src/config.ts`.                                                                 |
| Outbound HTTP          | `@effect/platform` `HttpClient`, used in `apps/server/src/services/usageProbe.ts`. Follow that style.                     |

## Decisions (do not re-litigate; flag in your report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                                                               | why                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A repository belongs to a company, not to an agent.** New table `repositories`; agents get _grants_ against it. Attaching/detaching a repository is **admin+** (`requireAdmin`); granting one to an agent is **whoever may manage that agent** (`requireManageAgent`).                                                               | Same shape as the vault: company owns the asset, department heads hand it out.                                                                                                                                             |
| D2  | **The connection is a GitHub App created through the manifest flow**, one app per Taut deployment-company. No PAT path in this phase.                                                                                                                                                                                                  | An App installation token can be minted **scoped to one repository with `contents: read` or `contents: write`**. That is the only primitive that makes read-only _real_ rather than advisory. A PAT cannot be down-scoped. |
| D3  | **Repository selection happens twice, and both are honoured.** GitHub's own installation picker decides what the App can see; Taut's list then decides which of those are _attached_ to the company. An agent may only be granted an attached repository.                                                                              | The owner asked to "select repositories"; GitHub will not let us bypass its picker, and we should not want to.                                                                                                             |
| D4  | **No token is ever written to disk or into the container environment.** `git` inside the box authenticates through a credential helper that calls the Taut agent API with the task's existing bearer token; the server answers with a freshly minted, repo-scoped, one-hour installation token.                                        | An `rw` token sitting in `.git-credentials` is a company-wide push credential that every later task and every `vault_get`-style read can find.                                                                             |
| D5  | **Every task gets a git worktree; the primary clone is never worked in** (owner decision). `<home>/repos/<owner>__<name>` is a pristine clone kept on the default branch. `rw` → `git worktree add -b taut/<handle>/<taskId-short> <work>/<name> origin/<default>`. `ro` → `git worktree add --detach <work>/<name> origin/<default>`. | Worktrees give each task a clean checkout without re-cloning, and keep the object store shared.                                                                                                                            |
| D6  | **Read-write means branch + pull request, never the default branch.** The minted token carries `contents: write` and `pull_requests: write`; a `pre-push` hook installed in every `rw` worktree rejects a push whose target ref is the repository's default branch.                                                                    | The owner said "push PRs". A token alone cannot express "not main".                                                                                                                                                        |
| D7  | **Pull requests are opened by the server, through a new `taut` MCP tool `github_open_pr`.** The agent never calls the GitHub API directly. The tool is refused for `ro` grants and for repositories the agent has no grant on.                                                                                                         | Auditable, and it keeps `gh` out of the image.                                                                                                                                                                             |
| D8  | **The App's private key, client secret and webhook secret are encrypted at rest** with `vault/crypto.ts`, AAD = the company id. No endpoint ever returns them, not even redacted.                                                                                                                                                      | Same bar as the vault.                                                                                                                                                                                                     |
| D9  | **No webhooks in this phase.** The repository list is fetched on demand from `GET /installation/repositories`. Store the webhook secret, wire nothing.                                                                                                                                                                                 | A self-hosted deployment usually has no inbound URL, and nothing in this feature needs push-time reaction.                                                                                                                 |
| D10 | **github.com only.** No GitHub Enterprise Server base-URL setting in this phase; leave the host in one constant so adding it later is a one-line change.                                                                                                                                                                               | Scope.                                                                                                                                                                                                                     |
| D11 | **Connecting GitHub is optional and never blocks company creation.** Onboarding creates the company first, then offers a "Connect GitHub" step that can be skipped; the same flow lives permanently under company settings.                                                                                                            | A company with no repositories must stay fully usable.                                                                                                                                                                     |
| D12 | **Migration `0017_repositories.ts`.** Another session edits this repo concurrently: if `0017` is taken when you start, take the next free number and say so in your report. Do not renumber anyone else's.                                                                                                                             | Append-only migration numbers are contended.                                                                                                                                                                               |
| D13 | **Reuse `FileGrantMode` (`'ro'                                                                                                                                                                                                                                                                                                         | 'rw'`)** for repository access. Do not introduce a second two-value enum.                                                                                                                                                  | One vocabulary for "what may this agent do to that thing". |
| D14 | **A repository the agent has no grant on does not exist for that agent** — not in its instructions, not in its worktrees, not in `github_open_pr`, and `NotFound` (never `Forbidden`) from the agent API.                                                                                                                              | No leaking the company's repository list into an agent's context.                                                                                                                                                          |

## Schemas (verbatim — every wave codes against these)

`packages/contract/src/ids.ts`, add to `IdPrefix`:

```ts
repository: 'rep',
```

…and `export const RepositoryId = idSchema('rep', 'RepositoryId')`.

New `packages/contract/src/domain/repository.ts`:

```ts
/** A GitHub repository attached to a company (docs/build-plan-repositories.md D1). */
export class Repository extends Schema.Class<Repository>('Repository')({
  id: RepositoryId,
  companyId: CompanyId,
  /** GitHub's numeric repo id — the stable identity across renames. */
  githubId: Schema.Number,
  /** `octocat` in `octocat/hello-world`. */
  owner: Schema.String,
  /** `hello-world` in `octocat/hello-world`. */
  name: Schema.String,
  /** `octocat/hello-world`, denormalised for display and lookup. */
  fullName: Schema.String,
  /** Branch a read-only agent reads and a read-write agent branches from. */
  defaultBranch: Schema.String,
  private: Schema.Boolean,
  /** `https://github.com/octocat/hello-world.git` — what the clone uses. */
  cloneUrl: Schema.String,
  attachedAt: Schema.DateTimeUtc
}) {}

/** A repository an agent may use, and how (D13). */
export class AgentRepoGrant extends Schema.Class<AgentRepoGrant>('AgentRepoGrant')({
  agentId: AgentId,
  repositoryId: RepositoryId,
  mode: FileGrantMode
}) {}

/** Where the company stands with GitHub. No secret is ever part of this. */
export class GithubConnection extends Schema.Class<GithubConnection>('GithubConnection')({
  companyId: CompanyId,
  /** `none` → nothing yet · `app-created` → app exists, not installed · `connected` → installed. */
  state: Schema.Literal('none', 'app-created', 'connected'),
  /** The App's `slug`, used to build the install URL. Absent while `none`. */
  appSlug: Schema.optional(Schema.String),
  /** The account the App is installed on, e.g. `acme-inc`. Present only when `connected`. */
  accountLogin: Schema.optional(Schema.String),
  connectedAt: Schema.optional(Schema.DateTimeUtc)
}) {}

/** One row of GitHub's installation repository list — a candidate for attaching (D3). */
export class AvailableRepository extends Schema.Class<AvailableRepository>('AvailableRepository')({
  githubId: Schema.Number,
  owner: Schema.String,
  name: Schema.String,
  fullName: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
  cloneUrl: Schema.String,
  /** Already attached to this company. */
  attached: Schema.Boolean
}) {}
```

New `packages/contract/src/api/repositories.ts` — group `repositories`, prefix `/repositories`,
`Authentication` middleware, added to `TautApi` in `api/index.ts` after `AgentsGroup`:

```
GET    /repositories/github                 → GithubConnection
POST   /repositories/github/manifest        → { postUrl: string, manifest: string, state: string }
GET    /repositories/github/callback        ?code&state  → 302 to the web app (see below)
GET    /repositories/github/install-url     → { url: string }
GET    /repositories/github/setup           ?installation_id&state → 302 to the web app
DELETE /repositories/github                 → 204   (admin+, drops the app row and every repository)
GET    /repositories/available              → Page(AvailableRepository)   (admin+)
GET    /repositories                        → Page(Repository)
POST   /repositories/attach                 payload { githubIds: ReadonlyArray<number> } → Page(Repository) (admin+)
DELETE /repositories/:repositoryId          → 204 (admin+; cascades its grants)
```

On `packages/contract/src/api/agents.ts` (`AgentsGroup`), after the file-grant block:

```
GET    /:agentId/repositories               → ReadonlyArray<AgentRepoGrant>
PUT    /:agentId/repositories/:repositoryId payload { mode: FileGrantMode } → AgentRepoGrant
DELETE /:agentId/repositories/:repositoryId → 204
```

`AgentDetail` gains `repoGrants: Schema.Array(AgentRepoGrant)`, and `CreateAgentPayload` gains
`repoGrants: Schema.optional(Schema.Array(Schema.Struct({ repositoryId: RepositoryId, mode: FileGrantMode })))`
so the create-agent form can grant on the way in.

### Migration `0017_repositories.ts`

```sql
CREATE TABLE github_apps (
  company_id       TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  app_id           INTEGER NOT NULL,
  app_slug         TEXT NOT NULL,
  client_id        TEXT NOT NULL,
  client_secret_ct BLOB NOT NULL,
  private_key_ct   BLOB NOT NULL,
  webhook_secret_ct BLOB,
  installation_id  INTEGER,
  account_login    TEXT,
  created_at       TEXT NOT NULL,
  connected_at     TEXT
);
CREATE TABLE repositories (
  id             TEXT PRIMARY KEY,
  company_id     TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  github_id      INTEGER NOT NULL,
  owner          TEXT NOT NULL,
  name           TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  default_branch TEXT NOT NULL,
  private        INTEGER NOT NULL,
  clone_url      TEXT NOT NULL,
  attached_at    TEXT NOT NULL,
  UNIQUE (company_id, github_id)
);
CREATE TABLE agent_repos (
  agent_id      TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  mode          TEXT NOT NULL,
  granted_at    TEXT NOT NULL,
  PRIMARY KEY (agent_id, repository_id)
);
CREATE INDEX idx_agent_repos_repository ON agent_repos(repository_id);
```

## The GitHub App manifest flow, concretely

1. Web calls `POST /api/repositories/github/manifest`. Server builds the manifest and a signed,
   single-use `state` (HMAC over `{companyId, userId, exp}` with the master key; 10-minute life).
   `redirect_url` is `${TAUT_PUBLIC_URL}/api/repositories/github/callback`,
   `setup_url` is `${TAUT_PUBLIC_URL}/api/repositories/github/setup`, `public: false`,
   `default_permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }`,
   `default_events: []`. `postUrl` is `https://github.com/settings/apps/new?state=<state>`.
   **Fail with `Validation` when `TAUT_PUBLIC_URL` is unset** — say exactly that in the message.
2. Web renders a real `<form method="POST" action={postUrl}>` with one hidden input `manifest`
   holding the JSON, and submits it. GitHub shows its create-app page; the owner names it and clicks
   Create.
3. GitHub redirects to the callback with `?code=…&state=…`. Server verifies `state`, then
   `POST https://api.github.com/app-manifests/{code}/conversions` → `{ id, slug, client_id,
client_secret, pem, webhook_secret }`. Encrypt and insert `github_apps`. Redirect the browser to
   `${TAUT_PUBLIC_URL}/settings/repositories?github=app-created`.
4. Web then sends the owner to `https://github.com/apps/<slug>/installations/new?state=<state>`
   (`GET /install-url`). The owner picks the account and **the repositories** — this is GitHub's
   picker, D3.
5. GitHub redirects to `setup_url` with `?installation_id=…&state=…`. Server verifies `state`,
   stores `installation_id` + `account_login` (from `GET /app/installations/{id}`), sets
   `connected_at`, redirects to `${TAUT_PUBLIC_URL}/settings/repositories?github=connected`.

### Token minting (`GitHubApp` service)

- App JWT: RS256 over `{ iat: now-60, exp: now+540, iss: app_id }`, signed with `node:crypto`
  `createSign('RSA-SHA256')` on the decrypted PEM. **No new dependency.**
- Installation token: `POST /app/installations/{installation_id}/access_tokens` with the JWT and
  body `{ repositories: [name], permissions }` — `ro` → `{ contents: 'read', metadata: 'read' }`,
  `rw` → `{ contents: 'write', pull_requests: 'write', metadata: 'read' }`.
- Cache per `(companyId, repositoryId, mode)` in memory until `expires_at - 60s`.
- Every response is `Redacted`. Never log a token, never include one in an error.

## Inside the box

### Layout

```
<home>/repos/<owner>__<name>/     pristine clone, on <defaultBranch>, never edited
<home>/work/<taskId>/<name>/      the worktree this task works in
```

### Per-task lifecycle (in `runTask.ts`, after `cwd` is computed and before `writeMcpConfig`)

1. `repositories.grantsOf(agent.id)` → `[{ repository, mode }]`. Empty → skip the whole block, and
   the task path must stay byte-identical to today.
2. For each grant, over `machine.exec`:
   - clone if missing: `git clone --filter=blob:none <cloneUrl> <home>/repos/<owner>__<name>`
   - `git -C <primary> fetch --prune origin`
   - `rw`: `git -C <primary> worktree add -b taut/<handle>/<taskId last 8> <work>/<name> origin/<default>`
   - `ro`: `git -C <primary> worktree add --detach <work>/<name> origin/<default>`
   - `rw` only: write `<work>/<name>/.git/hooks/pre-push`, mode 0755, refusing any push whose
     remote ref is `refs/heads/<defaultBranch>` with a one-line message naming `github_open_pr`.
3. `addDirs` gains every worktree path.
4. After the task: `git -C <primary> worktree remove --force <path>` **unless** the branch has
   commits not on `origin/<default>` — leave those, `Effect.logInfo` the branch name, and prune on
   the next run once they are pushed. Always `git -C <primary> worktree prune`.
5. A failure anywhere in step 2 must **not** fail the task. Log a warning, drop that repository from
   the instruction file, and carry on. A GitHub outage cannot stop an agent answering a message.

### Credentials

- `git` is configured per-exec with
  `GIT_CONFIG_COUNT=1`, `GIT_CONFIG_KEY_0=credential.https://github.com.helper`,
  `GIT_CONFIG_VALUE_0=!taut git-credential` — no global git config written into the image.
  **Two deviations, both required.** `credential.https://github.com.useHttpPath=true`, or the
  helper never learns which repository is being asked for. And an empty `credential.helper`
  **before** the two, because helpers are a list git appends to: macOS ships `osxkeychain` in
  the system git config, so without the reset it runs alongside ours and its `store` pops
  "The keychain cannot be found to store 'https://x-access-token@github.com'" on every clone.
  Three entries, reset first.
- `packages/taut-mcp` gains a `git-credential` subcommand on the existing CLI: it reads git's
  key/value block on stdin, and on `get` calls `POST <TAUT_URL>/agent/git-credential` with the task
  bearer token already in its env and the requested `host`/`path`, printing
  `username=x-access-token` and `password=<token>`. `store` and `erase` are no-ops that exit 0.
- New agent-API endpoint `POST /agent/git-credential` in `apps/server/src/agents/agentApi.ts`:
  resolves the task token → agent, maps `path` (`/owner/name(.git)`) to a granted repository,
  `NotFound` when there is no grant (D14), mints at the grant's mode, returns
  `{ username, password, expiresAt }`. Log `{ agentId, repositoryId, mode }` — never the token.

### `github_open_pr` (D7)

New tool in `packages/taut-mcp/src/tools.ts` + `protocol.ts`, and its handler in `agentApi.ts`:

```
github_open_pr({ repo: "owner/name", title, body, head?, base? })
```

`head` defaults to the branch of that repository's worktree for this task, `base` to
`defaultBranch`. Refused with a plain sentence when the grant is missing or `ro`. Server pushes
nothing — the agent pushes its branch itself, the tool only opens the PR
(`POST /repos/{owner}/{repo}/pulls`). Returns `{ url, number }`.

### Instructions (`packages/runtime/src/instructions.ts`)

When the agent has grants, add a `## Repositories` section: one line per repository giving the
worktree path, `read-only` / `read-write`, the branch it is on, and for `rw` the two rules —
never push to the default branch, open the pull request with `github_open_pr`. Nothing when there
are no grants.

## The UI

- **Company settings → Repositories** (`apps/web/src/routes/_app.settings.repositories.tsx`, new,
  linked from the settings nav next to Vault). Three states, driven by `GithubConnection.state`:
  `none` → the Connect card that POSTs the manifest form; `app-created` → "Install it on your
  GitHub account" with the install link; `connected` → the account name, a Disconnect button, and
  the repository list with a picker of `AvailableRepository` rows to attach or detach.
- **Onboarding** (`_auth.onboarding.tsx`) gains a second, skippable step after the company is
  created: the same Connect card, plus "Skip for now" going to `/`. D11.
- **Agent detail** (`_app.agents.$agentId.tsx`) gains a `Repositories` tab after `Skills`, rendered
  by a new `apps/web/src/components/agent-repos.tsx`: every attached repository with a three-way
  control — No access · Read-only · Read & write. Disabled with an explanatory line for anyone who
  may not manage the agent, and an empty state linking to settings when the company has none.
- **New agent** (`_app.agents.new.tsx`) gains the same list, feeding `CreateAgentPayload.repoGrants`.
- Hooks go in `apps/web/src/lib/api.ts` beside the existing ones, same TanStack Query patterns.

## Build order

1. **W1a — contract + server core.** ids, `domain/repository.ts`, `api/repositories.ts`, the
   `AgentsGroup` additions, migration `0017`, `services/githubApp.ts` (manifest, conversion, JWT,
   installation tokens, `open PR`), `services/repositories.ts` (attach/detach/list/grants + authz),
   `http/repositories.ts`, the `agentApi.ts` credential + PR endpoints, `domain/rows.ts` rows,
   events. Wire the group into `TautApi` and the layer into `apps/server/src/layers.ts`.
2. **W1b — the box.** Worktree lifecycle in `packages/runtime`, `runTask.ts` integration,
   `instructions.ts`, the pre-push hook, the `git-credential` CLI subcommand and the
   `github_open_pr` tool declaration in `packages/taut-mcp`. Codes against the schemas above.
3. **W1c — the web.** Settings page, onboarding step, agent tab, create-agent list, api hooks.
4. **W2 — tests and docs.** `apps/server/test/` coverage for authz, token scoping, state
   verification and grant enforcement; a `docs/CHANGELOG.md` phase entry.

W1a, W1b and W1c are disjoint by directory and run in parallel. W2 lands last.

## Definition of done

- `pnpm typecheck` and `pnpm lint` clean across the workspace.
- An admin can connect GitHub, attach repositories, and grant them per agent, all from the UI.
- A `ro` agent's push is rejected **by GitHub**, not by a local check — verify this, it is the
  whole point of D2.
- An `rw` agent can push `taut/<handle>/<id>` and open a PR, and cannot push the default branch.
- An agent with no grants runs exactly as it does today.
