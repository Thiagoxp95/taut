import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Company, Invite, Membership } from '../domain/company.js'
import { MembershipRole } from '../domain/enums.js'
import { DisplayName, Email, Password } from '../domain/primitives.js'
import { User } from '../domain/user.js'
import { Conflict, Forbidden, NotFound, Validation } from '../errors.js'
import { InviteId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

export const CreateInvitePayload = Schema.Struct({ email: Email, role: MembershipRole })

/**
 * Public: a brand-new user supplies `name` + `password` and gets an account;
 * a logged-in user (cookie present) omits them and the invite attaches to them.
 */
export const AcceptInvitePayload = Schema.Struct({
  token: Schema.NonEmptyString,
  name: Schema.optional(DisplayName),
  password: Schema.optional(Password)
})

export const AcceptInviteResult = Schema.Struct({
  user: User,
  company: Company,
  membership: Membership
})
export type AcceptInviteResult = typeof AcceptInviteResult.Type

/**
 * What `/invite/$token` can show before accepting. Public: the token is the capability.
 * `acceptedAt` set or `expiresAt` in the past means `accept` will answer `Conflict`.
 */
export const InvitePreview = Schema.Struct({
  email: Email,
  role: MembershipRole,
  /** Whether `email` already has an account, so the form knows to ask for a name. */
  hasAccount: Schema.Boolean,
  company: Company,
  inviterName: DisplayName,
  expiresAt: Schema.DateTimeUtc,
  acceptedAt: Schema.optional(Schema.DateTimeUtc)
})
export type InvitePreview = typeof InvitePreview.Type

const InvitePath = Schema.Struct({ inviteId: InviteId })
const TokenPath = Schema.Struct({ token: Schema.NonEmptyString })

export class InvitesGroup extends HttpApiGroup.make('invites')
  .add(
    HttpApiEndpoint.post('create', '/')
      .setPayload(CreateInvitePayload)
      .addSuccess(Invite, { status: 201 })
      .addError(Forbidden)
      .addError(Conflict)
      .middleware(Authentication)
  )
  .add(
    HttpApiEndpoint.get('list', '/')
      .setUrlParams(PageQuery)
      .addSuccess(Page(Invite))
      .addError(Forbidden)
      .middleware(Authentication)
  )
  .add(
    HttpApiEndpoint.get('preview', '/preview/:token')
      .setPath(TokenPath)
      .addSuccess(InvitePreview)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.post('accept', '/accept')
      .setPayload(AcceptInvitePayload)
      .addSuccess(AcceptInviteResult)
      .addError(NotFound)
      .addError(Conflict)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.del('revoke', '/:inviteId')
      .setPath(InvitePath)
      .addError(NotFound)
      .addError(Forbidden)
      .middleware(Authentication)
  )
  .prefix('/invites') {}
