import { SqlClient } from '@effect/sql'
import { type Avatar, MembershipRole, type User } from '@taut/contract/domain'
import { AgentId, CompanyId, UserId, newUserId } from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { findAll, findOne, nowIso, run, single, Count } from '../db/sql.js'
import {
  AgentRefRow,
  CompanyWithRoleRow,
  MembershipRow,
  UserAuthRow,
  UserRow,
  UserWithRoleRow,
  toUser
} from '../domain/rows.js'

const USER_COLUMNS = 'id, email, name, avatar_json, created_at'

/** Lookups shared by every domain service: users, memberships and agent references. */
export class Users extends Effect.Service<Users>()('Users', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const byIdRow = findOne({
      Request: UserId,
      Result: UserRow,
      execute: (id) => sql`SELECT ${sql.literal(USER_COLUMNS)} FROM users WHERE id = ${id}`
    })

    const byEmailRow = findOne({
      Request: Schema.String,
      Result: UserAuthRow,
      execute: (email) =>
        sql`SELECT ${sql.literal(USER_COLUMNS)}, password_hash FROM users WHERE email = ${email}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: UserId,
        email: Schema.String,
        passwordHash: Schema.String,
        name: Schema.String,
        avatarJson: Schema.String,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO users (id, email, password_hash, name, avatar_json, created_at)
        VALUES (${r.id}, ${r.email}, ${r.passwordHash}, ${r.name}, ${r.avatarJson}, ${r.createdAt})`
    })

    const membershipRow = findOne({
      Request: Schema.Struct({ companyId: CompanyId, userId: UserId }),
      Result: MembershipRow,
      execute: (r) => sql`
        SELECT company_id, user_id, role FROM memberships
        WHERE company_id = ${r.companyId} AND user_id = ${r.userId}`
    })

    const membershipCount = single({
      Request: UserId,
      Result: Count,
      execute: (userId) => sql`SELECT COUNT(*) AS n FROM memberships WHERE user_id = ${userId}`
    })

    const companiesOf = findAll({
      Request: UserId,
      Result: CompanyWithRoleRow,
      execute: (userId) => sql`
        SELECT c.id, c.slug, c.name, c.avatar_json, c.created_at, m.role
        FROM memberships m JOIN companies c ON c.id = m.company_id
        WHERE m.user_id = ${userId}
        ORDER BY m.created_at ASC, m.rowid ASC`
    })

    const membersOf = findAll({
      Request: CompanyId,
      Result: UserWithRoleRow,
      execute: (companyId) => sql`
        SELECT u.id, u.email, u.name, u.avatar_json, u.created_at, m.role
        FROM memberships m JOIN users u ON u.id = m.user_id
        WHERE m.company_id = ${companyId}
        ORDER BY m.created_at ASC, m.rowid ASC`
    })

    const insertMembership = run({
      Request: Schema.Struct({
        companyId: CompanyId,
        userId: UserId,
        role: MembershipRole,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO memberships (company_id, user_id, role, created_at)
        VALUES (${r.companyId}, ${r.userId}, ${r.role}, ${r.createdAt})`
    })

    const agentRow = findOne({
      Request: Schema.Struct({ companyId: CompanyId, agentId: AgentId }),
      Result: AgentRefRow,
      execute: (r) =>
        sql`SELECT id, handle, name FROM agents WHERE company_id = ${r.companyId} AND id = ${r.agentId}`
    })

    const agentsOf = findAll({
      Request: CompanyId,
      Result: AgentRefRow,
      execute: (companyId) =>
        sql`SELECT id, handle, name FROM agents WHERE company_id = ${companyId}`
    })

    const create = (input: {
      readonly email: string
      readonly passwordHash: string
      readonly name: string
      readonly avatar: Avatar
    }): Effect.Effect<User> =>
      Effect.gen(function* () {
        const id = newUserId()
        yield* insert({
          id,
          email: input.email.trim().toLowerCase(),
          passwordHash: input.passwordHash,
          name: input.name,
          avatarJson: JSON.stringify(input.avatar),
          createdAt: nowIso()
        })
        const row = yield* byIdRow(id)
        return toUser(yield* Effect.orDie(row))
      })

    return {
      byId: (id: UserId) => byIdRow(id).pipe(Effect.map(Option.map(toUser))),
      /** Includes `password_hash`; only `Auth` may call this. */
      byEmailWithHash: (email: string) => byEmailRow(email.trim().toLowerCase()),
      create,
      /** The user's role in `companyId`, if a member. */
      roleIn: (companyId: CompanyId, userId: UserId) =>
        membershipRow({ companyId, userId }).pipe(Effect.map(Option.map((m) => m.role))),
      membershipCount: (userId: UserId) => membershipCount(userId).pipe(Effect.map((c) => c.n)),
      companiesOf,
      membersOf,
      addMembership: (companyId: CompanyId, userId: UserId, role: MembershipRole) =>
        insertMembership({ companyId, userId, role, createdAt: nowIso() }),
      agentIn: (companyId: CompanyId, agentId: AgentId) => agentRow({ companyId, agentId }),
      agentsOf
    } as const
  })
}) {}

/** Default avatar for new accounts: the first character of the display name. */
export const initialAvatar = (name: string): Avatar => ({
  kind: 'emoji',
  value: (name.trim().charAt(0) || '?').toUpperCase()
})
