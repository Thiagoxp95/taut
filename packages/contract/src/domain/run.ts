import { Schema } from 'effect'

import { SubscriptionId } from '../ids.js'
import { ReasoningEffort, RuntimeKind } from './enums.js'

/**
 * What one message asks its run to do differently
 * (docs/build-plan-run-overrides.md D1, D4).
 *
 * Every field is optional and independent. An absent field means "whatever the
 * agent is configured with"; a present one wins over it for this run only. The
 * override is stored on the message that carried it, so a thread read a year
 * later still says which runtime and model each turn actually asked for.
 *
 * `permissionMode` is deliberately absent: an override may pick a different
 * brain, never a wider hand (D9).
 */
export class RunOverride extends Schema.Class<RunOverride>('RunOverride')({
  /** Overrides `Agent.runtimeKind`. Starts a fresh runtime session (D5). */
  runtimeKind: Schema.optional(RuntimeKind),
  /** Overrides `Agent.pinnedSubscriptionId`; must belong to the effective runtime. */
  subscriptionId: Schema.optional(SubscriptionId),
  /** Overrides `Agent.model ?? Subscription.defaultModel`. */
  model: Schema.optional(Schema.String),
  /** Override-only; there is no agent-level counterpart today (D4). */
  reasoningEffort: Schema.optional(ReasoningEffort),
  /** Codex speed preference; absent inherits the seat, false requests standard processing. */
  fastMode: Schema.optional(Schema.Boolean)
}) {}

/** One row of the model dropdown. A struct, not a class: it is data the server builds by the hundred. */
export const ModelOption = Schema.Struct({
  /** Passed to the runtime verbatim as `--model`. */
  id: Schema.String,
  /** What the dropdown shows; the provider's display name when it has one. */
  label: Schema.String,
  /** Section heading, e.g. the provider for an OpenCode `provider/model` id. */
  group: Schema.optional(Schema.String)
})
export type ModelOption = typeof ModelOption.Type

/**
 * The models a runtime can actually reach, read from the provider through the
 * seat's own credential (D6).
 *
 * `source` is the honest part. `live` came from the provider just now (or from
 * the 30-minute cache); `fallback` is the short built-in list, and `note` says
 * in one line why the provider could not answer.
 */
export class ModelCatalog extends Schema.Class<ModelCatalog>('ModelCatalog')({
  runtime: RuntimeKind,
  source: Schema.Literal('live', 'fallback'),
  models: Schema.Array(ModelOption),
  /** Efforts this runtime honours; empty hides the reasoning row (D7). */
  reasoningEfforts: Schema.Array(ReasoningEffort),
  /** Why `source` is `fallback`. Absent when it is `live`. */
  note: Schema.optional(Schema.String),
  fetchedAt: Schema.DateTimeUtc
}) {}
