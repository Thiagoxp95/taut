/**
 * The typed client derived from `@taut/contract`'s `HttpApi`.
 *
 * There is exactly one `HttpApiClient.make(TautApi)` in the app; it lives in
 * the `ManagedRuntime` built in `runtime.ts` and every hook in `api.ts` runs
 * through it. No hand-written `fetch` anywhere.
 */
import { FetchHttpClient, HttpApiClient } from '@effect/platform'
import { TautApi } from '@taut/contract'
import { Context, Effect, Layer } from 'effect'

/** Same-origin so the `taut_session` cookie rides along; `include` is explicit. */
const FetchLive = FetchHttpClient.layer.pipe(
  Layer.provide(Layer.succeed(FetchHttpClient.RequestInit, { credentials: 'include' }))
)

const makeClient = HttpApiClient.make(TautApi, { baseUrl: '' })

export type TautClient = Effect.Effect.Success<typeof makeClient>

export class Api extends Context.Tag('@taut/web/Api')<Api, TautClient>() {}

export const ApiLive: Layer.Layer<Api> = Layer.effect(Api, makeClient).pipe(
  Layer.provide(FetchLive)
)

/** `Effect.gen` sugar: `call((api) => api.auth.me())`. */
export const call = <A, E>(
  f: (api: TautClient) => Effect.Effect<A, E, never>
): Effect.Effect<A, E, Api> => Effect.flatMap(Api, f)

// --- errors ---------------------------------------------------------------

/**
 * Every contract `TaggedError` (plus transport/decode failures) reaches React
 * as one of these, so components and toasts only ever see `{ tag, message }`.
 */
export class ApiError extends Error {
  readonly tag: string

  constructor(tag: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'ApiError'
    this.tag = tag
  }
}

const readString = (source: Record<string, unknown>, key: string): string | undefined => {
  const value = source[key]
  return typeof value === 'string' && value !== '' ? value : undefined
}

export function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  if (typeof error !== 'object' || error === null) {
    return new ApiError('Unknown', 'Something went wrong', { cause: error })
  }

  const record = error as Record<string, unknown>
  const tag = readString(record, '_tag') ?? 'Unknown'

  // `NotFound`/`Conflict`/`Validation`/`RuntimeUnavailable` compute `message`.
  const message =
    readString(record, 'message') ??
    (tag === 'RequestError' || tag === 'ResponseError'
      ? 'Could not reach the server'
      : 'Something went wrong')

  if (tag === 'ParseError') {
    return new ApiError('ParseError', 'The server sent a response Taut could not read', {
      cause: error
    })
  }

  return new ApiError(tag, message, { cause: error })
}
