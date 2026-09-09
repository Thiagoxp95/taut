/**
 * The signal tick (docs/build-plan-triggers.md Part II, D19). Every 5 seconds — the coarsest
 * interval a human would still call a timer — over `Signals.due(now)`, shaped exactly like the
 * routine tick and for the same reason: one dispatch path, never a second one.
 *
 *   `Signals.due(now)` ─▶ per signal:
 *     ├─ re-read the row: not `pending` any more → nothing (a cancel got there first, D26)
 *     ├─ the target agent is gone, archived or paused → `expired` + a note in the thread
 *     ├─ D24: the thread is at `TURN_CAP` → `cancelled` + the existing `TURN_CAP_NOTE`. An
 *     │  agent must not escape a thread's turn cap by routing through the clock, and cancelling
 *     │  beats dropping — the human sees why the reminder never came.
 *     ├─ publish `signal.emitted` on the bus  ← broadcast listeners (D17) wake from *here*
 *     └─ when `targetAgentId` is set (D18): post `@handle <note>` **as the requester** into
 *        `threadId`/`channelId` through `Messages.postAsUser` + `Scheduler.postAndDispatch`,
 *        stamping `tasks.signal_id` (D21), then `markDelivered`
 *
 * Broadcast delivery is not handled here at all: publishing on the bus **is** the delivery,
 * because `TriggerRunner` already consumes `signal.emitted` through the `SignalTrigger` variant.
 * The two paths meet at the bus and nowhere else.
 *
 * The trick that makes the whole feature cheap is the last line of the targeted case. A thread
 * *is* a session (docs/build-plan-sessions.md D1) and `postAsUser` takes a `threadId`, so posting
 * into the thread the promise was made in resumes the same `agent_sessions` row: the woken agent
 * picks up with everything it knew, and says the thing it promised to say (D20). Nothing about
 * the context travels in the payload.
 *
 * An immediate emit has already announced itself inside `Signals.emit`'s transaction (D19), and
 * is recognised here by `deliverAt <= createdAt` — announcing it again would wake every broadcast
 * listener twice. Every signal is isolated with `Effect.catchAllCause` plus a log line, the way
 * `routineRunner` is; `tick(now)` is exposed so tests drive the clock instead of waiting on it.
 */
import type { Agent, Signal } from '@taut/contract/domain'
import type { ChannelId, UserId } from '@taut/contract/ids'
import { DateTime, Duration, Effect, Option, Schedule } from 'effect'
import { AppConfig } from '../config.js'
import { Agents } from '../services/agents.js'
import { Channels } from '../services/channels.js'
import { Messages } from '../services/messages.js'
import { EventPublisher } from '../services/publisher.js'
import { Signals } from '../services/signals.js'
import { Tasks } from '../services/tasks.js'
import { Users } from '../services/users.js'
import { Scheduler, TURN_CAP, TURN_CAP_NOTE } from './scheduler.js'

export type DeliveryOutcome =
  | { readonly _tag: 'delivered'; readonly signal: Signal }
  /** A broadcast: announced on the bus, and that is the whole of its delivery. */
  | { readonly _tag: 'announced'; readonly signal: Signal }
  | { readonly _tag: 'expired'; readonly signal: Signal; readonly reason: string }
  | { readonly _tag: 'cancelled'; readonly signal: Signal; readonly reason: string }
  /** Settled by someone else between `due` and the re-read. */
  | { readonly _tag: 'stale' }

