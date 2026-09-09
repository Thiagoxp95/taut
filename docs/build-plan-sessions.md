# Build plan: thread = session (one agent copy per conversation)

Engineering contract for one owner requirement (2026-09-08 evening): **a thread is an agent
session.** DM an agent and it always answers in a thread; that thread is the conversation you keep
going back and forth in. Mention an agent inside a thread anywhere else and that thread becomes its
context. Every invocation is **its own copy of the agent, in a new runtime session, with its own
context** — and that copy carries the **full capability set of the agent** (repository grants
ro/rw, skills, vault, browser, memory, MCP tools). Extends `docs/build-plan.md` and
`docs/agent-model.md` §7/§9. Effect everywhere, pinned versions from `docs/CHANGELOG.md`.
Migrations are append-only; `0021` is taken by the skills build — **this build owns `0022`.**

## Owner requirement (verbatim intent)

> "When we DM agents, they will reply always on the thread, and the thread is gonna be the session
> itself that we're gonna keep going back and forth. So for example, if I wanna do something
> complex with Claude Code, I shoot him a message, it's gonna maybe reply to me asking more
> clarifications on the same thread and we keep going from there. If it's on another channel that
> I mention an agent on a thread already, that thread becomes its context. So I want to make clear
> that every invocation of each agent is its own copy of the agent in a new session that has its
> own context." … "And of course it has all the capabilities of the agent — read-only, writes,
> repositories, everything."

Two questions the owner answered before this plan was written:

- **A new top-level DM message opens a new thread and a new session.** It never continues the
  previous conversation. Continuation happens inside the thread.
- **Threads of the same agent run in parallel, capped.** Three live threads with `@bruno` are
  three concurrent copies, not a queue.

## What is wrong today (verified in the code, not assumed)

