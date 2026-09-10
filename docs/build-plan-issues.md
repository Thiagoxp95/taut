# Build plan — Issues (Linear tickets, editable, with a thread)

Status: contract frozen 2026-09-09. Implemented in four passes:
**contract → server (Linear + service + http) → web (issue page) → thread + agent context**.

Read `docs/build-plan-projects.md` first. This plan does not add a feature beside the projects
mirror — it **changes what an issue is** in Taut. Projects stay exactly what D1 of that plan made
them: a read-only copy that hands you to Linear for every change. Issues stop being that.

## What changes

> A mirrored `ProjectIssue` gains a page of its own, every property on it becomes editable, and an
> issue can carry **one Taut thread** where humans and agents talk about that ticket.

Three things follow, and nothing else in the projects mirror moves:

1. **Taut is a Linear client for issues.** Create, edit and delete are real, and they are
   write-through: the mutation goes to Linear, and the mirror row is rewritten from the issue
   Linear sends back. Precedent is projects D13, the drag that moves a project between board
   columns — this is that, generalised to every field of an issue.
2. **The Activity feed is a Taut thread.** Linear's own history (created, moved, assigned) is
   read live and rendered as events. The conversation underneath it is a real Taut thread, so it
   gets notifications, unread counts, search, attachments, reactions and — the point — `@agent`.
3. **An agent woken in an issue thread knows which ticket it is in**, and which project the ticket
   hangs under, without anyone pasting it.

Non-goals in this pass: no offline queue, no Linear webhooks (sync stays pull), no project-level
discussion thread (D7), no issue views outside a project, no cycles/estimates editing beyond what
D12's pickers cover, no Linear document or attachment mirroring.

## Decisions

