import type { CurrentUserShape } from '@taut/contract/api'
import type { MembershipRole } from '@taut/contract/domain'
import { Forbidden, Unauthorized } from '@taut/contract/errors'
import type { CompanyId, UserId } from '@taut/contract/ids'
import { Effect } from 'effect'

/** The session narrowed to a company: every company-scoped service starts here. */
export interface Actor {
  readonly userId: UserId
  readonly companyId: CompanyId
  readonly role: MembershipRole
}

/** Fails with 401 when the session has no active company (the web sends the user to onboarding). */
export const actor = (me: CurrentUserShape): Effect.Effect<Actor, Unauthorized> =>
  me.activeCompanyId !== undefined && me.role !== undefined
    ? Effect.succeed({ userId: me.userId, companyId: me.activeCompanyId, role: me.role })
    : Effect.fail(new Unauthorized({ message: 'No active company for this session' }))

export const isAdmin = (role: MembershipRole): boolean => role === 'owner' || role === 'admin'

export const requireAdmin = (who: Actor): Effect.Effect<void, Forbidden> =>
  isAdmin(who.role)
    ? Effect.void
    : Effect.fail(new Forbidden({ message: 'Requires the owner or admin role' }))

export const forbiddenUnless = (
  allowed: boolean,
  message: string
): Effect.Effect<void, Forbidden> =>
  allowed ? Effect.void : Effect.fail(new Forbidden({ message }))

/** Slack-style user handle: the local part of the email, lower-cased (users have no handle column). */
export const userHandle = (email: string): string =>
  email.slice(0, email.indexOf('@')).toLowerCase()
