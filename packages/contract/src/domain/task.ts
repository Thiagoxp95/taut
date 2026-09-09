import { Schema } from 'effect'

import {
  AgentId,
  ChannelId,
  CompanyId,
  MessageId,
  RoutineId,
  SignalId,
  SubscriptionId,
  TaskId,
  VaultItemId
} from '../ids.js'
import { ChannelKind, TaskStatus } from './enums.js'

/** One agent run, triggered by an @mention (docs/agent-model.md §7). */
export class Task extends Schema.Class<Task>('Task')({
  id: TaskId,
  companyId: CompanyId,
  agentId: AgentId,
  channelId: ChannelId,
  /** `dm` or `channel` — so a client can pick `/dm/:id` vs `/c/:id` without loading channels. */
  channelKind: Schema.optionalWith(ChannelKind, { default: () => 'channel' as const }),
  /** The thread the agent replies in (root message of the mention). */
  threadId: MessageId,
  /** The `streaming` message the agent's output is appended to. */
  messageId: MessageId,
  subscriptionId: Schema.optional(SubscriptionId),
  /** Set when the triggering mention was posted by a routine (D9); hand-typed mentions have none. */
  routineId: Schema.optional(RoutineId),
  /**
   * Set when a signal woke this run (docs/build-plan-triggers.md D21) — a delayed self-wake or a
   * broadcast another agent emitted. The thread badges the message off this, so a scheduled turn
   * never reads as words the human typed.
   */
  signalId: Schema.optional(SignalId),
  /**
   * The mention or DM that spawned this run (docs/build-plan-shimmer.md D3). The client shimmers
   * that message for as long as the run is live, so you can see which message started a session.
   */
  triggerMessageId: Schema.optional(MessageId),
  status: TaskStatus,
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.optional(Schema.DateTimeUtc),
  error: Schema.optional(Schema.String)
}) {}

export class AuditLog extends Schema.Class<AuditLog>('AuditLog')({
  id: Schema.String,
  companyId: CompanyId,
  agentId: Schema.optional(AgentId),
  taskId: Schema.optional(TaskId),
  vaultItemId: Schema.optional(VaultItemId),
  purpose: Schema.String,
  at: Schema.DateTimeUtc
}) {}
