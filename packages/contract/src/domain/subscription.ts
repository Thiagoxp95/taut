import { Schema } from 'effect'

import { CompanyId, SubscriptionId, VaultItemId } from '../ids.js'
import { RuntimeKind, SubscriptionStatus } from './enums.js'

/**
 * One quota window a provider reports for a seat.
 *
 * `percentUsed` is what the provider says is *consumed* (0-100), matching
 * Anthropic's `utilization` and OpenAI's `used_percent`. `resetsAt` is the
 * provider's own rollover time — the whole point of the probe, because a
 * rolling window starts at its first request, not at the moment a limit
 * is hit (docs/build-plan-usage-limits.md).
 */
export const LimitWindowKind = Schema.Literal('session', 'weekly', 'weekly-model', 'spend')
export type LimitWindowKind = typeof LimitWindowKind.Type

export class LimitWindow extends Schema.Class<LimitWindow>('LimitWindow')({
  kind: LimitWindowKind,
  /** Operator-facing name: "Session", "Weekly", "Opus", "Fable 5". */
  label: Schema.String,
  /** 0-100 consumed. Can exceed 100 when a provider reports overage. */
  percentUsed: Schema.Number,
  resetsAt: Schema.optional(Schema.DateTimeUtc),
  /** Window length in seconds, when the provider states it. Pace math only. */
  windowSeconds: Schema.optional(Schema.Number)
}) {}

/** At or above this, a window is treated as spent and parks the seat. */
export const EXHAUSTED_PCT = 95

/** A runtime seat in the company pool (docs/agent-model.md §3). */
export class Subscription extends Schema.Class<Subscription>('Subscription')({
  id: SubscriptionId,
  companyId: CompanyId,
  runtime: RuntimeKind,
  label: Schema.String,
  credentialId: VaultItemId,
  /**
   * Optional second credential, read by the usage probe and never injected into
   * a runtime. Absent = probe the seat's own `credentialId`
   * (docs/build-plan-usage-limits.md).
   */
  usageCredentialId: Schema.optional(VaultItemId),
  defaultModel: Schema.optional(Schema.String),
  status: SubscriptionStatus,
  /** Default 1; 0 = drain (no new tasks). */
  weight: Schema.NonNegativeInt,
  cooldownUntil: Schema.optional(Schema.DateTimeUtc),
  /** Last usage snapshot from the provider; empty when never probed. */
  limits: Schema.Array(LimitWindow),
  limitsCheckedAt: Schema.optional(Schema.DateTimeUtc),
  /** Why the last probe could not answer — a scope or network problem, not a quota. */
  limitsError: Schema.optional(Schema.String),
  /** Reset at company-local midnight. */
  tasksToday: Schema.NonNegativeInt,
  lastCheckedAt: Schema.optional(Schema.DateTimeUtc)
}) {}
