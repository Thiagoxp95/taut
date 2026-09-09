# Build plan — Skills an agent can absorb, author and keep current

Engineering contract for one owner requirement (2026-09-08 evening): **you talk to an agent, hand
it a skill, and it absorbs it — a link, an `npx skills` command, or pasted markdown. Agents write
their own skills. Installed skills stay current on their own.**

Extends `docs/build-plan.md` and `docs/agent-model.md` §5. Effect everywhere, pinned versions from
`docs/CHANGELOG.md`. Migrations are append-only: **this build owns `0021`** (`0020` is the
repositories build). This partly un-defers "Shared skill library" from `agent-model.md`; the
company-wide library itself stays deferred (see Non-goals).

## Owner requirement (verbatim intent)

> "I want to be able to talk to the agents and give them skills for them to absorb. So they should
> be able to code their own agent skills. For example, I wanna drop this link
> `https://www.aihero.dev/skills-grill-with-docs` or the npx command
> `npx skills@latest add mattpocock/skills --skill=grill-with-docs`. And you should be able to
> auto-update its own skills."

Three capabilities, one subsystem:

1. **Absorb** — a source string (link, `owner/repo`, or an `npx skills` command) becomes a real
   skill in `<home>/skills/<name>/`, from chat or from the agent page.
2. **Author** — an agent writes its own `SKILL.md` from what it learned, through an MCP tool.
3. **Keep current** — an installed skill records where it came from and checks upstream daily.

## Ground truth (verified 2026-09-08, do not re-derive)

Run against the real CLI and the real page, in a scratch directory:

- `skills` on npm is **`vercel-labs/skills`** ("the open agent skills ecosystem"), not
  `mattpocock/skills`. Matt Pocock's repo is a _source_ the CLI installs from.
- `npx skills@latest add mattpocock/skills --skill grill-with-docs --agent claude-code --copy -y`
  writes `./.claude/skills/grill-with-docs/` containing **`SKILL.md` plus sibling files**
  (`agents/openai.yaml` in this case), and a root `skills-lock.json`:
  ```json
  {
    "version": 1,
    "skills": {
      "grill-with-docs": {
        "source": "mattpocock/skills",
        "sourceType": "github",
        "skillPath": "skills/engineering/grill-with-docs/SKILL.md",
        "computedHash": "35e62aa4…96c8cf"
      }
    }
  }
  ```
- `--agent claude` is **rejected**; the valid identifier is `claude-code`.
- The CLI discovers skills by walking the repo for `SKILL.md` (37 found in that repo) and takes the
  skill name from the containing directory.
- `https://www.aihero.dev/skills-grill-with-docs` is a prose page, but its HTML **does** contain the
  literal string `npx skills@latest add mattpocock/skills --skill=grill-with-docs`, plus
  `https://github.com/mattpocock/skills` and `skills.sh/mattpocock/skills`. Page resolution (D4)
  works on this exact URL by scraping that command.

