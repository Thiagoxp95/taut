import { SESSION_COOKIE } from '@taut/contract/api'
import type { CompanyId, UserId } from '@taut/contract/ids'
import { Context, Data, Effect, Layer, Option } from 'effect'
import type { IncomingMessage } from 'node:http'
import { Sessions } from './sessions.js'

export interface Principal {
  readonly userId: UserId
  readonly companyId: CompanyId
}

export class WsUnauthorized extends Data.TaggedError('WsUnauthorized')<{
  /** HTTP status written on the failed upgrade: 401 (no session) or 403 (no active company). */
  readonly status: 401 | 403
  readonly reason: string
}> {}

/** Resolves the upgrade request's cookie to the socket's user + company. */
export class WsAuthenticator extends Context.Tag('WsAuthenticator')<
  WsAuthenticator,
  { readonly authenticate: (req: IncomingMessage) => Effect.Effect<Principal, WsUnauthorized> }
>() {}

export const parseCookies = (header: string | undefined): Record<string, string> => {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    if (name.length === 0) continue
    out[name] = decodeURIComponent(part.slice(eq + 1).trim())
  }
  return out
}

/** Same cookie → session → active company resolution as the HTTP `Authentication` middleware. */
export const WsAuthenticatorLive = Layer.effect(
  WsAuthenticator,
  Effect.gen(function* () {
    const sessions = yield* Sessions
    return {
      authenticate: (req) =>
        Effect.gen(function* () {
          const token = parseCookies(req.headers.cookie)[SESSION_COOKIE] ?? ''
          const resolved = yield* sessions.resolve(token)
          if (Option.isNone(resolved)) {
            return yield* new WsUnauthorized({ status: 401, reason: 'invalid session' })
          }
          const companyId = resolved.value.activeCompanyId
          if (companyId === undefined) {
            return yield* new WsUnauthorized({ status: 403, reason: 'no active company' })
          }
          return { userId: resolved.value.userId, companyId }
        })
    }
  })
)
