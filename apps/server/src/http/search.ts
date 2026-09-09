import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Search } from '../services/search.js'
import { ServerApi } from './serverApi.js'

export const SearchLive = HttpApiBuilder.group(ServerApi, 'search', (handlers) =>
  handlers.handle('query', ({ urlParams }) =>
    Effect.gen(function* () {
      const search = yield* Search
      return yield* search.query(yield* CurrentUser, urlParams)
    })
  )
)
