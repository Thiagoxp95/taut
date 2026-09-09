import { Schema } from 'effect'

import { SessionId, UserId } from '../ids.js'
import { Avatar } from './avatar.js'
import { DisplayName, Email } from './primitives.js'

/**
 * Public user shape. The password hash never leaves the server; the server
 * keeps its own internal row schema with `passwordHash`.
 */
export class User extends Schema.Class<User>('User')({
  id: UserId,
  email: Email,
  name: DisplayName,
  avatar: Avatar,
  createdAt: Schema.DateTimeUtc
}) {}

export class Session extends Schema.Class<Session>('Session')({
  id: SessionId,
  userId: UserId,
  expiresAt: Schema.DateTimeUtc
}) {}
