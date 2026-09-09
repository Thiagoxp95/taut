# Build plan — Triggers (event-fired routines)

Status: contract frozen 2026-09-09. Implemented in three passes: **contract → server → web**.
Read `docs/build-plan-routines.md` first — this plan does not add a feature next to routines, it
**generalises the routine's fire condition**. A routine used to fire when a clock said so; now it
fires when a `Trigger` says so, and a clock is one of two kinds of trigger.

## What changes

> `Routine.schedule` + `Routine.timezone` become `Routine.trigger`, a union of
> `{ _tag: 'schedule' }` and `{ _tag: 'event' }`.

Everything downstream is untouched. An event trigger fires the *same* `fire()` that the 30-second
tick fires: post `@handle <prompt>` as the owner into the target channel, let the existing
`Scheduler` turn the mention into a `Task`, let `TaskRunner` run it. Threads, notifications,
unread counts, turn caps, handoff depth, cancel, `Tasks.byTrigger` idempotency, presence, the
`routines_agent` list, the Routines tab, "Run now" — all reused as-is.

The motivating case: an agent whose mandate is "when a huddle ends, tell me what happened" sits
dormant until `call.ended` lands on the bus, then runs one turn in the owner↔agent DM.

Non-goals: no second execution path, no retries, no replay of events missed while the server was
down, no generic user-written predicate language, no agent-authored triggers in this pass (D15).

## Decisions

| #   | Decision | Why |
| --- | -------- | --- |
| D1  | `Routine.trigger: Trigger` replaces `schedule` + `timezone`. `Trigger = ScheduleTrigger \| EventTrigger`. One row type, one table, one service, one fire path. | A routine is "a named prompt that fires on a condition". The condition was always the variable part; only the clock was hard-coded. Two tables would duplicate the whole D6–D12 gate set. |
| D2  | An event trigger fires by **posting a message as its owner user**, exactly as D1 of the routines plan. `RoutineRunner.fire` gains a `mode` argument (`due` \| `force` \| `event`) and is exported. | The channel shows a normal turn, not a ghost run. Every §9 dispatch gate keeps applying with no new code. |
| D3  | The event catalogue is a **closed union whose `_tag` is the event name itself** (`EventTrigger`), not "any `EventType` plus a free-form filter". Each variant carries only the filters that make sense for it. | `matchesEvent` becomes a switch on the same literal the bus carries — no stringly-typed dispatch, no way to build a filter that cannot match. Adding an event later is one variant plus one case. |
| D4  | v1 exposes **five** events: `call.ended`, `call.started`, `message.created`, `agent.task.failed`, `project.issue.created`. | Each is something a human would actually ask an agent to watch. Every other `EventType` is either configuration churn (`channel.updated`) or already delivered as a notification. |
| D5  | The fired message body is `@handle <prompt>` followed by a **server-rendered context block** describing the event in prose. Rendering lives in `agents/triggerContext.ts`, one function per event kind. | `call.ended` carries only `{callId, channelId, endedAt}`. Without context the agent is woken with no idea what ended, and would have to guess which tool to call. |
| D6  | **No self-trigger.** An event whose actor is the routine's own agent never fires that routine. | An agent with a `message.created` trigger would otherwise fire on its own reply, forever. This is a structural cut, not a heuristic. |
| D7  | **Rate cap**: at most `TAUT_TRIGGER_MAX_FIRES_PER_HOUR` (default 20) fires per routine per rolling hour. Over the cap the occurrence is dropped with `lastStatus: 'skipped'` and one log line per hour, not per drop. | The bus is not rate-limited. A misconfigured trigger must degrade into silence, not into a bill. |
| D8  | **No overlap**, inherited verbatim from routines D6: previous task still `queued`/`running` → skip. | Three huddles ending in a minute collapse into one run plus two skips, on the agent's serial gate. |
| D9  | `next_run_at` is **NULL** for event triggers, so `routines_due` never returns them and the tick never sees them. Event routines are found through a new denormalised `trigger_event` column. | SQLite cannot index inside `trigger_json`. The hot path is "an event just landed, which routines want it" and must be one indexed lookup. |
| D10 | Events are **at-most-once and in-process**: the runner subscribes to `Bus.streamAll()`. Nothing that happened while the server was down is replayed. | Same reasoning as routines D5 — a burst of stale prompts on boot is worse than a gap. |
| D11 | Delivery is **immediate, with no debounce**. LiveKit re-join churn is absorbed by D8, not by a settle timer. | A timer would need its own persistence to survive a restart, for a case D8 already covers. |
| D12 | **"Run now" works on an event trigger**, firing with a synthetic context block that says the run was manual. | Testing a notifier must not require starting a real huddle. |
| D13 | Permission is unchanged: `access.requireManageAgent` for every write, agent-visibility for the list. | Triggers are agent configuration, like the rest of the row. |
| D14 | One list and one dialog. The dialog gets a two-way mode switch **Schedule · Trigger**; rows render `describeTrigger(...)` either way. | A routine and a trigger differ in one field. Splitting the UI would duplicate name, prompt, target channel and the enable switch. |
| D15 | An agent registering **its own** trigger from its mandate is deferred. The row stays the only machine-readable form; a `taut.trigger.create` MCP tool can be added later with no schema change. | The subscription must be a row regardless — the server cannot re-read prose on every bus event. Shipping the row first makes the tool a thin wrapper instead of a redesign. |

