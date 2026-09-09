import { Schema } from 'effect'

import { AgentId, ChannelId, CompanyId, RoutineId, TaskId, UserId } from '../ids.js'
import { RoutineRunStatus } from './enums.js'
import { Trigger } from './trigger.js'

/** Short label, shown in the list. */
export const RoutineName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(80),
  Schema.annotations({ identifier: 'RoutineName' })
)
export type RoutineName = typeof RoutineName.Type

/** What the agent is asked, without the `@handle` prefix — the server adds that when it fires. */
export const RoutinePrompt = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(4000),
  Schema.annotations({ identifier: 'RoutinePrompt' })
)
export type RoutinePrompt = typeof RoutinePrompt.Type

/**
 * A named prompt, owned by one agent, that fires on a condition (docs/build-plan-routines.md,
 * generalised by docs/build-plan-triggers.md D1). Firing posts `@handle <prompt>` as
 * `ownerUserId`; the existing `Scheduler` does the rest, whether a clock or the bus set it off.
 */
export class Routine extends Schema.Class<Routine>('Routine')({
  id: RoutineId,
  companyId: CompanyId,
  agentId: AgentId,
  /** Who it posts as, and who owns it. */
  ownerUserId: UserId,
  name: RoutineName,
  prompt: RoutinePrompt,
  /** Where the run lands. Absent = the owner↔agent DM, opened on first fire. */
  channelId: Schema.optional(ChannelId),
  /** What makes it fire: a clock, or a bus event (D1). Replaces `schedule` + `timezone`. */
  trigger: Trigger,
  enabled: Schema.Boolean,
  /**
   * Computed server-side on every write and every fire. Absent = never fires again — and always
   * absent for an event trigger, which has no next run, so the tick never sees one (D9).
   */
  nextRunAt: Schema.optional(Schema.DateTimeUtc),
  lastRunAt: Schema.optional(Schema.DateTimeUtc),
  lastTaskId: Schema.optional(TaskId),
  lastStatus: Schema.optional(RoutineRunStatus),
  createdAt: Schema.DateTimeUtc,
  updatedAt: Schema.DateTimeUtc
}) {}
