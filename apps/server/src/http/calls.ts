import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { actor } from '../services/access.js'
import { Calls } from '../services/calls.js'
import { ServerApi } from './serverApi.js'

/**
 * `/api/calls` (docs/build-plan-calls.md). `join` is start-or-join (D1), so there is no
 * "start" verb; `config` is the only endpoint that means anything when LiveKit is unset.
 */
export const CallsLive = HttpApiBuilder.group(ServerApi, 'calls', (handlers) =>
  handlers
    .handle('config', () => Effect.flatMap(Calls, (calls) => calls.config))
    .handle('active', () =>
      Effect.gen(function* () {
        const calls = yield* Calls
        return yield* calls.active(yield* actor(yield* CurrentUser))
      })
    )
    .handle('join', ({ path }) =>
      Effect.gen(function* () {
        const calls = yield* Calls
        return yield* calls.join(yield* actor(yield* CurrentUser), path.channelId)
      })
    )
    .handle('leave', ({ path }) =>
      Effect.gen(function* () {
        const calls = yield* Calls
        return yield* calls.leave(yield* actor(yield* CurrentUser), path.callId)
      })
    )
)

/**
 * `/api/hooks/livekit` (D2). Raw on purpose: LiveKit's JWT carries a sha256 of the request
 * body, so the bytes must reach `WebhookReceiver` exactly as they arrived — a schema-decoded
 * payload re-serialises and every signature fails. No session either; the signature is the
 * authentication.
 */
export const HooksLive = HttpApiBuilder.group(ServerApi, 'hooks', (handlers) =>
  handlers.handleRaw('livekit', () =>
    Effect.gen(function* () {
      const calls = yield* Calls
      const request = yield* HttpServerRequest.HttpServerRequest
      // A body we cannot even read is a broken client, not a failed signature.
      const body = yield* Effect.orDie(request.text)
      yield* calls.handleWebhook(body, request.headers['authorization'] ?? '')
      return HttpServerResponse.empty({ status: 204 })
    })
  )
)
