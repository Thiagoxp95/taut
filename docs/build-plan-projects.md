# Build plan: projects (Linear · company connection · read-only mirror)

Engineering contract for one owner requirement (2026-09-09): **a company connects to Linear the way
it connects to GitHub, and the projects in that Linear workspace are mirrored into Taut and shown in
the sidebar. No mutations in this phase — the mirror is read-only.** Extends `docs/build-plan.md` and
`docs/build-plan-repositories.md`, whose shape this feature deliberately copies.
Effect everywhere; pinned versions from `docs/CHANGELOG.md` (effect 3.22.1, @effect/platform 0.97.1).

> Taut says **company** where Linear says "workspace" and the owner said "organization". Same thing.

## Owner requirement (verbatim intent)

> "We're gonna do a new feature that is gonna be visible on the side bar which are projects. Now
> projects are not a native entity here, we need linear connected to the organization like github
> and we will mirror projects from linear here. no mutations for now, just have them there."

Plus four answered questions, which are D2, D8, D4 and D5 below: the connection is a **personal API
key**, the sidebar is an **expandable group listing each project**, the mirror covers **projects and
their milestones**, and it refreshes **when the page is viewed plus a Refresh button**.

## What already exists (do not rebuild)

| thing                | today                                                                                                 |
| -------------------- | ----------------------------------------------------------------------------------------------------- |
| Company-owned asset  | `repositories` + `github_apps` (`apps/server/src/services/repositories.ts`). Copy this shape.         |
| Secret at rest       | `apps/server/src/vault/crypto.ts` — `encrypt`/`decryptToString`, AEAD, AAD is the company id.         |
| Admin gate           | `requireAdmin` / `actor` (`apps/server/src/services/access.ts`).                                      |
| Outbound HTTP        | `@effect/platform` `HttpClient`, as `services/githubApp.ts` and `services/usageProbe.ts` use it.      |
| Row → domain mapping | `apps/server/src/domain/rows.ts`, `Schema.parseJson` for JSON columns (`AvatarJson`, `ScheduleJson`). |
| List endpoint shape  | `Page(item)` + `PageQuery` (`packages/contract/src/api/common.ts`).                                   |
| Sidebar group        | `DepartmentGroup` in `apps/web/src/components/app-sidebar.tsx` — collapsible, icon-mode aware.        |
| Settings rail        | `WorkspaceSettingsNav` (`apps/web/src/components/settings-nav.tsx`).                                  |
| Realtime             | `EventPublisher.transact` + `EventType` union (`packages/contract/src/events.ts`).                    |

