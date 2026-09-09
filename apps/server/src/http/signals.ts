import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Signals } from '../services/signals.js'
import { ServerApi } from './serverApi.js'

/**
 * The human half of signals (docs/build-plan-triggers.md D26): see what an agent has armed, and
 * kill a reminder you no longer want. Emitting is deliberately not exposed here — agents emit
 * through their tool surface, which is where the D23–D25 budgets live.
 */
export const SignalsLive = HttpApiBuilder.group(ServerApi, 'signals', (handlers) =>
  handlers
    .handle('list', ({ urlParams }) =>
      Effect.gen(function* () {
        const signals = yield* Signals
        return yield* signals.list(yield* CurrentUser, urlParams)
      })
    )
    .handle('delete', ({ path }) =>
      Effect.gen(function* () {
        const signals = yield* Signals
        yield* signals.cancel(yield* CurrentUser, path.signalId)
      })
    )
)
