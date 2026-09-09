/**
 * Authentication contract. The server implements `Authentication` (reads the
 * `taut_session` cookie, loads the session, provides `CurrentUser`); the web
 * client only needs the security scheme to know a cookie is involved.
 */
import { HttpApiMiddleware, HttpApiSecurity } from '@effect/platform'
import { Context, Schema } from 'effect'

import { MembershipRole } from '../domain/enums.js'
import { Unauthorized } from '../errors.js'
import { CompanyId, UserId } from '../ids.js'

export const SESSION_COOKIE = 'taut_session'

export const CurrentUserSchema = Schema.Struct({
  userId: UserId,
  /** The company the session is scoped to; unset until the user has one. */
  activeCompanyId: Schema.optional(CompanyId),
  /** Role in `activeCompanyId`. */
  role: Schema.optional(MembershipRole)
})
export type CurrentUserShape = typeof CurrentUserSchema.Type

export class CurrentUser extends Context.Tag('@taut/contract/CurrentUser')<
  CurrentUser,
  CurrentUserShape
>() {}

export class Authentication extends HttpApiMiddleware.Tag<Authentication>()(
  '@taut/contract/Authentication',
  {
    failure: Unauthorized,
    provides: CurrentUser,
    security: {
      session: HttpApiSecurity.apiKey({ in: 'cookie', key: SESSION_COOKIE })
    }
  }
) {}
