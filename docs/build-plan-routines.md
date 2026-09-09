# Build plan — Routines (scheduled agent prompts)

Status: contract frozen 2026-09-08. Implemented in three passes: **contract → server → web**.
Read `docs/agent-model.md` §7 (tasks) and §9 (dispatch) first; a routine is _only_ a scheduled
way to produce the message the existing `Scheduler` already reacts to. Nothing here is a second
execution path.

## What a routine is

> A named prompt, owned by one agent, that runs on a schedule.

When a routine fires the server posts a message **authored by the routine's owner (a human)**
into a target channel, body `@handle <prompt>`. `message.created` carries the mention, the
existing `Scheduler` creates the `Task`, `TaskRunner` runs it, and the reply streams into the
thread exactly like a hand-typed mention. Free from reuse: threads, notifications, unread
counts, turn caps, handoff depth, cancel, `Tasks.byTrigger` idempotency, presence.

Non-goals: no separate routine execution engine, no routine-only output surface, no retries,
no backfill of missed runs.

## Decisions

| #   | Decision                                                                                                                                                                                 | Why                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| D1  | A routine fires by **posting a message as its owner user**, not by calling `Tasks.create` directly. `Messages.postAsUser` (new, server-internal, mirrors `postAsAgent`) does the insert. | One dispatch path. Every §9 gate keeps applying; the run is visible in the channel as a normal turn.                   |
| D2  | Schedule is a **structured schema** (`Schedule` union), not a cron string. A `cron` variant is the escape hatch.                                                                         | The UI is the point: chips and pickers, a human sentence, and a "next runs" preview. Cron cannot express `everyNDays`. |
| D3  | `nextRuns(schedule, timezone, after, count)` lives in **`@taut/contract`** (`src/domain/schedule.ts`), pure, `effect/DateTime` + `effect/Cron`. Server and web import the same function. | The preview the human approves and the time the server fires must be the same computation.                             |
| D4  | Times are wall-clock in the routine's **IANA timezone**, stored on the row. Defaults to the creator's browser zone. DST is whatever `DateTime.zoneMakeNamed` says.                       | A 9:00 standup is 9:00 local in March and in November.                                                                 |
| D5  | **Missed runs are skipped, never replayed.** `nextRunAt` is always recomputed from `now`, so a server that was down for a day fires once when it comes back, not 24 times.               | A backlog of stale prompts is worse than a gap.                                                                        |
| D6  | **No overlap.** If the routine's previous task is still `queued`/`running`, the tick skips this occurrence and records `lastStatus: 'skipped'`.                                          | A slow hourly routine must not stack tasks on the agent's serial gate.                                                 |
| D7  | Default target is the **DM between the owner and the agent** (`Channels.dm`), created on first fire. Any channel the agent is a member of may be chosen instead.                         | A private routine does not spam a team channel; a standup routine can.                                                 |
| D8  | Permission = **the same guard as managing the agent** (`access.requireManageAgent`): owner, admin, or the head of one of the agent's departments.                                        | Routines are agent configuration.                                                                                      |
| D9  | `tasks.routine_id` records the routine a task came from; `Task.routineId` is optional in the contract.                                                                                   | "Last run" links to a real task; older `agent.task.*` events still decode.                                             |
| D10 | Routine rows carry `lastRunAt`, `lastTaskId`, `lastStatus`, `nextRunAt` — no separate run-history table.                                                                                 | Task history already exists and is filterable.                                                                         |
| D11 | A paused agent (`status: 'paused'`) does not fire its routines; the tick advances `nextRunAt` and records `skipped`.                                                                     | Matches `Scheduler.dispatchTo`, which already ignores mentions of a paused agent.                                      |
| D12 | Every mutation emits a `routine.*` event on the bus.                                                                                                                                     | The settings tab and any open client stay live like every other surface.                                               |

## Contract — `packages/contract`

### `src/ids.ts`

Add `routine: 'rtn'` to `IdPrefix`, `RoutineId`, `newRoutineId()`.

### `src/domain/schedule.ts` (new)

