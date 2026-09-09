import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { RoutineRunner } from '../agents/routineRunner.js'
import { Routines } from '../services/routines.js'
import { ServerApi } from './serverApi.js'

export const RoutinesLive = HttpApiBuilder.group(ServerApi, 'routines', (handlers) =>
  handlers
    .handle('list', ({ urlParams }) =>
      Effect.gen(function* () {
        const routines = yield* Routines
        return yield* routines.list(yield* CurrentUser, urlParams)
      })
    )
    .handle('create', ({ payload }) =>
      Effect.gen(function* () {
        const routines = yield* Routines
        return yield* routines.create(yield* CurrentUser, payload)
      })
    )
    .handle('update', ({ path, payload }) =>
      Effect.gen(function* () {
        const routines = yield* Routines
        return yield* routines.update(yield* CurrentUser, path.routineId, payload)
      })
    )
    .handle('delete', ({ path }) =>
      Effect.gen(function* () {
        const routines = yield* Routines
        yield* routines.remove(yield* CurrentUser, path.routineId)
      })
    )
    // Firing needs the `Scheduler`, so "run now" lives on the runner, not the service.
    .handle('run', ({ path }) =>
      Effect.gen(function* () {
        const runner = yield* RoutineRunner
        return yield* runner.runNow(yield* CurrentUser, path.routineId)
      })
    )
)
