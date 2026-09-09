import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, Multipart } from '@effect/platform'
import { Schema } from 'effect'

import { Attachment } from '../domain/attachment.js'
import { Forbidden, NotFound, Validation } from '../errors.js'
import { AttachmentId, ChannelId } from '../ids.js'
import { Authentication } from './middleware.js'

/**
 * One file per request (docs/build-plan-attachments.md D2). The result is an orphan until a
 * `messages.create` carries its id in `attachmentIds`.
 */
export const UploadAttachmentPayload = HttpApiSchema.Multipart(
  Schema.Struct({
    /** Channel the file will be posted in; the uploader needs post rights there. */
    channelId: ChannelId,
    file: Multipart.SingleFileSchema
  })
)

export const AttachmentContentQuery = Schema.Struct({
  /** `?download=1` forces `Content-Disposition: attachment` (D5). */
  download: Schema.optional(Schema.BooleanFromString)
})

/**
 * Raw bytes, streamed by the server with `handlers.handleRaw` + `HttpServerResponse.file`
 * (D5 headers). Declared as a binary body so the OpenAPI document and the derived client
 * describe a 200 with content, not JSON.
 */
export const AttachmentContent = Schema.Uint8ArrayFromSelf.pipe(
  HttpApiSchema.withEncoding({ kind: 'Uint8Array', contentType: 'application/octet-stream' })
)

const AttachmentPath = Schema.Struct({ attachmentId: AttachmentId })

export class AttachmentsGroup extends HttpApiGroup.make('attachments')
  .add(
    HttpApiEndpoint.post('upload', '/')
      .setPayload(UploadAttachmentPayload)
      .addSuccess(Attachment, { status: 201 })
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.get('get', '/:attachmentId')
      .setPath(AttachmentPath)
      .addSuccess(Attachment)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.get('content', '/:attachmentId/content')
      .setPath(AttachmentPath)
      .setUrlParams(AttachmentContentQuery)
      .addSuccess(AttachmentContent)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .middleware(Authentication)
  .prefix('/attachments') {}
