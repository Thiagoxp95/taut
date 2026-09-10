# Agent discussion turns

The two-agent screenshot exposed overlapping runs and misleading message order. The scheduler's
"thread" semaphore was keyed by **agent + thread**, so two different agents could independently
answer the same prompt. Steering reached them only at later tool calls, after they had already
formed their responses. Tool-posted proposals then queued additional turns. Finally, the response
placeholders kept their creation positions, making later conclusions appear above earlier proposals.

The existing steering test used one parked agent and a human message. It did not exercise two
agents started by the same mention, the follow-up dispatches, or runtime narration after an explicit
silent completion.

The corrected behavior is:

- One agent runs per company/thread, in explicit FIFO order. Semaphore wakeups allowed newer
  replies to overtake older queued turns; each job now waits for its predecessor, including a
  cancelled predecessor. Other threads still execute concurrently. A waiting agent's
  prompt is assembled after it acquires the floor, with the latest completed messages, message IDs,
  and reactions. The original trigger is labeled as the earlier request.
- Completed replies resolve mentions and deliver the next turn. Reaction updates do not dispatch
  another turn. Successful runs remember teammate messages they consumed; queued tasks for those
  same messages finish without another model invocation or an empty bubble. Human requests are
  never suppressed by those receipts.
- Agents can post a contribution with `taut_send`, then call `taut_done("")` to yield. An accepted
  empty completion suppresses later runtime narration, including "I reacted with a thumbs up."
- `taut_ask` parks immediately for a teammate in the same thread. The scheduler delivers the answer
  to the asker even if the human started the thread and the answer has no mention.
- Ordinary completed replies continue the current delegation depth. Tool-created handoffs retain
  the depth limit. The 20-message circuit breaker remains the ceiling for an agent-only exchange.
- Final replies receive their publication timestamp. The live message cache sorts by timestamps,
  so the UI and a refreshed thread show proposals before responses.
- Migration 0034 removes the cascading link from a task to its optional chat reply. Withdrawing
  an empty message preserves task history, trigger idempotency, pending asks, and task references.
  The migration preserves existing rows and all relationships pointing to tasks.

The server guarantees turn exclusion, fresh context, dispatch rules, and explicit silent completion.
Choosing a position and deciding when agreement is real remain model behavior, guided by the prompt.
No agreement or reaction is fabricated by the scheduler.

## Verification

Deterministic integration test (real scheduler, SQLite, runtime adapter and HTTP API; scripted model):

```sh
pnpm --filter @taut/server exec vitest run test/conversationTurns.test.ts test/migrations.test.ts
```

The regression begins with two mentions, sends a proposal for A, debates B over multiple turns,
reports one common decision, and ends with the other agent's actual stored thumbs-up reaction.
It also checks message ordering, no duplicate model invocation, parked asks, independent threads,
cancellation, and an upgrade with existing task/ask rows.

Live test using two Claude agents and the host development login in a temporary workspace:

```sh
pnpm --filter @taut/taut-mcp build
TAUT_TEST_CONVERSATION=1 pnpm --filter @taut/server exec vitest run test/conversationTurns.live.test.ts
```

The live task compares A (one-day delivery, $100/month) with B (three-day delivery, $10/month),
with a one-week deadline and annual cost as the priority. It checks one reported decision and a
thumbs-up from the other agent, with no unfinished tasks. Live model wording is intentionally not
asserted verbatim.

Final verification on 2026-09-09: **312 server tests passed**, **35 MCP tests passed**, server/web/MCP
typechecks and targeted lint passed. The stricter live test passed in 49.6 seconds: proposal for B →
argument for A → B with a fallback → explicit acceptance → one reported decision carrying the other
agent's 👍. It checks that both agents contribute before the sole decision report, which must be
the final text message. Earlier live runs exposed both queue overtaking and premature decision
labels; those observations tightened the scheduler, opening-turn instructions, and regression.