## Contract — `packages/contract`

### `src/domain/trigger.ts` (new)

```ts
import { Schema } from 'effect'
import { AgentId, ChannelId, ProjectId } from '../ids.js'
import { MemberKind } from './enums.js'
import { Schedule, Timezone } from './schedule.js'

/** The five bus events a routine may listen for (D4). Each `_tag` is the `EventType` itself (D3). */
export const CallEndedTrigger = Schema.TaggedStruct('call.ended', {
  /** Empty = any channel the agent can see. */
  channelIds: Schema.optionalWith(Schema.Array(ChannelId), { default: () => [] }),
  /** Ignore huddles shorter than this — a misclick is not a meeting. 0 = fire on all. */
  minSeconds: Schema.optionalWith(Schema.Int.pipe(Schema.between(0, 3600)), { default: () => 60 })
})

export const CallStartedTrigger = Schema.TaggedStruct('call.started', {
  channelIds: Schema.optionalWith(Schema.Array(ChannelId), { default: () => [] })
})

/**
 * Loud by nature, so the filter is mandatory: at least one channel, and by default only
 * humans. Combined with D6 (never the routine's own agent) this cannot self-feed.
 */
export const MessageCreatedTrigger = Schema.TaggedStruct('message.created', {
  channelIds: Schema.NonEmptyArray(ChannelId),
  authorKinds: Schema.optionalWith(Schema.NonEmptyArray(MemberKind), { default: () => ['user'] }),
  /** Case-insensitive substring the body must contain. Absent = every message. */
  containing: Schema.optional(Schema.String.pipe(Schema.maxLength(200))),
  /** Replies in a thread, or only top-level posts. */
  includeThreadReplies: Schema.optionalWith(Schema.Boolean, { default: () => false })
})

export const TaskFailedTrigger = Schema.TaggedStruct('agent.task.failed', {
  /** Empty = any agent in the company. Watching yourself is allowed here: D6 only blocks
   *  the *actor*, and a failed task has no actor. */
  agentIds: Schema.optionalWith(Schema.Array(AgentId), { default: () => [] })
})

export const IssueCreatedTrigger = Schema.TaggedStruct('project.issue.created', {
  projectIds: Schema.optionalWith(Schema.Array(ProjectId), { default: () => [] })
})

export const EventTrigger = Schema.Union(
  CallEndedTrigger,
  CallStartedTrigger,
  MessageCreatedTrigger,
  TaskFailedTrigger,
  IssueCreatedTrigger
)
export type EventTrigger = typeof EventTrigger.Type

/** The `EventType` an `EventTrigger` listens for — its own tag. */
export type TriggerEventType = EventTrigger['_tag']
export const TriggerEventType = Schema.Literal(
  'call.ended', 'call.started', 'message.created', 'agent.task.failed', 'project.issue.created'
) satisfies Schema.Schema<TriggerEventType>

export const ScheduleTrigger = Schema.TaggedStruct('schedule', {
  schedule: Schedule,
  timezone: Timezone
})

export const Trigger = Schema.Union(ScheduleTrigger, Schema.TaggedStruct('event', {
  event: EventTrigger
}))
export type Trigger = typeof Trigger.Type
```

