import { SqlClient } from '@effect/sql'
import type { CurrentUserShape, DepartmentDetail } from '@taut/contract/api'
import {
  type Department,
  type DepartmentMember,
  DepartmentShape,
  MemberKind
} from '@taut/contract/domain'
import { Conflict, Forbidden, NotFound, type Unauthorized } from '@taut/contract/errors'
import { CompanyId, DepartmentId, MemberId, UserId, newDepartmentId } from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import {
  type DepartmentRow,
  DepartmentMemberRow,
  DepartmentRow as DepartmentRowSchema,
  toDepartment,
  toDepartmentMember
} from '../domain/rows.js'
import { type Actor, actor, isAdmin, requireAdmin } from './access.js'
import { Channels, type MemberRef } from './channels.js'
import { type Emit, EventPublisher } from './publisher.js'
import { Users } from './users.js'

const DEPARTMENT_COLUMNS = 'id, company_id, name, slug, head_user_id, shape, created_at'
const isUserId = Schema.is(UserId)

/** Departments: one human head each, members are users and agents (agent-model.md §2). */
export class Departments extends Effect.Service<Departments>()('Departments', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const users = yield* Users
    const channels = yield* Channels
    const publisher = yield* EventPublisher

    const byId = findOne({
      Request: Schema.Struct({ companyId: CompanyId, departmentId: DepartmentId }),
      Result: DepartmentRowSchema,
      execute: (r) => sql`
        SELECT ${sql.literal(DEPARTMENT_COLUMNS)} FROM departments
        WHERE company_id = ${r.companyId} AND id = ${r.departmentId}`
    })

    const listOf = findAll({
      Request: CompanyId,
      Result: DepartmentRowSchema,
      execute: (companyId) => sql`
        SELECT ${sql.literal(DEPARTMENT_COLUMNS)} FROM departments
        WHERE company_id = ${companyId} ORDER BY created_at ASC, rowid ASC`
    })

    const slugTaken = findOne({
      Request: Schema.Struct({ companyId: CompanyId, slug: Schema.String }),
      Result: Schema.Struct({ id: DepartmentId }),
      execute: (r) =>
        sql`SELECT id FROM departments WHERE company_id = ${r.companyId} AND slug = ${r.slug}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: DepartmentId,
        companyId: CompanyId,
        name: Schema.String,
        slug: Schema.String,
        headUserId: UserId,
        shape: Schema.NullOr(DepartmentShape),
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO departments (id, company_id, name, slug, head_user_id, shape, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.name}, ${r.slug}, ${r.headUserId}, ${r.shape}, ${r.createdAt})`
    })

    const update = run({
      Request: Schema.Struct({
        companyId: CompanyId,
        departmentId: DepartmentId,
        name: Schema.String,
        slug: Schema.String,
        shape: Schema.NullOr(DepartmentShape)
      }),
      execute: (r) => sql`
        UPDATE departments SET name = ${r.name}, slug = ${r.slug}, shape = ${r.shape}
        WHERE company_id = ${r.companyId} AND id = ${r.departmentId}`
    })

    const setHeadRow = run({
      Request: Schema.Struct({
        companyId: CompanyId,
        departmentId: DepartmentId,
        headUserId: UserId
      }),
      execute: (r) => sql`
        UPDATE departments SET head_user_id = ${r.headUserId}
        WHERE company_id = ${r.companyId} AND id = ${r.departmentId}`
    })

    const remove = run({
      Request: Schema.Struct({ companyId: CompanyId, departmentId: DepartmentId }),
      execute: (r) =>
        sql`DELETE FROM departments WHERE company_id = ${r.companyId} AND id = ${r.departmentId}`
    })

    const MemberKey = Schema.Struct({
      departmentId: DepartmentId,
      memberKind: MemberKind,
      memberId: MemberId
    })

    const memberRow = findOne({
      Request: MemberKey,
      Result: DepartmentMemberRow,
      execute: (r) => sql`
        SELECT department_id, member_kind, member_id FROM department_members
        WHERE department_id = ${r.departmentId} AND member_kind = ${r.memberKind} AND member_id = ${r.memberId}`
    })

    const membersOf = findAll({
      Request: DepartmentId,
      Result: DepartmentMemberRow,
      execute: (departmentId) => sql`
        SELECT department_id, member_kind, member_id FROM department_members
        WHERE department_id = ${departmentId} ORDER BY rowid ASC`
    })

    const insertMember = run({
      Request: MemberKey,
      execute: (r) => sql`
        INSERT OR IGNORE INTO department_members (department_id, member_kind, member_id)
        VALUES (${r.departmentId}, ${r.memberKind}, ${r.memberId})`
    })

    const deleteMember = run({
      Request: MemberKey,
      execute: (r) => sql`
        DELETE FROM department_members
        WHERE department_id = ${r.departmentId} AND member_kind = ${r.memberKind} AND member_id = ${r.memberId}`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    const load = (who: Actor, departmentId: DepartmentId): Effect.Effect<DepartmentRow, NotFound> =>
      byId({ companyId: who.companyId, departmentId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Department', id: departmentId })),
            onSome: Effect.succeed
          })
        )
      )

    /** Admin+ or the department's head. */
    const requireManage = (who: Actor, dept: DepartmentRow): Effect.Effect<void, Forbidden> =>
      isAdmin(who.role) || dept.head_user_id === who.userId
        ? Effect.void
        : Effect.fail(new Forbidden({ message: 'Requires admin or the head of this department' }))

    const requireHumanMember = (
      companyId: CompanyId,
      userId: UserId
    ): Effect.Effect<void, NotFound> =>
      users
        .roleIn(companyId, userId)
        .pipe(
          Effect.flatMap((role) =>
            Option.isSome(role)
              ? Effect.void
              : Effect.fail(new NotFound({ entity: 'User', id: userId }))
          )
        )

    const validateRef = (companyId: CompanyId, ref: MemberRef): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        if (ref.memberKind === 'user') {
          if (!isUserId(ref.memberId))
            return yield* new NotFound({ entity: 'User', id: ref.memberId })
          yield* requireHumanMember(companyId, ref.memberId)
        } else {
          const ok = !isUserId(ref.memberId)
            ? Option.isSome(yield* users.agentIn(companyId, ref.memberId))
            : false
          if (!ok) return yield* new NotFound({ entity: 'Agent', id: ref.memberId })
        }
      })

    const loadDepartment = (companyId: CompanyId, departmentId: DepartmentId) =>
      byId({ companyId, departmentId }).pipe(Effect.flatMap(Effect.orDie), Effect.map(toDepartment))

    const emitUpdated = (emit: Emit, companyId: CompanyId, departmentId: DepartmentId) =>
      loadDepartment(companyId, departmentId).pipe(
        Effect.flatMap((department) =>
          emit({ type: 'department.updated', payload: { department } })
        )
      )

    // ── endpoints ────────────────────────────────────────────────────────────

    const list = (me: CurrentUserShape): Effect.Effect<ReadonlyArray<Department>, Unauthorized> =>
      actor(me).pipe(
        Effect.flatMap((who) => listOf(who.companyId)),
        Effect.map((rows) => rows.map(toDepartment))
      )

    const create = (
      me: CurrentUserShape,
      input: {
        readonly name: string
        readonly slug: string
        readonly headUserId: UserId
        readonly shape?: DepartmentShape | undefined
      }
    ): Effect.Effect<Department, Unauthorized | Forbidden | Conflict | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        yield* requireHumanMember(who.companyId, input.headUserId)
        if (Option.isSome(yield* slugTaken({ companyId: who.companyId, slug: input.slug }))) {
          return yield* new Conflict({ reason: `Department slug "${input.slug}" is taken` })
        }
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const id = newDepartmentId()
            yield* insert({
              id,
              companyId: who.companyId,
              name: input.name,
              slug: input.slug,
              headUserId: input.headUserId,
              shape: input.shape ?? null,
              createdAt: nowIso()
            })
            yield* insertMember({
              departmentId: id,
              memberKind: 'user',
              memberId: input.headUserId
            })
            const department = yield* loadDepartment(who.companyId, id)
            yield* emit({ type: 'department.created', payload: { department } })
            // The department's default channel, named after it (build-plan: "#general-style").
            yield* channels.createDefault(emit, {
              companyId: who.companyId,
              departmentId: id,
              name: input.slug,
              headUserId: input.headUserId
            })
            return department
          })
        )
      })

    const get = (
      me: CurrentUserShape,
      departmentId: DepartmentId
    ): Effect.Effect<DepartmentDetail, Unauthorized | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const dept = yield* load(who, departmentId)
        const members = yield* membersOf(departmentId)
        return { department: toDepartment(dept), members: members.map(toDepartmentMember) }
      })

    const patch = (
      me: CurrentUserShape,
      departmentId: DepartmentId,
      input: {
        readonly name?: string | undefined
        readonly slug?: string | undefined
        /** Absent keeps the current shape; `null` puts the department on auto. */
        readonly shape?: DepartmentShape | null | undefined
      }
    ): Effect.Effect<Department, Unauthorized | NotFound | Forbidden | Conflict> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const dept = yield* load(who, departmentId)
        yield* requireManage(who, dept)
        const slug = input.slug ?? dept.slug
        if (slug !== dept.slug) {
          if (Option.isSome(yield* slugTaken({ companyId: who.companyId, slug }))) {
            return yield* new Conflict({ reason: `Department slug "${slug}" is taken` })
          }
        }
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* update({
              companyId: who.companyId,
              departmentId,
              name: input.name ?? dept.name,
              slug,
              shape: input.shape === undefined ? dept.shape : input.shape
            })
            const department = yield* loadDepartment(who.companyId, departmentId)
            yield* emit({ type: 'department.updated', payload: { department } })
            return department
          })
        )
      })

    const del = (
      me: CurrentUserShape,
      departmentId: DepartmentId
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* load(who, departmentId)
        yield* requireAdmin(who)
        yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* channels.deleteDepartmentChannels(emit, who.companyId, departmentId)
            yield* remove({ companyId: who.companyId, departmentId })
            yield* emit({ type: 'department.deleted', payload: { departmentId } })
          })
        )
      })

    const addMember = (
      me: CurrentUserShape,
      departmentId: DepartmentId,
      ref: MemberRef
    ): Effect.Effect<DepartmentMember, Unauthorized | NotFound | Forbidden | Conflict> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const dept = yield* load(who, departmentId)
        yield* requireManage(who, dept)
        yield* validateRef(who.companyId, ref)
        if (Option.isSome(yield* memberRow({ departmentId, ...ref }))) {
          return yield* new Conflict({ reason: 'Already a member of this department' })
        }
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* insertMember({ departmentId, ...ref })
            // Department members read the department's channels.
            yield* channels.addToDepartmentChannels(emit, who.companyId, departmentId, ref)
            yield* emitUpdated(emit, who.companyId, departmentId)
            return toDepartmentMember(
              yield* memberRow({ departmentId, ...ref }).pipe(Effect.flatMap(Effect.orDie))
            )
          })
        )
      })

    const removeMember = (
      me: CurrentUserShape,
      departmentId: DepartmentId,
      ref: MemberRef
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const dept = yield* load(who, departmentId)
        yield* requireManage(who, dept)
        if (ref.memberKind === 'user' && ref.memberId === dept.head_user_id) {
          return yield* new Forbidden({ message: 'Set a new head before removing this one' })
        }
        if (Option.isNone(yield* memberRow({ departmentId, ...ref }))) {
          return yield* new NotFound({ entity: 'DepartmentMember', id: ref.memberId })
        }
        yield* publisher.transact(who.companyId, (emit) =>
          deleteMember({ departmentId, ...ref }).pipe(
            Effect.zipRight(emitUpdated(emit, who.companyId, departmentId))
          )
        )
      })

    const setHead = (
      me: CurrentUserShape,
      departmentId: DepartmentId,
      headUserId: UserId
    ): Effect.Effect<Department, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const dept = yield* load(who, departmentId)
        yield* requireManage(who, dept)
        yield* requireHumanMember(who.companyId, headUserId)
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const ref: MemberRef = { memberKind: 'user', memberId: headUserId }
            yield* setHeadRow({ companyId: who.companyId, departmentId, headUserId })
            yield* insertMember({ departmentId, ...ref })
            yield* channels.addToDepartmentChannels(emit, who.companyId, departmentId, ref)
            const department = yield* loadDepartment(who.companyId, departmentId)
            yield* emit({ type: 'department.updated', payload: { department } })
            return department
          })
        )
      })

    return {
      list,
      create,
      get,
      update: patch,
      delete: del,
      addMember,
      removeMember,
      setHead
    } as const
  })
}) {}