| where                               | today                                           | consequence                                                                                                                                                                                                                                                                                                |
| ----------------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agents/sessions.ts`                | `agent_sessions` PK is `(agent_id, channel_id)` | every thread in a channel shares one runtime session; a DM is one endless session                                                                                                                                                                                                                          |
| `agents/scheduler.ts:119`           | DM replies get `threadId: null`                 | a DM has no threads at all, so there is nothing to key a session on                                                                                                                                                                                                                                        |
| `agents/runTask.ts:833`             | `cwd = <home>/work/<taskId>`                    | claude-code stores sessions at `~/.claude/projects/<encoded-cwd>/<id>.jsonl`; a **new cwd every task** means `--resume <sid>` can never find the session it was handed. The `resumeFailed` branch at `runTask.ts:1021` is the path that actually runs. **Resume is effectively dead in production today.** |
| `agents/scheduler.ts:59`            | `agentGates` = 1 permit per `agentId`           | one slow thread blocks every other thread with that agent                                                                                                                                                                                                                                                  |
| `packages/runtime/src/repos.ts:386` | branch is `taskBranch(handle, taskId)`          | turn 2 of a conversation opens a _different_ branch than turn 1, so a review round trip cannot amend its own PR                                                                                                                                                                                            |

Fixing the session key without fixing the working directory changes nothing: the resume still
misses. D1 and D3 ship together or not at all.

## Decisions (do not re-litigate; flag in the report if you had to deviate)

| #   | decision                                                                                                                                                                                                                                                                                                                                                                                                                         | why                                                                                                                                                                                                                                        |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | **The session key is the thread.** `agent_sessions` PK becomes `(agent_id, thread_id)`, `thread_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE`. `runtime` stays a column, and `get` still filters on it so switching an agent from claude-code to codex never resumes a foreign session id. `channel_id` stays as a non-key column for debugging and for `clear`-by-channel.                                        | One thread, one session. Deleting the thread root retires the session with it, no sweeper.                                                                                                                                                 |
| D2  | **Every agent reply lands in a thread — DMs included.** In `scheduler.createTask` the `channelKind === 'dm' ? … : threadRoot` branch is deleted; both kinds use `message.threadId ?? message.id`. A top-level DM is therefore a thread root, and the agent's reply is its first reply.                                                                                                                                           | This _is_ the requirement. It also collapses two code paths into one.                                                                                                                                                                      |
| D3  | **The working directory is the thread, not the task**: `cwd = <home>/work/<threadRootId>`. Created once, reused by every turn, never deleted between turns.                                                                                                                                                                                                                                                                      | Without it `--resume` cannot work at all (see table above). It also means files the agent wrote in turn 1 are still on disk in turn 2, which is what "same session" means to a user.                                                       |
| D4  | **Threads of one agent run in parallel, capped at `maxThreadsPerAgent` (default 3, `AppConfig`).** `agentGates` keyed by `agentId` gets `maxThreadsPerAgent` permits; a **new** `threadGates` map keyed by `${agentId}:${threadRootId}` gets 1 permit. Acquire order is always `thread → agent → company`, never any other order.                                                                                                | A second turn in the same thread must never run while the first is running: they would share a cwd and a session file. Across threads, isolation is real, so parallelism is safe. Consistent lock ordering is what keeps it deadlock-free. |
| D5  | **Capabilities are per agent; only context and scratch are per thread.** The agent home, `~/.claude`, vault, skills, file grants, repository grants, browser access and MCP wiring are resolved from the agent exactly as they are today. No per-thread home, no per-thread credential, no per-thread grant.                                                                                                                     | "Its own copy" means its own _context_, not its own _permissions_. A copy with fewer capabilities would be a different agent.                                                                                                              |
| D6  | **Repository branches follow the thread.** `PrepareReposOptions.taskId` is renamed `sessionId` and receives the thread root id; `taskBranch(handle, id)` becomes `sessionBranch(handle, id)`, producing `taut/<handle>/<threadRootId>`. Worktrees live under the thread's work dir (D3) and survive between turns. `teardownRepos` still runs at the end of every task and still leaves a branch with unpushed commits standing. | A conversation is one unit of work, so it is one branch and one PR. Amending after review feedback becomes possible; today it is not.                                                                                                      |
| D7  | **On resume the prompt carries only what is new.** `agent_sessions` gains `last_message_id TEXT`. When a resume id exists, the prompt injects only thread messages **after** `last_message_id`; with no resume id it injects the last `CONTEXT_MESSAGES` of the thread as today. `last_message_id` is written alongside `session_id` on every successful run.                                                                    | The resumed runtime already holds the earlier transcript. Re-injecting it wastes tokens and lets the model see the same message twice with two different framings.                                                                         |
| D8  | **Resume failure degrades, never fails.** The existing `resumeFailed` retry stays: clear the row (now by thread), drop `resumeSessionId`, and retry once with the full-context prompt of D7's cold path. The user sees a normal reply.                                                                                                                                                                                           | An expired or pruned session file is routine, not an error worth surfacing.                                                                                                                                                                |
| D9  | **Handoffs and asks inherit the thread, not the session.** A `taut_handoff` child task keeps the parent's `threadId` but has a different `agentId`, so it gets **its own** row and its own session in that same thread. A `taut_ask` answer posted in the thread resumes the asking agent's session, because the key matches. Handoff depth 2 and the 20-turn cap are unchanged.                                                 | Falls out of D1 with no extra code. Two agents in one thread are two copies with two contexts, which is the correct reading of the requirement.                                                                                            |
| D10 | **The DM view becomes a thread list.** The DM route renders thread roots with a reply count and opens the existing `thread-panel.tsx` on click, exactly as a channel does. The DM composer posts a **new top-level message**, which by D2 starts a new conversation. No new "new session" button.                                                                                                                                | The affordance already exists and already means "start something new". Adding a second one would make the model less clear, not more.                                                                                                      |
| D11 | **The thread header names the session** for agent threads: the agent handle, its state (`idle` / `working`), and a "New conversation" link back to the top-level composer. `// TODO(plan)`: showing the runtime session id to admins.                                                                                                                                                                                            | The owner's whole ask is that this model be _legible_. A thread that silently is a session teaches nobody.                                                                                                                                 |