Also in this file, pure and total:

- `matchesEvent(trigger: EventTrigger, event: Event): boolean` — a switch on `trigger._tag`;
  returns `false` immediately when `event.type !== trigger._tag`. Contains **no** D6/D7 logic:
  those are runner concerns that need the routine, not the trigger.
- `describeTrigger(trigger, names?): string` — the human sentence, used identically in list rows
  and the dialog preview. `names` is an optional `(id) => string | undefined` so the web can print
  `#design` where the server prints the id.
  Examples: `"When a huddle ends in #design (over 1 min)"`, `"When anyone posts in #support"`,
  `"When any agent's run fails"`, `"Every weekday at 9:00 AM"` (delegates to `describeSchedule`).
- `validateTrigger(trigger): ReadonlyArray<Issue>` — delegates to `validateSchedule` for the
  schedule arm; for the event arm checks non-empty required arrays and a `containing` that is not
  pure whitespace.

`describeSchedule` / `nextRuns` / `validateSchedule` in `domain/schedule.ts` are untouched.

### `src/domain/routine.ts`

Replace `schedule` and `timezone` with `trigger: Trigger`. `nextRunAt` keeps its doc comment plus:
*absent for an event trigger, which has no next run.* Nothing else on the class moves.

### `src/api/routines.ts`

`CreateRoutinePayload` and `UpdateRoutinePayload` swap `schedule` + `timezone` for `trigger`.
`ListRoutinesQuery` gains `kind?: 'schedule' | 'event'`. The five endpoints and their errors
are otherwise unchanged, including `POST /:routineId/run` (D12).

### `src/events.ts`

No new event types. `routine.created|updated|deleted` already carry the whole `Routine`, so a
trigger change reaches every open client for free.

### Tests — `packages/contract/test/trigger.test.ts`

`@effect/vitest`. Must cover: `matchesEvent` true/false for each of the five variants;
`call.ended` below `minSeconds`; `message.created` with a non-matching `authorKinds`; a
`containing` match that differs only in case; a thread reply with `includeThreadReplies: false`;
an empty `channelIds` matching every channel; `describeTrigger` strings with and without `names`;
`validateTrigger` rejecting a whitespace-only `containing`; and a `schedule` arm still round-
tripping through `describeSchedule`.

## Server — `apps/server`

### Migration `0031_routine_triggers.ts`

```
ALTER TABLE routines ADD COLUMN trigger_json  TEXT
ALTER TABLE routines ADD COLUMN trigger_kind  TEXT NOT NULL DEFAULT 'schedule'
ALTER TABLE routines ADD COLUMN trigger_event TEXT            -- NULL for a schedule (D9)
-- backfill: every existing row becomes {"_tag":"schedule","schedule":<schedule_json>,"timezone":<timezone>}
ALTER TABLE routines DROP COLUMN schedule_json
ALTER TABLE routines DROP COLUMN timezone
CREATE INDEX routines_event ON routines(trigger_event, enabled)
```

