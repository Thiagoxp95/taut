import { SqlClient } from '@effect/sql'
import { Session, type MembershipRole } from '@taut/contract/domain'
import { CompanyId, SessionId, UserId, newSessionId } from '@taut/contract/ids'
import { DateTime, Duration, Effect, Option, Schema } from 'effect'
import { findOne, nowIso, run } from '../db/sql.js'
import { SessionRow } from '../domain/rows.js'

export const SESSION_TTL = Duration.days(30)

/** What the `taut_session` cookie resolves to. */
export interface ResolvedSession {
  readonly sessionId: SessionId
  readonly userId: UserId
  readonly activeCompanyId: CompanyId | undefined
  readonly role: MembershipRole | undefined
}

/**
 * Session rows behind the `taut_session` cookie (the cookie value is the session id,
 * a random UUID). Shared by the HTTP `Authentication` middleware and the `/ws`
 * authenticator so both resolve the same user + active company.
 */
export class Sessions extends Effect.Service<Sessions>()('Sessions', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient

    const insert = run({
      Request: Schema.Struct({
        id: SessionId,
        userId: UserId,
        activeCompanyId: Schema.NullOr(CompanyId),
        expiresAt: Schema.String,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO sessions (id, user_id, active_company_id, expires_at, created_at)
        VALUES (${r.id}, ${r.userId}, ${r.activeCompanyId}, ${r.expiresAt}, ${r.createdAt})`
    })

    const load = findOne({
      Request: Schema.Struct({ id: Schema.String, now: Schema.String }),
      Result: SessionRow,
      execute: (r) => sql`
        SELECT s.id, s.user_id, s.expires_at, s.active_company_id, m.role
        FROM sessions s
        LEFT JOIN memberships m ON m.company_id = s.active_company_id AND m.user_id = s.user_id
        WHERE s.id = ${r.id} AND s.expires_at > ${r.now}`
    })

    const oldestMembership = findOne({
      Request: UserId,
      Result: Schema.Struct({ company_id: CompanyId, role: SessionRow.fields.role }),
      execute: (userId) => sql`
        SELECT company_id, role FROM memberships
        WHERE user_id = ${userId} ORDER BY created_at ASC, rowid ASC LIMIT 1`
    })

    const updateActive = run({
      Request: Schema.Struct({ id: SessionId, companyId: Schema.NullOr(CompanyId) }),
      execute: (r) => sql`UPDATE sessions SET active_company_id = ${r.companyId} WHERE id = ${r.id}`
    })

    const remove = run({
      Request: Schema.String,
      execute: (id) => sql`DELETE FROM sessions WHERE id = ${id}`
    })

    const purgeExpired = run({
      Request: Schema.String,
      execute: (now) => sql`DELETE FROM sessions WHERE expires_at <= ${now}`
    })

    const create = (userId: UserId, activeCompanyId?: CompanyId): Effect.Effect<Session> =>
      Effect.gen(function* () {
        const id = newSessionId()
        const now = new Date()
        const expiresAt = new Date(now.getTime() + Duration.toMillis(SESSION_TTL))
        yield* insert({
          id,
          userId,
          activeCompanyId: activeCompanyId ?? null,
          expiresAt: expiresAt.toISOString(),
          createdAt: now.toISOString()
        })
        return new Session({ id, userId, expiresAt: DateTime.unsafeFromDate(expiresAt) })
      })

    /**
     * `None` for a missing, unknown or expired token. A session whose active company
     * no longer has a membership for the user (or was never set) falls back to the
     * user's oldest membership and persists that choice.
     */
    const resolve = (token: string): Effect.Effect<Option.Option<ResolvedSession>> =>
      Effect.gen(function* () {
        if (token.length === 0) return Option.none()
        const row = yield* load({ id: token, now: nowIso() })
        if (Option.isNone(row)) return Option.none()
        const s = row.value
        if (s.active_company_id !== null && s.role !== null) {
          return Option.some({
            sessionId: s.id,
            userId: s.user_id,
            activeCompanyId: s.active_company_id,
            role: s.role
          })
        }
        const fallback = yield* oldestMembership(s.user_id)
        if (Option.isNone(fallback) || fallback.value.role === null) {
          if (s.active_company_id !== null) yield* updateActive({ id: s.id, companyId: null })
          return Option.some({
            sessionId: s.id,
            userId: s.user_id,
            activeCompanyId: undefined,
            role: undefined
          })
        }
        yield* updateActive({ id: s.id, companyId: fallback.value.company_id })
        return Option.some({
          sessionId: s.id,
          userId: s.user_id,
          activeCompanyId: fallback.value.company_id,
          role: fallback.value.role
        })
      })

    const setActiveCompany = (sessionId: SessionId, companyId: CompanyId): Effect.Effect<void> =>
      updateActive({ id: sessionId, companyId })

    const destroy = (token: string): Effect.Effect<void> =>
      token.length === 0 ? Effect.void : remove(token)

    return {
      create,
      resolve,
      setActiveCompany,
      destroy,
      purgeExpired: () => purgeExpired(nowIso())
    } as const
  })
}) {}