## Interfaces

### Migration `0022_thread_sessions.ts`

`agent_sessions` is a cache, not a record: there is no meaningful way to map an old
channel-scoped session onto a thread, and every one of those session ids is unresumable anyway
(the cwd bug). **Drop and recreate; do not migrate rows.** Every affected agent starts its next
thread cold, which is the correct outcome.

```sql
DROP TABLE agent_sessions;
CREATE TABLE agent_sessions (
  agent_id        TEXT NOT NULL REFERENCES agents(id)   ON DELETE CASCADE,
  thread_id       TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  channel_id      TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  runtime         TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  last_message_id TEXT,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (agent_id, thread_id)
);
CREATE INDEX agent_sessions_channel ON agent_sessions(channel_id);
```

### `apps/server/src/agents/sessions.ts`

```ts
get: (agentId: AgentId, threadId: MessageId, runtime: RuntimeKind) =>
  Effect<Option<{ sessionId: string; lastMessageId: MessageId | undefined }>>
set: (
  agentId: AgentId,
  threadId: MessageId,
  channelId: ChannelId,
  runtime: RuntimeKind,
  sessionId: string,
  lastMessageId: MessageId
) => Effect<void>
clear: (agentId: AgentId, threadId: MessageId) => Effect<void>
```

### `apps/server/src/services/messages.ts`

```ts
/** Oldest-first: thread messages strictly after `afterId` (D7 warm path). */
since: (companyId: CompanyId, threadId: MessageId, afterId: MessageId, limit: number) =>
  Effect<ReadonlyArray<Message>>
```

### `packages/runtime/src/repos.ts`

`PrepareReposOptions.taskId: string` → `sessionId: string` (the thread root id).
`taskBranch` → `sessionBranch`. Update `packages/runtime/test/repos.test.ts` call sites.

### `AppConfig`

`maxThreadsPerAgent: number` (default `3`, env `TAUT_MAX_THREADS_PER_AGENT`). Sits beside the
existing `maxConcurrentTasks`, which stays the company-wide ceiling and is unchanged.

## Order of work

1. **Migration `0022`** + `sessions.ts` rewritten to the thread key. Nothing else compiles against
   it yet; land it first so the concurrent Taut session sees `0022` taken.
2. **D2 in `scheduler.createTask`** — delete the DM branch. Verify a DM now produces a thread root
   and a threaded reply before touching anything else.
3. **D3 + D6 in `runTask.ts`** — thread-scoped `cwd`, thread-scoped repo branch. This is the change
   that makes resume work; test it in isolation.
4. **D1 + D7 + D8 wiring in `runTask.ts`** — session lookup by thread, `since`-based prompt on the
   warm path, `clear` by thread on resume failure.
5. **D4 in `scheduler.ts`** — `threadGates`, re-permitted `agentGates`, fixed acquire order.
6. **D10 + D11 in `apps/web`** — DM thread list, thread-panel header.

Steps 1–5 are server-only and independently testable. Step 6 is the only one that touches the
client and can land in a separate pass.

## How to know it works

- **Resume is real.** Two turns in one DM thread. The second run's command line carries
  `--resume <sid>` and the run does **not** hit `resumeFailed`. Today it always does. This is the
  single most important check in this plan — everything else is cosmetic without it.
- **Contexts are isolated.** Tell `@bruno` a secret in thread A. Ask for it in thread B of the same
  DM. He does not have it.
- **Parallelism is real.** Start three threads with one agent. Three processes run at once. Start a
  fourth: it queues behind the cap, it does not fail.
- **One thread is serial.** Two messages fired into the same thread while it is working: the second
  waits, and does not corrupt the working directory.
- **Capabilities survive.** An agent with `rw` on a repository can still push from thread A and
  from thread B, on the same branch when it is the same thread and different branches otherwise.
- **A mention in an existing channel thread** picks up that thread's context and no other.