## Decisions (do not re-litigate; flag in your report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | why                                                                                                                                                                                                                                                                                                                           |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A project belongs to a company and is a mirror, never a source.** New table `projects`; the only writer is the sync. No create, no rename, no delete endpoint, and no agent grant surface in this phase.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The owner asked for the projects to "be there". A half-written mutation path is worse than none.                                                                                                                                                                                                                              |
| D2  | **The connection is one Linear personal API key**, pasted by an admin, encrypted at rest, never returned — not even redacted. The UI shows the last four characters and the workspace the key resolves to.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Linear has no manifest flow. OAuth needs an app the owner registers by hand plus a public redirect URL, which a self-hosted deployment usually lacks (D11 of repositories).                                                                                                                                                   |
| D3  | **The key is validated before it is stored.** `POST /projects/linear` calls `viewer`/`organization` first; a key Linear refuses is a `Validation`, and nothing is written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A stored key that has never worked turns every later failure into a mystery.                                                                                                                                                                                                                                                  |
| D4  | **The mirror is projects and their milestones.** Issues are out of scope in this phase.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Issue volume is orders of magnitude larger and needs its own paging and retention story.                                                                                                                                                                                                                                      |
| D5  | **Sync is on view and on demand, never scheduled.** The Projects page syncs when the mirror is older than `SYNC_STALE_MS` (5 minutes) and on the Refresh button. No webhooks, no cron.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Same reasoning as repositories D9: nothing here has to react within seconds, and a self-hosted box should not grow a background poller for a read-only list.                                                                                                                                                                  |
| D6  | **Sync is a full reconcile inside one transaction**: upsert every project Linear returned by `(company_id, linear_id)`, then delete the rows Linear no longer returns. Milestones reconcile the same way, per project.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Linear's id is the identity that survives a rename; Taut's own `prj_…` id must stay stable across syncs because the sidebar links to it.                                                                                                                                                                                      |
| D7  | **A failed sync never empties the mirror.** The last good rows stay, `last_sync_error` is set, and the page shows the error above the list it already has.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | A network blip must not make the sidebar look like the company lost its projects.                                                                                                                                                                                                                                             |
| D8  | **The sidebar shows an expandable `Projects` group listing each project**, first in the sidebar above `Channels` and `Departments`, collapsed state remembered per browser. Each row links to `/projects/$projectId`; the group footer links to `/projects`. Anyone who may connect Linear sees the group even before it is connected, with a `Connect Linear` row; a plain member of a company with no connection sees nothing.                                                                                                                                                                                                                                                                                                                                                                          | Owner's choice. It is the Departments group's shape, not the Repositories row's. Hiding it until connected made the whole feature invisible to the person who has to turn it on (owner, 2026-09-09).                                                                                                                          |
| D9  | **Reading projects is any member; connecting, disconnecting and syncing is admin+.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The vault split, once more: the company owns the connection, everyone sees the asset.                                                                                                                                                                                                                                         |
| D10 | **Milestones live in their own table**, `project_milestones`, cascading from `projects`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | A project row that carried a JSON array of milestones could not be ordered or counted in SQL.                                                                                                                                                                                                                                 |
| D11 | **Migration `0024_projects.ts`.** Another session edits this repo concurrently: if `0024` is taken when you start, take the next free number and say so in your report.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Append-only migration numbers are contended.                                                                                                                                                                                                                                                                                  |
| D12 | **`linear.app` only, one constant.** No self-hosted Linear (there is none) and no OAuth base URL.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Scope.                                                                                                                                                                                                                                                                                                                        |
| D13 | **The board is grouped by Linear's _project statuses_, and a drag writes one field back.** New nullable `status_*` columns on `projects` (migration `0026_project_status.ts`); `/projects` opens on a board and keeps a list view behind a toggle. Dropping a card calls `POST /projects/:projectId/status`, which sends `projectUpdate` to Linear and rewrites the row from Linear's answer. Admin+, like every other path that spends the company's key. Columns come from the statuses the mirrored projects are in, so a status nobody uses has no column.                                                                                                                                                                                                                                            | Linear's fixed `state` merges `Exploration` and `Planning` into one `backlog` column, which is not the board the owner sees in Linear. Writing through Linear rather than into the mirror keeps D1 true where it matters: Taut still holds no project state Linear can contradict (owner, 2026-09-09).                        |
| D14 | **The board card is Linear's card, measured off Linear's own board.** New columns on `projects` (migration `0027_project_priority.ts`): `priority`, `priority_label`, `priority_sort_order`, `health`, `issue_count`, plus `status` on `project_milestones`. A card carries the icon, the title, the health flag, the status ring, the priority bars, the lead avatar, two lines of description, the milestone it is working towards, the target date (red once it is past) and the issue count — and nothing else. Geometry is written as exact pixels: a 364px column with 12px of gutter and no chrome, a 340px card with 12px of padding down and 10px across, 13px text on a 16px line, 16px icons, 6px between cards. Cards inside a column sort by priority, then by Linear's `prioritySortOrder`. | The owner asked for the layout, the cards, the spacing and the size to match Linear, and for priority to come across. Percent-complete and the team badge went the other way: Linear shows neither on a board card, and keeping them was what made the old board read as an imitation rather than a copy (owner, 2026-09-09). |
| D15 | **The workspace's people are mirrored too, into `linear_users` (migration `0029_linear_users.ts`), and every column but one is Linear's.** The sync pages `users(includeArchived: true)` alongside the projects and reconciles the table the same way; a key that cannot read the member directory logs a warning and leaves the table exactly as it was, because the projects are the feature and this is a page an admin opens on purpose. People who have left Linear stay in the list, greyed.                                                                                                                                                                                                                                                                                                        | An assignee, a lead or a ticket author is a Linear id, and Taut had no way to say who that is here. Deactivated accounts still wrote half the tickets, so dropping them would drop the mapping that explains old work.                                                                                                        |
| D16 | **`linear_users.user_id` is Taut's own state, set by an admin and never by a sync.** `PUT /projects/linear/users/:linearUserId` takes `{ member: UserId \| null }`; `null` is the default and unmaps. The mapping is one-to-one per company, enforced by a partial unique index and refused as a `Validation` — one human cannot stand for two Linear accounts. No email-matching, no guessing at connect time.                                                                                                                                                                                                                                                                                                                                                                                           | Agents will assign real work through this table, so an ambiguous or auto-guessed mapping is worse than an empty one. The upsert names every Linear column explicitly so a rename in Linear cannot quietly unmap somebody.                                                                                                     |

