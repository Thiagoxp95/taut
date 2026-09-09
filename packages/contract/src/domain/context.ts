import { Schema } from 'effect'

import { AgentId, MessageId } from '../ids.js'
import { RuntimeKind } from './enums.js'

/**
 * How full one agent's context window is in one thread
 * (docs/build-plan-context-meter.md D1, D7).
 *
 * A thread is a session (docs/build-plan-sessions.md D1), so a thread is a
 * context window. Two agents in one thread hold two windows and produce two of
 * these; the same agent in two threads likewise. There is no such thing as an
 * agent's context outside a thread, which is why the ring is drawn only where
 * an avatar stands in one (D11).
 *
 * `usedTokens` and `totalTokens` are different quantities and the gap between
 * them is the point. The first is occupancy: what the window holds right now,
 * taken from the last sample of the run and never summed (D2). The second is
 * the bill: every token the thread has ever pushed through the provider,
 * cached re-reads included. On a long cached conversation the second is many
 * times the first, and a meter that showed it would read as full almost at once.
 */
export class ThreadContext extends Schema.Class<ThreadContext>('ThreadContext')({
  agentId: AgentId,
  threadId: MessageId,
  runtime: RuntimeKind,
  /** Tokens resident in the window. */
  usedTokens: Schema.Number,
  /**
   * The window itself. Absent when neither the runtime nor the model catalogue
   * could say (D6) — the ring is then not drawn and the meter shows raw tokens,
   * because a percentage of a guess is worse than no percentage.
   */
  maxTokens: Schema.optional(Schema.Number),
  /** Cumulative billed tokens for this thread. The meter's second line only. */
  totalTokens: Schema.optional(Schema.Number),
  /** The model the last sample came from; it can change per message (run overrides D1). */
  model: Schema.optional(Schema.String),
  /** Whether this runtime compacts itself, which is why a sample may shrink (D9). */
  compactsAutomatically: Schema.Boolean,
  /** Tokens at which it will do so, when the runtime states a number. */
  autoCompactThreshold: Schema.optional(Schema.Number),
  /**
   * When occupancy last fell sharply, which is what a compaction looks like from
   * outside (D9). Without it a user who watches the ring climb to 90% and then
   * drop to 30% concludes the meter is broken, and stops trusting the one number
   * it exists to give them.
   */
  compactedAt: Schema.optional(Schema.String),
  updatedAt: Schema.String
}) {}
