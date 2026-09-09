/**
 * A named event an agent emits, optionally in the future, that wakes an agent — usually itself,
 * in the same thread, with the same context (docs/build-plan-triggers.md Part II).
 *
 * A signal is a row, not a held-open turn: the emitting turn ends, and the row is delivered later
 * by its own tick (D19). Delivery posts into `threadId`, so the woken agent resumes the session
 * the thread already is (D20) — the payload is a hint, never the context (D22).
 */
import { Schema } from 'effect'

import { AgentId, ChannelId, CompanyId, MemberId, MessageId, SignalId, TaskId } from '../ids.js'
import { MemberKind } from './enums.js'

/**
 * Company-scoped, never namespaced by agent (D28): a broadcast signal is worthless if only its
 * author can name it, so a collision between two agents is the coordination mechanism.
 */
export const SignalName = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
    identifier: 'SignalName',
    message: () => 'expected lower-case letters, digits, ".", "_" or "-" (max 64)'
  }),
  Schema.brand('SignalName')
)
export type SignalName = typeof SignalName.Type

/** Free-form JSON the emitter attaches; a hint for the woken agent, not its context (D22). */
export const SignalPayload = Schema.Record({ key: Schema.String, value: Schema.Unknown })
export type SignalPayload = typeof SignalPayload.Type

/** `expired` is delivery giving up (agent gone, channel archived); `cancelled` is someone asking. */
export const SignalStatus = Schema.Literal('pending', 'delivered', 'cancelled', 'expired')
export type SignalStatus = typeof SignalStatus.Type

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
  /** What the woken agent is told to do — the body of the wake message, after `@handle`. */
  note: Schema.String.pipe(Schema.minLength(1), Schema.maxLength(2000)),
  /** Now, or the future. Immediate emits set this to the emit time (D19). */
  deliverAt: Schema.DateTimeUtc,
  /** Hops inside the D23 chain window; `MAX_SIGNAL_DEPTH` is the 10 in this bound. */
  depth: Schema.Int.pipe(Schema.between(0, 10)),
  status: SignalStatus,
  /** The run the wake produced, set with `status: 'delivered'`; mirrors `Routine.lastTaskId`. */
  deliveredTaskId: Schema.optional(TaskId),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}
