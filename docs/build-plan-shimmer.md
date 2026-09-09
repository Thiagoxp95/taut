# Build plan: shimmer on the message that invoked an agent

Engineering contract for one owner requirement (2026-09-08 evening), companion to
`docs/build-plan-sessions.md` (D11: make the session model legible). **The message that invokes an
agent shimmers until that agent is done.** DM an agent and your own message shimmers. Mention an
agent in a thread with colleagues and the line you mentioned them in shimmers. Effect everywhere,
pinned versions from `docs/CHANGELOG.md`. This build owns **no migration**; it owns one contract
field (`Task.triggerMessageId`) and one new dependency.

## Owner requirement (verbatim intent)

> "https://www.assistant-ui.com/tw-shimmer — let's use that to add a shimmering effect to every
> message that initiates a session or to invoke an agent that will produce a response. So if I DM
> an agent, my own message becomes shimmering, and if I am on a thread talking to my colleagues and
> I invoke an agent then my text that I invoked the agent will also be shimmering until done."

## The library (read off the page, 2026-09-08)

`tw-shimmer` by assistant-ui. "Zero-dependency shimmer for Tailwind CSS v4. Sine-eased gradients,
OKLCH color mixing, text and skeletons." **CSS only, no JavaScript runtime.** Install is
`npm install tw-shimmer`, then one line beside the Tailwind import.

Utilities the page documents:

| utility                     | meaning                                                         | default                       |
| --------------------------- | --------------------------------------------------------------- | ----------------------------- |
| `shimmer`                   | base; needs a text color lighter or darker than the page        | —                             |
| `shimmer-invert`            | contrasting dark band instead of a light one                    | —                             |
| `shimmer-color-{color}`     | override the highlight, any Tailwind color                      | mixed from current text color |
| `shimmer-spread-{n}`        | highlight width in px                                           | `120`                         |
| `shimmer-angle-{n}`         | sweep angle in degrees                                          | `15`                          |
| `shimmer-duration-{ms}`     | fixed cycle time; wide text looks faster                        | —                             |
| `shimmer-speed-{px/s}`      | constant visual speed at any width                              | `200`                         |
| `shimmer-repeat-delay-{ms}` | pause between cycles, `0` for continuous                        | `1000`                        |
| `shimmer-bg`                | sweep the background instead of the text (skeletons)            | —                             |
| `shimmer-container`         | share timing across a group, with `--shimmer-x` / `--shimmer-y` | —                             |

