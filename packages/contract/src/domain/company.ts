import { Schema } from 'effect'

import { CompanyId, InviteId, UserId } from '../ids.js'
import { Avatar } from './avatar.js'
import { MembershipRole } from './enums.js'
import { DisplayName, Email, Slug } from './primitives.js'

export class Company extends Schema.Class<Company>('Company')({
  id: CompanyId,
  slug: Slug,
  name: DisplayName,
  avatar: Avatar,
  createdAt: Schema.DateTimeUtc
}) {}

export class Membership extends Schema.Class<Membership>('Membership')({
  companyId: CompanyId,
  userId: UserId,
  role: MembershipRole
}) {}

export class Invite extends Schema.Class<Invite>('Invite')({
  id: InviteId,
  companyId: CompanyId,
  email: Email,
  role: MembershipRole,
  token: Schema.String,
  invitedBy: UserId,
  expiresAt: Schema.DateTimeUtc,
  acceptedAt: Schema.optional(Schema.DateTimeUtc)
}) {}
