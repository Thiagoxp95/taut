import { FileSystem, HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Attachments, contentDisposition, isInlineMimeType } from '../services/attachments.js'
import { ServerApi } from './serverApi.js'

/**
 * `/api/attachments` (docs/build-plan-attachments.md D2, D5). `content` is a raw handler: the
 * bytes stream from the blob store behind the session cookie, so a plain `<img src>` works in
 * the web and desktop apps. `Content-Disposition: inline` only for the D5 allow-list (SVG and
 * anything else download), `nosniff`, and a year-long private cache — the bytes of an id never
 * change.
 */
export const AttachmentsLive = HttpApiBuilder.group(ServerApi, 'attachments', (handlers) =>
  handlers
    .handle('upload', ({ payload }) =>
      Effect.gen(function* () {
        const attachments = yield* Attachments
        return yield* attachments.upload(yield* CurrentUser, payload.channelId, payload.file)
      })
    )
    .handle('get', ({ path }) =>
      Effect.gen(function* () {
        const attachments = yield* Attachments
        return yield* attachments.get(yield* CurrentUser, path.attachmentId)
      })
    )
    .handleRaw('content', ({ path, urlParams }) =>
      Effect.gen(function* () {
        const attachments = yield* Attachments
        const fs = yield* FileSystem.FileSystem
        const { path: file, attachment } = yield* attachments.openContent(
          yield* CurrentUser,
          path.attachmentId
        )
        const inline = urlParams.download !== true && isInlineMimeType(attachment.mimeType)
        // Streamed by hand rather than `HttpServerResponse.file`: that helper derives the type
        // from the extension (the blob has none) and ignores `contentType`.
        const info = yield* fs.stat(file).pipe(Effect.orDie)
        return HttpServerResponse.stream(fs.stream(file), {
          contentType: attachment.mimeType,
          contentLength: Number(info.size),
          headers: {
            'content-disposition': contentDisposition(
              inline ? 'inline' : 'attachment',
              attachment.name
            ),
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, max-age=31536000, immutable'
          }
        })
      })
    )
)
