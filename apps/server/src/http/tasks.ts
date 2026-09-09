import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Tasks } from '../services/tasks.js'
import { ServerApi } from './serverApi.js'

export const TasksLive = HttpApiBuilder.group(ServerApi, 'tasks', (handlers) =>
  handlers
    .handle('list', ({ urlParams }) =>
      Effect.gen(function* () {
        const tasks = yield* Tasks
        return yield* tasks.list(yield* CurrentUser, urlParams)
      })
    )
    .handle('get', ({ path }) =>
      Effect.gen(function* () {
        const tasks = yield* Tasks
        return yield* tasks.get(yield* CurrentUser, path.taskId)
      })
    )
    .handle('cancel', ({ path }) =>
      Effect.gen(function* () {
        const tasks = yield* Tasks
        return yield* tasks.cancel(yield* CurrentUser, path.taskId)
      })
    )
)
