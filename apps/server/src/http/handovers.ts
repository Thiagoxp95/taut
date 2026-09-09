import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Handovers } from '../services/handovers.js'
import { ServerApi } from './serverApi.js'

export const HandoversLive = HttpApiBuilder.group(ServerApi, 'handovers', (handlers) =>
  handlers
    .handle('list', ({ urlParams }) =>
      Effect.gen(function* () {
        const handovers = yield* Handovers
        return yield* handovers.list(yield* CurrentUser, urlParams)
      })
    )
    .handle('raise', ({ path, payload }) =>
      Effect.gen(function* () {
        const handovers = yield* Handovers
        return yield* handovers.raise(yield* CurrentUser, path.handoverId, payload)
      })
    )
    .handle('dismiss', ({ path }) =>
      Effect.gen(function* () {
        const handovers = yield* Handovers
        return yield* handovers.dismiss(yield* CurrentUser, path.handoverId)
      })
    )
)
