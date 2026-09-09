# Build plan: context meter (a ring on the agent, per thread)

Engineering contract for one owner requirement (2026-09-09): **show how full an agent's context
window is, in the place where that agent is speaking.** A thread is a session
(`docs/build-plan-sessions.md` D1), so a thread is a context window; two agents in one thread are
two copies with two contexts and therefore two rings. Extends `docs/build-plan-sessions.md` and
`docs/agent-model.md` §9. Effect everywhere, pinned versions from `docs/CHANGELOG.md`. Migrations
are append-only; `0027` is taken by project priority — **this build owns `0028`.**

Reference implementation studied before writing this: `pingdotgg/t3code`
(`apps/web/src/lib/contextWindow.ts`, `apps/web/src/components/chat/ContextWindowMeter.tsx`,
`apps/server/src/provider/Layers/ClaudeAdapter.ts`, `.../CodexAdapter.ts`). Where this plan copies
them it says so; where it departs it says why.

## Owner requirement (verbatim intent)

> "I'm in a public channel, I ping an agent and ask a question. It replies on the thread. That
> whole thread now has a context for that agent. If I invoke another agent on the same thread, now
> another agent has a similar context window. We want to display, around the avatar of the agent, a
> circle that is a loading bar of the context of the agent. Hover it and you see how much we have
> used from the context window. And that differs from Claude Code, Codex, etc. — make that
> connection properly."

## The thing that makes this hard

**Tokens billed ≠ tokens resident.** Every runtime already emits a `usage` event
(`packages/runtime/src/adapters/types.ts:48`) and every one of them means a different thing by it.
Summing those numbers gives a cost report, not a context gauge — the two diverge by an order of
magnitude the moment prompt caching is on, because a cached prompt is re-read every turn and
re-billed every turn while occupying the window exactly once.

What each runtime actually gives us, verified in the adapters in this repo:

