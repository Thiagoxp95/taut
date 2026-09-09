# Build plan: live steering + agents reacting

Engineering contract for one owner requirement (2026-09-09): **a new message in a thread must be
forced into every agent still thinking in that thread, and an agent must be able to answer with a
reaction instead of a message.** Extends `docs/build-plan.md` and closes the one item
`docs/build-plan-message-actions.md` parked as `// TODO(plan)` ("agents reacting through the MCP
tools"). Effect everywhere, pinned versions from `docs/CHANGELOG.md`.

**No migration.** `message_reactions.member_kind` (migration `0013`) and `ReactionMember.kind` were
both written "so agents can react later without another migration" — this is that later. The steer
queue is in-memory next to `doneSummaries` and `redactors` in `runTask.ts`; a server restart already
kills the runs it would belong to.

## Owner requirement (verbatim intent)

> "Sometimes the agents does not need to text me back mandatorily. Sometimes the agents can just
> react to the message. In this case, I asked two agents simultaneously on the same message to agree
> on a color. As soon as the first agent posts, that should get injected right away into the other
> agents that are thinking, so they can just choose to give a reaction to the reply. Each new message
> should really take effect and steer and force steering on what the other agent's thinking. If the
> first agent says 'We agreed it's blue', and that gets forced and steered into the second one that
> is still thinking, he can see the answer was already given and just give thumbs up to the answer
> from the previous agent."

The screenshot shows the failure this fixes: `@clarifier` and `@dumb` were mentioned in one message,
ran in parallel, and each posted a full answer _and_ a redundant "cool with that?" round-trip — four
messages where one message plus one 👍 was the whole content.

## What is true today (verified in this repo, 2026-09-09)

| fact                                                                                                                                        | where                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| Reactions are user-only at the edge; the service already takes `memberKind` generically                                                     | `apps/server/src/services/reactions.ts:47,249,274`                            |
| The table and the contract already carry `member_kind` / `kind` for agents                                                                  | `db/migrations/0013_message_reactions.ts`, `contract/src/domain/message.ts:9` |
| Chips resolve any member through `useLookupMember`, not a user table                                                                        | `apps/web/src/components/reaction-chips.tsx`                                  |
| No agent-facing react tool exists                                                                                                           | `packages/taut-mcp/src/tools.ts` — 20 tools, none react                       |
| Nothing reaches a running agent. `taut_inbox` says so in its own description: _"Nothing is ever injected into your session while you work"_ | `packages/taut-mcp/src/tools.ts`                                              |
| The prompt is a one-shot string; stdin is written then closed                                                                               | `machine/types.ts:60`, `machine/process.ts:129-133`                           |
| claude-code runs `claude -p --output-format stream-json`, no `--input-format`                                                               | `adapters/claudeCode.ts`                                                      |

So: the reaction half is nearly free, the steering half is the build.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #      | decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | why                                                                                                                                                                                |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1     | **A reaction is a complete reply.** New MCP tool `taut_react` → `POST /react` on the agent protocol, body `{ messageId, emoji, on? }` (`on` defaults `true`; `false` removes). Returns `{ messageId, emoji, on }`.                                                                                                                                                                                                                                                                                                                                            | The owner's whole point: not every invocation deserves a paragraph.                                                                                                                |
| D2     | **Agent identity on a reaction** is `memberKind: 'agent'`, `memberId: agent.id`, taken from the task token — never a parameter. Same emoji validation and the same 20-distinct-emoji cap as a human.                                                                                                                                                                                                                                                                                                                                                          | Matches every other agent endpoint (protocol.ts §"the server derives `from` from the token").                                                                                      |
| D3     | **Reach**: an agent may react to any message in a channel it can view — its task thread and the channel root the task hangs off included. Reuses `channels.requireView` against the agent member, not a new rule.                                                                                                                                                                                                                                                                                                                                             | One access rule, already tested.                                                                                                                                                   |
| D4     | **A run that only reacted posts nothing.** `taut_done` with an empty summary and at least one reaction this run **withdraws** the streaming placeholder (delete the row, emit `message.deleted`) instead of finalizing an empty bubble. Task still ends `done`; the shimmer stops on the delete. Zero reactions and an empty summary keeps today's behaviour.                                                                                                                                                                                                 | Otherwise the thread fills with blank agent messages, which is worse than the redundant text we are removing.                                                                      |
| D5     | **Steer queue**: one in-memory queue per running task, keyed by `taskId`, held in `runTask.ts` beside `doneSummaries`. `messages.create` publishes into the queue of every in-flight run whose `threadId` matches, skipping the run's own agent. Bounded at 20 items, oldest dropped. Nothing persisted.                                                                                                                                                                                                                                                      | The run is in-process and dies with the server; persisting it would outlive the thing it steers.                                                                                   |
| D6     | **Injection point 1 — every runtime, guaranteed.** Every `taut_*` tool response carries `steer: [...]` when the queue is non-empty, and reading drains it. An agent cannot touch Taut without seeing what landed.                                                                                                                                                                                                                                                                                                                                             | Works on claude-code, codex, cursor and opencode alike, with no process change. Deletes the "nothing is ever injected" sentence honestly.                                          |
| D7     | **Injection point 2 — the teeth.** `taut_send` and `taut_done` **deflect once per run** when the queue is non-empty: the post does **not** happen, the call returns `{ posted: false, steer, hint }`, and the agent re-decides — post again, react instead, or finish. Hard cap of **one** deflection per run.                                                                                                                                                                                                                                                | This is what produces the screenshot's missing behaviour: `dumb` goes to post "We agreed: teal", is handed `clarifier`'s message, and answers 👍. The cap makes a loop impossible. |
| ~~D8~~ | **DROPPED 2026-09-09 — the experiment came back TURN BOUNDARY; see below.** ~~Injection point 3 — claude-code only, tier 2.~~ `ExecOptions.stdin` gains a streaming sibling; `process.ts` keeps the pipe open instead of `stdin.end(...)`; the adapter adds `--input-format stream-json` and wraps the prompt in a `{"type":"user","message":{…}}` envelope, so a steered message arrives even while the agent is deep in a non-Taut tool loop. Behind `TAUT_STREAM_STDIN`, default off until verified. Every other runtime falls back to D6/D7 with no loss. | The only way to reach an agent that is thinking rather than calling. Flagged, not assumed: mid-_turn_ delivery in headless claude-code is unverified here (§Verification).         |
| D9     | **A steer item is an inbox item** — `{ messageId, from, text, at, threadId, attachments? }` — plus a fixed one-line preamble: _"This arrived while you were working. A reaction alone is a complete answer."_ No new schema to learn.                                                                                                                                                                                                                                                                                                                         | The agent already knows this shape from `taut_inbox`.                                                                                                                              |
| D10    | **Prompt and tool copy change**: the instruction file gains a _"Reacting is a valid answer"_ paragraph naming the two-agents-one-question case; `taut_inbox`'s description loses "Nothing is ever injected into your session while you work"; `taut_send`'s gains "if a teammate already answered, react instead of repeating them".                                                                                                                                                                                                                          | The current copy actively teaches the behaviour we are removing.                                                                                                                   |
| D11    | **No new UI.** Chips already render any member. One fix only: `reaction-chips.tsx` must label an agent member from the directory rather than falling through to "Unknown member", and the `title` should read "Clarifier reacted with 👍".                                                                                                                                                                                                                                                                                                                    | The feature is server-side; the surface already exists.                                                                                                                            |
| D11b   | **`posted` is a real field.** `SendResponse` and `DoneResponse` carry `posted: true`, `Deflected` carries `posted: false`, and both routes answer a `Schema.Union` of the two. `steer` is merged into the encoded body by the HTTP layer and pulled back off it by the client.                                                                                                                                                                                                                                                                                | A discriminated union decodes unambiguously; declaring `steer` on twenty-odd schemas would say the same thing worse, and leaving it off means `Schema.Struct` silently drops it.   |
| D12    | **Fan-out is not special-cased.** One message mentioning two agents starts two tasks as it does today; whichever posts first feeds the other's queue through the ordinary `messages.create` path.                                                                                                                                                                                                                                                                                                                                                             | No new orchestration, and it works identically for three agents or a human interrupting one.                                                                                       |

## Interfaces every agent must honour

### `packages/taut-mcp` — protocol

```ts
// protocol.ts
export const ReactRequest = Schema.Struct({
  messageId: Schema.String.annotations({ description: 'Message to react to.' }),
  emoji: Schema.String.annotations({ description: 'A single emoji, 1–8 code points.' }),
  on: Schema.optional(Schema.Boolean) // default true; false removes your reaction
})
export const ReactResponse = Schema.Struct({
  messageId: Schema.String,
  emoji: Schema.String,
  on: Schema.Boolean
})

/** Messages that landed in your thread while this run was in flight (D9). */
export const SteerItem = Schema.Struct({
  messageId: Schema.String,
  from: Schema.String,
  text: Schema.String,
  at: Schema.String,
  threadId: Schema.String,
  attachments: Schema.optional(Schema.Array(InboxAttachment))
})

// routes: + react: route('POST', '/react', ReactRequest, ReactResponse)
// every response schema gains: steer: Schema.optional(Schema.Array(SteerItem))
```

### `packages/taut-mcp` — tools

```ts
defineTool({
  name: 'taut_react',
  description:
    'React to a message with an emoji instead of writing one. A reaction is a complete answer: ' +
    'when a teammate already said what you were going to say, react to their message (👍 to agree, ' +
    '👀 to acknowledge) and finish — do not repeat them in your own words. Pass on:false to take ' +
    'your reaction back. You may react to any message in a channel you can see.',
  input: ReactRequest,
  run: (c, i) => c.react(i)
})
```

`taut_send` and `taut_done` descriptions gain the deflection contract:

> If the response comes back `posted:false` with a `steer` list, your message was **not** posted —
> someone answered while you were writing. Read it, then either react to their message and call
> `taut_done`, or send again with something that adds to it. This happens at most once per run.

### Server (`apps/server`)

- `services/reactions.ts` — no change beyond exporting the member-generic path already there.
- `agents/agentApi.ts` — `react` handler: token → agent → `channels.requireView` → `reactions.toggle({ memberKind: 'agent', memberId: agent.id })` → emit `message.updated`.
- `agents/runTask.ts` — `steerQueues: Map<TaskId, SteerItem[]>` next to `doneSummaries`; registered in `run`'s `ensuring` teardown exactly as `redactors` is.
- `services/messages.ts` — after a successful `create`, call `runTask.steer(message)`; it is a no-op when no run matches. Must never fail a message create.
- `agents/prompt.ts` — the D10 paragraph.

### Runtime (`packages/runtime`) — D8 only

- `machine/types.ts` — `ExecOptions.stdinStream?: Stream.Stream<string>` alongside `stdin?: string`; the two are mutually exclusive.
- `machine/process.ts:129` — when `stdinStream` is set, do not `stdin.end()`; write each element as a line and end when the stream completes.
- `machine/docker.ts` — the hijacked `Duplex` at `:274` already supports it; only the end-on-write path changes.
- `adapters/claudeCode.ts` — `--input-format stream-json` and the user-message envelope, gated on the flag.

## What actually shipped (2026-09-09)

All five phases are built. Deltas from the decisions above, none of them re-litigations:

- **D11 needed no code.** The chips already resolve any member through `useDirectoryIndex`, which
  merges users and agents, so an agent reaction renders with its name and never falls through to
  "Unknown member". The web is untouched by this build.
- **"Same conversation" is the thread a run replies into**, not the channel. Every agent reply is
  created with `threadId = message.threadId ?? message.id`, so a task's conversation is always its
  `task.threadId` — and two agents woken by one root message therefore share one, which is what makes
  D12 free. A _new_ root message in the same channel is a new topic and does not steer.
- **A run is never steered by the message that woke it**, on top of never by its own reply: the
  trigger is already the prompt it started from, so it is seeded into the seen-set.
- **The steer queue is not what withdraws the reply.** `taut_done("")` records the intent; the runner
  withdraws at the end, and only if the runtime printed nothing. An empty summary with no reaction is
  refused with a 422 that says what to do instead, rather than silently keeping the old behaviour.
- **D8 was built, measured and then removed.** `scripts/verify-streaming-stdin.mjs` came back
  **TURN BOUNDARY**: a user message written to an open stdin mid-turn is queued until the turn ends.
  That is useless for the case this build exists for — by the turn boundary the agent has already
  posted the answer we were trying to stop it duplicating — so the flag, the streaming
  `ExecOptions`, the adapter's `--input-format stream-json` mode and their tests were taken back out
  rather than shipped off-by-default. Steering is D6 and D7 only.
- ~~**`local.ts` had to learn about the new shape**~~: it opened a stdin pipe only when `stdin` was set,
  so a `stdinLines`-only exec got `stdin: null` and no lines at all.

## Phases

| #   | phase                                   | scope                                                                        | estimate               |
| --- | --------------------------------------- | ---------------------------------------------------------------------------- | ---------------------- |
| 1   | **Agent reactions end to end**          | D1–D3, D11: protocol route, `taut_react`, agentApi handler, chip label fix   | ~1h                    |
| 2   | **Steer queue + tool-result injection** | D5, D6, D9: the queue, the `messages.create` hook, `steer` on every response | ~2h                    |
| 3   | **Deflect once on send/done**           | D7, D10: the deflection, the cap, the tool copy                              | ~1h                    |
| 4   | **Withdrawn placeholder**               | D4: empty-summary + reacted → delete the streaming message                   | ~1h                    |
| 5   | **Streaming stdin**                     | D8: machine layer, adapter, flag                                             | ~3h, plus verification |

Phases 1-4 are built and shipped. **Phase 5 was built, measured and deleted** — the experiment below
came back the wrong way, which is exactly the outcome the phase was gated on.

Phases 1–4 land the owner's scenario on every runtime. Phase 5 is the upgrade from "steered at the
next Taut call" to "steered mid-thought", and is the only phase that can fail for reasons outside
this repo.

## Verification

The repro is the screenshot. In one channel, one message: `@clarifier @dumb can you agree on a color
and tell me which one?`

Pass after phase 3:

1. Both tasks start; both shimmer.
2. Whichever finishes first posts one message naming a color.
3. The second one's `taut_send` returns `posted:false` with the first one's message in `steer`.
4. The second one reacts 👍 on that message and calls `taut_done` with no summary.
5. The thread holds **two** entries: the human's question and one agent answer carrying a 👍 chip
   attributed to the second agent. No "cool with that?" round-trip.

That is `apps/server/test/steering.test.ts`, which runs it against the fake provider with a run
parked mid-turn. Phases 1-4 are covered there; phase 5's plumbing is covered by
`packages/runtime/test/local.test.ts` and `packages/runtime/test/claudeCode.test.ts`.

Phase 5 has its own gate, and it is a real unknown: headless `claude` accepts multiple user messages
on a streaming stdin, but whether one sent _during_ an assistant turn is delivered mid-turn or queued
to the next turn boundary has not been tested here. Test it standalone before wiring it: run
`claude -p --input-format stream-json --output-format stream-json`, push a long task, push a second
user message two seconds later, and read the transcript for where it landed. If it queues to the turn
boundary, phase 5 buys nothing over D6 and should be dropped rather than shipped — say so in the
report instead of landing it dark.

`scripts/verify-streaming-stdin.mjs` is that experiment. **Run 2026-09-09 against the pinned
`claude`: TURN BOUNDARY.** The marker only appeared after the first turn closed, so a message pushed
into an open stdin waits for the model to finish what it was saying — by which point the redundant
answer this whole build exists to prevent has already been posted. Phase 5 was therefore deleted,
not defaulted off: `TAUT_STREAM_STDIN`, `ExecOptions.stdinLines`, the adapter's `streamInput` /
`encodeInput` and their tests are all gone.

The script stays, because the answer belongs to a `claude` version rather than to Taut. Re-run it
after a runtime upgrade; if it ever says MID-TURN, D8 becomes worth building again and this plan
says how.

## Risks

- **Deflection reads as a failure to a badly-prompted agent.** The response must say `posted:false`
  plus a hint, never an error code — an agent that treats it as a failure will retry blindly and burn
  the one deflection it gets. Watch this in phase 3.
- **An agent that never calls a Taut tool is never steered.** This is the honest ceiling of D6/D7,
  and with D8 measured and dropped there is no way past it today. In practice a run ends by calling
  `taut_done`, so the ceiling is "steered before it finishes" rather than "never" — but an agent that
  thinks for a long stretch without touching Taut is genuinely unreachable until it does.
- **Reaction spam.** The 20-emoji cap is per message across all members, so agents and humans compete
  for it. If that bites, cap agents separately rather than raising the shared limit.