## Schemas (verbatim — the whole build codes against these)

`packages/contract/src/ids.ts`, add to `IdPrefix`: `project: 'prj'`, `projectMilestone: 'pms'`, and
the matching `ProjectId` / `ProjectMilestoneId` schemas plus `newProjectId` / `newProjectMilestoneId`.

New `packages/contract/src/domain/project.ts`:

```ts
/** Where a project stands, normalised out of Linear's `Project.state`. */
export const ProjectState = Schema.Literal(
  'backlog',
  'planned',
  'started',
  'paused',
  'completed',
  'canceled',
  'unknown'
)

/** One team the project belongs to, as Linear names it. */
export const ProjectTeam = Schema.Struct({ key: Schema.String, name: Schema.String })

/** Whoever leads the project in Linear. Display only; not a Taut user. */
export const ProjectLead = Schema.Struct({
  name: Schema.String,
  email: Schema.optional(Schema.String),
  avatarUrl: Schema.optional(Schema.String)
})

export class Project extends Schema.Class<Project>('Project')({
  id: ProjectId,
  companyId: CompanyId,
  /** Linear's UUID: the identity that survives a rename (D6). */
  linearId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  state: ProjectState,
  /** 0–1, as Linear reports it. */
  progress: Schema.Number,
  /** Linear's icon name and colour, for the sidebar dot. */
  icon: Schema.optional(Schema.String),
  color: Schema.optional(Schema.String),
  /** Deep link back to Linear — the only place a mutation can happen (D1). */
  url: Schema.String,
  lead: Schema.optional(ProjectLead),
  teams: Schema.Array(ProjectTeam),
  /** `YYYY-MM-DD`, Linear's `TimelessDate`. Not a timestamp. */
  startDate: Schema.optional(Schema.String),
  targetDate: Schema.optional(Schema.String),
  updatedAt: Schema.optional(Schema.DateTimeUtc),
  syncedAt: Schema.DateTimeUtc
}) {}

export class ProjectMilestone extends Schema.Class<ProjectMilestone>('ProjectMilestone')({
  id: ProjectMilestoneId,
  projectId: ProjectId,
  linearId: Schema.String,
  name: Schema.String,
  description: Schema.optional(Schema.String),
  targetDate: Schema.optional(Schema.String),
  sortOrder: Schema.Number
}) {}

/** Where the company stands with Linear. No key, no fragment of one, ever (D2). */
export class LinearConnection extends Schema.Class<LinearConnection>('LinearConnection')({
  companyId: CompanyId,
  state: Schema.Literal('none', 'connected'),
  /** The workspace the key resolves to, e.g. `Acme`. Present only when connected. */
  workspaceName: Schema.optional(Schema.String),
  /** Linear's URL key, e.g. `acme` in `linear.app/acme`. */
  workspaceUrlKey: Schema.optional(Schema.String),
  /** Last four characters of the key — the only plaintext ever shown (`crypto.hint`). */
  keyHint: Schema.optional(Schema.String),
  connectedAt: Schema.optional(Schema.DateTimeUtc),
  lastSyncedAt: Schema.optional(Schema.DateTimeUtc),
  /** Why the last sync failed; cleared by the next one that succeeds (D7). */
  lastSyncError: Schema.optional(Schema.String)
}) {}

/** A project with the milestones under it — what `/projects/:projectId` answers. */
export class ProjectDetail extends Schema.Class<ProjectDetail>('ProjectDetail')({
  project: Project,
  milestones: Schema.Array(ProjectMilestone)
}) {}
```

`packages/contract/src/api/projects.ts`, prefix `/projects`, middleware `Authentication`:

| endpoint     | method + path     | who    | answers                                  |
| ------------ | ----------------- | ------ | ---------------------------------------- |
| `connection` | `GET /linear`     | member | `LinearConnection`                       |
| `connect`    | `POST /linear`    | admin+ | `LinearConnection` (validates first, D3) |
| `disconnect` | `DELETE /linear`  | admin+ | — (drops the key and every mirrored row) |
| `sync`       | `POST /sync`      | admin+ | `Page(Project)`                          |
| `list`       | `GET /`           | member | `Page(Project)`                          |
| `get`        | `GET /:projectId` | member | `ProjectDetail`                          |

