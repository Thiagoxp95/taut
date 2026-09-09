/**
 * The context block appended to an event-fired routine's prompt (docs/build-plan-triggers.md D5).
 *
 * `call.ended` carries `{ callId, channelId, endedAt }` and nothing else. Without this block the
 * agent is woken with no idea *what* ended and has to guess which tool to call — which is how a
 * "tell me what happened in the huddle" mandate turns into three speculative lookups. So the
 * server renders the facts once, in prose, and the agent starts from them.
 *
 * One branch per event kind, and every branch is `Effect.catchAll`'d down to a one-liner built
 * from the payload alone: a channel that was deleted between the event and the render, a call row
 * that vanished, an agent that was archived — none of those may cost the fire. A degraded prompt
 * is a worse prompt; a failed render would be no run at all.
 *
 * Everything here is presentation. No gate lives in this file: `matchesEvent` (contract), D6 and
 * D7 are all `triggerRunner.ts`'s, and this is only called once they have all said yes.
 */
import type { Call, Message, Signal } from '@taut/contract/domain'
import type { Event } from '@taut/contract/events'
import type { AgentId, CallId, ChannelId, CompanyId, MemberId, UserId } from '@taut/contract/ids'
import { DateTime, Effect, Option } from 'effect'
import { userHandle } from '../services/access.js'
import { Agents } from '../services/agents.js'
import { Calls } from '../services/calls.js'
import { Channels } from '../services/channels.js'
import { Users } from '../services/users.js'

/**
 * D12: "Run now" on an event trigger must not need a real huddle, and the agent must not be
 * told a huddle happened when none did. Exported because `routineRunner.ts` renders it without
 * an event to render from.
 */
export const MANUAL_CONTEXT = '\n\nContext — this was a manual test run; no event fired it.'

/** Every block opens with a blank line, so the prompt above it reads as its own paragraph. */
const block = (lines: ReadonlyArray<string>): string => `\n\n${lines.join('\n')}`

/** "3:42 PM" in UTC — the server has no viewer whose zone it could use. */
const clock = (at: DateTime.Utc): string =>
  DateTime.format(at, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })

const minutesBetween = (from: DateTime.Utc, to: DateTime.Utc): number =>
  Math.max(0, Math.round((DateTime.toEpochMillis(to) - DateTime.toEpochMillis(from)) / 60_000))

/** "a", "a and b", "a, b and c" — the joiner `describeTrigger` uses, kept identical on purpose. */
const list = (items: ReadonlyArray<string>): string =>
  items.length <= 1
    ? items.join('')
    : `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`