Taut today: `agent_skills(agent_id, name, description)`, PK `(agent_id, name)`, one file at
`<home>/skills/<name>/SKILL.md`, no origin, no sibling files, and **no MCP tool that lets an agent
touch its own skills**.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Why                                                                                                                                                                                                                                                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Resolution is server-side HTTPS, never a shell-out.** No `git clone`, no `npm`, no `npx` anywhere in this build. The GitHub REST API (`/repos`, `/git/trees`, `/contents`) supplies the tree and the blobs. An `npx skills …` string is **parsed as a source, not executed**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Deterministic and unit-testable, needs no npm or network in the agent container, and keeps the server the only writer of skill files — the invariant `ensureBuiltinSkills` already depends on.                                                                                |
| D2  | **One free-text `source` string** for every entry point (UI field, MCP tool, HTTP payload). `parseSkillSource` in `@taut/contract` is a pure total function returning `SkillSource \| ParseFailure`. Accepted forms in D3.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The owner's two examples are different shapes of the same intent. One parser, one test table, one thing to explain to an agent.                                                                                                                                               |
| D3  | **Source grammar.** `owner/repo`, `owner/repo[@ref][#skill]`, `owner/repo/<path>`, `https://github.com/o/r`, `https://github.com/o/r/tree\|blob/<ref>/<path>`, `https://raw.githubusercontent.com/…/SKILL.md`, `https://skills.sh/[b/]o/r[/skill]`, `npx\|bunx\|pnpm dlx\|yarn dlx skills[@ver] add <pkg> [--skill\|-s a,b] […]` (unknown flags ignored, package argument re-parsed), any other `https://…` → `{ kind: 'page' }`, a non-GitHub `*.md` URL → `{ kind: 'raw' }`, and a string starting with `---\n` that parses as frontmatter → `{ kind: 'inline' }` (pasted markdown). Anything else → a one-line reason. **`raw.githubusercontent.com` resolves to `github`, not `raw`** — the owner/repo/ref/path are all in the URL, and going through the repo keeps the skill's sibling files (D5) and keeps it updatable (D10). Commands are tokenised quote-aware, so `--skill="a, b"` survives. | Covers both owner examples verbatim plus paste. `inline` is what makes "just paste the skill into chat" work with no network at all.                                                                                                                                          |
| D4  | **Page resolution** for `kind: 'page'`, in order, first hit wins: (1) an `npx skills … add <pkg>` command anywhere in the HTML → re-parse as D3; (2) a fenced block that is itself a valid `SKILL.md`; (3) a `skills.sh/<owner>/<repo>` link; (4) a single `github.com/<owner>/<repo>` link, with the skill name taken from the page's URL slug after stripping a leading `skills-`. No match → `Validation` "no skill found at <url>; paste the SKILL.md or give me the repo".                                                                                                                                                                                                                                                                                                                                                                                                                         | Verified to resolve the owner's aihero.dev link at step 1. The ordered fallbacks degrade instead of failing, and the error tells a human or an agent exactly what to do next.                                                                                                 |
| D5  | **A skill is a directory, not a file.** `<home>/skills/<name>/` keeps `SKILL.md` **and its sibling files** (`references/`, `scripts/`, `agents/*.yaml`). Caps: 40 files, 1 MB total, 256 KB per file, text-like extensions only, no symlinks, every path re-checked through `AgentHomes.resolveInside`. `SKILL.md` stays the indexed body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The real CLI ships multi-file skills (verified above); a skill that loses its `references/` is broken. The caps and the path check are the whole security surface of unpacking a stranger's archive.                                                                          |
| D5b | **Canonical form prefers the path.** `formatSkillSource` writes `github:owner/repo[@ref]/<path>` when the source carries a path and `…#<skill>` when it only carries a name, so every non-`inline` source round-trips through `parseSkillSource`. `inline` has no address and formats to the bare word `inline`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | A path says exactly where a skill is; a name only says what to look for. Round-tripping is what lets the stored `source` column be re-resolved at update time.                                                                                                                |
| D6  | **`origin`** on the row: `builtin` \| `authored` \| `installed`. `builtin` is unchanged and still derived from `isBuiltinSkill(name)`. `authored` has no upstream and is never checked. `installed` carries `source`, `sourceKind`, `sourceRef`, `sourcePath`, `resolvedSha`, `contentHash`. **The rows are the lockfile** — no `skills-lock.json` on disk.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | Taut's server already owns the filesystem; a second source of truth on disk would drift the way built-in `SKILL.md` files drift today.                                                                                                                                        |
| D7  | **Agent-initiated install lands `pending`.** `skill_install` from an agent writes to `<home>/.taut/pending-skills/<name>/`, inserts the row with `state: 'pending'`, and returns text telling the agent to ask a human. A pending skill is **excluded from `skillsOf`**, so it never reaches `CLAUDE.md`/`AGENTS.md`. Approval moves the directory into `skills/<name>/` and flips `state: 'active'`. A human installing through the UI (or `agents.installSkill` as a user) lands `active` directly. Company setting `skills_agent_install_policy` (`approve` \| `auto`, default `approve`) can lift the gate.                                                                                                                                                                                                                                                                                         | A skill body is injected into the agent's system prompt. Without the gate, any page the agent reads can talk it into installing instructions that rewrite its own mandate. The pending directory under `.taut/` means the gate is a filesystem fact, not just a query filter. |
| D8  | **`skill_write` needs no approval.** An agent creating or replacing one of its own `authored` skills with a body it wrote itself is immediate. It still refuses built-in names, caps at 40 skills and 64 KB per body, emits `agent.skill.changed`, and writes the audit line.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | The body is the agent's own words, not third-party content, so D7's threat does not apply. This is the "code their own agent skills" half of the requirement, and gating it would kill the loop.                                                                              |
| D9  | **Update policy per skill**: `manual` \| `notify` \| `auto`, **default `notify`**. `SkillUpdater` ticks every 6 h and checks any `installed` skill with policy ≠ `manual` whose `checkedAt` is older than 24 h. On an upstream hash change: `auto` applies the update and posts a one-line note; `notify` stamps `upstreamHash`, emits the event, and posts an ask into the agent↔manager DM. Nothing ever silently changes a `notify` skill.                                                                                                                                                                                                                                                                                                                                                                                                                                                           | "Auto-update" exists as a real setting, but the default keeps a third-party author from rewriting an agent's behaviour overnight with nobody looking.                                                                                                                         |
| D10 | **Upstream comparison is by content hash**, not by commit. One `GET` of the skill's `SKILL.md` at the tracked ref, `sha256` of the bytes, compared to `contentHash`. Sibling files are re-fetched only when a change is being applied.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | One request per skill per day. Commit-walking a monorepo of 37 skills costs more and answers a question we do not have.                                                                                                                                                       |
| D11 | **GitHub auth**: unauthenticated by default (60 req/h/IP is ample at one check per skill per day). When the repo is private or the response is 403/429, retry with the company's GitHub App installation token from `services/githubApp.ts`. A source that still fails returns `Validation` naming the repo, never a raw GitHub error body.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | The App is already wired for repositories; reusing it means a private company skill repo works with zero new configuration.                                                                                                                                                   |
| D12 | **Agents act on themselves only.** Every `skill_*` MCP tool resolves the agent from the runtime token and ignores any agent id in the payload, mirroring the vault rule in §9. Built-in names are refused by every write path with `Forbidden`, as they are today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | One sentence an agent cannot misread, and the same sentence the vault already enforces.                                                                                                                                                                                       |
| D13 | **Two new events**: `agent.skill.changed` (payload `{ skill: AgentSkill }`) and `agent.skill.removed` (`{ agentId, name }`). No change to `agent.updated`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | The agent page stays live for install, approve, update and policy changes without refetching the whole agent.                                                                                                                                                                 |

