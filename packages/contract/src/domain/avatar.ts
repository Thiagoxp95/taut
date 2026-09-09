import { Schema } from 'effect'

export const EmojiAvatar = Schema.Struct({
  kind: Schema.Literal('emoji'),
  value: Schema.NonEmptyString
})
export type EmojiAvatar = typeof EmojiAvatar.Type

export const ImageAvatar = Schema.Struct({
  kind: Schema.Literal('image'),
  assetId: Schema.NonEmptyString
})
export type ImageAvatar = typeof ImageAvatar.Type

export const Avatar = Schema.Union(EmojiAvatar, ImageAvatar)
export type Avatar = typeof Avatar.Type
