import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Messages } from '../services/messages.js'
import { Reactions } from '../services/reactions.js'
import { ServerApi } from './serverApi.js'

const group = HttpApiBuilder.group(ServerApi, 'messages', (handlers) =>
  handlers
    .handle('list', ({ urlParams }) =>
      Effect.gen(function* () {
        const messages = yield* Messages
        return yield* messages.list(yield* CurrentUser, urlParams)
      })
    )
    .handle('create', ({ payload }) =>
      Effect.gen(function* () {
        const messages = yield* Messages
        return yield* messages.create(yield* CurrentUser, payload)
      })
    )
    .handle('edit', ({ path, payload }) =>
      Effect.gen(function* () {
        const messages = yield* Messages
        return yield* messages.edit(yield* CurrentUser, path.messageId, payload.body)
      })
    )
    .handle('delete', ({ path }) =>
      Effect.gen(function* () {
        const messages = yield* Messages
        yield* messages.delete(yield* CurrentUser, path.messageId)
      })
    )
    .handle('thread', ({ path, urlParams }) =>
      Effect.gen(function* () {
        const messages = yield* Messages
        return yield* messages.thread(yield* CurrentUser, path.threadId, urlParams)
      })
    )
    .handle('react', ({ path }) =>
      Effect.gen(function* () {
        const reactions = yield* Reactions
        return yield* reactions.add(yield* CurrentUser, path.messageId, path.emoji)
      })
    )
    .handle('unreact', ({ path }) =>
      Effect.gen(function* () {
        const reactions = yield* Reactions
        return yield* reactions.remove(yield* CurrentUser, path.messageId, path.emoji)
      })
    )
)

export const MessagesLive = group