Backfill in SQL with `json_object('_tag','schedule','schedule',json(schedule_json),'timezone',timezone)`
so no row is decoded in JS. `trigger_json` is written by the backfill and then read as
`Schema.parseJson(Trigger)`, exactly as `schedule_json` was. `DROP COLUMN` needs SQLite ≥ 3.35;
`@effect/sql-sqlite-node` ships well past that — if it ever fails, fall back to
create-copy-drop-rename in the same migration.

### `services/routines.ts`

- Read/write `trigger` instead of `schedule`/`timezone`; persist the two denormalised columns
  alongside `trigger_json` on every write.
- `nextRunAt` recomputation is now conditional: `trigger._tag === 'schedule'` → `nextRuns(...)[0]`;
  `'event'` → `undefined` (D9).
- New `byEvent(companyId, type: TriggerEventType): Effect<ReadonlyArray<Routine>>` — one indexed
  query, `enabled = 1`.
- New `recordFire` / `fireCountSince(routineId, since)` for the D7 cap, or keep the counter in
  memory in the runner. **Keep it in memory**: the cap is a safety valve, not accounting, and a
  restart clearing it is correct.
- `due(now)` is unchanged and now naturally excludes event routines.

### `agents/routineRunner.ts`

Two edits, no restructuring:

1. `fireLocked` takes `mode: FireMode` instead of `force: boolean`:
   ```ts
   type FireMode =
     | { readonly _tag: 'due' }
     | { readonly _tag: 'force' }
     | { readonly _tag: 'event'; readonly context: string }
   ```
   The staleness check becomes: `due` → today's `nextRunAt` test; `force` → always proceed;
   `event` → proceed if `routine.enabled`. The posted body becomes
   `` `@${handle} ${routine.prompt}${context}` `` where `context` is `''` for the clock arms.
2. `fire` is added to the service's returned object so `TriggerRunner` can call it. The semaphore
   stays inside `RoutineRunner`, so the clock and the bus can never fire one routine twice at once.

### `agents/triggerContext.ts` (new)

`render(event: Event): Effect<string, never, Calls | Channels | Agents | Messages>` — a switch on
`event.type` returning a blank line followed by an indented context paragraph. `call.ended` loads
the `Call`, resolves the channel name and the participants, and renders:

```
Context — the huddle in #design just ended.
Started 3:18 PM, ended 3:42 PM (24 minutes). Present: @tedy, @nova.
The huddle chat is the thread on message msg_….
```

Every branch is `Effect.catchAll`'d to a minimal one-liner built from the payload alone, so a
missing channel or a deleted call degrades the prompt instead of failing the fire. D12's manual
run renders `Context — this was a manual test run; no event fired it.`

### `agents/triggerRunner.ts` (new)

A scoped daemon, shaped like `Scheduler`'s consumer:

```
bus.streamAll()
  ├─ keep only `_tag: 'Event'` whose `event.type` is a `TriggerEventType`
  ├─ `Routines.byEvent(companyId, type)`
  ├─ per routine: `matchesEvent` (contract) → D6 self-trigger → D7 rate cap
  ├─ `triggerContext.render(event)`
  └─ `RoutineRunner.fire(companyId, routineId, now, { _tag: 'event', context })`
```

Run the per-routine work with `Effect.forEach(..., { discard: true })` — sequential, so one
agent's triggers stay ordered, and the semaphore in `RoutineRunner` is never contended from two
directions. Each routine is wrapped in `Effect.catchAllCause` + a log line: one bad trigger never
stops the stream. D6 is one helper, `actorOf(event): Option<{kind, id}>`, matched against the
routine's `agentId`.

### `http/` and `layers.ts`

`RoutinesGroup` implementations only change where they touch `schedule`. Add
`TriggerRunner.Default` to `AgentsLive` next to `RoutineRunner.Default`; it depends on `Bus`,
`Routines` and `RoutineRunner`.

### `config.ts`

`TAUT_TRIGGER_MAX_FIRES_PER_HOUR`, default 20.

### Tests — `test/triggers.test.ts`