Events, added to `EventType`: `project.synced` (payload `{ count: number, syncedAt }`) and
`project.linear.changed` (payload `{ connection: LinearConnection }`). Individual project rows are
not evented — a sync replaces the whole list and the client refetches once.

## Storage — migration `0024_projects.ts` (D11)

```sql
CREATE TABLE linear_connections (
  company_id        TEXT PRIMARY KEY REFERENCES companies(id) ON DELETE CASCADE,
  api_key_ct        BLOB NOT NULL,     -- vault ciphertext, AAD = company id (D2)
  key_hint          TEXT NOT NULL,     -- last 4 characters
  workspace_id      TEXT,
  workspace_name    TEXT,
  workspace_url_key TEXT,
  connected_by      TEXT NOT NULL,
  connected_at      TEXT NOT NULL,
  last_synced_at    TEXT,
  last_sync_error   TEXT
);

CREATE TABLE projects (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  linear_id    TEXT NOT NULL,
  name         TEXT NOT NULL,
  description  TEXT,
  state        TEXT NOT NULL,
  progress     REAL NOT NULL,
  icon         TEXT,
  color        TEXT,
  url          TEXT NOT NULL,
  lead_name    TEXT,
  lead_email   TEXT,
  lead_avatar  TEXT,
  teams        TEXT NOT NULL,          -- JSON array of { key, name }
  start_date   TEXT,
  target_date  TEXT,
  updated_at   TEXT,
  synced_at    TEXT NOT NULL,
  UNIQUE (company_id, linear_id)
);

CREATE TABLE project_milestones (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  linear_id   TEXT NOT NULL,
  name        TEXT NOT NULL,
  description TEXT,
  target_date TEXT,
  sort_order  REAL NOT NULL,
  UNIQUE (project_id, linear_id)
);

CREATE INDEX idx_projects_company ON projects(company_id);
CREATE INDEX idx_project_milestones_project ON project_milestones(project_id);
```

## Linear, and the one query that matters

`https://api.linear.app/graphql`, `Authorization: <key>` (a personal key is sent bare, not as a
Bearer token), `Content-Type: application/json`. Two documents, both in `services/linear.ts`:

**Validation** (D3) — `{ viewer { id name email } organization { id name urlKey } }`.

**Projects**, paged 50 at a time until `pageInfo.hasNextPage` is false, capped at
`MAX_PROJECT_PAGES` so a pathological workspace cannot spin forever:

```graphql
query TautProjects($after: String) {
  projects(first: 50, after: $after) {
    pageInfo {
      hasNextPage
      endCursor
    }
    nodes {
      id
      name
      description
      state
      progress
      icon
      color
      url
      startDate
      targetDate
      updatedAt
      lead {
        name
        email
        avatarUrl
      }
      teams(first: 10) {
        nodes {
          key
          name
        }
      }
      projectMilestones(first: 50) {
        nodes {
          id
          name
          description
          targetDate
          sortOrder
        }
      }
    }
  }
}
```

A GraphQL `errors` array with a 200 status is still a failure: `LinearFailure` carries an
operator-facing sentence and never the key. Every message that reaches a user or a log goes through
it, exactly as `GithubFailure` does.

## Web

- `apps/web/src/routes/_app.projects.tsx` — the list. Syncs on mount when stale (D5), Refresh
  button for admins, empty state that links to the connect page when there is no connection.
- `apps/web/src/routes/_app.projects.$projectId.tsx` — one project, its milestones, its Linear link.
- `apps/web/src/routes/_app.settings.linear.tsx` — paste the key, see the workspace, disconnect.
  Added to `WorkspaceSettingsNav`.
- `apps/web/src/components/app-sidebar.tsx` — a `ProjectsGroup` above `Company` (D8).
- `apps/web/src/lib/query-keys.ts` + `lib/api.ts` — `qk.projects`, `qk.projectList`,
  `qk.project(id)`, `qk.linearConnection`, and the hooks over them.

## Definition of done