| #   | Decision | Why |
| --- | -------- | --- |
| D1  | **Issues are writable; projects are not.** Projects D1 is amended for `project_issues` only. A project still has no create, rename or delete in Taut. | A ticket is where work actually happens, and a chat app that can only *show* you a ticket makes you leave it to do anything. A project is a container someone sets up once. |
| D2  | Every write is **write-through and re-read**: call the Linear mutation, take the `issue` from the same round trip, rewrite the mirror row from it, publish `project.issue.updated`. Taut never writes a field Linear has not confirmed. | Exactly projects D13. A local edit Linear later contradicts is a bug that shows up hours later on somebody else's screen. |
| D3  | The UI is **optimistic with rollback**. A chip shows the new value while the mutation is in flight and snaps back if Linear refuses, surfacing the `Validation` message. | Linear's own pickers are instant. A picker that spins for 400 ms per click does not read as the same product. |
| D4  | **Member+ may edit and create. Admin+ may delete.** Sync, connect and disconnect stay admin+ as they are. | Editing a ticket is ordinary work. Deleting one is not recoverable from Taut, so it keeps the same gate the connection does. |
| D5  | Delete calls Linear's **`issueDelete`** (trash, restorable for 30 days), not `issueArchive`. The mirror row goes; the thread survives, and its root message is edited to say the ticket was deleted. | Trash is what Linear's own delete does. Dropping the conversation with the row would destroy the only record of *why* it was deleted. |
| D6  | The mirror widens (migration 0033): `description`, `parent_linear_id`, `parent_identifier`, `parent_title`, `sub_issue_count`, `team_id`, `team_key`, `milestone_id`, `estimate`, `creator_id`/`creator_name`/`creator_avatar`, `completed_at`, `canceled_at`, `thread_message_id`. | The detail page needs every one of them, and a page that re-fetches Linear to draw itself is a page that is blank whenever Linear is slow. |
| D7  | **A project has no thread.** Only an issue does. | The owner's call: a project is a bucket, and a bucket-wide conversation is what channels already are. |
| D8  | **A thread is created lazily, never in bulk.** No ticket has a thread until the first message is posted to it. `project_issues.thread_message_id` is NULL for almost every row and that is the normal state. | A workspace with 4 000 tickets must not become a workspace with 4 000 threads. The owner asked for the capability, not for the fan-out. |
| D9  | The thread lives in a **hidden channel, one per project**, created lazily with the first thread in it. `channels.hidden` and `channels.project_id` are new; the sidebar filters `hidden = 0`, and everything else (search, mentions, notifications, unread, tasks) treats it as an ordinary company channel. | A message needs a channel — that is the whole data model. Hiding one channel is a one-column change; inventing a second, channel-less message home is not. |
| D10 | The **root message of an issue thread is the first thing said**, authored by whoever said it. There is no synthetic system author. The ticket is identified by `thread_message_id` on the issue row, not by the message's body. | `AuthorKind` is `user | agent`. Adding a third kind to give a ticket card an author would touch every message renderer in the app. |
| D11 | **Two-way comments, with an honesty rule.** A Linear comment is mirrored into the thread as a message **only when its Linear author maps to a Taut human** (projects D15/D16). An unmapped author's comment renders in the Activity list as a read-only Linear comment, never as a Taut message. A Taut reply is pushed to Linear as a comment, prefixed `@handle via Taut —`. | Mirroring a stranger's comment as a message means picking a Taut author for it, and every available choice is a lie about who said it. |
| D12 | Comments reconcile **when the issue page opens**, not during the bulk sync, and are keyed by `project_issue_comments (linear_comment_id ↔ message_id)`. | Pulling 50 comments per issue for a workspace-wide sync multiplies the payload by two orders of magnitude to serve a page nobody has opened. |
| D13 | **Linear's issue history is read live and never stored.** `GET /projects/issues/:issueId/activity` proxies Linear's `history` connection and merges it with the thread's messages into one time-ordered list. | History is derived state that only Linear can author. A stale copy of it is worse than a spinner. |
| D14 | Picker options — workflow states, labels, assignable users, milestones, sibling projects — are read **live from Linear** through `GET /projects/:projectId/options` and cached per session in TanStack Query. No new tables. | These are pick-lists, not content. A mirrored pick-list goes stale silently and files tickets into states that no longer exist. |
| D15 | The issue page is a **top-level route, `/issues/$issueId`**, and it resolves either a `pis_…` id or a Linear identifier (`ENG-4636`). | An identifier is the one thing a human quotes in chat. A link to it must work without knowing which project it is under. |
| D16 | **Sub-issues** are first class: `parent_linear_id` on the mirror, a sub-issue list on the page, and "Add sub-issue" creates one with the parent pre-set. | Linear's own detail page has them, and the owner asked for that page. |
| D17 | An agent woken in an issue thread gets a **ticket block prepended to its prompt** — identifier, title, state, priority, assignee, labels, milestone, project name, URL, and the description truncated to 1 200 chars — built in `agents/issueContext.ts`. | Otherwise the first thing every agent does is ask which ticket this is. |
| D18 | Agents get **`linear_update_issue`** beside the existing `linear_create_issue`, gated identically, plus `linear_get_issue`. | An agent that can be told "take this ticket" and cannot move it to In Progress is a worse teammate than a human intern. |
| D19 | New events: `project.issue.updated`, `project.issue.deleted`, `project.issue.thread.opened`. `project.issue.created` is reused as-is and now also fires for a human-created issue. | Two browsers open on the same ticket must agree, and the trigger catalogue (triggers D4) already listens for the created one. |
| D20 | Issue endpoints are registered **before** `/:projectId` in `ProjectsGroup` and live under the static prefix `/projects/issues/…`. | `/:projectId` is a catch-all. A route added after it never matches. |

| D21 | The hidden project channel has **`department_id = NULL`**, like a DM, and `kind = 'channel'`. Membership is **joined on demand**: posting into an issue thread adds the poster (and any agent they mention) to the channel if they are not already in it. | Channels normally belong to a department and a project does not. DMs already prove the column is nullable. Pre-seeding every company member into every project's channel would put a read cursor per person per project into the database for a conversation that may never happen. |

| D22 | `IssueDetail` carries **`threadChannelId`**, and the read is allowed to see the hidden channel even for a member who has not joined it. | Without it the first message of somebody else's thread is invisible until they reply, because `messages.thread` returns replies only and D21 defers membership. Found while building the page, not while writing this plan. |

