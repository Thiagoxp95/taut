import type { CurrentUserShape, Me } from '@taut/contract/api'
import type { Session, User } from '@taut/contract/domain'
import { Conflict, Unauthorized } from '@taut/contract/errors'
import { Effect, Option } from 'effect'
import { DUMMY_HASH, hashPassword, verifyPassword } from '../auth/password.js'
import { Sessions } from '../auth/sessions.js'
import { toCompany, toUser } from '../domain/rows.js'
import { Users, initialAvatar } from './users.js'

export interface Authenticated {
  readonly user: User
  readonly session: Session
}

const invalidCredentials = () => new Unauthorized({ message: 'Invalid email or password' })

/** Signup / login / logout / me (build-plan "Auth": email + password, scrypt, session cookie). */
export class Auth extends Effect.Service<Auth>()('Auth', {
  effect: Effect.gen(function* () {
    const users = yield* Users
    const sessions = yield* Sessions

    const signup = (input: {
      readonly email: string
      readonly password: string
      readonly name: string
    }): Effect.Effect<Authenticated, Conflict> =>
      Effect.gen(function* () {
        const existing = yield* users.byEmailWithHash(input.email)
        if (Option.isSome(existing)) {
          return yield* new Conflict({ reason: 'An account with this email already exists' })
        }
        const passwordHash = yield* hashPassword(input.password)
        const user = yield* users.create({
          email: input.email,
          passwordHash,
          name: input.name,
          avatar: initialAvatar(input.name)
        })
        const session = yield* sessions.create(user.id)
        return { user, session }
      })

    const login = (input: {
      readonly email: string
      readonly password: string
    }): Effect.Effect<Authenticated, Unauthorized> =>
      Effect.gen(function* () {
        const row = yield* users.byEmailWithHash(input.email)
        // Always run scrypt so an unknown email takes as long as a wrong password.
        const ok = yield* verifyPassword(
          input.password,
          Option.isSome(row) ? row.value.password_hash : DUMMY_HASH
        )
        if (Option.isNone(row) || !ok) return yield* invalidCredentials()
        const user = toUser(row.value)
        const session = yield* sessions.create(user.id)
        return { user, session }
      })

    const logout = (token: string): Effect.Effect<void> => sessions.destroy(token)

    const me = (current: CurrentUserShape): Effect.Effect<Me, Unauthorized> =>
      Effect.gen(function* () {
        const user = yield* users.byId(current.userId)
        if (Option.isNone(user)) {
          return yield* new Unauthorized({ message: 'User no longer exists' })
        }
        const companies = yield* users.companiesOf(current.userId)
        return {
          user: user.value,
          memberships: companies.map((row) => ({ company: toCompany(row), role: row.role })),
          activeCompanyId: current.activeCompanyId
        }
      })

    return { signup, login, logout, me } as const
  })
}) {}
