import { SqlSchema } from '@effect/sql'
import { Effect, Option, Schema } from 'effect'

/**
 * Thin wrappers over `SqlSchema` that turn infrastructure failures (`SqlError`,
 * `ParseError`) into defects. Repositories never fail with anything but domain
 * errors, so handlers only surface the errors their endpoint declares; a broken
 * query or an undecodable row is a bug, not a 4xx.
 */

export const findAll = <IA, II, A, AI, E, R>(options: {
  readonly Request: Schema.Schema<IA, II, never>
  readonly Result: Schema.Schema<A, AI, never>
  readonly execute: (request: II) => Effect.Effect<ReadonlyArray<unknown>, E, R>
}): ((request: IA) => Effect.Effect<ReadonlyArray<A>, never, R>) => {
  const run = SqlSchema.findAll(options)
  return (request) => Effect.orDie(run(request))
}

export const findOne = <IA, II, A, AI, E, R>(options: {
  readonly Request: Schema.Schema<IA, II, never>
  readonly Result: Schema.Schema<A, AI, never>
  readonly execute: (request: II) => Effect.Effect<ReadonlyArray<unknown>, E, R>
}): ((request: IA) => Effect.Effect<Option.Option<A>, never, R>) => {
  const run = SqlSchema.findOne(options)
  return (request) => Effect.orDie(run(request))
}

/** Exactly one row (aggregates such as `SELECT COUNT(*)`); no row is a defect. */
export const single = <IA, II, A, AI, E, R>(options: {
  readonly Request: Schema.Schema<IA, II, never>
  readonly Result: Schema.Schema<A, AI, never>
  readonly execute: (request: II) => Effect.Effect<ReadonlyArray<unknown>, E, R>
}): ((request: IA) => Effect.Effect<A, never, R>) => {
  const run = SqlSchema.single(options)
  return (request) => Effect.orDie(run(request))
}

export const run = <IA, II, E, R>(options: {
  readonly Request: Schema.Schema<IA, II, never>
  readonly execute: (request: II) => Effect.Effect<unknown, E, R>
}): ((request: IA) => Effect.Effect<void, never, R>) => {
  const exec = SqlSchema.void(options)
  return (request) => Effect.orDie(exec(request))
}

export const Count = Schema.Struct({ n: Schema.Number })

/** Wall-clock ISO timestamp for `*_at` columns (not the Effect `Clock`, so tests keep real ordering). */
export const nowIso = (): string => new Date().toISOString()