| runtime       | stream line                       | fields                                                                         | is it context?                                                                                                            |
| ------------- | --------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` | `result` (`claudeCode.ts:271`)    | `input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_…` | **No.** Run totals across every turn. `input_tokens` is near zero on a cached run; the real prompt sits in `cache_read`.  |
| `claude-code` | `assistant` (`claudeCode.ts:222`) | `message.usage` — **dropped today**                                            | **Yes.** Each assistant message carries the prompt size of the call that produced it. The last one is the live occupancy. |
| `codex`       | `turn.completed` (`codex.ts:175`) | `input_tokens`, `cached_input_tokens`, `output_tokens`                         | **Per turn.** The last turn's total is the occupancy. Codex also streams `model_context_window`, which we ignore today.   |
| `opencode`    | `step_finish` (`opencode.ts:137`) | `tokens.input/output/cache.read/cache.write`                                   | **Per step.** Same treatment as codex: last sample wins.                                                                  |
| `cursor`      | —                                 | none                                                                           | **Nothing.** Cursor reports no usage at all. It gets no ring and says why on hover.                                       |

`apps/server/src/agents/runTask.ts:657` has no `case 'usage'`: the events are parsed and thrown
away. Nothing in the server has ever read them.

The second half is the denominator. No provider hands us a context window with the usage:

- **Codex** streams `model_context_window` on its `token_count` events. Authoritative — take it.
- **Claude Code** never states it. It must be resolved from the model id, and the model can change
  per message (`docs/build-plan-run-overrides.md`), so it is resolved per sample, not per agent.
- **models.dev** (`apps/server/src/services/modelCatalog.ts:25`) is already fetched and decoded for
  the OpenCode dropdown, and carries `limit.context` for every model of every provider. It is the
  one catalogue that covers all four runtimes.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                                                 | why                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **A new adapter event `context`, separate from `usage`.** `usage` keeps meaning money and stays untouched. `context` is `{ usedTokens, maxTokens?, inputTokens?, cacheReadTokens?, cacheWriteTokens?, outputTokens? }` and means "this is how full the window was at this instant".                                      | Overloading `usage` would force every consumer to know which runtime it came from to know what it means. The distinction is the whole build.                                                                                                                                             |
| D2  | **Occupancy is the last sample, never a sum.** `runTask` keeps the most recent `context` event and discards the ones before it.                                                                                                                                                                                          | Adding two turns together counts the same resident prompt twice. t3code reaches the same conclusion through `lastClaudeUsageIteration`.                                                                                                                                                  |
| D3  | **`claude-code` samples from `assistant`, not from `result`**: `usedTokens = input_tokens + cache_read_input_tokens + cache_creation_input_tokens + output_tokens` of that message. `result` still produces `usage` for cost, plus `totalProcessedTokens` for the hover card.                                            | This is the only number in the stream that equals the prompt actually sent. It also means the ring moves during a long run rather than snapping at the end.                                                                                                                              |
| D4  | **`codex` and `opencode` sample per turn / per step** from the lines they already parse. Codex additionally emits `maxTokens` from `model_context_window` when the `token_count` line carries it.                                                                                                                        | Their protocols are turn-shaped, not message-shaped. Taking the last one is the same rule as D2, applied to what they give.                                                                                                                                                              |
| D5  | **`cursor` reports nothing and the UI must say so**, not render an empty ring. `contextReported: false` in the runtime descriptor; the avatar draws no ring and the hover card reads "Cursor does not report context usage."                                                                                             | A grey ring at 0% is a lie. An absent ring with a reason is information.                                                                                                                                                                                                                 |
| D6  | **The denominator resolves server-side, in this order:** the runtime's own number (codex) → models.dev `limit.context` for the sample's model → a built-in `FALLBACK_CONTEXT_WINDOWS` table beside `FALLBACK_MODELS` → `undefined`. With `undefined` the ring is not drawn and the hover card shows the raw token count. | Same shape as the model catalogue that already exists, same failure posture: never fail, degrade to a floor. A percentage against a guessed denominator is worse than no percentage.                                                                                                     |
| D7  | **The unit of storage is `(agent_id, thread_id)`** — a new table `agent_thread_context`, not a column on `agent_sessions`.                                                                                                                                                                                               | Same key, different lifetime. Context is observable from runtimes that hand back no resumable session id, and it is written mid-run, before any session row exists. `sessions.clear` clears it explicitly.                                                                               |
| D8  | **A cold start resets the ring to zero.** Wherever `AgentSessions.clear` runs — including the resume-failure path (`docs/build-plan-sessions.md` D8) — the context row is deleted in the same transaction.                                                                                                               | A run that could not resume starts with an empty window. Leaving the old ring up would be the single most misleading state this feature can enter.                                                                                                                                       |
| D9  | **Compaction is shown, not hidden.** The snapshot carries `compactsAutomatically`, `autoCompactThreshold` and `compactedAt`. A sample below 80% of the one before it is a compaction: `compactedAt` is stamped and the card reads "Last compacted 4 min ago".                                                            | Without this, a user who watches the ring fill to 90% and then fall back to 30% concludes the meter is broken. Copied from t3code, which surfaces the same fields for the same reason.                                                                                                   |
| D10 | **Live during the run, coalesced to at most one broadcast per second per task** — the same discipline as `agent.task.delta`.                                                                                                                                                                                             | Watching the ring fill while the agent works is the point. Ten broadcasts a second for a number that moves once a turn is not.                                                                                                                                                           |
| D11 | **The ring is drawn only where the avatar stands in a thread**: the agent's message bubble inside a thread, and a facepile in the thread panel header carrying one avatar per agent holding a window in that conversation. The sidebar, member picker, command palette and profile card get no ring.                     | An agent has one context _per thread_. An avatar outside a thread would have to pick one arbitrarily, and any pick is wrong. This narrows the owner's "every avatar" deliberately — see **Scope** below.                                                                                 |
| D12 | **The ring is drawn at `md` and above.** A 20px tile cannot carry the stroke legibly, so the message facepile (`sm`) shows none and the thread header facepile uses `md`.                                                                                                                                                | Rendering it anyway produces a smudge, and a smudge that encodes a number is worse than nothing.                                                                                                                                                                                         |
| D13 | **The hover card is a `tooltip`, not a `popover`,** using `packages/ui/src/components/tooltip.tsx`, and it holds no controls.                                                                                                                                                                                            | t3code puts a "Compact context" button in its popover because it drives the agent directly. Taut drives agents by talking to them; a button here would be a second, mute control surface. `// TODO(plan)`: a `/compact` message shortcut, if it is ever wanted, belongs in the composer. |

