import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Subscriptions } from '../services/subscriptions.js'
import { ServerApi } from './serverApi.js'

export const SubscriptionsLive = HttpApiBuilder.group(ServerApi, 'subscriptions', (handlers) =>
  handlers
    .handle('list', () =>
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions
        return { items: yield* subscriptions.list(yield* CurrentUser) }
      })
    )
    .handle('add', ({ payload }) =>
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions
        return yield* subscriptions.add(yield* CurrentUser, payload)
      })
    )
    .handle('remove', ({ path }) =>
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions
        yield* subscriptions.remove(yield* CurrentUser, path.subscriptionId)
      })
    )
    .handle('setWeight', ({ path, payload }) =>
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions
        return yield* subscriptions.setWeight(
          yield* CurrentUser,
          path.subscriptionId,
          payload.weight
        )
      })
    )
    .handle('setUsageCredential', ({ path, payload }) =>
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions
        return yield* subscriptions.setUsageCredential(
          yield* CurrentUser,
          path.subscriptionId,
          payload.usageCredentialId
        )
      })
    )
    .handle('models', ({ urlParams }) =>
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions
        return yield* subscriptions.models(yield* CurrentUser, urlParams)
      })
    )
    .handle('clearCooldown', ({ path }) =>
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions
        return yield* subscriptions.clearCooldown(yield* CurrentUser, path.subscriptionId)
      })
    )
    .handle('check', ({ path }) =>
      Effect.gen(function* () {
        const subscriptions = yield* Subscriptions
        return yield* subscriptions.check(yield* CurrentUser, path.subscriptionId)
      })
    )
)