Create an event routine → publish a matching `call.ended` on the bus → a task exists and the
message body starts with `@handle` and contains the context block. Then: a non-matching channel
fires nothing; a 20-second huddle with `minSeconds: 60` fires nothing; a `message.created`
authored by the routine's own agent fires nothing (D6); the 21st fire in an hour is skipped (D7);
a still-running previous task skips (D8); a paused agent skips; `runNow` on an event trigger
returns a task with the manual context (D12); and the existing `test/routines.test.ts` still
passes after the schema swap.

## Web — `apps/web`

The Routines tab keeps its place and its name. One list, one dialog (D14).

- `components/agent-routines.tsx` — rows render `describeTrigger(trigger, channelName)` instead of
  `describeSchedule`. The "Next run in 3 h" cell shows `—` for an event trigger; the last-run badge
  and the dropdown (Run now · Edit · Delete) are unchanged. Add a filter chip row
  *All · Schedules · Triggers* above the list once a company has both kinds.
- `components/routine-dialog.tsx` — between "Deliver to" and the picker, a two-tab segmented
  control **Schedule · Trigger** styled exactly like the mode row inside `SchedulePicker`.
  Selecting a tab swaps `<SchedulePicker>` for `<TriggerPicker>`; both are controlled and the
  dialog holds one `Trigger` in state. Save stays disabled while `validateTrigger` has issues.
- `components/trigger-picker.tsx` (new) — top to bottom:
  1. **Event** — a `Select` of the five events, each labelled as a sentence fragment
     ("A huddle ends", "Someone posts a message", "An agent's run fails", …).
  2. **Where / who** — the variant's filters, and only those:
     - `call.ended` / `call.started` — a multi-select of the agent's channels, empty reading as
       "any channel"; `call.ended` also gets "Ignore huddles under `[N]` minutes".
     - `message.created` — the same channel multi-select but **required**, an author-kind toggle
       pair *People · Agents*, a `containing` `Input`, and a `Switch` for thread replies.
     - `agent.task.failed` — a multi-select of agents, empty reading as "any agent".
     - `project.issue.created` — a multi-select of projects, empty reading as "any project".
  3. **Preview** — the `describeTrigger` sentence in `text-sm font-medium`, and under it the plain
     warning "Triggers fire at most 20 times an hour" when the chosen event is `message.created`.
- `components/schedule-picker.tsx` — unchanged.
- `lib/api.ts` — the routine hooks keep their names and shapes; only the payload type moves.
- `lib/live.ts` — unchanged: `routine.*` already carries the whole row.

### UI rules (non-negotiable)

Same as the routines plan. `@taut/ui` primitives only, no new dependency, no new colour, no icon
set beyond `lucide-react`. The mode switch reuses the segmented `Tabs` look already in
`SchedulePicker`. Multi-selects are the existing chip-and-popover pattern, not a new component.
No layout shift between the two modes or between event variants — the picker keeps a fixed
min-height, as `SchedulePicker` already does.

---

# Part II — Signals (agent-emitted events)

Status: contract frozen 2026-09-09, pass two. Depends on Part I; do not start it first.

## What a signal is

> A named event an agent emits, optionally in the future, that wakes an agent — usually itself,
> in the same thread, with the same context.

The motivating case is a timer. A human opens a thread and asks *"remind me in three minutes to
buy watermelon"*. The agent calls one tool, answers "set", and its turn ends — the process exits,
nothing is held open. Three minutes later the server posts into **that same thread**, the
scheduler dispatches, and `AgentSessions` resumes `(agentId, threadId, runtime)` exactly as it
does for a human's follow-up message. The agent picks up with everything it knew, and says the
thing it promised to say.

That last part is the whole trick and it costs nothing: a thread *is* a session
(`docs/build-plan-sessions.md` D1), and `Messages.postAsUser` already takes a `threadId`.

## Decisions

