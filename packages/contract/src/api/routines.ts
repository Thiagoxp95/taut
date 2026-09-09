import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Routine, RoutineName, RoutinePrompt } from '../domain/routine.js'
import { Task } from '../domain/task.js'
import { Trigger, TriggerKind } from '../domain/trigger.js'
import { Conflict, Forbidden, NotFound, Validation } from '../errors.js'
import { AgentId, ChannelId, RoutineId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

export const ListRoutinesQuery = Schema.Struct({
  ...PageQuery.fields,
  agentId: Schema.optional(AgentId),
  /** One list holds both kinds (D14); this is the *All · Schedules · Triggers* chip row. */
  kind: Schema.optional(TriggerKind)
})

export const CreateRoutinePayload = Schema.Struct({
  agentId: AgentId,
  name: RoutineName,
  prompt: RoutinePrompt,
  /** Absent = the owner↔agent DM (D7). Must be a channel the agent is a member of, else `Validation`. */
  channelId: Schema.optional(ChannelId),
  /** A clock or a bus event (D1); `Validation` carries whatever `validateTrigger` found. */
  trigger: Trigger,
  enabled: Schema.optionalWith(Schema.Boolean, { default: () => true })
})

/** `null` clears `channelId` back to the DM. `agentId` cannot change: make a new routine. */
export const UpdateRoutinePayload = Schema.partial(
  Schema.Struct({
    name: RoutineName,
    prompt: RoutinePrompt,
    channelId: Schema.NullOr(ChannelId),
    /** Replaced whole, never merged: switching arms changes which filters exist at all. */
    trigger: Trigger,
    enabled: Schema.Boolean
  })
)

const RoutinePath = Schema.Struct({ routineId: RoutineId })

export class RoutinesGroup extends HttpApiGroup.make('routines')
  .add(
    /** Any member who may view the agent; every write below takes `requireManageAgent` (D8). */
    HttpApiEndpoint.get('list', '/')
      .setUrlParams(ListRoutinesQuery)
      .addSuccess(Page(Routine))
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post('create', '/')
      .setPayload(CreateRoutinePayload)
      .addSuccess(Routine, { status: 201 })
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.patch('update', '/:routineId')
      .setPath(RoutinePath)
      .setPayload(UpdateRoutinePayload)
      .addSuccess(Routine)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.del('delete', '/:routineId')
      .setPath(RoutinePath)
      .addError(Forbidden)
      .addError(NotFound)
  )
  .add(
    /** Fire now, ignoring the schedule. `Conflict` while the previous run is still live (D6). */
    HttpApiEndpoint.post('run', '/:routineId/run')
      .setPath(RoutinePath)
      .addSuccess(Task)
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Conflict)
  )
  .middleware(Authentication)
  .prefix('/routines') {}
