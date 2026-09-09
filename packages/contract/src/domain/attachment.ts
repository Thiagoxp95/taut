import { Schema } from 'effect'

import { AttachmentId, ChannelId, CompanyId, MemberId, MessageId } from '../ids.js'
import { AuthorKind } from './enums.js'

/**
 * A file sent in chat (docs/build-plan-attachments.md D1). The bytes live in the company
 * blob store; this is the row. Serve with `attachments.content`.
 */
export class Attachment extends Schema.Class<Attachment>('Attachment')({
  id: AttachmentId,
  companyId: CompanyId,
  channelId: ChannelId,
  /** Unset while the upload is an orphan (not yet sent). */
  messageId: Schema.optional(MessageId),
  uploaderKind: AuthorKind,
  uploaderId: MemberId,
  /** Bare file name as shown to humans and as written into inbox/. */
  name: Schema.String,
  mimeType: Schema.String,
  size: Schema.NonNegativeInt,
  createdAt: Schema.DateTimeUtc
}) {}