| #   | Decision | Why |
| --- | -------- | --- |
| D16 | **One** new bus event, `signal.emitted`, carrying `{ signalId, name, payload, emittedBy, threadId?, targetAgentId?, depth }`. The custom name is **data**, never a new `EventType`. | The bus union stays closed and exhaustively matchable. An open set of event types would defeat every `switch` in the codebase and every decoder in the web client. |
| D17 | Listening is **one more variant in the Part I union**: `SignalTrigger`, tagged `'signal.emitted'`, filtering on `names` and `fromAgentIds`. | D3 was built for this. The runner, the rate cap, the overlap rule and the picker all extend by one case. |
| D18 | **A self-wake needs no trigger row.** `to: 'self'` stamps `target_agent_id` on the signal; delivery goes straight to that agent. Broadcast signals (no target) wake only agents whose `SignalTrigger` matches. | The timer must be one tool call. Making an agent write a listener before it can set a reminder would make the common case the hard one. |
| D19 | A delayed signal is a **row in `signals`**, delivered by its own 5-second tick. An immediate emit publishes on the bus inside `publisher.transact` and is rowed in the same transaction. | "In three minutes" must survive a deploy. 5 seconds is the coarsest tick a human would still call a timer; the query is one index seek. |
| D20 | `thread: 'current'` (the default when a signal is emitted from inside a thread) records `thread_id`, and delivery posts **into that thread**. Context comes back through the ordinary session resume, not through the payload. | This is the requirement. Anything else re-implements session state in a JSON blob and drifts from it. |
| D21 | The wake message is posted **as the user who requested the originating task**, body `@handle <note>`, and `tasks.signal_id` records where it came from (mirroring `tasks.routine_id`, D9). The thread renders a small "scheduled by @handle" affordance off that column. | Consistent with routines D1: one dispatch path, a visible normal turn. The affordance is what stops it reading as words the human typed. |
| D22 | `payload` is arbitrary JSON, capped at 8 KB, and is rendered into the wake message's context block. It is a **hint, not the context** — D20 supplies the context. | A broadcast signal crossing agents has no shared thread, so it needs to carry something. A self-wake usually needs nothing. |
| D23 | **Chain depth is time-scoped.** A signal delivered within `SIGNAL_CHAIN_WINDOW` (60 s) of the task that emitted it inherits `depth + 1` and is refused above `MAX_SIGNAL_DEPTH` (10). A signal delivered later starts at 0. | A runaway is a tight loop, not a slow one. A watcher that re-arms itself every three minutes is a legitimate pattern and must not be capped out; ten immediate hops in a minute is a bug. |
| D24 | Signal wakes **count toward `TURN_CAP`** like every other turn. When a wake would exceed it, the signal is cancelled, not queued, and the runner posts the existing `TURN_CAP_NOTE` in the thread. | An agent must not be able to escape the thread's turn cap by routing through the clock. Cancelling beats silently dropping: the human sees why the reminder never came. |
| D25 | Each agent may hold at most `MAX_PENDING_SIGNALS` (50) undelivered signals; emitting past that fails the tool call with a message the agent can act on. Part I's D7 hourly fire cap applies to delivery on top. | Two independent valves: one on how many can be armed, one on how fast they can go off. |
| D26 | Signals are **cancellable and listable** by the agent that emitted them (`list_signals`, `cancel_signal`), and by a human from the thread. Deleting the agent, archiving the thread's channel, or a failed dispatch cancels the pending ones. | "Actually, never mind" is half of what a reminder is for. |
| D27 | Part I's D6 self-trigger guard **does not apply to signals.** An agent waking itself is the point. | D6 exists to stop an agent reacting to its own side effects; a signal is an explicit, budgeted, depth-capped request to be woken. D23/D24/D25 are its guard rails instead. |
| D28 | Signal names are `[a-z0-9][a-z0-9._-]{0,63}`, scoped to the company. No namespacing by agent. | A broadcast signal is worthless if only its author can name it. Collisions are the coordination mechanism, not a bug. |

## Contract — `packages/contract`

