import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { TaskStatus } from '../domain/enums.js'
import { Task } from '../domain/task.js'
import { Conflict, Forbidden, NotFound } from '../errors.js'
import { AgentId, ChannelId, TaskId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

export const ListTasksQuery = Schema.Struct({
  ...PageQuery.fields,
  agentId: Schema.optional(AgentId),
  channelId: Schema.optional(ChannelId),
  status: Schema.optional(TaskStatus),
  /**
   * Only runs that have not ended (`done` / `failed` / `cancelled`). The client seeds its
   * shimmer set from this on boot, then keeps it from `agent.task.*` events
   * (docs/build-plan-shimmer.md D9).
   */
  live: Schema.optional(Schema.BooleanFromString)
})

const TaskPath = Schema.Struct({ taskId: TaskId })

export class TasksGroup extends HttpApiGroup.make('tasks')
  .add(HttpApiEndpoint.get('list', '/').setUrlParams(ListTasksQuery).addSuccess(Page(Task)))
  .add(
    HttpApiEndpoint.get('get', '/:taskId')
      .setPath(TaskPath)
      .addSuccess(Task)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /** `Conflict` if the task already ended. */
    HttpApiEndpoint.post('cancel', '/:taskId/cancel')
      .setPath(TaskPath)
      .addSuccess(Task)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
  )
  .middleware(Authentication)
  .prefix('/tasks') {}