## Contract — `packages/contract`

### `src/domain/project.ts` (extended)

`ProjectIssue` gains:

```ts
  /** The ticket body, Linear's markdown. Absent when nobody wrote one. */
  description: Schema.optional(Schema.String),
  /** The parent ticket, when this is a sub-issue (D16). */
  parent: Schema.optional(Schema.Struct({
    linearId: Schema.String,
    identifier: Schema.String,
    title: Schema.String
  })),
  /** How many sub-issues hang off it. `0` is both "none" and "Linear declined to say". */
  subIssueCount: Schema.NonNegativeInt,
  /** The team the ticket belongs to — what a create mutation needs (D14). */
  team: Schema.optional(Schema.Struct({ id: Schema.String, key: Schema.String })),
  /** Linear's milestone UUID, beside the name the row already carried. */
  milestoneId: Schema.optional(Schema.String),
  estimate: Schema.optional(Schema.Number),
  creator: Schema.optional(IssueAssignee),
  completedAt: Schema.optional(Schema.DateTimeUtc),
  canceledAt: Schema.optional(Schema.DateTimeUtc),
  /** The root message of this ticket's thread, once somebody has opened one (D8). */
  threadId: Schema.optional(MessageId),
```

New shapes in the same file:

```ts
/** One entry of Linear's own history for an issue (D13). Read live, never stored. */
export class IssueHistoryEvent extends Schema.Class<IssueHistoryEvent>('IssueHistoryEvent')({
  linearId: Schema.String,
  at: Schema.DateTimeUtc,
  /** Who did it, as Linear knows them; absent for an automation. */
  actor: Schema.optional(IssueAssignee),
  /** `created` · `state` · `assignee` · `priority` · `label` · `title` · `description`
   *  · `milestone` · `dueDate` · `parent` · `project` · `estimate` · `archived` · `other` */
  kind: IssueHistoryKind,
  /** Rendered by the server into Linear's own words: `moved from Todo to In progress`. */
  summary: Schema.String
}) {}

/** A Linear comment whose author is nobody in Taut (D11). Read-only in the Activity list. */
export class IssueLinearComment extends Schema.Class<IssueLinearComment>('IssueLinearComment')({
  linearId: Schema.String,
  body: Schema.String,
  author: Schema.optional(IssueAssignee),
  createdAt: Schema.DateTimeUtc,
  url: Schema.String
}) {}

/** Everything `/issues/:issueId` draws in one read. */
export class IssueDetail extends Schema.Class<IssueDetail>('IssueDetail')({
  issue: ProjectIssue,
  /** The project it hangs under — the page's breadcrumb and the agent's context (D17). */
  project: Project,
  subIssues: Schema.Array(ProjectIssue),
  /**
   * The hidden channel this ticket's thread lives in (D9), once there is one.
   * D22: the page cannot find it any other way. `messages.thread` answers with
   * replies only, and D21 joins members on demand — so a reader who has never
   * posted on a ticket whose thread has no replies yet can see neither the
   * channel nor the root message. This field is what closes that hole.
   */
  threadChannelId: Schema.optional(ChannelId)
}) {}

/** The Activity list: Linear history + unmapped Linear comments, time-ordered (D13). */
export class IssueActivity extends Schema.Class<IssueActivity>('IssueActivity')({
  history: Schema.Array(IssueHistoryEvent),
  comments: Schema.Array(IssueLinearComment)
}) {}

/** The pick-lists every editor on the page needs, read live from Linear (D14). */
export class IssueOptions extends Schema.Class<IssueOptions>('IssueOptions')({
  states: Schema.Array(IssueState),
  labels: Schema.Array(Schema.Struct({
    id: Schema.String, name: Schema.String, color: Schema.optional(Schema.String)
  })),
  members: Schema.Array(IssueAssignee),
  milestones: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  /** Every project the issue could be moved to, id + name only. */
  projects: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String }))
}) {}
```

