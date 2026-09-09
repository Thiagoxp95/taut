import { SqlClient } from '@effect/sql'
import type { CurrentUserShape, InvitePreview } from '@taut/contract/api'
import {
  type Company,
  type Invite,
  type Membership,
  MembershipRole,
  type User
} from '@taut/contract/domain'
import {
  Conflict,
  NotFound,
  Validation,
  type Forbidden,
  type Unauthorized
} from '@taut/contract/errors'
import { CompanyId, InviteId, type SessionId, UserId, newInviteId } from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { randomBytes } from 'node:crypto'
import { hashPassword, verifyPassword } from '../auth/password.js'
import { Sessions, type ResolvedSession } from '../auth/sessions.js'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import { InviteRow, toCompany, toInvite, toUser } from '../domain/rows.js'
import { actor, requireAdmin } from './access.js'
import { Companies } from './companies.js'
import { EventPublisher } from './publisher.js'
import { Users, initialAvatar } from './users.js'

export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000
const INVITE_COLUMNS = 'id, company_id, email, role, token, invited_by, expires_at, accepted_at'

export interface Accepted {
  readonly user: User
  readonly company: Company
  readonly membership: Membership
  /** The session to put in the cookie: the caller's own when it matched, else a fresh one. */
  readonly sessionId: SessionId
}

const issue = (path: string, message: string) =>
  new Validation({ issues: [{ path: [path], message }] })

