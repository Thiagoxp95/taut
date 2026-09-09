import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Validation } from '@taut/contract/errors'
import { Effect } from 'effect'
import { PushSender } from '../push/sender.js'
import { PushDevices } from '../services/pushDevices.js'
import { ServerApi } from './serverApi.js'

/** A push endpoint is always an absolute https URL; anything else is a bug or an attack. */
const isPushEndpoint = (endpoint: string): boolean => {
  try {
    return new URL(endpoint).protocol === 'https:'
  } catch {
    return false
  }
}

export const PushLive = HttpApiBuilder.group(ServerApi, 'push', (handlers) =>
  handlers
    .handle('key', () =>
      Effect.gen(function* () {
        const sender = yield* PushSender
        return sender.publicKey === undefined ? {} : { publicKey: sender.publicKey }
      })
    )
    .handle('subscribe', ({ payload }) =>
      Effect.gen(function* () {
        if (!isPushEndpoint(payload.endpoint)) {
          return yield* new Validation({
            issues: [{ path: ['endpoint'], message: 'must be an https URL' }]
          })
        }
        const devices = yield* PushDevices
        const { userId } = yield* CurrentUser
        return yield* devices.register(userId, payload)
      })
    )
    .handle('unsubscribe', ({ payload }) =>
      Effect.gen(function* () {
        const devices = yield* PushDevices
        const { userId } = yield* CurrentUser
        yield* devices.unregister(userId, payload.endpoint)
      })
    )
    .handle('list', () =>
      Effect.gen(function* () {
        const devices = yield* PushDevices
        const { userId } = yield* CurrentUser
        return yield* devices.list(userId)
      })
    )
)
