import { Schema } from 'effect'

/** Company/department slug: lowercase, digits, hyphens; used for on-disk folders. */
export const Slug = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/, {
    identifier: 'Slug',
    message: () => 'slug must be 1–40 chars of a-z, 0-9 and hyphens, not starting/ending with -'
  })
)
export type Slug = typeof Slug.Type

/** Agent handle: `@mentionable`, unique within a company. */
export const Handle = Schema.String.pipe(
  Schema.pattern(/^[a-z0-9][a-z0-9_-]{1,31}$/, {
    identifier: 'Handle',
    message: () => 'handle must be 2–32 chars of a-z, 0-9, _ and -'
  })
)
export type Handle = typeof Handle.Type

export const Email = Schema.String.pipe(
  Schema.pattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/, {
    identifier: 'Email',
    message: () => 'invalid email address'
  })
)
export type Email = typeof Email.Type

export const Password = Schema.String.pipe(
  Schema.minLength(8),
  Schema.maxLength(256),
  Schema.annotations({ identifier: 'Password' })
)
export type Password = typeof Password.Type

/** Short display name (user, company, department, channel, agent). */
export const DisplayName = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(80),
  Schema.annotations({ identifier: 'DisplayName' })
)
export type DisplayName = typeof DisplayName.Type