```ts
/** "09:00" — wall clock in the routine's timezone, 24 h. */
export const TimeOfDay = Schema.String.pipe(
  Schema.pattern(/^([01]\d|2[0-3]):[0-5]\d$/),
  Schema.brand('TimeOfDay')
)

/** 0 = Sunday … 6 = Saturday (matches `Date.getDay`). */
export const Weekday = Schema.Int.pipe(Schema.between(0, 6))

/** 1–31, or 'last' for the last day of the month. */
export const MonthDay = Schema.Union(Schema.Int.pipe(Schema.between(1, 31)), Schema.Literal('last'))

export const IntervalSchedule = Schema.TaggedStruct('interval', {
  /** 5 … 1440. Anchored on `Routine.createdAt` so "every 90 min" is stable across restarts. */
  everyMinutes: Schema.Int.pipe(Schema.between(5, 1440))
})

export const DailySchedule = Schema.TaggedStruct('daily', {
  /** 1 = every day, 2 = every other day … 30. Counted from `anchorDate`. */
  everyNDays: Schema.Int.pipe(Schema.between(1, 30)),
  /** Calendar day (YYYY-MM-DD, routine timezone) the count starts from. */
  anchorDate: Schema.String.pipe(Schema.pattern(/^\d{4}-\d{2}-\d{2}$/)),
  times: Schema.NonEmptyArray(TimeOfDay)
})

export const WeeklySchedule = Schema.TaggedStruct('weekly', {
  weekdays: Schema.NonEmptyArray(Weekday),
  times: Schema.NonEmptyArray(TimeOfDay)
})

export const MonthlySchedule = Schema.TaggedStruct('monthly', {
  days: Schema.NonEmptyArray(MonthDay),
  times: Schema.NonEmptyArray(TimeOfDay)
})

/** Five-field cron, parsed with `effect/Cron`. Validated on decode. */
export const CronSchedule = Schema.TaggedStruct('cron', { expression: Schema.NonEmptyString })

export const Schedule = Schema.Union(
  IntervalSchedule,
  DailySchedule,
  WeeklySchedule,
  MonthlySchedule,
  CronSchedule
)
```

Also in this file, pure and total:

- `nextRuns(schedule, timezone, after: DateTime.Utc, count: number): ReadonlyArray<DateTime.Utc>`
  — strictly after `after`; `[]` if the schedule can never fire again (e.g. `monthly` day 31 is
  _not_ such a case: skip months without that day). Walk forward at most 400 days.
- `describeSchedule(schedule, timezone): string` — the human sentence
  ("Every weekday at 9:00 AM", "Every 2 days at 8:00 AM and 6:00 PM", "On the 1st and 15th at 9:00 AM",
  "Every 30 minutes", "Cron `0 9 * * 1-5`"). Used identically in list rows and the editor preview.
- `validateSchedule(schedule): ReadonlyArray<Issue>` — cron parses, times sorted+deduped, arrays non-empty.

`nextRuns` is the only place that does calendar math. Implementation shape: `interval` steps from
the anchor; every other kind enumerates candidate days forward in `timezone` and, for each matching
day, yields its `times` in order. Use `DateTime.zoneMakeNamed` + `DateTime.setZone` +
`DateTime.toPartsUtc`; never construct dates from string concatenation.

### `src/domain/routine.ts` (new)

```ts
export class Routine extends Schema.Class<Routine>('Routine')({
  id: RoutineId,
  companyId: CompanyId,
  agentId: AgentId,
  /** Who it posts as, and who owns it. */
  ownerUserId: UserId,
  /** Short label, shown in the list. */
  name: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(80)),
  /** The prompt sent to the agent, without the `@handle` prefix. Max 4000 chars. */
  prompt: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)),
  /** Where the run lands. Absent = the owner↔agent DM, opened on first fire. */
  channelId: Schema.optional(ChannelId),
  schedule: Schedule,
  /** IANA zone, e.g. "America/Toronto". */
  timezone: Schema.String,
  enabled: Schema.Boolean,
  /** Computed server-side on every write and every fire. Absent = never fires again. */
  nextRunAt: Schema.optional(Schema.DateTimeUtc),
  lastRunAt: Schema.optional(Schema.DateTimeUtc),
  lastTaskId: Schema.optional(TaskId),
  lastStatus: Schema.optional(RoutineRunStatus),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}
```

