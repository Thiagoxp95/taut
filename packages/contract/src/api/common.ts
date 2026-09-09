import { Schema } from 'effect'

/** Every list endpoint returns `{ items, nextCursor? }`. */
export const Page = <S extends Schema.Schema.Any>(item: S) =>
  Schema.Struct({
    items: Schema.Array(item),
    nextCursor: Schema.optional(Schema.String)
  })

export const Limit = Schema.NumberFromString.pipe(Schema.int(), Schema.between(1, 200))

export const PageQuery = Schema.Struct({
  cursor: Schema.optional(Schema.String),
  limit: Schema.optional(Limit)
})
export type PageQuery = typeof PageQuery.Type
