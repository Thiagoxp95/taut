import {
  HttpApiBuilder,
  HttpMiddleware,
  HttpServerRequest,
  HttpServerResponse,
  Multipart
} from '@effect/platform'
import { NodeHttpServer } from '@effect/platform-node'
import { Effect, Layer, Option } from 'effect'
import { createServer } from 'node:http'
import { AppConfig } from '../config.js'
import { ApiLive } from './api.js'
import { GithubRedirectLive } from './repositories.js'
import { StaticLive } from './static.js'

/** The raw Node server, shared by the HTTP app and the `/ws` upgrade handler. */
export class HttpNodeServer extends Effect.Service<HttpNodeServer>()('HttpNodeServer', {
  sync: () => ({ server: createServer() })
}) {}

/** Listens on `PORT` (0 = random, handy in tests). Closed when the layer scope ends. */
export const NodeHttpServerLive = Layer.unwrapEffect(
  Effect.gen(function* () {
    const { server } = yield* HttpNodeServer
    const config = yield* AppConfig
    return NodeHttpServer.layer(() => server, { port: config.port })
  })
)

/**
 * A multipart body is the file plus the boundaries and part headers (`channelId` field,
 * `Content-Disposition` with the file name, `Content-Type`), so the transport cap sits this much
 * above the per-file limit: the exact check on the bytes is `Attachments.store` (422). This one
 * is the backstop that refuses an oversize request early instead of spooling it to disk.
 */
const MULTIPART_HEADROOM = 4 * 1024

const fileTooLarge = HttpServerResponse.unsafeJson(
  {
    _tag: 'Validation',
    issues: [{ path: ['file'], message: 'file is larger than TAUT_ATTACHMENT_MAX_BYTES allows' }]
  },
  { status: 422 }
)

/**
 * Multipart uploads (`attachments.upload`, `agents.uploadFile`) are refused just above
 * `TAUT_ATTACHMENT_MAX_BYTES` (docs/build-plan-attachments.md D6) by their declared
 * `Content-Length`, before the body is parsed. Browsers (`fetch` with a `FormData` body) and
 * curl always declare it. Not `Multipart.MaxFileSize`: with platform 0.97.1 a part that trips the
 * parser's cap mid-file leaves its channel waiting on a mailbox that already ended, and the
 * request hangs with no response (`Multipart.makeChannel` never marks the part finished on
 * `ReachedLimit`; reproduced with a 200 KB upload against a 100 KB limit). A chunked body with no
 * length still spools to the temp dir and gets the 422 from `Attachments.store`.
 */
const MultipartLengthBackstopLive = HttpApiBuilder.middleware(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const cap = config.attachmentMaxBytes + MULTIPART_HEADROOM
    return (httpApp) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const type = request.headers['content-type'] ?? ''
        const length = Number(request.headers['content-length'])
        if (type.startsWith('multipart/form-data') && Number.isFinite(length) && length > cap) {
          return fileTooLarge
        }
        return yield* httpApp
      })
  })
)

const isMultipartError = (u: unknown): u is Multipart.MultipartError =>
  typeof u === 'object' && u !== null && (u as { _tag?: unknown })._tag === 'MultipartError'

/**
 * `HttpApiBuilder` parses multipart bodies with `orDie`, so a malformed body (or a limit, should
 * one be provided again) would surface as a 500. This API-level middleware (it wraps the router
 * before the builder's own cause handling) turns that defect into the `Validation` 422 the
 * `attachments.upload` / `agents.uploadFile` endpoints declare — the same shape the typed client
 * decodes.
 */
const MultipartLimitErrorsLive = HttpApiBuilder.middleware((httpApp) =>
  httpApp.pipe(
    Effect.catchSomeDefect((defect) =>
      isMultipartError(defect)
        ? Option.some(
            defect.reason === 'FileTooLarge' || defect.reason === 'BodyTooLarge'
              ? fileTooLarge
              : HttpServerResponse.unsafeJson(
                  {
                    _tag: 'Validation',
                    issues: [
                      { path: ['file'], message: `multipart body rejected: ${defect.reason}` }
                    ]
                  },
                  { status: 422 }
                )
          )
        : Option.none()
    )
  )
)

/**
 * HttpApi routes (`/api/*`) + static SPA, served on the shared Node server.
 * Exposes `HttpServer` so callers can read the bound address.
 */
export const HttpLive = HttpApiBuilder.serve(HttpMiddleware.logger).pipe(
  Layer.provide(StaticLive),
  // Before the SPA fallback: these two are `/api/*` routes GitHub redirects into.
  Layer.provide(GithubRedirectLive),
  Layer.provide(ApiLive),
  Layer.provide(MultipartLimitErrorsLive),
  Layer.provide(MultipartLengthBackstopLive),
  Layer.provideMerge(NodeHttpServerLive)
)