### `src/api/projects.ts` (extended — added **before** the `/:projectId` endpoints, D20)

```ts
/** Every field is optional and `null` clears it; an empty payload is a `Validation`. */
export const UpdateIssuePayload = Schema.Struct({
  title: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255))),
  description: Schema.optional(Schema.NullOr(Schema.String.pipe(Schema.maxLength(50_000)))),
  stateId: Schema.optional(Schema.String),
  priority: Schema.optional(ProjectPriority),
  assigneeId: Schema.optional(Schema.NullOr(Schema.String)),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  milestoneId: Schema.optional(Schema.NullOr(Schema.String)),
  dueDate: Schema.optional(Schema.NullOr(Schema.String)),
  estimate: Schema.optional(Schema.NullOr(Schema.Number)),
  parentId: Schema.optional(Schema.NullOr(Schema.String)),
  projectLinearId: Schema.optional(Schema.String)
})

export const CreateIssuePayload = Schema.Struct({
  title: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(255)),
  description: Schema.optional(Schema.String.pipe(Schema.maxLength(50_000))),
  stateId: Schema.optional(Schema.String),
  priority: Schema.optional(ProjectPriority),
  assigneeId: Schema.optional(Schema.String),
  labelIds: Schema.optional(Schema.Array(Schema.String)),
  milestoneId: Schema.optional(Schema.String),
  dueDate: Schema.optional(Schema.String),
  /** Set to file this as a sub-issue of an existing ticket (D16). */
  parentId: Schema.optional(Schema.String)
})

/** The first message of a ticket's thread — the call that creates the thread (D8). */
export const OpenIssueThreadPayload = Schema.Struct({
  body: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(16_000))
})
```

Endpoints, in this order:

| verb | path | success | errors | gate |
| --- | --- | --- | --- | --- |
| GET | `/projects/issues/:issueId` | `IssueDetail` | `NotFound` | member |
| GET | `/projects/issues/:issueId/activity` | `IssueActivity` | `NotFound`, `Validation` | member |
| PATCH | `/projects/issues/:issueId` | `ProjectIssue` | `Forbidden`, `NotFound`, `Validation` | member |
| DEL | `/projects/issues/:issueId` | `void` | `Forbidden`, `NotFound`, `Validation` | admin |
| POST | `/projects/issues/:issueId/thread` | `ProjectIssue` | `Forbidden`, `NotFound`, `Validation` | member |
| GET | `/projects/:projectId/options` | `IssueOptions` | `NotFound`, `Validation` | member |
| POST | `/projects/:projectId/issues` | `ProjectIssue` | `Forbidden`, `NotFound`, `Validation` | member |

`issueId` accepts a `pis_…` id **or** a Linear identifier (D15); the path schema is a plain
`Schema.String` and the service resolves it.

### `src/domain/channel.ts` (extended)

```ts
  /** Hidden channels back an issue's thread (D9): real in every way but absent from the sidebar. */
  hidden: Schema.optionalWith(Schema.Boolean, { default: () => false }),
  /** The project whose tickets talk here, when this is one of those channels. */
  projectId: Schema.optional(ProjectId)
```

### `src/events.ts` (extended, D19)

```ts
export const ProjectIssueUpdated = variant('project.issue.updated',
  Schema.Struct({ projectId: ProjectId, issue: ProjectIssue }))
export const ProjectIssueDeleted = variant('project.issue.deleted',
  Schema.Struct({ projectId: ProjectId, issueId: ProjectIssueId }))
export const ProjectIssueThreadOpened = variant('project.issue.thread.opened',
  Schema.Struct({ projectId: ProjectId, issueId: ProjectIssueId, threadId: MessageId }))
```

## Server — `apps/server`

### Migration `0033_issue_detail.ts`

- `ALTER TABLE project_issues` × the D6 column list, every one nullable or defaulted so the
  migration cannot fail on an existing mirror.