export class TriggerContext extends Effect.Service<TriggerContext>()('TriggerContext', {
  effect: Effect.gen(function* () {
    const agents = yield* Agents
    const calls = yield* Calls
    const channels = yield* Channels
    const users = yield* Users

    /** `#design`, or the raw id when the channel is gone — never a failure. */
    const channelName = (companyId: CompanyId, channelId: ChannelId): Effect.Effect<string> =>
      channels.find(companyId, channelId).pipe(
        Effect.map(
          Option.match({
            onNone: () => String(channelId),
            onSome: (channel) => (channel.kind === 'dm' ? 'the DM' : `#${channel.name}`)
          })
        )
      )

    const agentHandle = (companyId: CompanyId, agentId: AgentId): Effect.Effect<string> =>
      agents.byId(companyId, agentId).pipe(
        Effect.map((agent) => `@${agent.handle}`),
        Effect.catchAll(() => Effect.succeed(String(agentId)))
      )

    /** A member of either kind as the handle a human would type. */
    const memberHandle = (
      companyId: CompanyId,
      kind: 'user' | 'agent',
      id: MemberId
    ): Effect.Effect<string> =>
      kind === 'agent'
        ? agentHandle(companyId, id as AgentId)
        : users.byId(id as UserId).pipe(
            Effect.map(
              Option.match({
                onNone: () => String(id),
                onSome: (user) => `@${userHandle(user.email)}`
              })
            )
          )

    const participants = (call: Call): Effect.Effect<string> =>
      Effect.forEach(call.participants, (p) => memberHandle(call.companyId, p.kind, p.id)).pipe(
        Effect.map((handles) => (handles.length === 0 ? 'nobody on the record' : list(handles)))
      )

    // ── one branch per event kind (D4, D17) ──────────────────────────────────

    const callEnded = (
      companyId: CompanyId,
      channelId: ChannelId,
      callId: CallId,
      endedAt: DateTime.Utc
    ): Effect.Effect<string> =>
      Effect.gen(function* () {
        const where = yield* channelName(companyId, channelId)
        const found = yield* calls.find(companyId, callId)
        if (Option.isNone(found)) {
          return block([`Context — the huddle in ${where} just ended.`])
        }
        const call = found.value
        const who = yield* participants(call)
        const minutes = minutesBetween(call.startedAt, endedAt)
        const thread =
          call.messageId === undefined
            ? 'It has no thread of its own.'
            : `The huddle chat is the thread on message ${call.messageId}.`
        return block([
          `Context — the huddle in ${where} just ended.`,
          `Started ${clock(call.startedAt)}, ended ${clock(endedAt)} (${minutes} minutes). Present: ${who}.`,
          thread
        ])
      }).pipe(
        Effect.catchAllCause(() =>
          Effect.succeed(block([`Context — a huddle just ended (call ${callId}).`]))
        )
      )

    const callStarted = (call: Call): Effect.Effect<string> =>
      Effect.gen(function* () {
        const where = yield* channelName(call.companyId, call.channelId)
        const who = yield* participants(call)
        return block([
          `Context — a huddle just started in ${where} at ${clock(call.startedAt)}.`,
          `In the room: ${who}.`
        ])
      }).pipe(
        Effect.catchAllCause(() => Effect.succeed(block(['Context — a huddle just started.'])))
      )

    const messageCreated = (message: Message): Effect.Effect<string> =>
      Effect.gen(function* () {
        const where = yield* channelName(message.companyId, message.channelId)
        const who = yield* memberHandle(message.companyId, message.authorKind, message.authorId)
        const thread =
          message.threadId === undefined
            ? `It is a top-level post (message ${message.id}).`
            : `It is a reply in the thread on message ${message.threadId}.`
        return block([
          `Context — ${who} posted in ${where} at ${clock(message.createdAt)}.`,
          thread,
          'What they wrote:',
          message.body
        ])
      }).pipe(
        Effect.catchAllCause(() =>
          Effect.succeed(block([`Context — a message was posted (${message.id}).`]))
        )
      )

    const taskFailed = (
      companyId: CompanyId,
      agentId: AgentId,
      taskId: string,
      error: string
    ): Effect.Effect<string> =>
      agentHandle(companyId, agentId).pipe(
        Effect.map((who) =>
          block([`Context — ${who}'s run ${taskId} failed.`, `The error was: ${error}`])
        ),
        Effect.catchAllCause(() =>
          Effect.succeed(block([`Context — run ${taskId} failed: ${error}`]))
        )
      )

    /**
     * The issue payload already carries everything a human would quote — identifier, title,
     * state and the deep link — so this branch reads nothing and can only fail by arithmetic.
     */
    const issueCreated = (event: Extract<Event, { type: 'project.issue.created' }>): string => {
      const issue = event.payload.issue
      const assignee = issue.assignee === undefined ? '' : ` Assigned to ${issue.assignee.name}.`
      return block([
        `Context — issue ${issue.identifier} was just filed: ${issue.title}`,
        `It is in "${issue.state.name}" in project ${event.payload.projectId}.${assignee}`,
        issue.url
      ])
    }

    /**
     * D22: the payload is a hint, never the context — the thread the wake lands in is the
     * context (D20). It is rendered as fenced JSON only when there is something in it, so a
     * plain self-reminder does not carry `{}` into the prompt for no reason.
     */
    const signalEmitted = (signal: Signal): Effect.Effect<string> =>
      Effect.gen(function* () {
        const who = yield* memberHandle(signal.companyId, signal.emittedByKind, signal.emittedById)
        const lines = [
          `Context — the signal \`${signal.name}\` was emitted by ${who}.`,
          `The note on it: ${signal.note}`
        ]
        const keys = Object.keys(signal.payload)
        if (keys.length > 0) {
          lines.push('It carried this payload:', '```json', JSON.stringify(signal.payload), '```')
        }
        return block(lines)
      }).pipe(
        Effect.catchAllCause(() =>
          Effect.succeed(block([`Context — the signal \`${signal.name}\` was emitted.`]))
        )
      )

    /**
     * The block for whatever landed on the bus. Total: an event no trigger can listen for
     * renders nothing, which is exactly what the caller would append for a clock fire.
     */
    const render = (companyId: CompanyId, event: Event): Effect.Effect<string> => {
      switch (event.type) {
        case 'call.ended':
          return callEnded(
            companyId,
            event.payload.channelId,
            event.payload.callId,
            event.payload.endedAt
          )
        case 'call.started':
          return callStarted(event.payload.call)
        case 'message.created':
          return messageCreated(event.payload.message)
        case 'agent.task.failed':
          return taskFailed(
            companyId,
            event.payload.task.agentId,
            event.payload.task.id,
            event.payload.error
          )
        case 'project.issue.created':
          return Effect.succeed(issueCreated(event))
        case 'signal.emitted':
          return signalEmitted(event.payload.signal)
        default:
          return Effect.succeed('')
      }
    }

    return { render } as const
  })
}) {}
