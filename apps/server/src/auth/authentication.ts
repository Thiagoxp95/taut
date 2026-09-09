import { HttpApiBuilder, HttpServerRequest } from '@effect/platform'
import { Authentication, SESSION_COOKIE, type CurrentUserShape } from '@taut/contract/api'
import { Unauthorized } from '@taut/contract/errors'
import { SessionId } from '@taut/contract/ids'
import { Effect, Layer, Option, Redacted, Schema } from 'effect'
import { AppConfig } from '../config.js'
import { SESSION_TTL, Sessions } from './sessions.js'

/**
 * Implements the contract's `Authentication` middleware: `taut_session` cookie →
 * `sessions` row → `CurrentUser { userId, activeCompanyId, role }`.
 */
export const AuthenticationLive = Layer.effect(
  Authentication,
  Effect.gen(function* () {
    const sessions = yield* Sessions
    return {
      session: (token) =>
        sessions.resolve(Redacted.value(token)).pipe(
          Effect.flatMap(
            Option.match({
              onNone: () =>
                Effect.fail(new Unauthorized({ message: 'Invalid or expired session' })),
              onSome: (s): Effect.Effect<CurrentUserShape> =>
                Effect.succeed({
                  userId: s.userId,
                  activeCompanyId: s.activeCompanyId,
                  role: s.role
                })
            })
          )
        )
    }
  })
)

/** The raw cookie value of the current request (`''` when absent). */
export const currentSessionToken = HttpServerRequest.HttpServerRequest.pipe(
  Effect.map((request) => request.cookies[SESSION_COOKIE] ?? '')
)

const decodeSessionId = Schema.decodeUnknownOption(SessionId)

/** The current request's session id (None when the cookie is missing or malformed). */
export const currentSessionId: Effect.Effect<
  Option.Option<SessionId>,
  never,
  HttpServerRequest.HttpServerRequest
> = currentSessionToken.pipe(Effect.map(decodeSessionId))

/** Set the httpOnly session cookie on the pending response (30 days, `Secure` per config). */
export const setSessionCookie = (sessionId: SessionId) =>
  Effect.gen(function* () {
    const config = yield* AppConfig
    yield* HttpApiBuilder.securitySetCookie(Authentication.security.session, sessionId, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: 'lax',
      path: '/',
      maxAge: SESSION_TTL
    })
  })

export const clearSessionCookie = Effect.gen(function* () {
  const config = yield* AppConfig
  yield* HttpApiBuilder.securitySetCookie(Authentication.security.session, '', {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    expires: new Date(0)
  })
})