### Non-goals (record as `// TODO(plan)`)

Company-wide skill library and agent-to-agent skill sharing; skill versions/rollback beyond the
single tracked upstream; non-GitHub forges; executing anything a skill ships in `scripts/`;
`skills.sh` search (`skills find`); importing an existing `skills-lock.json`.

## Contract — `packages/contract`

### `src/domain/enums.ts`

```ts
export const SkillOrigin = Schema.Literal('builtin', 'authored', 'installed')
export const SkillState = Schema.Literal('active', 'pending')
export const SkillUpdatePolicy = Schema.Literal('manual', 'notify', 'auto')
export const SkillSourceKind = Schema.Literal('github', 'raw', 'page', 'inline')
```

### `src/domain/skillSource.ts` (new, pure — the heart of D2/D3)

```ts
export type SkillSource =
  | { readonly kind: 'github'; readonly owner: string; readonly repo: string
      readonly ref?: string; readonly path?: string; readonly skills: ReadonlyArray<string> }
  | { readonly kind: 'raw';    readonly url: string; readonly name?: string }
  | { readonly kind: 'page';   readonly url: string; readonly slug?: string }
  | { readonly kind: 'inline'; readonly markdown: string }

export class SkillSourceParseError extends Schema.TaggedError<SkillSourceParseError>()(
  'SkillSourceParseError', { input: Schema.String, reason: Schema.String }
) {}

/** Total. Never throws, never fetches. */
export const parseSkillSource = (input: string): Either.Either<SkillSource, SkillSourceParseError>
/** The canonical string stored in `agent_skills.source`, e.g. `github:mattpocock/skills#grill-with-docs`. */
export const formatSkillSource = (s: SkillSource): string
```

`SKILL_SOURCE_HELP` (exported const) is the one-paragraph explanation of the accepted forms; the web
input, the MCP tool description and the `Validation` messages all render the same text.

### `src/domain/agent.ts`

```ts
AgentSkill: + origin: SkillOrigin
            + state: SkillState
            + source: Schema.optional(Schema.String)          // canonical, D6
            + updatePolicy: SkillUpdatePolicy
            + updateAvailable: Schema.optionalWith(Schema.Boolean, { default: () => false })
