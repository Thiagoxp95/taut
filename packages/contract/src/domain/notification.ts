import { Schema } from 'effect'

import { CompanyId, EventSeq, NotificationId, UserId } from '../ids.js'
import { NotificationKind } from './enums.js'

export class Notification extends Schema.Class<Notification>('Notification')({
  id: NotificationId,
  companyId: CompanyId,
  userId: UserId,
  eventSeq: EventSeq,
  kind: NotificationKind,
  readAt: Schema.optional(Schema.DateTimeUtc)
}) {}