export class SignalRunner extends Effect.Service<SignalRunner>()('SignalRunner', {
  scoped: Effect.gen(function* () {
    const config = yield* AppConfig
    const agents = yield* Agents
    const channels = yield* Channels
    const messages = yield* Messages
    const publisher = yield* EventPublisher
    const scheduler = yield* Scheduler
    const signals = yield* Signals
    const tasks = yield* Tasks
    const users = yield* Users

    const interval = Duration.seconds(config.signalTickSeconds)

    /** D19: an immediate emit already announced itself; a delayed one is announced here. */
    const announcedOnEmit = (signal: Signal): boolean =>
      DateTime.lessThanOrEqualTo(signal.deliverAt, signal.createdAt)

    const announce = (signal: Signal): Effect.Effect<void> =>
      announcedOnEmit(signal)
        ? Effect.void
        : publisher
            .transact(signal.companyId, (emit) =>
              emit({ type: 'signal.emitted', payload: { signal } })
            )
            .pipe(Effect.asVoid)

    /**
     * A short agent-attributed note in the thread the reminder was promised in. Membership is
     * not required — it explains a refusal, exactly as `Scheduler.note` does.
     */
    const note = (agent: Agent, signal: Signal, text: string): Effect.Effect<void> => {
      if (signal.channelId === undefined) return Effect.void
      return messages
        .postAsAgent(agent.companyId, {
          agentId: agent.id,
          channelId: signal.channelId,
          threadId: signal.threadId,
          body: `_(system)_ ${text}`,
          requireMembership: false
        })
        .pipe(
          Effect.catchAll((e) => Effect.logWarning(`signals: cannot post note: ${e.message}`)),
          Effect.asVoid
        )
    }

    /**
     * D21: the wake is posted as the human who asked for the originating task, so the turn is a
     * normal one in the channel. Falls back to the thread root's author when the emitting task
     * is gone — a reminder set two days ago must still go off after its task row was pruned.
     */
    const requester = (signal: Signal): Effect.Effect<Option.Option<UserId>> =>
      Effect.gen(function* () {
        if (signal.emittedByTaskId !== undefined) {
          const task = yield* tasks
            .internal(signal.companyId, signal.emittedByTaskId)
            .pipe(Effect.option)
          if (Option.isSome(task) && task.value.triggerUserId !== undefined) {
            return Option.some(task.value.triggerUserId)
          }
        }
        if (signal.threadId === undefined) return Option.none<UserId>()
        const root = yield* messages.byId(signal.companyId, signal.threadId)
        return Option.isSome(root) && root.value.authorKind === 'user'
          ? Option.some(root.value.authorId as UserId)
          : Option.none<UserId>()
      })

    /** The channel the wake lands in: the one recorded, else the requester↔agent DM. */
    const targetChannel = (
      signal: Signal,
      agent: Agent,
      userId: UserId
    ): Effect.Effect<Option.Option<ChannelId>> =>
      Effect.gen(function* () {
        if (signal.channelId !== undefined) return Option.some(signal.channelId)
        const role = yield* users.roleIn(signal.companyId, userId)
        if (Option.isNone(role)) return Option.none<ChannelId>()
        const dm = yield* channels
          .dm(
            { userId, activeCompanyId: signal.companyId, role: role.value },
            {
              memberKind: 'agent',
              memberId: agent.id
            }
          )
          .pipe(Effect.option)
        return Option.map(dm, (channel) => channel.id)
      })

    const expire = (
      signal: Signal,
      reason: string,
      agent: Option.Option<Agent>
    ): Effect.Effect<DeliveryOutcome> =>
      signals
        .markExpired(signal.companyId, signal.id)
        .pipe(
          Effect.zipRight(
            Option.isSome(agent)
              ? note(
                  agent.value,
                  signal,
                  `the reminder "${signal.note}" could not be delivered: ${reason}`
                )
              : Effect.void
          ),
          Effect.zipLeft(Effect.logInfo(`signals: ${signal.id} expired — ${reason}`)),
          Effect.as({ _tag: 'expired', signal, reason })
        )

    /** One due signal, from the re-read to the settled row. */
    const deliverOne = (due: Signal): Effect.Effect<DeliveryOutcome> =>
      Effect.gen(function* () {
        const fresh = yield* signals.fresh(due.id)
        if (Option.isNone(fresh) || fresh.value.status !== 'pending') {
          return { _tag: 'stale' } as const
        }
        const signal = fresh.value

        // A broadcast has no target to post to: the bus event is the whole delivery (D18).
        if (signal.targetAgentId === undefined) {
          yield* announce(signal)
          // Nothing to link it to: a broadcast produces no task of its own.
          yield* signals.markDelivered(signal.companyId, signal.id)
          return { _tag: 'announced', signal } as const
        }

        const agent = yield* agents.byId(signal.companyId, signal.targetAgentId).pipe(Effect.option)
        if (Option.isNone(agent)) {
          return yield* expire(signal, 'the agent no longer exists', Option.none())
        }
        if (agent.value.archivedAt !== undefined) {
          return yield* expire(signal, `@${agent.value.handle} is archived`, Option.none())
        }
        if (agent.value.status !== 'active') {
          return yield* expire(signal, `@${agent.value.handle} is paused`, agent)
        }

        // D24: the wake counts toward the thread's turn cap like every other turn, and a
        // signal that would exceed it is cancelled with the note the scheduler already uses.
        if (signal.threadId !== undefined) {
          const turns = yield* messages.agentTurnCount(signal.companyId, signal.threadId)
          if (turns >= TURN_CAP) {
            yield* signals.markCancelled(signal.companyId, signal.id)
            yield* note(agent.value, signal, TURN_CAP_NOTE)
            yield* Effect.logInfo(`signals: ${signal.id} cancelled — turn cap`)
            return { _tag: 'cancelled', signal, reason: 'turn cap' } as const
          }
        }

        // Broadcast listeners wake from the bus, targeted ones from the post below. Both
        // happen for a targeted signal: a `SignalTrigger` may legitimately watch it too.
        yield* announce(signal)

        const who = yield* requester(signal)
        if (Option.isNone(who)) {
          return yield* expire(signal, 'nobody is left to post it as', agent)
        }
        const channelId = yield* targetChannel(signal, agent.value, who.value)
        if (Option.isNone(channelId)) {
          return yield* expire(signal, 'the target channel is gone', agent)
        }

        const post = messages.postAsUser(signal.companyId, {
          userId: who.value,
          channelId: channelId.value,
          threadId: signal.threadId,
          body: `@${agent.value.handle} ${signal.note}`
        })
        const created = yield* scheduler
          .postAndDispatch(post, {
            mentions: [
              { memberKind: 'agent', memberId: agent.value.id, handle: agent.value.handle }
            ],
            signalId: signal.id
          })
          .pipe(Effect.option)
        const task = Option.isNone(created)
          ? undefined
          : created.value.find((t) => t.task.agentId === agent.value.id)?.task
        if (task === undefined) {
          // The mention landed but the scheduler refused it (membership, a cap …) and has
          // already posted the reason in the thread. D26: a failed dispatch cancels the row.
          return yield* expire(signal, 'the scheduler did not start a task', agent)
        }
        yield* signals.markDelivered(signal.companyId, signal.id, task.id)
        yield* Effect.logInfo(
          `signals: ${signal.id} woke @${agent.value.handle} as task ${task.id}`
        )
        return { _tag: 'delivered', signal } as const
      }).pipe(
        Effect.catchAllCause((cause) =>
          Effect.logError(`signals: ${due.id} crashed`, cause).pipe(
            Effect.zipRight(
              signals
                .markExpired(due.companyId, due.id)
                .pipe(Effect.catchAllCause(() => Effect.void))
            ),
            Effect.as<DeliveryOutcome>({
              _tag: 'expired',
              signal: due,
              reason: 'internal error (see the log)'
            })
          )
        )
      )

    /** Everything due at `now`, in `deliverAt` order. Sequential: one thread stays ordered. */
    const tick = (now: DateTime.Utc): Effect.Effect<ReadonlyArray<DeliveryOutcome>> =>
      Effect.gen(function* () {
        const due = yield* signals.due(now)
        const out: Array<DeliveryOutcome> = []
        for (const signal of due) out.push(yield* deliverOne(signal))
        return out
      })

    // ── the daemon ───────────────────────────────────────────────────────────

    const loop = DateTime.now.pipe(
      Effect.flatMap(tick),
      Effect.catchAllCause((cause) => Effect.logError('signals: tick failed', cause)),
      Effect.repeat(Schedule.fixed(interval))
    )
    yield* Effect.forkScoped(loop)
    yield* Effect.logInfo(`signals: ticking every ${Duration.format(interval)}`)

    return { tick } as const
  })
}) {}