## Interfaces

### Migration `0028_thread_context.ts`

```sql
CREATE TABLE agent_thread_context (
  agent_id         TEXT NOT NULL REFERENCES agents(id)   ON DELETE CASCADE,
  thread_id        TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id       TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  runtime          TEXT NOT NULL,
  model            TEXT,
  used_tokens      INTEGER NOT NULL,
  max_tokens       INTEGER,
  total_tokens     INTEGER,            -- cumulative billed tokens in this thread (hover card only)
  compacts_auto    INTEGER NOT NULL DEFAULT 0,
  compact_at       INTEGER,            -- auto-compact threshold in tokens, when the runtime states one
  updated_at       TEXT NOT NULL,
  PRIMARY KEY (agent_id, thread_id)
);
CREATE INDEX agent_thread_context_channel ON agent_thread_context(channel_id);
```

### `packages/runtime/src/adapters/types.ts`

```ts
const Context = Schema.Struct({
  type: Schema.Literal('context'),
  /** Tokens resident in the window at this instant. Never a running total (D2). */
  usedTokens: Schema.Number,
  /** Only when the runtime states it (codex). Otherwise resolved server-side (D6). */
  maxTokens: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  inputTokens: Schema.optional(Schema.Number),
  cacheReadTokens: Schema.optional(Schema.Number),
  cacheWriteTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number)
})
```

Added to the `AgentEvent` union. `RuntimeDescriptor` gains
`contextReported: boolean` and `compactsAutomatically: boolean` (D5, D9).

### `packages/contract/src/domain/context.ts`

```ts
export const ThreadContext = Schema.Struct({
  agentId: AgentId,
  threadId: MessageId,
  runtime: RuntimeKind,
  usedTokens: Schema.Number,
  maxTokens: Schema.optional(Schema.Number),
  totalTokens: Schema.optional(Schema.Number),
  model: Schema.optional(Schema.String),
  compactsAutomatically: Schema.Boolean,
  autoCompactThreshold: Schema.optional(Schema.Number),
  updatedAt: Schema.String
})
```

### `packages/contract/src/events.ts`

```ts
/** Coalesced to ≤ 1/sec per task (D10). Broadcast to the thread's channel. */
export const AgentContextUpdated = variant('agent.context.updated', ThreadContext)
```

Added to the event union and to the channel-scoped event list beside `agent.task.*`.

### `apps/server/src/services/threadContext.ts`

```ts
get: (companyId, agentId, threadId) => Effect<Option<ThreadContext>>
list: (companyId, channelId) => Effect<ReadonlyArray<ThreadContext>> // seeds the client
record: (input: RecordContext) => Effect<ThreadContext> // upsert + broadcast
clear: (agentId, threadId) => Effect<void> // D8
```

### `apps/server/src/services/modelCatalog.ts`

`ModelsDev` gains `limit: Schema.optional(Schema.Struct({ context: Schema.optional(Schema.Number) }))`,
and the service gains `contextWindow(runtime, model): Effect<Option<number>>` implementing D6's
chain. `FALLBACK_CONTEXT_WINDOWS: Record<RuntimeKind, Record<string, number>>` sits beside
`FALLBACK_MODELS` with the same posture: a floor, not a catalogue.

### `GET /api/channels/:id/context`

Returns `ReadonlyArray<ThreadContext>` for every open thread in the channel, so a refresh mid-run
does not leave the rings blank. Mirrors `GET /api/tasks?live=true`
(`docs/build-plan-shimmer.md` D9), which exists for exactly this reason.

### `apps/web/src/lib/live.ts`

A `threadContextStore: Map<`${agentId}:${threadId}`, ThreadContext>`, fed by
`agent.context.updated`, seeded by the endpoint above, and read by
`useThreadContext(agentId, threadId)`. Same shape as the shimmer set that already lives there.

### `apps/web/src/components/entity-avatar.tsx`

```ts
/** Agents in a thread only (D11). Draws the ring; `sm` ignores it (D12). */
context?: ThreadContext
```

The ring is an absolutely positioned `<svg viewBox="0 0 24 24">` rotated `-90deg` over the
existing figure, two `<circle>`s (track + arc) with `strokeDasharray`/`strokeDashoffset`,
transitioning `stroke-dashoffset` over 500ms with `motion-reduce:transition-none`. It sits
_outside_ the `AgentFigure` canvas and never touches it, so the orb morph
(`docs/build-plan-shimmer.md`, the agent-figure clock) is unaffected.