### `src/ids.ts`

Add `signal: 'sig'` to `IdPrefix`, `SignalId`, `newSignalId()`.

### `src/domain/signal.ts` (new)

```ts
export const SignalName = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/),
  Schema.brand('SignalName')
)

/** Free-form JSON the emitter attaches; a hint for the woken agent, not its context (D22). */
export const SignalPayload = Schema.Record({ key: Schema.String, value: Schema.Unknown })

export const SignalStatus = Schema.Literal('pending', 'delivered', 'cancelled', 'expired')

export class Signal extends Schema.Class<Signal>('Signal')({
  id: SignalId,
  companyId: CompanyId,
  name: SignalName,
  payload: Schema.optionalWith(SignalPayload, { default: () => ({}) }),
  /** Who emitted it. Agents today; a human-set reminder is the same row tomorrow. */
  emittedByKind: MemberKind,
  emittedById: MemberId,
  /** The task whose turn emitted it — the anchor for the D23 chain window. */
  emittedByTaskId: Schema.optional(TaskId),
  /** Set by `to: 'self'` or an explicit agent. Absent = broadcast to matching triggers (D18). */
  targetAgentId: Schema.optional(AgentId),
  /** Where the wake lands. Absent = the target agent's DM with the requester. */
  channelId: Schema.optional(ChannelId),
  /** The thread to resume (D20). Absent = a new thread. */
  threadId: Schema.optional(MessageId),
  /** What the woken agent is told to do. */
  note: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)),
  /** Now, or the future. Immediate emits set this to the emit time (D19). */
  deliverAt: Schema.DateTimeUtc,
  depth: Schema.Int.pipe(Schema.between(0, 10)),
  status: SignalStatus,
  deliveredTaskId: Schema.optional(TaskId),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}
```

### `src/domain/trigger.ts`

Add the sixth variant and put it in the `EventTrigger` union and `TriggerEventType`:

```ts
export const SignalTrigger = Schema.TaggedStruct('signal.emitted', {
  names: Schema.NonEmptyArray(SignalName),
  /** Empty = from anyone. A broadcast listener usually leaves this empty. */
  fromAgentIds: Schema.optionalWith(Schema.Array(AgentId), { default: () => [] })
})
```

`matchesEvent` gains one case; `describeTrigger` gains one sentence
(`"When the signal \`deploy-finished\` is emitted"`).

### `src/events.ts`

```ts
export const SignalEmitted = variant('signal.emitted', Schema.Struct({ signal: Signal }))
```

Add `'signal.emitted'` to `EventType` and the variant to the `Event` union. Carrying the whole
`Signal` follows the `call.updated` precedent: one payload, no follow-up fetch.

### `src/api/signals.ts` (new) — `SignalsGroup`, prefix `/signals`, `Authentication`

`GET /` (`{ ...PageQuery, agentId?, status? }` → `Page(Signal)`) and `DELETE /:signalId` → void,
so a human can see and kill a pending reminder from the thread (D26). Emitting over HTTP is not
exposed in this pass; agents emit through their tool surface.

### Tests — `packages/contract/test/signal.test.ts`

`SignalName` accepting and rejecting the boundary cases; `matchesEvent` for `SignalTrigger` on
name and on `fromAgentIds`; `describeTrigger` for the new variant; `Signal` round-tripping with an
absent payload and with a nested one.

## Server — `apps/server`

### Migration `0032_signals.ts`

```
CREATE TABLE signals (
  id, company_id, name, payload_json, emitted_by_kind, emitted_by_id, emitted_by_task_id,
  target_agent_id, channel_id, thread_id, note, deliver_at, depth, status,
  delivered_task_id, created_at, updated_at
)
CREATE INDEX signals_due     ON signals(status, deliver_at)
CREATE INDEX signals_emitter ON signals(company_id, emitted_by_id, status)
ALTER TABLE tasks ADD COLUMN signal_id TEXT
```

