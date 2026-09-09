import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Unauthorized } from '@taut/contract/errors'
import { Effect, Option } from 'effect'
import { currentSessionId } from '../auth/authentication.js'
import { Companies } from '../services/companies.js'
import { ServerApi } from './serverApi.js'

export const CompaniesLive = HttpApiBuilder.group(ServerApi, 'companies', (handlers) =>
  handlers
    .handle('create', ({ payload }) =>
      Effect.gen(function* () {
        const companies = yield* Companies
        const sessionId = yield* currentSessionId
        return yield* companies.create(
          yield* CurrentUser,
          payload,
          Option.getOrUndefined(sessionId)
        )
      })
    )
    .handle('list', () =>
      Effect.gen(function* () {
        const companies = yield* Companies
        return { items: yield* companies.list(yield* CurrentUser) }
      })
    )
    .handle('get', ({ path }) =>
      Effect.gen(function* () {
        const companies = yield* Companies
        return yield* companies.get(yield* CurrentUser, path.companyId)
      })
    )
    .handle('update', ({ path, payload }) =>
      Effect.gen(function* () {
        const companies = yield* Companies
        return yield* companies.update(yield* CurrentUser, path.companyId, payload)
      })
    )
    .handle('delete', ({ path }) =>
      Effect.gen(function* () {
        const companies = yield* Companies
        yield* companies.delete(yield* CurrentUser, path.companyId)
      })
    )
    .handle('switch', ({ path }) =>
      Effect.gen(function* () {
        const companies = yield* Companies
        const sessionId = yield* currentSessionId
        if (Option.isNone(sessionId)) return yield* new Unauthorized({ message: 'No session' })
        return yield* companies.switchActive(yield* CurrentUser, path.companyId, sessionId.value)
      })
    )
    .handle('members', ({ path }) =>
      Effect.gen(function* () {
        const companies = yield* Companies
        return { items: yield* companies.members(yield* CurrentUser, path.companyId) }
      })
    )
    .handle('setRole', ({ path, payload }) =>
      Effect.gen(function* () {
        const companies = yield* Companies
        return yield* companies.setRole(
          yield* CurrentUser,
          path.companyId,
          path.userId,
          payload.role
        )
      })
    )
)
