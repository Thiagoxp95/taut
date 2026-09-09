import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { currentSessionToken, setSessionCookie } from '../auth/authentication.js'
import { Sessions } from '../auth/sessions.js'
import { Invites } from '../services/invites.js'
import { ServerApi } from './serverApi.js'

export const InvitesLive = HttpApiBuilder.group(ServerApi, 'invites', (handlers) =>
  handlers
    .handle('create', ({ payload }) =>
      Effect.gen(function* () {
        const invites = yield* Invites
        return yield* invites.create(yield* CurrentUser, payload)
      })
    )
    .handle('list', () =>
      Effect.gen(function* () {
        const invites = yield* Invites
        return { items: yield* invites.list(yield* CurrentUser) }
      })
    )
    .handle('preview', ({ path }) =>
      Effect.gen(function* () {
        const invites = yield* Invites
        return yield* invites.preview(path.token)
      })
    )
    .handle('accept', ({ payload }) =>
      Effect.gen(function* () {
        const invites = yield* Invites
        const sessions = yield* Sessions
        const current = yield* sessions.resolve(yield* currentSessionToken)
        const { user, company, membership, sessionId } = yield* invites.accept(payload, current)
        yield* setSessionCookie(sessionId)
        return { user, company, membership }
      })
    )
    .handle('revoke', ({ path }) =>
      Effect.gen(function* () {
        const invites = yield* Invites
        yield* invites.revoke(yield* CurrentUser, path.inviteId)
      })
    )
)