`RoutineRunStatus = Schema.Literal('fired', 'skipped', 'failed')` goes in `domain/enums.ts`.

### `src/domain/task.ts`

Add `routineId: Schema.optional(RoutineId)`.

### `src/api/routines.ts` (new) — `RoutinesGroup`, prefix `/routines`, `Authentication`

| verb   | path              | payload → success                                                       | errors                                                      |
| ------ | ----------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------- |
| GET    | `/`               | `ListRoutinesQuery { ...PageQuery, agentId? }` → `Page(Routine)`        | `Forbidden`                                                 |
| POST   | `/`               | `CreateRoutinePayload` → `Routine` (201)                                | `Forbidden` `NotFound` `Validation`                         |
| PATCH  | `/:routineId`     | `UpdateRoutinePayload` (partial, `null` clears `channelId`) → `Routine` | `Forbidden` `NotFound` `Validation`                         |
| DELETE | `/:routineId`     | → void                                                                  | `Forbidden` `NotFound`                                      |
| POST   | `/:routineId/run` | → `Task` — fire now, ignoring the schedule                              | `Forbidden` `NotFound` `Conflict` (previous run still live) |

`CreateRoutinePayload = { agentId, name, prompt, channelId?, schedule, timezone, enabled = true }`.
List is readable by any member who may view the agent; writes take `requireManageAgent`.

Register the group in `src/api/index.ts` (after `TasksGroup`) and re-export the module.

### `src/events.ts`

`RoutineCreated | RoutineUpdated | RoutineDeleted` (`routine.created` / `routine.updated` /
`routine.deleted`; deleted carries `{ routineId, agentId }`). Add the three literals to `EventType`
and the variants to the `Event` union.

### Tests — `packages/contract/test/schedule.test.ts`

`@effect/vitest`. Must cover: every kind's next 5 runs; multiple times per day sorted;
`everyNDays` alternating across a month boundary; `monthly` day 31 skipping February;
`'last'` in a leap February; a DST spring-forward day (`America/Toronto`, 2026-03-08 — a 2:30 AM
daily time still fires once) and a fall-back day; cron parity with `Cron.next`; `describeSchedule`
strings; `validateSchedule` rejecting a bad cron.

## Server — `apps/server`

- **Migration `0011_routines.ts`**: `routines` table (columns mirror `Routine`; `schedule` stored as
  a JSON `TEXT` column encoded with `Schema.parseJson(Schedule)`), plus
  `ALTER TABLE tasks ADD COLUMN routine_id TEXT`. Indexes:
  `routines_due(enabled, next_run_at)`, `routines_agent(company_id, agent_id, created_at)`.
- **`services/routines.ts`** — `Routines` Effect.Service: `list` / `create` / `update` / `remove` /
  `runNow` / `due(now)` / `markFired` / `markSkipped`. Every write recomputes `nextRunAt` via
  `nextRuns(...)[0]` and emits the `routine.*` event through `publisher.transact`.
- **`services/messages.ts`** — add server-internal `postAsUser(companyId, { userId, channelId, threadId?, body })`,
  a copy of `postAsAgent` with `author: { kind: 'user', id: userId }` and no membership requirement
  for the owner's own DM.
- **`agents/routineRunner.ts`** — scoped daemon. `Effect.repeat(Schedule.fixed('30 seconds'))` over
  `Routines.due(now)`; per routine: D11 paused check → D6 overlap check → resolve channel (D7) →
  `Messages.postAsUser` → the existing `Scheduler` picks the mention up → stamp
  `lastRunAt`/`lastTaskId`/`lastStatus` and the new `nextRunAt`. Every routine is isolated with
  `Effect.catchAllCause` + a log line; one bad routine never stops the tick.
  `tasks.routine_id` is set by passing the routine id through `Scheduler.dispatch`'s input.
