/**
 * Turns messages into agent tasks (docs/agent-model.md §9, §11; build-plan "Agent execution").
 *
 *   Bus `message.created` (and `agent.task.done` when an agent's reply closes —
 *     the placeholder itself carries no body yet) ─▶ targets = @mentioned agents ∪ the agents
 *     in a DM ∪ the agent whose message started this thread (a reply answers the question that
 *     opened it) ∪ agents whose parked questions this message answers
 *     ├─ author is an agent? same department only (§9 routing) — inside it they reach each
 *     │  other anywhere they are both members, channel or DM; across it the message gets a
 *     │  note + a handover row for the sending agent's head
 *     ├─ handoff depth > 2 → note · agent-authored turns in the thread ≥ 20 → note (§9 loop controls)
 *     ├─ one task per (agent, trigger message): `Tasks.byTrigger` makes dispatch idempotent
 *     └─ transact: streaming reply message + Task(queued) + `agent.task.started`
 *   then fork `TaskRunner.run` after the preceding thread job, followed by agent → company
 *   permits: a conversation must read the previous contribution before answering; per agent
 *   (`TAUT_MAX_THREADS_PER_AGENT` — its threads are independent copies and run in parallel),
 *   and per company (`TAUT_MAX_CONCURRENT_TASKS`). Explicit predecessor links preserve FIFO
 *   order even when the semaphore implementation wakes several contenders together.
 *   Bus `task.updated{cancelled}` ─▶ interrupt that task's fiber (`Map<TaskId, Fiber>`).
 *   On boot, tasks left `queued`/`running` by a previous process are failed ("server restarted").
 */
import type { Agent, Message } from '@taut/contract/domain'
import { SqlClient } from '@effect/sql'
import { AgentId as AgentIdSchema } from '@taut/contract/ids'
import type { Mention } from '@taut/contract/events'
import type {
  AgentId,
  CompanyId,
  MessageId,
  RoutineId,
  SignalId,
  TaskId,
  UserId
} from '@taut/contract/ids'
import { DateTime, Effect, Fiber, FiberSet, Option, Schema, Stream } from 'effect'
import { AppConfig } from '../config.js'
import { nowIso } from '../db/sql.js'
import { Bus } from '../realtime/bus.js'
import { Agents } from '../services/agents.js'
import { Channels } from '../services/channels.js'
import { Handovers } from '../services/handovers.js'
import { Messages } from '../services/messages.js'
import { EventPublisher } from '../services/publisher.js'
import { type TaskInternal, Tasks } from '../services/tasks.js'
import { TaskRunner } from './runTask.js'

/** Agent-authored messages allowed per thread before a human must step in (§9). */
export const TURN_CAP = 20
/** A child of a child cannot hand off again (§9). */
export const MAX_HANDOFF_DEPTH = 2

export const CROSS_DEPARTMENT_NOTE =
  "cross-department agent messaging is blocked: agents only talk inside their own department. The attempt is queued for the sending agent's department head, who can raise it with the other head."
export const TURN_CAP_NOTE = `turn cap reached (${TURN_CAP} agent messages in this thread) — a human has to continue this thread`
export const DEPTH_NOTE = `handoff depth cap reached (${MAX_HANDOFF_DEPTH}) — this task cannot be delegated further`

export interface DispatchInput {
  readonly message: Message
  readonly mentions: ReadonlyArray<Mention>
  /** The routine whose fire posted `message` (docs/build-plan-routines.md D9); recorded on every task it spawns. */
  readonly routineId?: RoutineId | undefined
  /**
   * The signal whose delivery posted `message` (docs/build-plan-triggers.md D21). Same shape as
   * `routineId` and for the same reason: the thread has to be able to say a scheduled turn was
   * scheduled, instead of letting it read as words the human typed.
   */
  readonly signalId?: SignalId | undefined
}

