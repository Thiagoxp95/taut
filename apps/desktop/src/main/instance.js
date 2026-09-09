import { Data, Effect, Either, Schema } from 'effect'
/** `GET /api/health` — mirrors `apps/server/src/http/serverApi.ts`. */
const Health = Schema.Struct({ ok: Schema.Literal(true), version: Schema.String })
const decodeHealth = Schema.decodeUnknownEither(Health)
const PROBE_TIMEOUT = '5 seconds'
export class InvalidInstanceUrl extends Data.TaggedError('InvalidInstanceUrl') {}
export class InstanceUnreachable extends Data.TaggedError('InstanceUnreachable') {}
/**
 * `localhost:3000` → `http://localhost:3000`, and every form collapses to an
 * origin: the allowlist below compares origins, so a stored path or query
 * would quietly widen it.
 */
export const normalizeInstanceUrl = (raw) => {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (trimmed.length === 0) {
    return Either.left(new InvalidInstanceUrl({ message: 'Enter the URL of your Taut server.' }))
  }
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  try {
    const url = new URL(withScheme)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return Either.left(new InvalidInstanceUrl({ message: 'Only http:// and https:// work.' }))
    }
    return Either.right(url.origin)
  } catch {
    return Either.left(new InvalidInstanceUrl({ message: `"${raw}" is not a URL.` }))
  }
}
/** `http://host` → `ws://host/ws?since=n` (and `https` → `wss`). */
export const socketUrl = (instanceUrl, since) => {
  const url = new URL('/ws', instanceUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('since', String(since))
  return url.toString()
}
/**
 * Is this a Taut server? `GET /api/health` is unauthenticated, so it answers
 * before the user has logged in — which is the whole point of the check.
 */
export const probeInstance = (origin) =>
  Effect.tryPromise({
    try: (signal) =>
      fetch(new URL('/api/health', origin), { signal, redirect: 'error' }).then((response) =>
        response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))
      ),
    catch: (cause) =>
      new InstanceUnreachable({
        message: `Could not reach ${origin} — ${cause instanceof Error ? cause.message : String(cause)}`
      })
  }).pipe(
    Effect.timeoutFail({
      duration: PROBE_TIMEOUT,
      onTimeout: () => new InstanceUnreachable({ message: `${origin} did not answer in time.` })
    }),
    Effect.flatMap((body) =>
      decodeHealth(body).pipe(
        Either.mapLeft(
          () =>
            new InstanceUnreachable({
              message: `${origin} answered, but it is not a Taut server.`
            })
        )
      )
    ),
    Effect.map(({ version }) => ({ version }))
  )