- **`http/`** — implement `RoutinesGroup`; wire the group in the HttpApi builder next to `tasks`.
- **`layers.ts`** — `Routines.Default` into the services tier; `RoutineRunner.Default` merged into
  `AgentsLive` (it needs `Scheduler`, `Messages`, `Channels`, `Agents`).
- **Tests** — `test/routines.test.ts`: create → tick at a stubbed clock → a task exists and the
  message body starts with `@handle`; overlap skip; paused-agent skip; missed-run collapse (D5);
  `runNow` returns a task; a non-head member gets `Forbidden`.

## Web — `apps/web`

New tab **Routines**, between `Skills` and `Files` in `routes/_app.agents.$agentId.tsx`.

- `components/agent-routines.tsx` — the tab: list + empty state + "New routine".
  Each row: name, `describeSchedule(...)` sentence, "Next run in 3 h" (`formatRelative`),
  last-run badge linking to the task thread, `Switch` for `enabled`, and a `DropdownMenu`
  (Run now · Edit · Delete → `ConfirmDialog`). Read-only viewers get `ReadOnlyNote`.
- `components/schedule-picker.tsx` — **the centrepiece**, reusable and controlled
  (`value: Schedule`, `onChange`). Layout, top to bottom:
  1. A segmented row of five modes — _Interval · Daily · Weekly · Monthly · Advanced_
     (`Tabs` styled as a segmented control, matching the existing tab pill look).
  2. The mode body:
     - **Interval** — "Every `[N]` `[minutes|hours]`" (`Input type=number` + `Select`).
     - **Daily** — "Every `[N]` day(s)", with `1` reading as "Every day".
     - **Weekly** — seven round toggle chips `S M T W T F S`, plus preset buttons
       _Every day · Weekdays · Weekends_. The preset highlights when the selection matches it.
     - **Monthly** — a 31-cell grid of square day chips plus a `Last day` chip, with quick
       actions _All · Odd · Even · Clear_ (this is the "odd days" affordance).
     - **Advanced** — a cron `Input` with inline validation and the parsed sentence beneath it.
  3. **Times** (every mode but Interval and Advanced) — a row of time chips, each a
     `<input type="time">` with an `X` to remove, and a `+ Add time` button. Sorted, deduped.
  4. **Timezone** — `Select` of `Intl.supportedValuesOf('timeZone')`, defaulting to
     `Intl.DateTimeFormat().resolvedOptions().timeZone`.
  5. **Preview** — the sentence from `describeSchedule` in `text-sm font-medium`, and under it
     "Next: Mon Sep 8, 9:00 AM · Tue Sep 9, 9:00 AM · Wed Sep 10, 9:00 AM" from `nextRuns(..., 3)`,
     recomputed on every change. If `nextRuns` returns `[]`, an inline warning instead.
- `components/routine-dialog.tsx` — create/edit `Dialog`: Name, Prompt (`Textarea`, the
  `@handle` prefix shown as static helper text so nobody types it twice), Deliver to
  (`Select`: "Direct message" + every channel the agent is a member of), then `<SchedulePicker>`.
  Save is disabled while `validateSchedule` has issues.
- `lib/api.ts` — `useRoutines(agentId)`, `useCreateRoutine`, `useUpdateRoutine`, `useDeleteRoutine`,
  `useRunRoutine`, following the existing hook shape exactly.
- `lib/live.ts` — apply `routine.created|updated|deleted` to the query cache like `agent.*`.
- `lib/ids.ts` — `parseRoutineId`.

### UI rules (non-negotiable)

Reuse `@taut/ui` primitives and the existing spacing/typography; add no new dependency, no new
colour, no icon set beyond `lucide-react`. Chips are `rounded-full` for weekdays,
`rounded-md` for month days, `size-9`, `bg-muted` unselected / `bg-primary text-primary-foreground`
selected, `focus-visible:ring-[3px] focus-visible:ring-ring/50` like every other control here.
Keyboard: every chip is a real `<button>`; the grid is arrow-key navigable; the whole dialog is
usable without a mouse. No layout shift when switching modes — the picker keeps a fixed min-height.
