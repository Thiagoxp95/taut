import { SqlClient } from '@effect/sql'
import type { CompanyMember, CompanyWithRole, CurrentUserShape } from '@taut/contract/api'
import {
  type Avatar,
  type Company,
  Membership,
  MembershipRole,
  type User
} from '@taut/contract/domain'
import { Conflict, Forbidden, NotFound } from '@taut/contract/errors'
import { CompanyId, type SessionId, UserId, newCompanyId } from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { Sessions } from '../auth/sessions.js'
import { Count, findOne, nowIso, run, single } from '../db/sql.js'
import { CompanyRow, toCompany, toUser } from '../domain/rows.js'
import { isAdmin } from './access.js'
import { type Emit, EventPublisher } from './publisher.js'
import { Users } from './users.js'

/** Companies + memberships (agent-model.md §1, §2). */
export class Companies extends Effect.Service<Companies>()('Companies', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const users = yield* Users
    const sessions = yield* Sessions
    const publisher = yield* EventPublisher

    const byId = findOne({
      Request: CompanyId,
      Result: CompanyRow,
      execute: (id) =>
        sql`SELECT id, slug, name, avatar_json, created_at FROM companies WHERE id = ${id}`
    })

    const bySlug = findOne({
      Request: Schema.String,
      Result: CompanyRow,
      execute: (slug) =>
        sql`SELECT id, slug, name, avatar_json, created_at FROM companies WHERE slug = ${slug}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: CompanyId,
        slug: Schema.String,
        name: Schema.String,
        avatarJson: Schema.String,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO companies (id, slug, name, avatar_json, created_at)
        VALUES (${r.id}, ${r.slug}, ${r.name}, ${r.avatarJson}, ${r.createdAt})`
    })

    const ownerCount = single({
      Request: CompanyId,
      Result: Count,
      execute: (companyId) =>
        sql`SELECT COUNT(*) AS n FROM memberships WHERE company_id = ${companyId} AND role = 'owner'`
    })

    const updateRow = run({
      Request: Schema.Struct({
        companyId: CompanyId,
        name: Schema.String,
        avatarJson: Schema.String
      }),
      execute: (r) => sql`
        UPDATE companies SET name = ${r.name}, avatar_json = ${r.avatarJson} WHERE id = ${r.companyId}`
    })

    const removeRow = run({
      Request: CompanyId,
      execute: (companyId) => sql`DELETE FROM companies WHERE id = ${companyId}`
    })

    const updateRole = run({
      Request: Schema.Struct({ companyId: CompanyId, userId: UserId, role: MembershipRole }),
      execute: (r) => sql`
        UPDATE memberships SET role = ${r.role}
        WHERE company_id = ${r.companyId} AND user_id = ${r.userId}`
    })

    /** The company, or `NotFound` when it does not exist or the user is not a member (no leaking). */
    const visible = (
      me: CurrentUserShape,
      companyId: CompanyId
    ): Effect.Effect<{ company: Company; role: MembershipRole }, NotFound> =>
      Effect.gen(function* () {
        const role = yield* users.roleIn(companyId, me.userId)
        const row = yield* byId(companyId)
        if (Option.isNone(role) || Option.isNone(row)) {
          return yield* new NotFound({ entity: 'Company', id: companyId })
        }
        return { company: toCompany(row.value), role: role.value }
      })

    const create = (
      me: CurrentUserShape,
      input: { readonly slug: string; readonly name: string; readonly avatar: Avatar },
      sessionId: SessionId | undefined
    ): Effect.Effect<Company, Conflict> =>
      Effect.gen(function* () {
        if (Option.isSome(yield* bySlug(input.slug))) {
          return yield* new Conflict({ reason: `Slug "${input.slug}" is taken` })
        }
        const creator = yield* users.byId(me.userId).pipe(Effect.flatMap(Effect.orDie))
        const id = newCompanyId()
        const company = yield* publisher.transact(id, (emit) =>
          Effect.gen(function* () {
            yield* insert({
              id,
              slug: input.slug,
              name: input.name,
              avatarJson: JSON.stringify(input.avatar),
              createdAt: nowIso()
            })
            yield* users.addMembership(id, me.userId, 'owner')
            const company = toCompany(yield* byId(id).pipe(Effect.flatMap(Effect.orDie)))
            yield* emit({
              type: 'membership.created',
              payload: {
                membership: new Membership({ companyId: id, userId: me.userId, role: 'owner' }),
                user: creator
              }
            })
            return company
          })
        )
        if (sessionId !== undefined) yield* sessions.setActiveCompany(sessionId, id)
        return company
      })

    const list = (me: CurrentUserShape): Effect.Effect<ReadonlyArray<CompanyWithRole>> =>
      users
        .companiesOf(me.userId)
        .pipe(
          Effect.map((rows) => rows.map((row) => ({ company: toCompany(row), role: row.role })))
        )

    const get = (me: CurrentUserShape, companyId: CompanyId): Effect.Effect<Company, NotFound> =>
      visible(me, companyId).pipe(Effect.map((v) => v.company))

    const switchActive = (
      me: CurrentUserShape,
      companyId: CompanyId,
      sessionId: SessionId
    ): Effect.Effect<Company, NotFound> =>
      Effect.gen(function* () {
        const { company } = yield* visible(me, companyId)
        yield* sessions.setActiveCompany(sessionId, companyId)
        return company
      })

    const members = (
      me: CurrentUserShape,
      companyId: CompanyId
    ): Effect.Effect<ReadonlyArray<CompanyMember>, NotFound> =>
      Effect.gen(function* () {
        yield* visible(me, companyId)
        const rows = yield* users.membersOf(companyId)
        return rows.map((row) => ({ user: toUser(row), role: row.role }))
      })

    const setRole = (
      me: CurrentUserShape,
      companyId: CompanyId,
      userId: UserId,
      role: MembershipRole
    ): Effect.Effect<Membership, NotFound | Forbidden | Conflict> =>
      Effect.gen(function* () {
        const { role: myRole } = yield* visible(me, companyId)
        if (!isAdmin(myRole)) {
          return yield* new Forbidden({ message: 'Requires the owner or admin role' })
        }
        const current = yield* users.roleIn(companyId, userId)
        if (Option.isNone(current)) return yield* new NotFound({ entity: 'Membership', id: userId })
        if ((role === 'owner' || current.value === 'owner') && myRole !== 'owner') {
          return yield* new Forbidden({ message: 'Only an owner can grant or revoke ownership' })
        }
        if (
          current.value === 'owner' &&
          role !== 'owner' &&
          (yield* ownerCount(companyId)).n <= 1
        ) {
          return yield* new Conflict({ reason: 'A company must keep at least one owner' })
        }
        const membership = new Membership({ companyId, userId, role })
        yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            yield* updateRole({ companyId, userId, role })
            yield* emit({ type: 'membership.updated', payload: { membership } })
          })
        )
        return membership
      })

    /** Admin+: rename or re-avatar. `slug` is the on-disk folder and stays. */
    const update = (
      me: CurrentUserShape,
      companyId: CompanyId,
      input: { readonly name?: string | undefined; readonly avatar?: Avatar | undefined }
    ): Effect.Effect<Company, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const { company, role } = yield* visible(me, companyId)
        if (!isAdmin(role)) {
          return yield* new Forbidden({ message: 'Requires the owner or admin role' })
        }
        return yield* publisher.transact(companyId, (emit) =>
          Effect.gen(function* () {
            yield* updateRow({
              companyId,
              name: input.name ?? company.name,
              avatarJson: JSON.stringify(input.avatar ?? company.avatar)
            })
            const updated = toCompany(yield* byId(companyId).pipe(Effect.flatMap(Effect.orDie)))
            yield* emit({ type: 'company.updated', payload: { company: updated } })
            return updated
          })
        )
      })

    /**
     * Owner only, and only while the owner still belongs to another company: with
     * nothing to fall back to, deleting is `Forbidden`. `ON DELETE CASCADE` takes every
     * row; sessions pointing at it fall back to the user's next membership. Agent homes
     * on disk are kept (backup = copy `/data`).
     */
    const del = (
      me: CurrentUserShape,
      companyId: CompanyId
    ): Effect.Effect<void, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const { role } = yield* visible(me, companyId)
        if (role !== 'owner')
          return yield* new Forbidden({ message: 'Only an owner can delete a company' })
        if ((yield* users.membershipCount(me.userId)) <= 1) {
          return yield* new Forbidden({
            message: 'You cannot delete your only company — create or join another one first'
          })
        }
        yield* publisher.transact(companyId, (emit) =>
          emit({ type: 'company.deleted', payload: { companyId } }).pipe(
            Effect.zipRight(removeRow(companyId))
          )
        )
      })

    /** Used by `Invites.accept`: membership + `membership.created` in the caller's transaction. */
    const join = (
      companyId: CompanyId,
      user: User,
      role: MembershipRole,
      emit: Emit
    ): Effect.Effect<Membership> =>
      Effect.gen(function* () {
        yield* users.addMembership(companyId, user.id, role)
        const membership = new Membership({ companyId, userId: user.id, role })
        yield* emit({ type: 'membership.created', payload: { membership, user } })
        return membership
      })

    return {
      byId,
      create,
      list,
      get,
      update,
      delete: del,
      switchActive,
      members,
      setRole,
      join
    } as const
  })
}) {}