- `ALTER TABLE channels ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0`
- `ALTER TABLE channels ADD COLUMN project_id TEXT REFERENCES projects(id) ON DELETE SET NULL`
- ```sql
  CREATE TABLE project_issue_comments (
    linear_comment_id TEXT PRIMARY KEY,
    issue_id          TEXT NOT NULL REFERENCES project_issues(id) ON DELETE CASCADE,
    message_id        TEXT NOT NULL,
    -- 'in' = mirrored from Linear, 'out' = pushed to Linear from a Taut message
    direction         TEXT NOT NULL,
    synced_at         TEXT NOT NULL
  )
  ```
- `CREATE UNIQUE INDEX idx_issue_comment_message ON project_issue_comments(message_id)`
- `CREATE INDEX idx_project_issues_thread ON project_issues(thread_message_id)`
- `CREATE UNIQUE INDEX idx_channels_project ON channels(project_id) WHERE project_id IS NOT NULL`

### `services/linear.ts` (extended)

`ISSUE_FIELDS` gains `description parent { id identifier title } children { nodes { id } }
team { id key } projectMilestone { id name } estimate creator { id name avatarUrl }
completedAt canceledAt`, behind the same conditional-flag retry the board fields use — one flag,
one retry, and a Linear that has none of it still mirrors what it had before.

New documents:

- `UPDATE_ISSUE_MUTATION` — `issueUpdate(id:, input:)`, returning `issue {${ISSUE_FIELDS}}`.
  The input is built field by field from `UpdateIssuePayload`; a `null` in the payload becomes an
  explicit `null` in the input, an absent field is never sent.
- `DELETE_ISSUE_MUTATION` — `issueDelete(id:) { success }` (D5).
- `ISSUE_QUERY` — one issue by id or by identifier, `${ISSUE_FIELDS}` plus `comments(first: 100)`.
- `ISSUE_HISTORY_QUERY` — `issue(id:) { history(first: 100) { nodes { … } } }` with the actor and
  the from/to pairs Linear exposes; `renderHistory` turns each node into D13's `summary`.
- `COMMENT_CREATE_MUTATION` — `commentCreate(input: { issueId:, body: })`.
- `TEAM_OPTIONS_QUERY` — one team's `states`, `labels`, `members`, plus the workspace's projects
  and the project's milestones (D14).

Every one of them goes through the existing `call` helper, so a Linear that refuses stays a
`LinearFailure` and surfaces as `Validation` with Linear's own message.

### `services/projects.ts` (extended)

New methods, each following `move`'s shape exactly — resolve, gate, call Linear, rewrite the row
from Linear's answer, publish:

- `issue(actor, ref)` → `IssueDetail`. `ref` resolves `pis_…` first, then `identifier`
  case-insensitively within the company.
- `updateIssue(actor, ref, payload)` → `ProjectIssue`. Empty payload → `Validation`.
- `createIssue(actor, projectId, payload)` → `ProjectIssue`. Reuses the projects-plan D21 path; the team comes
  from the project's first team, and a project with no team id is the existing "sync first" error.
- `deleteIssue(actor, ref)` → `void`. Admin+. Deletes the row, edits the thread's root message
  (D5), publishes `project.issue.deleted`.
- `issueActivity(actor, ref)` → `IssueActivity`. Also **reconciles comments** (D12): every Linear
  comment not in `project_issue_comments` whose author maps to a Taut human is posted into the
  thread as that human's message and recorded; the rest are returned as `IssueLinearComment`.
- `openIssueThread(actor, ref, body)` → `ProjectIssue`. Idempotent: an issue that already has a
  `thread_message_id` just gets a reply. Otherwise it ensures the project's hidden channel, posts
  the body as a root message through `Messages` (so mentions, tasks and notifications all fire as
  usual), stores `thread_message_id`, publishes `project.issue.thread.opened`.
- `issueOptions(actor, projectId)` → `IssueOptions`.

Pushing a Taut reply out to Linear (D11) hangs off the message bus, not off the HTTP handler: a
subscriber on `message.created` checks whether the message's `threadId` is some issue's
`thread_message_id` and, if so, `commentCreate`s it and records the row. A push that fails is
logged and dropped — a chat message must not fail because Linear is down.