export class Scheduler extends Effect.Service<Scheduler>()('Scheduler', {
  scoped: Effect.gen(function* () {
    const config = yield* AppConfig
    const bus = yield* Bus
    const publisher = yield* EventPublisher
    const messages = yield* Messages
    const tasks = yield* Tasks
    const agents = yield* Agents
    const channels = yield* Channels
    const handovers = yield* Handovers
    const runner = yield* TaskRunner
    const sql = yield* SqlClient.SqlClient

    const agentGates = new Map<AgentId, Effect.Semaphore>()
    const companyGates = new Map<CompanyId, Effect.Semaphore>()
    /** The last queued job in each conversation, including all participating agents. */
    const threadTails = new Map<
      string,
      { readonly taskId: TaskId; readonly fiber: Fiber.RuntimeFiber<void> }
    >()
    const running = new Map<TaskId, Fiber.RuntimeFiber<void>>()
    const jobs = yield* FiberSet.make<void>()
    /**
     * One dispatch at a time. The bus consumer and the routine runner can both dispatch the
     * same message; `byTrigger` only makes that idempotent if the check and the insert are one step.
     */
    const dispatching = yield* Effect.makeSemaphore(1)

    const gateFor = <K>(map: Map<K, Effect.Semaphore>, key: K, permits: number) =>
      Effect.gen(function* () {
        const existing = map.get(key)
        if (existing !== undefined) return existing
        const created = yield* Effect.makeSemaphore(permits)
        map.set(key, created)
        return created
      })

    /** A short agent-attributed note in a thread; membership is not required (it explains a refusal). */
    const note = (agent: Agent, message: Message, text: string) =>
      messages
        .postAsAgent(agent.companyId, {
          agentId: agent.id,
          channelId: message.channelId,
          threadId: message.threadId ?? message.id,
          body: `_(system)_ ${text}`,
          requireMembership: false
        })
        .pipe(
          Effect.catchAll((e) => Effect.logWarning(`scheduler: cannot post note: ${e.message}`)),
          Effect.asVoid
        )

    const sameDepartment = (a: AgentId, b: AgentId): Effect.Effect<boolean> =>
      Effect.all([agents.departmentsOf(a), agents.departmentsOf(b)]).pipe(
        Effect.map(([da, db]) => {
          const ids = new Set(da.map((d) => d.id))
          return db.some((d) => ids.has(d.id))
        })
      )

    /** Create the streaming reply + the task row (queued) and announce `agent.task.started`. */
    const createTask = (
      agent: Agent,
      message: Message,
      parent: TaskInternal | undefined,
      handoffDepth: number,
      routineId: RoutineId | undefined,
      signalId: SignalId | undefined
    ): Effect.Effect<TaskInternal> =>
      publisher.transact(agent.companyId, (emit) =>
        Effect.gen(function* () {
          const threadRoot = message.threadId ?? message.id
          const reply = yield* messages.createStreaming(emit, {
            companyId: agent.companyId,
            agentId: agent.id,
            channelId: message.channelId,
            // A thread is a session (docs/build-plan-sessions.md D2): every agent reply opens or
            // continues one, DMs included. A top-level DM is therefore a thread root and the
            // agent's reply is its first reply, so the next turn resumes rather than starts over.
            threadId: threadRoot
          })
          const task = yield* tasks.create(agent.companyId, {
            agentId: agent.id,
            channelId: message.channelId,
            threadId: threadRoot,
            messageId: reply.id,
            status: 'queued',
            parentTaskId: parent?.task.id,
            handoffDepth,
            triggerMessageId: message.id,
            triggerUserId: message.authorKind === 'user' ? (message.authorId as UserId) : undefined,
            routineId,
            signalId
          })
          yield* emit({ type: 'agent.task.started', payload: { task, message: reply } })
          return yield* tasks.internal(agent.companyId, task.id).pipe(Effect.orDie)
        })
      )

    const launch = (t: TaskInternal): Effect.Effect<void> =>
      Effect.gen(function* () {
        // Dispatch holds its lock while linking jobs, so no new turn can overtake an
        // older waiter. A semaphore alone wakes contenders without reserving their order.
        const threadKey = `${t.task.companyId}:${t.task.threadId}`
        const previous = threadTails.get(threadKey)
        const waitForTurn =
          previous === undefined ? Effect.void : Fiber.await(previous.fiber).pipe(Effect.asVoid)
        const agentGate = yield* gateFor(agentGates, t.task.agentId, config.maxThreadsPerAgent)
        const companyGate = yield* gateFor(
          companyGates,
          t.task.companyId,
          config.maxConcurrentTasks
        )
        const job = waitForTurn.pipe(
          Effect.zipRight(agentGate.withPermits(1)(companyGate.withPermits(1)(runner.run(t)))),
          // Cancelled while still waiting for a permit: close the placeholder ourselves.
          Effect.onInterrupt(() => runner.finalizeCancelled(t)),
          // A cancelled waiter stays linked until its predecessor ends, otherwise
          // its successor could run beside the still-active predecessor.
          Effect.ensuring(waitForTurn),
          Effect.ensuring(
            Effect.sync(() => {
              running.delete(t.task.id)
              if (threadTails.get(threadKey)?.taskId === t.task.id) threadTails.delete(threadKey)
            })
          )
        )
        const fiber = yield* FiberSet.run(jobs, job)
        running.set(t.task.id, fiber)
        threadTails.set(threadKey, { taskId: t.task.id, fiber })
        if (fiber.unsafePoll() !== null) {
          running.delete(t.task.id)
          if (threadTails.get(threadKey)?.taskId === t.task.id) threadTails.delete(threadKey)
        }
      })

    /** One target agent of one message → zero or one task. */
    const dispatchTo = (
      agentId: AgentId,
      message: Message,
      channelKind: 'channel' | 'dm',
      routineId: RoutineId | undefined,
      signalId: SignalId | undefined
    ): Effect.Effect<Option.Option<TaskInternal>> =>
      Effect.gen(function* () {
        const companyId = message.companyId
        const agent = yield* agents.byId(companyId, agentId).pipe(Effect.option)
        if (Option.isNone(agent)) return Option.none()
        if (agent.value.archivedAt !== undefined) {
          yield* Effect.logInfo(`scheduler: @${agent.value.handle} is archived; ignoring mention`)
          return Option.none()
        }
        if (agent.value.status !== 'active') {
          yield* Effect.logInfo(`scheduler: @${agent.value.handle} is paused; ignoring mention`)
          return Option.none()
        }
        if (message.authorKind === 'agent' && message.authorId === agentId) return Option.none()
        const isMember = yield* channels.isMember(message.channelId, {
          memberKind: 'agent',
          memberId: agentId
        })
        if (!isMember) {
          yield* Effect.logInfo(
            `scheduler: @${agent.value.handle} mentioned in ${message.channelId} but is not a member; ignoring`
          )
          return Option.none()
        }
        const existing = yield* tasks.byTrigger(companyId, agentId, message.id)
        if (Option.isSome(existing)) {
          return Option.some(yield* tasks.internal(companyId, existing.value.id).pipe(Effect.orDie))
        }

        let parent: TaskInternal | undefined
        let handoffDepth = 0
        if (message.authorKind === 'agent') {
          const authorId = message.authorId as AgentId
          const together = yield* sameDepartment(authorId, agentId)
          if (!together) {
            // The author's own head owns the attempt (services/handovers.ts), so they get a
            // queue entry with a "raise it with the other head" button, not just this note.
            yield* handovers.record({
              companyId,
              fromAgentId: authorId,
              toAgentId: agentId,
              channelId: message.channelId,
              threadId: message.threadId,
              text: message.body
            })
            yield* note(agent.value, message, CROSS_DEPARTMENT_NOTE)
            return Option.none()
          }
          // Same department: anywhere they are both members — a channel, a thread, or the DM
          // between the two of them. The department is the only boundary (§9).
          // The parent is the task that actually wrote this message (`Tasks.byMessage`), which
          // stays true after that task ends. Only when the message came from outside a task —
          // there is no such row — do we fall back to whatever the author is running now.
          // Guessing from live tasks alone resets the depth whenever a task finishes quickly,
          // and two agents in a DM then answer each other forever.
          const wrote = yield* tasks.byMessage(companyId, message.id)
          const live = Option.isSome(wrote)
            ? wrote
            : yield* tasks.liveInThread(companyId, authorId, message.threadId ?? message.id)
          parent = Option.getOrUndefined(
            Option.isSome(live) ? live : yield* tasks.liveOf(companyId, authorId)
          )
          // A completed reply continues the same discussion; it is not another level
          // of delegated work. Tool-created handoffs still advance the depth as before.
          const continuesThread =
            Option.isSome(wrote) && wrote.value.task.threadId === (message.threadId ?? message.id)
          handoffDepth = parent === undefined ? 0 : parent.handoffDepth + (continuesThread ? 0 : 1)
          if (handoffDepth > MAX_HANDOFF_DEPTH) {
            yield* note(agent.value, message, DEPTH_NOTE)
            return Option.none()
          }
        }
        // The cap bounds any agent-only exchange, which now includes an agent↔agent DM: with
        // no human in the room nothing else ends a ping-pong.
        if (channelKind === 'channel' || message.authorKind === 'agent') {
          const turns = yield* messages.agentTurnCount(companyId, message.threadId ?? message.id)
          if (turns >= TURN_CAP) {
            yield* note(agent.value, message, TURN_CAP_NOTE)
            return Option.none()
          }
        }
        const created = yield* createTask(
          agent.value,
          message,
          parent,
          handoffDepth,
          routineId,
          signalId
        )
        yield* launch(created)
        yield* Effect.logInfo(
          `scheduler: task ${created.task.id} queued for @${agent.value.handle} (trigger ${message.id})`
        )
        return Option.some(created)
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError(`scheduler: dispatch to ${agentId} failed`, cause).pipe(
            Effect.as(Option.none<TaskInternal>())
          )
        )
      )

    const dispatchAll = (input: DispatchInput): Effect.Effect<ReadonlyArray<TaskInternal>> =>
      Effect.gen(function* () {
        const { message } = input
        // A `streaming` row is the empty placeholder a task opens for its own reply; its body
        // arrives later, delta by delta. Dispatching it woke the thread's opener with a blank
        // trigger ("[dm] @clarifier:") — the agent then asked the question again instead of
        // reading the answer. Agent replies are dispatched on `message.updated` once finalised.
        if (message.status === 'streaming') return []
        const channel = yield* channels.find(message.companyId, message.channelId)
        if (Option.isNone(channel)) return []
        const targets = new Set<AgentId>()
        for (const m of input.mentions) {
          if (m.memberKind === 'agent') targets.add(m.memberId as AgentId)
        }
        // A parked ask can share a human-started thread. Its answer must wake the
        // asker even without an @mention; otherwise yielding the floor loses the reply.
        if (
          message.status === 'sent' &&
          message.body.trim() !== '' &&
          message.threadId !== undefined
        ) {
          const answered = yield* sql`
            UPDATE asks SET status = 'answered', reply_message_id = ${message.id}, answered_at = ${nowIso()}
            WHERE company_id = ${message.companyId} AND channel_id = ${message.channelId}
              AND status = 'pending' AND to_kind = ${message.authorKind} AND to_id = ${message.authorId}
              AND COALESCE(thread_id, message_id) = ${message.threadId}
              AND message_id <> ${message.id}
              AND (SELECT created_at FROM messages WHERE id = asks.message_id) <= ${DateTime.formatIso(message.createdAt)}
            RETURNING agent_id`.pipe(
            Effect.flatMap(
              Schema.decodeUnknown(Schema.Array(Schema.Struct({ agent_id: AgentIdSchema })))
            ),
            Effect.orDie
          )
          for (const ask of answered) targets.add(ask.agent_id)
        }
        // A human in a DM addresses the agent by definition — nobody writes `@` in a two-person
        // conversation. An *agent* in a DM must carry the mention, and `taut_send` always
        // prepends it (`agentApi.withMention`). That asymmetry is load-bearing: every task opens
        // a placeholder reply, which is itself an agent-authored message in this channel, so
        // waking agents on any agent message here makes each task spawn the next one forever.
        if (channel.value.kind === 'dm' && message.authorKind === 'user') {
          for (const id of yield* channels.agentMembers(channel.value.id)) targets.add(id)
        }
        // A reply reaches the agent whose message opened the thread, `@`-mention or not: an
        // agent that asks a question in a channel has to hear the answer, and the answer is
        // rarely addressed by handle. Unlike a mention this target is implicit, so a
        // cross-department replier is dropped in silence rather than filed as an attempt to
        // reach across — they are most likely talking to the human in the thread, not to the
        // agent that started it. The turn cap and the depth cap bound the rest.
        if (message.threadId !== undefined) {
          const root = yield* messages.byId(message.companyId, message.threadId)
          if (Option.isSome(root) && root.value.authorKind === 'agent') {
            const rootAuthor = root.value.authorId as AgentId
            const reachable =
              message.authorKind !== 'agent' ||
              (yield* sameDepartment(message.authorId as AgentId, rootAuthor))
            if (reachable) targets.add(rootAuthor)
          }
        }
        if (message.authorKind === 'agent') targets.delete(message.authorId as AgentId)
        const out: Array<TaskInternal> = []
        for (const agentId of targets) {
          const created = yield* dispatchTo(
            agentId,
            message,
            channel.value.kind,
            input.routineId,
            input.signalId
          )
          if (Option.isSome(created)) out.push(created.value)
        }
        return out
      })

    /** Every task a message spawns (idempotent per (agent, message)). */
    const dispatch = (input: DispatchInput): Effect.Effect<ReadonlyArray<TaskInternal>> =>
      dispatching.withPermits(1)(dispatchAll(input))

    /**
     * Post a message and dispatch it under the same lock (the routine runner). The bus consumer
     * receives the same `message.created` and dispatches it too, but only after this returns —
     * it then finds the task through `byTrigger` instead of racing for the insert, and the task
     * carries `routineId` from the start rather than being stamped after the fact.
     */
    const postAndDispatch = <E, R>(
      post: Effect.Effect<Message, E, R>,
      rest: Omit<DispatchInput, 'message'>
    ): Effect.Effect<ReadonlyArray<TaskInternal>, E, R> =>
      dispatching.withPermits(1)(
        post.pipe(Effect.flatMap((message) => dispatchAll({ message, ...rest })))
      )

    const cancel = (taskId: TaskId): Effect.Effect<boolean> =>
      Effect.suspend(() => {
        const fiber = running.get(taskId)
        if (fiber === undefined) return Effect.succeed(false)
        // Interrupt from a detached fiber so the bus consumer never blocks on the runner's finalizers.
        return Fiber.interruptFork(fiber).pipe(Effect.as(true))
      })

    // ── startup: tasks orphaned by a previous process ─────────────────────────

    const orphans = yield* tasks.live()
    yield* Effect.forEach(
      orphans,
      (task) =>
        publisher
          .transact(task.companyId, (emit) =>
            Effect.gen(function* () {
              const error = 'server restarted while the task was running'
              const updated = yield* tasks
                .update(task.companyId, task.id, { status: 'failed', endedAt: nowIso(), error })
                .pipe(Effect.orDie)
              const message = yield* messages.finalizeAgentMessage(
                emit,
                task.companyId,
                task.messageId,
                { status: 'failed', error }
              )
              yield* emit({ type: 'agent.task.failed', payload: { task: updated, message, error } })
            })
          )
          .pipe(
            Effect.catchAllCause((c) => Effect.logWarning('scheduler: orphan cleanup failed', c))
          ),
      { discard: true }
    )
    if (orphans.length > 0) {
      yield* Effect.logWarning(`scheduler: failed ${orphans.length} task(s) orphaned by a restart`)
    }

    // ── the bus consumer ─────────────────────────────────────────────────────

    const consume = bus.streamAll().pipe(
      Stream.runForEach((m) => {
        if (m._tag !== 'Event') return Effect.void
        switch (m.event.type) {
          case 'message.created':
            // Steering first (docs/build-plan-steering-reactions.md D5): a message that lands
            // while other agents are mid-run is news for them whether or not it starts a task.
            runner.steer(m.event.payload.message)
            return dispatch({
              message: m.event.payload.message,
              mentions: m.event.payload.mentions ?? []
            }).pipe(Effect.asVoid)
          // An agent reply enters the world empty and fills in as it streams, so it is only
          // dispatchable once closed. `byTrigger` keeps this idempotent against later edits.
          case 'message.updated':
            // Same reason it is only dispatchable here: an agent's answer is only worth
            // steering another agent with once it has closed and actually says something.
            runner.steer(m.event.payload.message)
            return Effect.void
          case 'agent.task.done': {
            // Dispatch the completed reply once, with its real mentions. Reaction edits
            // also emit message.updated and must never reopen a completed conversation.
            const { message } = m.event.payload
            if (message.status !== 'sent' || message.body.trim() === '') return Effect.void
            return messages
              .resolveMentions(message.companyId, message.channelId, message.body)
              .pipe(
                Effect.flatMap(({ mentions }) => dispatch({ message, mentions })),
                Effect.asVoid
              )
          }
          case 'task.updated':
            return m.event.payload.task.status === 'cancelled'
              ? cancel(m.event.payload.task.id).pipe(Effect.asVoid)
              : Effect.void
          default:
            return Effect.void
        }
      }),
      Effect.catchAllCause((cause) => Effect.logError('scheduler: bus consumer died', cause))
    )
    yield* Effect.forkScoped(consume)
    yield* Effect.logInfo(
      `scheduler: listening (max ${config.maxConcurrentTasks} concurrent tasks per company)`
    )

    return {
      dispatch,
      postAndDispatch,
      cancel,
      /** Ids of tasks currently queued or running in this process. */
      runningTaskIds: Effect.sync(() => [...running.keys()]),
      /** Fails with `MessageId` semantics only in tests: wait for the task of a trigger. */
      taskOf: (companyId: CompanyId, agentId: AgentId, triggerMessageId: MessageId) =>
        tasks.byTrigger(companyId, agentId, triggerMessageId)
    } as const
  })
}) {}