AgentSkillDetail: same additions, plus
            + resolvedSha: Schema.optional(Schema.String)
            + checkedAt:   Schema.optional(Schema.DateTimeUtc)
            /** Upstream `SKILL.md` body when `updateAvailable`; the UI diffs it against `body`. */
            + upstreamBody: Schema.optional(Schema.String)
```

`builtin: Schema.Boolean` **stays** (`origin === 'builtin'`) so no existing client breaks.

### `src/api/agents.ts`

```ts
export const InstallSkillPayload = Schema.Struct({
  source: Schema.NonEmptyString,
  /** Which skill from a multi-skill repo; required when `preview` returned more than one. */
  name: Schema.optional(Handle),
  updatePolicy: Schema.optionalWith(SkillUpdatePolicy, { default: () => 'notify' as const })
})
export const SkillCandidate = Schema.Struct({
  name: Handle,
  description: Schema.String,
  path: Schema.String
})
export const PreviewSkillPayload = Schema.Struct({ source: Schema.NonEmptyString })
export const UpdateSkillSettingsPayload = Schema.Struct({ updatePolicy: SkillUpdatePolicy })
```

Added to `AgentsGroup` (every existing endpoint untouched):

| verb                  | path                             | success                        | errors                                    |
| --------------------- | -------------------------------- | ------------------------------ | ----------------------------------------- |
| `post preview`        | `/:agentId/skills/preview`       | `Schema.Array(SkillCandidate)` | NotFound, Forbidden, Validation           |
| `post install`        | `/:agentId/skills/install`       | `AgentSkill` (201)             | NotFound, Forbidden, Validation, Conflict |
| `post approveSkill`   | `/:agentId/skills/:name/approve` | `AgentSkill`                   | NotFound, Forbidden                       |
| `post checkSkill`     | `/:agentId/skills/:name/check`   | `AgentSkillDetail`             | NotFound, Forbidden, Validation           |
| `post updateSkill`    | `/:agentId/skills/:name/update`  | `AgentSkill`                   | NotFound, Forbidden, Validation           |
| `patch skillSettings` | `/:agentId/skills/:name`         | `AgentSkill`                   | NotFound, Forbidden                       |

Reject a pending skill = the existing `deleteSkill`.

### `src/events.ts`

```ts
export const AgentSkillChanged = variant(
  'agent.skill.changed',
  Schema.Struct({ skill: AgentSkill })
)
export const AgentSkillRemoved = variant(
  'agent.skill.removed',
  Schema.Struct({ agentId: AgentId, name: Handle })
)
```

Both added to `Event`, `EventType` and the `EventTypes` literal list.

## Server — `apps/server`

### Migration `0021_agent_skills_origin.ts`

```sql
ALTER TABLE agent_skills ADD COLUMN origin        TEXT NOT NULL DEFAULT 'authored';
ALTER TABLE agent_skills ADD COLUMN state         TEXT NOT NULL DEFAULT 'active';
ALTER TABLE agent_skills ADD COLUMN source        TEXT;
ALTER TABLE agent_skills ADD COLUMN source_kind   TEXT;
ALTER TABLE agent_skills ADD COLUMN source_ref    TEXT;
ALTER TABLE agent_skills ADD COLUMN source_path   TEXT;
ALTER TABLE agent_skills ADD COLUMN resolved_sha  TEXT;
ALTER TABLE agent_skills ADD COLUMN content_hash  TEXT;
ALTER TABLE agent_skills ADD COLUMN upstream_hash TEXT;
ALTER TABLE agent_skills ADD COLUMN update_policy TEXT NOT NULL DEFAULT 'notify';
ALTER TABLE agent_skills ADD COLUMN checked_at    TEXT;
ALTER TABLE agent_skills ADD COLUMN installed_by  TEXT;   -- 'user:<id>' | 'agent'
ALTER TABLE agent_skills ADD COLUMN created_at    TEXT;
ALTER TABLE agent_skills ADD COLUMN updated_at    TEXT;
CREATE INDEX agent_skills_due ON agent_skills(update_policy, checked_at)
  WHERE origin = 'installed';