### `agents/issueContext.ts` (new, D17)

One exported function, `issueContextBlock(detail: IssueDetail): string`, rendering:

```
Ticket ENG-4636 — Development cycle. (In progress · Medium · @thiago · Chore)
Project: Standard procedures · Milestone: none · Due: none
https://linear.app/acme/issue/ENG-4636

<description, ≤1 200 chars>
---
```

`renderPrompt` takes a new optional `issue` input and puts the block first, before `Context (…)`.
`TaskRunner` fills it by looking up `project_issues.thread_message_id = <threadId>`; the lookup is
one indexed read and returns nothing for every ordinary thread.

### `taut-mcp` (D18)

`linear_get_issue(ref)` and `linear_update_issue(ref, { … })` beside `linear_create_issue`, sharing
its `canCreateIssues` gate and its refusal message. Both go through the same service methods, so an
agent cannot do anything a human in the UI cannot.

## Web — `apps/web`

### `routes/_app.issues.$issueId.tsx` (new, D15)

Linear's issue view, at Linear's measurements — the same discipline the project overview follows.
Two columns: a 720px content column and a 240px properties rail, stacking under 900px.

- **Header**: project breadcrumb, identifier, copy-link, `Open in Linear`, overflow menu with
  Delete (admin only, confirm dialog).
- **Title**: a 26px contenteditable-style input that commits on blur or `⌘↵` and reverts on `Esc`.
- **Description**: the `Markdown` renderer until clicked, a textarea after, same commit rules.
- **Sub-issues**: the D16 list plus `+ Add sub-issue`, which opens the create dialog with the
  parent pre-filled.
- **Properties rail**: status, priority, assignee, labels, project, milestone, due date, estimate.
  Every one is a `Popover` + `Command` picker fed by `useIssueOptions`, optimistic per D3.
- **Activity**: the merged list — Linear history events as one-line rows with the actor's avatar
  and a rail, unmapped Linear comments as read-only cards, and the thread's messages rendered by
  the **existing message list components**, not by a second copy of them.
- **Composer**: the existing composer, posting through `useOpenIssueThread` the first time and
  through the ordinary `sendMessage` after that. `@agent` works because it is a real thread.

### `components/issue-*.tsx`

`issue-state-icon.tsx` is lifted verbatim out of `project-issues.tsx` (it is already the right
glyph set), `issue-property-rail.tsx`, `issue-activity.tsx`, `issue-create-dialog.tsx`.

### `components/project-issues.tsx` (changed)

A row is now a `<Link to="/issues/$issueId">`, not an `<a href={issue.url}>`. The `+` on a group
header opens the create dialog with that state pre-selected instead of sending the reader to
Linear. The `Open in Linear` affordance moves to the issue page's header, where it belongs.

### `lib/api.ts` (extended)

`useIssue`, `useIssueActivity`, `useIssueOptions`, `useUpdateIssue`, `useCreateIssue`,
`useDeleteIssue`, `useOpenIssueThread` — each invalidating `qk.projectIssues(projectId)` and
`qk.issue(issueId)`, and `useUpdateIssue` doing D3's optimistic `setQueryData` with a rollback in
`onError`.

### Sidebar

`channels.hidden` is filtered out of the channel list (D9). Nothing else changes: an unread
message in an issue thread still badges, still notifies, still shows in search — it just has no
row of its own to click, because its home is the ticket.

## Test plan

- `test/issues.test.ts` — every write path against a stubbed Linear: update rewrites from Linear's
  answer, a refused mutation leaves the row untouched, delete is admin-gated, create files under
  the project's team, an empty patch is a `Validation`, an identifier resolves, a foreign-company
  identifier does not.
- `test/issue-thread.test.ts` — first message creates the channel and the root message exactly
  once, a second call replies instead, a mapped Linear comment mirrors in once and not twice, an
  unmapped one never becomes a message, a Taut reply pushes out as a comment, a failed push does
  not fail the message.
- `test/projects.test.ts` — unchanged and still passing, which is the check that projects stayed
  read-only.