`company_id`, `target_agent_id` and `channel_id` cascade; `thread_id` is a plain `TEXT` with no
foreign key, matching how thread ids are held elsewhere.

### `services/signals.ts` (new)

`emit` / `list` / `cancel` / `due(now)` / `markDelivered` / `markExpired`, each write through
`publisher.transact`. `emit` enforces D25 (pending count), D23 (depth, resolved by reading the
emitting task's own signal and comparing timestamps against `SIGNAL_CHAIN_WINDOW`) and D28 (name
shape), then either publishes `signal.emitted` immediately or leaves the row `pending`.

### `agents/signalRunner.ts` (new)

A 5-second tick over `Signals.due(now)`, shaped exactly like the routine tick. Per signal:

```
├─ re-read the row: not `pending` → nothing (a cancel got there first)
├─ target agent gone / archived / paused → `expired` + a note in the thread
├─ D24 turn cap: the thread is at `TURN_CAP` → `cancelled` + `TURN_CAP_NOTE`
├─ publish `signal.emitted` on the bus  ← broadcast listeners (D17) wake from here
└─ if `target_agent_id` is set (D18): post `@handle <note>` as the requester into
   `thread_id`/`channel_id` via `Messages.postAsUser` + `Scheduler.postAndDispatch`,
   stamping `tasks.signal_id` (D21), then `markDelivered`
```

Broadcast delivery is *not* handled here: publishing on the bus is enough, because
`TriggerRunner` from Part I already consumes `signal.emitted` through the `SignalTrigger` variant.
The two paths meet at the bus and nowhere else.

### `agents/agentApi.ts` — three tools

- **`emit_signal`** — `{ name, note, payload?, deliverIn?: Duration string, deliverAt?: ISO,
  to?: 'self' | 'broadcast' | AgentId, thread?: 'current' | 'new' }`. Defaults: `to: 'self'`,
  `thread: 'current'`, immediate if neither delay is given. Returns the `Signal`, so the agent can
  quote a real time back to the human instead of guessing one.
- **`list_signals`** — the emitting agent's own pending signals.
- **`cancel_signal`** — `{ signalId }`, own signals only.

The tool description must say plainly: *your turn ends when you return; you will be woken in this
same thread with this same context.* Without that sentence the model holds the turn open and
polls, which is the failure this whole design exists to remove.

### `agents/triggerContext.ts`

One more branch for `signal.emitted`: the name, the emitter, the note, and the payload rendered
as fenced JSON when non-empty.

### `config.ts`

`TAUT_SIGNAL_TICK_SECONDS` (5), `TAUT_SIGNAL_CHAIN_WINDOW_SECONDS` (60),
`TAUT_MAX_SIGNAL_DEPTH` (10), `TAUT_MAX_PENDING_SIGNALS` (50).

### Tests — `test/signals.test.ts`

The watermelon case end to end on a stubbed clock: a task calls `emit_signal` with a three-minute
delay, the task ends, the tick at +3 min posts into the same thread, and the new task resumes the
same `agent_sessions` row. Then: cancel before delivery; a chain of eleven immediate hops stopped
at ten (D23); the same chain with a two-minute gap never capped; the 51st pending signal refused
(D25); a thread at `TURN_CAP` cancelling the signal with a note (D24); a broadcast signal waking a
second agent through its `SignalTrigger` and *not* waking one whose `names` do not match.

## Web — `apps/web`

Small, deliberately.

- The `TriggerPicker` gains its sixth event, "A signal is emitted", with a name `Input` (validated
  against `SignalName`) and an optional emitter multi-select.
- A message whose task carries `signal_id` renders a muted "⏰ scheduled by @handle" line above the
  body, the same weight as the existing routine badge.
- `components/thread-signals.tsx` — when a thread has pending signals, one muted row under the
  composer: "Reminder at 6:32 PM · Cancel". That is the whole human-facing surface; a full
  signals list is not worth a tab.
