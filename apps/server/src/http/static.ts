import {
  FileSystem,
  HttpApiBuilder,
  HttpServerRequest,
  HttpServerResponse,
  Path
} from '@effect/platform'
import { Effect } from 'effect'
import { AppConfig } from '../config.js'

/**
 * Serves the built web client (`TAUT_WEB_DIST`, default `../web/dist`) at `/` with SPA
 * fallback to `index.html`. Registers nothing when the directory does not exist, so
 * `pnpm dev` (Vite serves the client) and tests are unaffected. `/api/*` and `/ws`
 * are never swallowed by the fallback.
 */
export const StaticLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const config = yield* AppConfig
    const dist = config.webDist
    const index = path.join(dist, 'index.html')

    if (!(yield* fs.exists(index))) {
      yield* Effect.logDebug(`static: ${dist} not found, SPA serving disabled`)
      return
    }
    yield* Effect.logInfo(`static: serving ${dist} at /`)

    const isFile = (candidate: string) =>
      fs.stat(candidate).pipe(
        Effect.map((info) => info.type === 'File'),
        Effect.orElseSucceed(() => false)
      )

    yield* router.get(
      '*',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
        if (pathname.startsWith('/api/') || pathname === '/ws') {
          return HttpServerResponse.empty({ status: 404 })
        }
        const candidate = path.resolve(dist, `.${pathname}`)
        const inside = candidate === dist || candidate.startsWith(dist + path.sep)
        const target = inside && (yield* isFile(candidate)) ? candidate : index
        return yield* HttpServerResponse.file(target)
      }).pipe(Effect.catchAll(() => Effect.succeed(HttpServerResponse.empty({ status: 404 }))))
    )
  })
)
