import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Company } from '../domain/company.js'
import { MembershipRole } from '../domain/enums.js'
import { DisplayName, Email, Password } from '../domain/primitives.js'
import { User } from '../domain/user.js'
import { Conflict, Unauthorized, Validation } from '../errors.js'
import { CompanyId } from '../ids.js'
import { Authentication } from './middleware.js'

export const SignupPayload = Schema.Struct({ email: Email, password: Password, name: DisplayName })
export const LoginPayload = Schema.Struct({ email: Email, password: Schema.String })

export const AuthResult = Schema.Struct({ user: User })

export const Me = Schema.Struct({
  user: User,
  memberships: Schema.Array(Schema.Struct({ company: Company, role: MembershipRole })),
  activeCompanyId: Schema.optional(CompanyId)
})
export type Me = typeof Me.Type

/** Sets/clears the `taut_session` cookie. signup/login/logout are public. */
export class AuthGroup extends HttpApiGroup.make('auth')
  .add(
    HttpApiEndpoint.post('signup', '/signup')
      .setPayload(SignupPayload)
      .addSuccess(AuthResult, { status: 201 })
      .addError(Conflict)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.post('login', '/login')
      .setPayload(LoginPayload)
      .addSuccess(AuthResult)
      .addError(Unauthorized)
  )
  .add(HttpApiEndpoint.post('logout', '/logout'))
  .add(HttpApiEndpoint.get('me', '/me').addSuccess(Me).middleware(Authentication))
  .prefix('/auth') {}
