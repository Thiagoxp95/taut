import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Channels } from '../services/channels.js'
import { ThreadContexts } from '../services/threadContext.js'
import { ServerApi } from './serverApi.js'

export const ChannelsLive = HttpApiBuilder.group(ServerApi, 'channels', (handlers) =>
  handlers
    .handle('list', ({ urlParams }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        return { items: yield* channels.list(yield* CurrentUser, urlParams) }
      })
    )
    .handle('create', ({ payload }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        return yield* channels.create(yield* CurrentUser, payload)
      })
    )
    .handle('dm', ({ payload }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        return yield* channels.dm(yield* CurrentUser, payload)
      })
    )
    .handle('get', ({ path }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        return yield* channels.get(yield* CurrentUser, path.channelId)
      })
    )
    .handle('update', ({ path, payload }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        return yield* channels.update(yield* CurrentUser, path.channelId, payload)
      })
    )
    .handle('delete', ({ path }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        yield* channels.delete(yield* CurrentUser, path.channelId)
      })
    )
    .handle('members', ({ path }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        return { items: yield* channels.members(yield* CurrentUser, path.channelId) }
      })
    )
    .handle('addMember', ({ path, payload }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        return yield* channels.addMember(yield* CurrentUser, path.channelId, payload)
      })
    )
    .handle('removeMember', ({ path }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        yield* channels.removeMember(yield* CurrentUser, path.channelId, {
          memberKind: path.memberKind,
          memberId: path.memberId
        })
      })
    )
    .handle('context', ({ path }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        const contexts = yield* ThreadContexts
        // The meter has no authorization of its own: if you can read the channel you can see
        // how full its agents' windows are, and `get` is what raises NotFound/Forbidden.
        yield* channels.get(yield* CurrentUser, path.channelId)
        return yield* contexts.list(path.channelId)
      })
    )
    .handle('markRead', ({ path, payload }) =>
      Effect.gen(function* () {
        const channels = yield* Channels
        return yield* channels.markRead(yield* CurrentUser, path.channelId, payload.lastReadSeq)
      })
    )
)
