import { Schema } from 'effect'

import {
  AgentId,
  ChannelId,
  CompanyId,
  DepartmentId,
  HandoverId,
  MessageId,
  TaskId,
  UserId
} from '../ids.js'
import { HandoverStatus } from './enums.js'

/**
 * The trace an agent leaves when it hits the department boundary (docs/agent-model.md §9).
 *
 * Agents cannot reach another department at all — not even through a gate — so a refused
 * `send` / `ask` / `handoff` is recorded here instead of vanishing into a system note. It is
 * addressed to **the sending agent's own head**, whose one move is to raise it with the other
 * department's head (`handovers.raise`) or drop it (`handovers.dismiss`). Nothing about a
 * handover grants an agent anything: resolving one only sends a DM between two humans.
 */
export class Handover extends Schema.Class<Handover>('Handover')({
  id: HandoverId,
  companyId: CompanyId,
  /** The agent that tried to cross. */
  fromAgentId: AgentId,
  /** Its primary department — the one whose head owns this handover. */
  fromDepartmentId: DepartmentId,
  /** Unset while the department has no head; then only admins see the handover. */
  fromHeadUserId: Schema.optional(UserId),
  /** The agent it tried to reach. */
  toAgentId: AgentId,
  toDepartmentId: DepartmentId,
  toHeadUserId: Schema.optional(UserId),
  /** Where the attempt happened, so the head can open the thread it came from. */
  channelId: ChannelId,
  threadId: Schema.optional(MessageId),
  taskId: Schema.optional(TaskId),
  /** What the agent tried to say — the head's raw material when raising it. */
  text: Schema.String,
  status: HandoverStatus,
  /** The DM the head sent when raising it. */
  raisedMessageId: Schema.optional(MessageId),
  createdAt: Schema.DateTimeUtc,
  resolvedAt: Schema.optional(Schema.DateTimeUtc),
  resolvedByUserId: Schema.optional(UserId)
}) {}