/** Email invites (agent-model.md §2): admin+ creates, anyone with the token accepts. */
export class Invites extends Effect.Service<Invites>()('Invites', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const users = yield* Users
    const sessions = yield* Sessions
    const companies = yield* Companies
    const publisher = yield* EventPublisher

    const insert = run({
      Request: Schema.Struct({
        id: InviteId,
        companyId: CompanyId,
        email: Schema.String,
        role: MembershipRole,
        token: Schema.String,
        invitedBy: UserId,
        expiresAt: Schema.String,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO invites (id, company_id, email, role, token, invited_by, expires_at, accepted_at, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.email}, ${r.role}, ${r.token}, ${r.invitedBy}, ${r.expiresAt}, NULL, ${r.createdAt})`
    })

    const byId = findOne({
      Request: Schema.Struct({ companyId: CompanyId, inviteId: InviteId }),
      Result: InviteRow,
      execute: (r) => sql`
        SELECT ${sql.literal(INVITE_COLUMNS)} FROM invites
        WHERE company_id = ${r.companyId} AND id = ${r.inviteId}`
    })

    const byToken = findOne({
      Request: Schema.String,
      Result: InviteRow,
      execute: (token) =>
        sql`SELECT ${sql.literal(INVITE_COLUMNS)} FROM invites WHERE token = ${token}`
    })

    const pendingFor = findOne({
      Request: Schema.Struct({ companyId: CompanyId, email: Schema.String, now: Schema.String }),
      Result: InviteRow,
      execute: (r) => sql`
        SELECT ${sql.literal(INVITE_COLUMNS)} FROM invites
        WHERE company_id = ${r.companyId} AND email = ${r.email}
          AND accepted_at IS NULL AND expires_at > ${r.now}`
    })

    const listOf = findAll({
      Request: CompanyId,
      Result: InviteRow,
      execute: (companyId) => sql`
        SELECT ${sql.literal(INVITE_COLUMNS)} FROM invites
        WHERE company_id = ${companyId} ORDER BY created_at DESC, rowid DESC`
    })

    const remove = run({
      Request: Schema.Struct({ companyId: CompanyId, inviteId: InviteId }),
      execute: (r) =>
        sql`DELETE FROM invites WHERE company_id = ${r.companyId} AND id = ${r.inviteId}`
    })

    const markAccepted = run({
      Request: Schema.Struct({ id: InviteId, at: Schema.String }),
      execute: (r) => sql`UPDATE invites SET accepted_at = ${r.at} WHERE id = ${r.id}`
    })

    const create = (
      me: CurrentUserShape,
      input: { readonly email: string; readonly role: MembershipRole }
    ): Effect.Effect<Invite, Unauthorized | Forbidden | Conflict> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const email = input.email.trim().toLowerCase()
        const existing = yield* users.byEmailWithHash(email)
        if (Option.isSome(existing)) {
          const role = yield* users.roleIn(who.companyId, existing.value.id)
          if (Option.isSome(role)) {
            return yield* new Conflict({ reason: `${email} is already a member` })
          }
        }
        if (Option.isSome(yield* pendingFor({ companyId: who.companyId, email, now: nowIso() }))) {
          return yield* new Conflict({ reason: `${email} already has a pending invite` })
        }
        const id = newInviteId()
        const now = Date.now()
        yield* insert({
          id,
          companyId: who.companyId,
          email,
          role: input.role,
          token: randomBytes(32).toString('base64url'),
          invitedBy: who.userId,
          expiresAt: new Date(now + INVITE_TTL_MS).toISOString(),
          createdAt: new Date(now).toISOString()
        })
        return toInvite(
          yield* byId({ companyId: who.companyId, inviteId: id }).pipe(Effect.flatMap(Effect.orDie))
        )
      })

    const list = (
      me: CurrentUserShape
    ): Effect.Effect<ReadonlyArray<Invite>, Unauthorized | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        return (yield* listOf(who.companyId)).map(toInvite)
      })

    const revoke = (
      me: CurrentUserShape,
      inviteId: InviteId
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const row = yield* byId({ companyId: who.companyId, inviteId })
        if (Option.isNone(row)) return yield* new NotFound({ entity: 'Invite', id: inviteId })
        yield* remove({ companyId: who.companyId, inviteId })
      })

    /** Public: who invited you, to which company, as what. `NotFound` for an unknown token. */
    const preview = (token: string): Effect.Effect<InvitePreview, NotFound> =>
      Effect.gen(function* () {
        const found = yield* byToken(token)
        if (Option.isNone(found)) return yield* new NotFound({ entity: 'Invite', id: token })
        const invite = found.value
        const company = toCompany(
          yield* companies.byId(invite.company_id).pipe(Effect.flatMap(Effect.orDie))
        )
        const inviter = yield* users.byId(invite.invited_by)
        const account = yield* users.byEmailWithHash(invite.email)
        return {
          email: invite.email,
          role: invite.role,
          hasAccount: Option.isSome(account),
          company,
          inviterName: Option.match(inviter, {
            onNone: () => 'A former member',
            onSome: (u) => u.name
          }),
          expiresAt: invite.expires_at,
          ...(invite.accepted_at === null ? {} : { acceptedAt: invite.accepted_at })
        }
      })

    /**
     * Public. Resolves the invite's email to a user: the caller's session when it is
     * that user, else `password` (existing account) or `name` + `password` (new account).
     */
    const accept = (
      input: {
        readonly token: string
        readonly name?: string | undefined
        readonly password?: string | undefined
      },
      current: Option.Option<ResolvedSession>
    ): Effect.Effect<Accepted, NotFound | Conflict | Validation> =>
      Effect.gen(function* () {
        const found = yield* byToken(input.token)
        if (Option.isNone(found)) return yield* new NotFound({ entity: 'Invite', id: input.token })
        const invite = found.value
        if (invite.accepted_at !== null) {
          return yield* new Conflict({ reason: 'This invite was already accepted' })
        }
        if (invite.expires_at.epochMillis <= Date.now()) {
          return yield* new Conflict({ reason: 'This invite has expired' })
        }

        const existing = yield* users.byEmailWithHash(invite.email)
        const user: User = yield* Option.match(existing, {
          onSome: (row) =>
            Effect.gen(function* () {
              const sameSession = Option.isSome(current) && current.value.userId === row.id
              if (sameSession) return toUser(row)
              if (input.password === undefined) {
                return yield* issue('password', `sign in as ${invite.email} to accept this invite`)
              }
              if (!(yield* verifyPassword(input.password, row.password_hash))) {
                return yield* issue('password', 'wrong password for this email')
              }
              return toUser(row)
            }),
          onNone: () =>
            Effect.gen(function* () {
              if (input.name === undefined || input.password === undefined) {
                return yield* issue('name', 'name and password are required to create the account')
              }
              const passwordHash = yield* hashPassword(input.password)
              return yield* users.create({
                email: invite.email,
                passwordHash,
                name: input.name,
                avatar: initialAvatar(input.name)
              })
            })
        })

        if (Option.isSome(yield* users.roleIn(invite.company_id, user.id))) {
          return yield* new Conflict({ reason: 'You are already a member of this company' })
        }
        const company = toCompany(
          yield* companies.byId(invite.company_id).pipe(Effect.flatMap(Effect.orDie))
        )

        const membership = yield* publisher.transact(invite.company_id, (emit) =>
          Effect.gen(function* () {
            const membership = yield* companies.join(invite.company_id, user, invite.role, emit)
            yield* markAccepted({ id: invite.id, at: nowIso() })
            return membership
          })
        )

        const sessionId = yield* Option.match(current, {
          onSome: (s) =>
            s.userId === user.id
              ? sessions.setActiveCompany(s.sessionId, company.id).pipe(Effect.as(s.sessionId))
              : sessions.create(user.id, company.id).pipe(Effect.map((s) => s.id)),
          onNone: () => sessions.create(user.id, company.id).pipe(Effect.map((s) => s.id))
        })
        return { user, company, membership, sessionId }
      })

    return { create, list, revoke, preview, accept } as const
  })
}) {}
