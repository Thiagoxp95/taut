import { Schema } from 'effect'

import { CompanyId, DepartmentId, MemberId, UserId } from '../ids.js'
import { DepartmentShape, MemberKind } from './enums.js'
import { DisplayName, Slug } from './primitives.js'

export class Department extends Schema.Class<Department>('Department')({
  id: DepartmentId,
  companyId: CompanyId,
  name: DisplayName,
  slug: Slug,
  /** Heads are always humans (docs/build-plan.md → authorization rules). */
  headUserId: UserId,
  /**
   * The silhouette its agents wear. Absent means "auto": the department takes
   * the next unclaimed shape by age, which is what every department did before
   * the field existed and what a company that never opens the picker keeps.
   */
  shape: Schema.optional(DepartmentShape),
  createdAt: Schema.DateTimeUtc
}) {}

export class DepartmentMember extends Schema.Class<DepartmentMember>('DepartmentMember')({
  departmentId: DepartmentId,
  memberKind: MemberKind,
  memberId: MemberId
}) {}