The page states one constraint that decides our styling: **"The highlight is invisible on solid
black or white. Use a muted or semi-transparent color."** A user's own message renders at full
`text-foreground` today, so it cannot shimmer as-is — see D4.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                                                                                                       | why                                                                                                                                                                                                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **`tw-shimmer` goes in `@taut/ui`**, not `apps/web`: `packages/ui/package.json` dependency, and `@import 'tw-shimmer';` on the line after `@import 'tw-animate-css';` in `packages/ui/src/styles/globals.css`.                                                                                                                                                                 | `tw-animate-css` is already wired exactly this way. The desktop shell renders the same bundle, so it gets the effect for free.                                                                                                              |
| D2  | **A message shimmers while it has at least one live task.** Live = a task whose `triggerMessageId` is that message and whose status is not `done`, `failed` or `cancelled`. Nothing else shimmers — not the agent's streaming reply, which already has its own streaming affordance.                                                                                           | "Until done" is exactly the task lifecycle. Reusing `trigger_message_id`, which the tasks table already stores, means no new state and no new event.                                                                                        |
| D3  | **`Task.triggerMessageId: Schema.optional(MessageId)`** is added to the public `Task` in `packages/contract/src/domain/task.ts`, and `toTask` in `apps/server/src/domain/rows.ts` maps the column that is already selected in `COLUMNS`. `agent.task.started` / `.done` / `.failed` all carry a full `Task`, so the client gets open and close signals with no new event type. | One optional field replaces an entire event surface. The column and the query are already there.                                                                                                                                            |
| D4  | **The shimmering message body renders `shimmer text-foreground/60`**, reverting to its normal color when the last task ends. Defaults otherwise: no `shimmer-invert`, no angle or spread override, `shimmer-speed-200`, `shimmer-repeat-delay-1000`.                                                                                                                           | The library cannot show a highlight on full-contrast text (quoted above). Dimming to 60% is both what makes the sweep visible and an honest "this is in flight" signal. Defaults first; tune only if it reads badly against the real theme. |
| D5  | **Several agents in one message = one shimmer, ending with the last of them.** The client keeps a count of live tasks per trigger message and stops at zero.                                                                                                                                                                                                                   | Mentioning two agents in one line is one invocation from the writer's point of view.                                                                                                                                                        |
| D6  | **Every trigger shimmers, whoever wrote it** — a human mention, a routine's posted message, an agent's handoff message. No author-kind special case.                                                                                                                                                                                                                           | A rule with no exceptions is the one a user can actually learn. It also makes a runaway handoff chain visible in the transcript.                                                                                                            |
| D7  | **Failure and cancellation stop the shimmer**, same as success. The `failed` styling on the agent's reply is what reports the outcome.                                                                                                                                                                                                                                         | A message shimmering forever after a crash would be the worst possible state.                                                                                                                                                               |
| D8  | **`prefers-reduced-motion: reduce` disables the animation**, via our own guard in `packages/ui/src/styles/globals.css` (`animation: none` on `.shimmer`), regardless of what the library ships. Live messages keep the dimmed `text-foreground/60` so the state is still readable without motion.                                                                              | Never assume a third-party plugin honours it. The state must survive the animation being gone.                                                                                                                                              |
| D9  | **Reload rehydrates from the server.** `ListTasksInput` and the tasks endpoint gain `live?: boolean` meaning "status not in (`done`,`failed`,`cancelled`)". The client fetches live tasks once on boot and maintains the set from events after that.                                                                                                                           | Without it, a refresh mid-run leaves every in-flight message flat. Live tasks are few, so this is one small query.                                                                                                                          |
| D10 | **No shimmer in search results, forwarded quotes, or the tasks list.** Only the message list and the thread panel.                                                                                                                                                                                                                                                             | The effect means "happening now, here". Anywhere else it is decoration.                                                                                                                                                                     |

## Interfaces

### `@taut/contract`

```ts
// domain/task.ts — add to Task, keep every existing field
/** The mention or DM that spawned this task; the client shimmers that message while the task runs. */
triggerMessageId: Schema.optional(MessageId)

// api/tasks.ts — add to the list endpoint's url params
live: Schema.optional(Schema.Boolean)
```

### `apps/server`

- `domain/rows.ts` — `toTask` maps `trigger_message_id` (already in `COLUMNS`, `tasks.ts:24`).
- `services/tasks.ts` — `ListTasksInput.live?: boolean`; when set, `AND t.status NOT IN ('done','failed','cancelled')`.
- Nothing in `agents/` changes. The events already carry `Task`.

### `apps/web`

A single hook owns the whole feature:

```ts
/** Message ids with at least one task still running. Seeded from `GET /api/tasks?live=true`,
 *  then kept by `agent.task.started` (+1) and `agent.task.done|failed` (-1). */
useLiveTriggers(): ReadonlySet<MessageId>
```

`message-bubble.tsx` reads it and applies `shimmer text-foreground/60` to the body when the
message's id is in the set. `thread-panel.tsx` gets it from the same hook. That is the entire
client change: one hook, one conditional class, two call sites.

## Order of work

1. `tw-shimmer` dependency + the `@import` line. Confirm a hand-written `<span class="shimmer text-foreground/60">` actually sweeps in the running app before writing any logic.
2. `Task.triggerMessageId` + `toTask` + the `live` filter. Server-only, testable with `pnpm test`.
3. `useLiveTriggers` + the two call sites.
4. The reduced-motion guard.

Step 1 is the one that can fail for reasons outside this plan (a Tailwind v4 plugin that does not
load under the Vite plugin). Do it first and stop if it does not sweep.

## How to know it works

- **DM an agent.** Your own message shimmers from the moment you send it and stops the instant the
  agent's reply finishes.
- **Mention an agent in a channel thread.** That one message shimmers; the surrounding human
  messages do not.
- **Mention two agents in one message.** One shimmer, still going while the slower agent works,
  stopping when it finishes.
- **Kill a task from the tasks view.** The shimmer stops.
- **Reload mid-run.** The message is still shimmering after the refresh.
- **Turn on Reduce Motion in macOS.** No animation, and the message still reads as dimmed.
