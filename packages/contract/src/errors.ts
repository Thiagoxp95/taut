/**
 * Every error an endpoint can raise. Each carries an HTTP status via
 * `HttpApiSchema.annotations` so `HttpApiBuilder` (server) and
 * `HttpApiClient` (web) map it without any hand-written wiring.
 */
import { HttpApiSchema } from '@effect/platform'
import { Schema } from 'effect'

import { RuntimeKind } from './domain/enums.js'

export class Unauthorized extends Schema.TaggedError<Unauthorized>()(
  'Unauthorized',
  {
    message: Schema.optionalWith(Schema.String, { default: () => 'Authentication required' })
  },
  HttpApiSchema.annotations({ status: 401 })
) {}

export class Forbidden extends Schema.TaggedError<Forbidden>()(
  'Forbidden',
  {
    message: Schema.optionalWith(Schema.String, { default: () => 'Forbidden' })
  },
  HttpApiSchema.annotations({ status: 403 })
) {}

export class NotFound extends Schema.TaggedError<NotFound>()(
  'NotFound',
  {
    /** Entity name, e.g. "Channel". */
    entity: Schema.String,
    id: Schema.String
  },
  HttpApiSchema.annotations({ status: 404 })
) {
  override get message(): string {
    return `${this.entity} ${this.id} not found`
  }
}

export class Conflict extends Schema.TaggedError<Conflict>()(
  'Conflict',
  {
    reason: Schema.String
  },
  HttpApiSchema.annotations({ status: 409 })
) {
  override get message(): string {
    return this.reason
  }
}

export const ValidationIssue = Schema.Struct({
  path: Schema.Array(Schema.Union(Schema.String, Schema.Number)),
  message: Schema.String
})
export type ValidationIssue = typeof ValidationIssue.Type

/**
 * Semantic validation failures (e.g. credential kind not accepted by runtime).
 * Shape/decoding failures are `HttpApiDecodeError` (400) from the platform;
 * this is 422 so the two never share a status.
 */
export class Validation extends Schema.TaggedError<Validation>()(
  'Validation',
  {
    issues: Schema.Array(ValidationIssue)
  },
  HttpApiSchema.annotations({ status: 422 })
) {
  override get message(): string {
    return this.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
  }
}

export class RateLimited extends Schema.TaggedError<RateLimited>()(
  'RateLimited',
  {
    retryAfterSeconds: Schema.optional(Schema.NonNegativeInt)
  },
  HttpApiSchema.annotations({ status: 429 })
) {}

/** The vault cannot decrypt: `TAUT_MASTER_KEY` missing or wrong for this data. */
export class VaultLocked extends Schema.TaggedError<VaultLocked>()(
  'VaultLocked',
  {
    message: Schema.optionalWith(Schema.String, { default: () => 'Vault is locked' })
  },
  HttpApiSchema.annotations({ status: 423 })
) {}

/** No usable runtime seat: binary missing, pool exhausted, or provider down. */
export class RuntimeUnavailable extends Schema.TaggedError<RuntimeUnavailable>()(
  'RuntimeUnavailable',
  {
    runtime: RuntimeKind,
    reason: Schema.String
  },
  HttpApiSchema.annotations({ status: 503 })
) {
  override get message(): string {
    return `${this.runtime}: ${this.reason}`
  }
}

export const TautError = Schema.Union(
  Unauthorized,
  Forbidden,
  NotFound,
  Conflict,
  Validation,
  RateLimited,
  VaultLocked,
  RuntimeUnavailable
)
export type TautError = typeof TautError.Type
