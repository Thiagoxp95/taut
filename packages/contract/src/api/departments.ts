import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Department, DepartmentMember } from '../domain/department.js'
import { DepartmentShape, MemberKind } from '../domain/enums.js'
import { DisplayName, Slug } from '../domain/primitives.js'
import { Conflict, Forbidden, NotFound } from '../errors.js'
import { DepartmentId, MemberId, UserId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

export const CreateDepartmentPayload = Schema.Struct({
  name: DisplayName,
  slug: Slug,
  headUserId: UserId,
  /** Omitted is "auto" — see `Department.shape`. */
  shape: Schema.optional(DepartmentShape)
})

/** `null` on `shape` puts the department back on auto. */
export const UpdateDepartmentPayload = Schema.partial(
  Schema.Struct({ name: DisplayName, slug: Slug, shape: Schema.NullOr(DepartmentShape) })
)

export const DepartmentDetail = Schema.Struct({
  department: Department,
  members: Schema.Array(DepartmentMember)
})
export type DepartmentDetail = typeof DepartmentDetail.Type

export const MemberRefPayload = Schema.Struct({ memberKind: MemberKind, memberId: MemberId })
export const SetHeadPayload = Schema.Struct({ headUserId: UserId })

const DepartmentPath = Schema.Struct({ departmentId: DepartmentId })
const DepartmentMemberPath = Schema.Struct({
  departmentId: DepartmentId,
  memberKind: MemberKind,
  memberId: MemberId
})

/** All scoped to the session's active company. */
export class DepartmentsGroup extends HttpApiGroup.make('departments')
  .add(HttpApiEndpoint.get('list', '/').setUrlParams(PageQuery).addSuccess(Page(Department)))
  .add(
    HttpApiEndpoint.post('create', '/')
      .setPayload(CreateDepartmentPayload)
      .addSuccess(Department, { status: 201 })
      .addError(Forbidden)
      .addError(Conflict)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.get('get', '/:departmentId')
      .setPath(DepartmentPath)
      .addSuccess(DepartmentDetail)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.patch('update', '/:departmentId')
      .setPath(DepartmentPath)
      .setPayload(UpdateDepartmentPayload)
      .addSuccess(Department)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
  )
  .add(
    HttpApiEndpoint.del('delete', '/:departmentId')
      .setPath(DepartmentPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post('addMember', '/:departmentId/members')
      .setPath(DepartmentPath)
      .setPayload(MemberRefPayload)
      .addSuccess(DepartmentMember, { status: 201 })
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
  )
  .add(
    HttpApiEndpoint.del('removeMember', '/:departmentId/members/:memberKind/:memberId')
      .setPath(DepartmentMemberPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post('setHead', '/:departmentId/head')
      .setPath(DepartmentPath)
      .setPayload(SetHeadPayload)
      .addSuccess(Department)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .middleware(Authentication)
  .prefix('/departments') {}
