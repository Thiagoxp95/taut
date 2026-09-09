import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Avatar } from '../domain/avatar.js'
import { Company, Membership } from '../domain/company.js'
import { MembershipRole } from '../domain/enums.js'
import { DisplayName, Slug } from '../domain/primitives.js'
import { User } from '../domain/user.js'
import { Conflict, Forbidden, NotFound } from '../errors.js'
import { CompanyId, UserId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

export const CreateCompanyPayload = Schema.Struct({
  slug: Slug,
  name: DisplayName,
  avatar: Avatar
})

/** A company the current user belongs to, with their role in it. */
export const CompanyWithRole = Schema.Struct({ company: Company, role: MembershipRole })
export type CompanyWithRole = typeof CompanyWithRole.Type

export const CompanyMember = Schema.Struct({ user: User, role: MembershipRole })
export type CompanyMember = typeof CompanyMember.Type

export const SetRolePayload = Schema.Struct({ role: MembershipRole })

/** Admin+. `slug` is the on-disk folder name and never changes. */
export const UpdateCompanyPayload = Schema.partial(
  Schema.Struct({ name: DisplayName, avatar: Avatar })
)

const CompanyPath = Schema.Struct({ companyId: CompanyId })
const CompanyMemberPath = Schema.Struct({ companyId: CompanyId, userId: UserId })

export class CompaniesGroup extends HttpApiGroup.make('companies')
  .add(
    HttpApiEndpoint.post('create', '/')
      .setPayload(CreateCompanyPayload)
      .addSuccess(Company, { status: 201 })
      .addError(Conflict)
  )
  .add(HttpApiEndpoint.get('list', '/').setUrlParams(PageQuery).addSuccess(Page(CompanyWithRole)))
  .add(
    HttpApiEndpoint.get('get', '/:companyId')
      .setPath(CompanyPath)
      .addSuccess(Company)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.patch('update', '/:companyId')
      .setPath(CompanyPath)
      .setPayload(UpdateCompanyPayload)
      .addSuccess(Company)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /**
     * Owner only, and only while the owner belongs to another company (`Forbidden`
     * otherwise — there would be nothing to fall back to). Cascades every row of the company.
     */
    HttpApiEndpoint.del('delete', '/:companyId')
      .setPath(CompanyPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /** Makes `companyId` the session's active company; returns it. */
    HttpApiEndpoint.post('switch', '/:companyId/switch')
      .setPath(CompanyPath)
      .addSuccess(Company)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.get('members', '/:companyId/members')
      .setPath(CompanyPath)
      .setUrlParams(PageQuery)
      .addSuccess(Page(CompanyMember))
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.patch('setRole', '/:companyId/members/:userId')
      .setPath(CompanyMemberPath)
      .setPayload(SetRolePayload)
      .addSuccess(Membership)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
  )
  .middleware(Authentication)
  .prefix('/companies') {}
