import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import {
  clearSessionCookie,
  currentSessionToken,
  setSessionCookie
} from '../auth/authentication.js'
import { Auth } from '../services/auth.js'
import { ServerApi } from './serverApi.js'

export const AuthLive = HttpApiBuilder.group(ServerApi, 'auth', (handlers) =>
  handlers
    .handle('signup', ({ payload }) =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const { user, session } = yield* auth.signup(payload)
        yield* setSessionCookie(session.id)
        return { user }
      })
    )
    .handle('login', ({ payload }) =>
      Effect.gen(function* () {
        const auth = yield* Auth
        const { user, session } = yield* auth.login(payload)
        yield* setSessionCookie(session.id)
        return { user }
      })
    )
    .handle('logout', () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        yield* auth.logout(yield* currentSessionToken)
        yield* clearSessionCookie
      })
    )
    .handle('me', () =>
      Effect.gen(function* () {
        const auth = yield* Auth
        return yield* auth.me(yield* CurrentUser)
      })
    )
)
