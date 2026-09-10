# Build plan: the running commentary under a streaming reply

## Updated behavior: protect the conversation (2026-09-09)

The current implementation supersedes D5–D6 below: an active reply is one compact row with a
working avatar and a muted, italic, shimmering status line. It has no message header or actions.
The fallback is “Name is working…”. Explicit short progress summaries and tool descriptions replace this
line; raw reasoning and draft answer text never reach it. Agents write 3–8 word summaries in
`<taut-status>` blocks between tool calls. Tags are buffered across chunks and removed from final
answers. Message bodies do not shimmer, and updates keep the same status element mounted.
These rules supersede the raw-reasoning behavior in D1 and D4 below; none are appended to the saved reply, even with the legacy show-tools setting enabled.

Each runtime attempt buffers its candidate answer independently. A successful result supplies
the complete answer when available; otherwise the last assistant message after tools is used.
Codex completed messages are snapshots, not concatenated chunks. OpenCode message IDs preserve
multipart answers while separating subsequent messages. Failed attempts never publish their
partial output. On success, the final event replaces the activity row with the completed message.
Existing saved messages are not rewritten.

Regression coverage: `activityLive.test.ts` exercises the runtime → socket → persisted reply
path; `replyText.test.ts` covers final-result replacement, snapshots, chunks, and failed output.

## Original implementation plan

Engineering contract for one owner requirement (2026-09-09 evening), companion to
`docs/build-plan-shimmer.md` and `docs/build-plan-context-meter.md`. **A reply that has not written
its first word stops being an empty orb and starts saying what the agent is doing** — its own
reasoning, or the tool it just reached for, in muted italic on the line the text will take. Effect
everywhere, pinned versions from `docs/CHANGELOG.md`. This build owns **no migration** and **no new
table**: every line here is broadcast and thrown away.

## Owner requirement (verbatim intent)

> "Let's have this part integrated with, instead of an empty state, let's show in text muted and
> italic the thought process and tool calling etc."

Said of the placeholder under **Bug hunter · AGENT · 9:19 PM**: an orb, three dots, and no other
information for as long as the run takes.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                          | why                                                                                                                                                                                                             |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | **Two sources, one line.** Reasoning (`thinking`) and tool calls (`tool_use`) both feed a single status line per streaming message. The newest wins; there is no log, no scrollback, no expandable trace.                                                                         | The reader wants to know the run is moving and roughly where it is. A transcript of every tool call is a second conversation nobody asked for.                                                                  |
| D2  | **Ephemeral, like `typing`.** `agent.activity` is broadcast on the `Bus` and never written to the event log (`EphemeralEventTypes`), never appended to the message body, never stored. A reload mid-run shows the orb and waits for the next line.                                | It arrives many times a turn and is worthless a second later. Replaying it on reconnect would narrate a run that finished yesterday, and putting it in the body would leave tool chatter in the answer forever. |
| D3  | **Throttled to one broadcast per 400 ms per task**, newest-wins, the same discipline the context meter keeps. Text is flattened to one line and truncated server-side (140 chars, 80 for a shell command), cut on a word boundary.                                                | A run hammering `Read` in a loop would otherwise strobe. Truncating on the server means every client shows the same line and no client has to decide.                                                           |
| D4  | **`thinking` is a first-class `AgentEvent`**, parsed from claude-code `{type:"thinking"}` blocks, codex `reasoning` items and opencode `reasoning` parts. Cursor reports none and shows tool calls only.                                                                          | Reasoning must never reach a `text_delta`: the body is the answer, and the answer is what the reader keeps. A separate event makes that impossible to get wrong by accident.                                    |
| D5  | **The placeholder keeps its orb and gains a line beside it**: `AgentActivityLine` in `message-bubble.tsx`, muted, italic, 13px, single-line truncate, `shimmer`, fading in on every change (`.taut-activity`, guarded by `prefers-reduced-motion`).                               | The orb says "alive" and stops there. The italic keeps the line visibly not-the-reply. Truncation rather than wrapping keeps the row height stable while the text changes underneath.                           |
| D6  | **The line survives the first paragraph.** While the message is still `streaming` and text has been written, the same line renders under the body without the orb (the avatar is already an orb).                                                                                 | Most of a long run happens after the agent's first paragraph. Dropping the commentary at the first token is dropping it exactly when it starts to matter.                                                       |
| D7  | **Tool names are phrased, not printed.** `apps/server/src/agents/activity.ts` maps a tool call to a sentence — _Reading lib/live.ts_, _Running pnpm test_, _Searching for AgentEvent_, _Using Taut · post message_ — with a fallback to the tool's own name for anything unknown. | `mcp__taut__post_message` is not a status line. An unknown tool still has to say that something is happening, which is the whole job, so the fallback prints the name rather than nothing.                      |
| D8  | **Paths are shortened to their last two segments**, commands and queries to their first 80 characters.                                                                                                                                                                            | A machine-visible absolute path is longer than the chat column and identifies the file no better than `lib/live.ts` does.                                                                                       |
| D9  | **Cleared when the run ends** — done, failed and cancelled alike, keyed on the message id.                                                                                                                                                                                        | The same rule as the shimmer (`build-plan-shimmer.md` D7). A commentary left running under a finished reply is the worst state available.                                                                       |
| D10 | **No redaction work here.** Every stdout line is already redacted before `parseLine` sees it (`packages/runtime/src/run.ts`), so a secret cannot reach a tool argument that reaches this line.                                                                                    | The existing guarantee is stronger than anything a second pass would add, and a second pass would drift.                                                                                                        |

## Interfaces

### `@taut/runtime`

`AgentEvent` gains `{ type: 'thinking', text: string }`. Adapters:

| runtime     | parsed from                                           |
| ----------- | ----------------------------------------------------- |
| claude-code | `assistant` content block `{type:"thinking"}`         |
| codex       | `item.*` item `{type:"reasoning"}` (`text`/`summary`) |
| opencode    | part `{type:"reasoning"}`                             |
| cursor      | — (reports no reasoning)                              |

### `@taut/contract`

```ts
AgentActivity = variant('agent.activity', {
  taskId,
  messageId,
  agentId,
  kind: 'thinking' | 'tool',
  text
})
```

Added to `Event`, to `EventType`, and to `EphemeralEventTypes`.

### `apps/server`

- `BusMessage` gains an `Activity` tag; `WsServer` turns it into an `agent.activity` frame and drops
  it for a backed-up socket on the same rule as typing.
- `agents/activity.ts` — `describeTool`, `thinkingLine`, `oneLine`. Pure, tested directly.
- `TaskRunner.makeActivity` — the throttle, one per task, publishing straight to the `Bus`.

### `apps/web`

- `live.ts` — `activityStore`, `live.setActivity` / `live.clearActivity`, `useMessageActivity`.
- `realtime-cache.ts` — `agent.activity` sets it; `agent.task.done` / `.failed` clear it.
- `message-bubble.tsx` — `AgentActivityLine`, in the placeholder slot and under streaming text.
- `styles/globals.css` — `.taut-activity` fade-in, reduced-motion guarded.

## Tests

- `packages/runtime/test/thinking.test.ts` — all three adapters, and that an empty block says nothing.
- `apps/server/test/activity.test.ts` — phrasing, truncation, word-boundary cuts, unknown tools.