Stroke colour by fill: under 70% `--muted-foreground` at 72%; 70–90% `--warning`; above 90%
`--destructive`. `aria-label` reads "Context window 43% used".

### `apps/web/src/components/context-meter.tsx`

The hover card. Header "Context window", right-aligned `43% · 87k/200k`, a horizontal bar, then
rows for "Total processed" and the compaction line. Token formatting copies t3code's
`formatContextWindowTokens` (`1.2k`, `87k`, `1.4m`).

The compaction line is runtime-specific and is the visible half of "that differs from Claude Code,
Codex, etc.":

| runtime       | line                                                                                |
| ------------- | ----------------------------------------------------------------------------------- |
| `claude-code` | `Compacts automatically at 176,000 tokens.` (from `compact_at`, else "when needed") |
| `codex`       | `Codex compacts this thread automatically.`                                         |
| `opencode`    | `Context for <model> compacts automatically when needed.`                           |
| `cursor`      | `Cursor does not report context usage.`                                             |

## Scope

D11 narrows the requirement as stated. The owner asked for the ring on "every avatar of the agent";
this ships it on every avatar **inside a thread**. An agent in the sidebar has as many contexts as
it has live threads, and no correct number to show. If a single figure outside a thread is wanted
later, the honest one is "n live threads", which is a different control and a different build.

## Order of work

1. **`types.ts` + the four adapters.** Emit `context` (D1, D3, D4), leave `usage` alone, set
   `contextReported` / `compactsAutomatically` on each descriptor. Unit tests over captured stream
   lines, including a cached claude run where `input_tokens` is ~3 and `cache_read` is ~90k — that
   fixture is the whole point and must fail against the old code.
2. **Migration `0028`** + `services/threadContext.ts`. Wire `clear` into `AgentSessions.clear` (D8).
3. **`modelCatalog.contextWindow`** with the models.dev field, the fallback table, and the
   resolution order of D6.
4. **`runTask.ts`**: `case 'context'` keeps the last sample (D2), resolves the denominator,
   detects a drop as compaction (D9), and calls `record` behind a 1/sec coalescer (D10).
5. **Contract + event + endpoint**, then `lib/live.ts` and the boot seed.
6. **`entity-avatar.tsx` ring** and `context-meter.tsx`, then the three call sites of D11.
7. **Verification**: a thread with two agents shows two independent rings; a second turn moves the
   ring rather than doubling it; a cursor agent shows no ring and the reason on hover; a compaction
   drops the ring and labels it; a refresh mid-run restores the ring from the endpoint.

## What shipped (2026-09-09)

Built in the order above. Everything below is in the tree and compiles; `packages/runtime`
(92 tests) and `apps/server` (240 of 241) pass. The one server failure, a DM visibility
assertion in the phase-3 suite, predates this work: both files involved were last touched
hours before it started, and nothing here reaches `canView`.

| decision | where it landed                                                                                 |
| -------- | ----------------------------------------------------------------------------------------------- |
| D1–D5    | `context` event in `adapters/types.ts`; sampled in all four adapters; `contextReported` on each |
| D6       | `ModelCatalogs.contextWindow` + `FALLBACK_CONTEXT_WINDOWS` in `services/modelCatalog.ts`        |
| D7, D8   | migration `0028`, `services/threadContext.ts`, and the delete inside `AgentSessions.clear`      |
| D9, D10  | `makeContextMeter` in `agents/runTask.ts`                                                       |
| —        | `agent.context.updated` event, `GET /channels/:id/context`, `live.ts` store + two hooks         |
| D11–D13  | `components/context-meter.tsx`, `lib/context-window.ts`, message bubble + thread panel header   |

`packages/runtime/test/contextSamples.test.ts` is the file that holds the arithmetic honest.
Its first case is a claude turn with 3 fresh input tokens and 90,000 served from cache: any
implementation that reads `input_tokens` and calls it the context fails it.

Never exercised against a live runtime: no agent has been run end to end, so the numbers on
screen have only ever come from fixtures. What is verified is the parsing, the storage, the
event and the render path.