ALTER TABLE companies ADD COLUMN skills_agent_install_policy TEXT NOT NULL DEFAULT 'approve';
```

PK stays `(agent_id, name)`. Existing rows read as `authored`/`active`, which is what they are. The
table has no `company_id`; the updater joins `agents`.

### `services/skillRegistry.ts` (new `SkillRegistry` Effect.Service)

Deps: `HttpClient`, `GithubApp`. Owns **all** network access in this build.

- `preview(companyId, source: SkillSource) -> ReadonlyArray<SkillCandidate>` — for `github`, resolve
  the ref to a sha (`/repos/{o}/{r}` for `default_branch`, `/commits/{ref}` for the sha), then
  `/git/trees/{sha}?recursive=1`, keep every `**/SKILL.md` (repo-root `SKILL.md` allowed), name =
  parent directory (or repo name at root), description from the frontmatter of a cheap `contents`
  fetch for the ones being shown. `raw`/`inline` return exactly one candidate; `page` runs D4 first
  and recurses.
- `fetch(companyId, source, name) -> ResolvedSkill` where
  `ResolvedSkill = { name, description, body, files: ReadonlyArray<{ path, contents }>, sourcePath, resolvedSha, contentHash }`.
  Enforces every D5 cap and rejects `..`, absolute paths and symlink blobs (`mode 120000`) before a
  byte is written.
- `upstreamHash(companyId, skill: AgentSkillRow) -> Option<string>` — D10, one request.
- `resolvePage(url) -> SkillSource` — D4, exported for its own test.
- Retries once with the App token on 401/403/429 (D11); maps everything else to
  `Validation({ field: 'source', message })` with the upstream body stripped.

### `services/homes.ts`

- `writeSkillDir(home, name, resolved, opts: { pending: boolean })` — writes
  `renderSkillMd(name, description, body)` plus each sibling under
  `skills/<name>/` or `.taut/pending-skills/<name>/`, every path through `resolveInside`.
- `promoteSkill(home, name)` — move `.taut/pending-skills/<name>` → `skills/<name>` (remove target
  first), used by approve.
- `removeSkill` gains a `pending` variant; `readSkill` unchanged.
- `PENDING_SKILLS = join('.taut', 'pending-skills')` exported; **add it to nothing in `HOME_DIRS`**
  — it is created on demand.

### `services/agents.ts`

- `skillsOf` gains `WHERE state = 'active'` (D7). A new `skillsOfAll` backs the agent page.
- `putSkill` unchanged in behaviour; it now stamps `origin: 'authored'`, `state: 'active'`,
  `updatePolicy: 'manual'`, `updated_at`.
- New: `previewSkill`, `installSkill`, `approveSkill`, `checkSkill`, `applySkillUpdate`,
  `setSkillPolicy`. Every one: `requireManageAgent` for a human actor, or the agent-is-itself check
  for a runtime actor; `isBuiltinSkill(name)` → `Forbidden`; `publisher.transact` + emit
  `agent.skill.changed`; one audit line in `.taut/audit.log`.
- `installSkill` decides `state` from D7: runtime actor + company policy `approve` → `pending`.
- `ensureBuiltinSkills` additionally stamps `origin: 'builtin'` and never touches a pending row.

### `agents/skillUpdater.ts` (new `SkillUpdater` Effect.Service, D9)

Mirrors `agents/routineRunner.ts`: `SKILL_CHECK_INTERVAL = Duration.hours(6)`, `STALE_AFTER =
Duration.hours(24)`, `Effect.repeat` so ticks never overlap, `tick(now)` exported for tests,
`Effect.forEach` with `{ concurrency: 4 }`, every skill isolated — a failure logs, stamps
`checkedAt` and moves on. `notify` posts through `Messages.postAsAgent` into `Channels.dm(manager,
agent)`; `auto` applies the update and posts one line. Registered in `layers.ts` beside
`RoutineRunner` inside `AgentsLive`.

### `http/agents.ts` and `http/agentRuntime.ts`

Handlers for the six new endpoints. `agentRuntime` mounts `/skills`, `/skills/write`,
`/skills/install`, `/skills/update`, `/skills/remove` next to the `/vault/*` routes, each resolving
the agent from the runtime token (D12).

## MCP — `packages/taut-mcp`

`ToolNames` gains `skill_list`, `skill_write`, `skill_install`, `skill_update`, `skill_remove`.
Request/response schemas in `protocol.ts` beside the vault ones; routes in the same table.
Descriptions are written for the agent that reads them, and must say plainly:

- `skill_write` — "Write one of YOUR OWN skills: a `SKILL.md` you author from what you have learned.
  Takes effect on your next task. You cannot write another agent's skills or change a built-in."
- `skill_install` — "Install a skill someone gave you. `source` can be a link, `owner/repo`, or the
  `npx skills@latest add …` command they pasted — give it to me exactly as you received it."
  Its response carries `state`; when it is `pending` the description tells the agent to say so in
  chat and name who can approve it.
- `skill_update` — "Apply an upstream change to a skill you installed."

## Web — `apps/web`

`components/agent-skills.tsx`:

- "Add skill" becomes a two-item menu: **Write one** (the existing dialog, unchanged) and
  **Install from a source** — one input, `SKILL_SOURCE_HELP` underneath, `preview` on submit, then a
  candidate list when the repo has more than one skill, then `install`.
- Row badges: `Built-in` (lock, unchanged) · `Installed` with the source as a link · `Pending`
  (amber, **Approve** / **Reject**) · `Update available` (**Review** → a side-by-side diff of `body`
  against `upstreamBody`, **Update** / **Keep**).
- A policy select per installed skill (Manual / Notify / Auto).
- `lib/api.ts` + `lib/query-keys.ts`: hooks for each endpoint; the two new events invalidate the
  agent detail query the way `agent.updated` does.

## Tests

| where        | what                                                                                                                                                                                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `contract`   | `parseSkillSource` table over **every** D3 form, including the owner's two verbatim inputs, plus 10 malformed strings that must return `ParseFailure` and not throw. `formatSkillSource` round-trips.                                                                                                        |
| `server`     | `resolvePage` against a saved copy of the aihero.dev HTML (fixture, no live network) resolves to `github:mattpocock/skills#grill-with-docs`. Registry against recorded tree/blob fixtures. D5 caps: a 50-file skill, a 2 MB skill, a `../escape` path and a symlink blob each rejected with nothing written. |
| `server`     | Approval gate: runtime install → `pending`, absent from `skillsOf`, absent from the rendered `CLAUDE.md`; approve → present in both, files moved out of `.taut/pending-skills`.                                                                                                                              |
| `server`     | Built-in refusal on all six endpoints and all five tools. Agent-acts-on-another-agent refused.                                                                                                                                                                                                               |
| `server`     | `SkillUpdater.tick`: `manual` does nothing; `notify` posts exactly one message and leaves the body byte-identical; `auto` rewrites the body and posts one line; a skill whose fetch throws still gets `checkedAt` stamped.                                                                                   |
| `migrations` | `0021` is idempotent-safe on a seeded DB and existing rows read `authored`/`active`/`notify`.                                                                                                                                                                                                                |

## Phases

1. **Contract** — enums, `skillSource.ts`, `AgentSkill`/`AgentSkillDetail`, payloads, endpoints,
   events. Nothing else compiles until this lands.
2. **Server** — migration `0021`, `homes.ts`, `skillRegistry.ts`, `agents.ts`, `http/agents.ts`,
   `skillUpdater.ts`, `layers.ts`, runtime routes.
3. **MCP** — `protocol.ts`, `tools.ts`, `client.ts`, CLI table.
4. **Web** — install dialog, badges, diff, policy select, hooks.

Phases 3 and 4 are disjoint and run in parallel once 2 lands. Report deviations against the D table.