1. `pnpm typecheck` and `pnpm lint` clean across the workspace.
2. `apps/server/test/projects.test.ts` green, against a stubbed Linear (`HttpClient` layer, the way
   `repositories.test.ts` stubs GitHub), covering: a bad key is refused and stores nothing (D3);
   a sync reconciles adds, renames and deletions while keeping `prj_…` ids stable (D6); a failed
   sync leaves the mirror intact and records the error (D7); listing is any member and connecting
   is admin+ (D9).
3. `migrations.test.ts` expects the three new tables.
4. The key is unreachable: no endpoint, event, log line or error message contains it.

---

# Issues, and the ticket an agent files (D18–D22)

Two features that share one gate. The mirror learns to hold a project's issues, and an agent learns
to put one there — but only for a human Linear already knows.

## D18 — issues are mirrored, and only the ones under a project

`project_issues` (migration `0030`) hangs off `projects` and cascades with it, keyed on Linear's
UUID like everything else here. The workflow state is stored flat — id, name, type, colour,
position — rather than in a `workflow_states` table: a state matters here only as the column an
issue sits in, nothing in Taut joins to one, and a flat copy means the tab needs one query.

The GraphQL filter is `project: { null: false }`. Taut mirrors issues as _the contents of a
project_; an issue nobody filed under one has no page here to appear on, and a workspace's issue
count dwarfs its project count. The ceiling is 200 pages — a mirror that syncs beats one that hangs.

## D19 — the Issues tab groups by workflow state

`GET /projects/:projectId/issues` answers ordered by `state_position`, then Linear's own
`sort_order`, then identifier. The client groups in a single pass whenever the state id changes and
sorts nothing: re-sorting a list the server ordered is how two screens of the same data end up
disagreeing.

The tab is a search param (`?tab=issues`), absent on Overview, so a plain project link needs no
search of its own. Activity stays a link out — Taut copies what a project _is_, not the feed of
everything that ever happened to it.

## D20 — issues are an addition to the sync, never a condition of it

The issues query rides along with the projects and the people, and its failure is a
`logWarning`, not a failed sync. A Linear that refuses it leaves the previous issues in place: the
tab keeps showing what it last knew rather than emptying itself. This is the same shrug the people
query gets (D15), for the same reason — the projects are the feature.

## D21 — an agent files a ticket only for a human Linear knows

`linear_create_issue` is the second write Taut sends Linear and the first an agent can cause. Four
conditions, each refusing with the sentence the agent should repeat to the human:

1. the company is connected to Linear;
2. the project is in this company's mirror — the agent names a `prj_…` id Taut already holds, so no
   id an agent typed reaches Linear;
3. that project has a team whose Linear id the mirror knows (a mirror synced before D21 has none;
   one sync fixes it);
4. **the human who asked is mapped to a Linear person** (D15, D16).

Condition 4 is the reason the feature exists. A ticket has to be somebody's, and Taut will not
guess: an unmapped human gets a refusal naming `Settings → Linear`, not a ticket assigned to
whoever owns the API key.

The human is `task.triggerUserId` — the person of the conversation the agent is answering — and
never a tool argument. An argument is something a model can choose, and the whole point of the
mapping is that it cannot. A run with no trigger user (a routine, a schedule) files nothing, which
is the same rule stated from the other side.

A personal API key authors every issue as the key's owner, so the mapped human cannot be the
creator in Linear. `assigneeId` is how they are on it instead: the ticket lands in their Linear
inbox, and a footer Taut appends — not the model's description — says which agent filed it and
where.

The created issue is written straight into the mirror from Linear's answer, never from what was
asked for. The next sync would find it anyway; an agent that just filed a ticket should be able to
say it is there.

## D22 — an agent learns it may not, before it tries

`linear_projects` answers the projects _and_ `canCreateIssues` with a `reason`. Both in one call on
purpose: an agent that has to ask two questions to learn it is not allowed will ask neither and try
anyway.

## Definition of done (D18–D22)

1. `pnpm typecheck` and `pnpm lint` clean across the workspace.
2. `apps/server/test/projects.test.ts` covers: issues mirror and order by workflow state (D18, D19);
   a Linear that will not answer for issues leaves the mirror standing (D20); an unmapped human is
   refused _before_ Linear is asked, and a run with no human files nothing (D21); a mapped human
   gets a ticket assigned to them, in the mirror at once (D21); a project of another company is a
   404 rather than a ticket somewhere else (D21).
3. No Linear id an agent supplied is ever forwarded: the team, the project and the assignee are all
   resolved from the mirror.
