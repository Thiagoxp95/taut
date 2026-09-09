import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Call, CallCredentials } from '../domain/call.js'
import { Forbidden, NotFound, Unauthorized, Validation } from '../errors.js'
import { CallId, ChannelId } from '../ids.js'
import { Authentication } from './middleware.js'

/**
 * Whether this deployment can hold a huddle at all (docs/build-plan-calls.md D3). False unless
 * `TAUT_LIVEKIT_URL`, `TAUT_LIVEKIT_API_KEY` and `TAUT_LIVEKIT_API_SECRET` are all set; the UI
 * hides every huddle affordance when it is.
 */
export const CallsConfig = Schema.Struct({ enabled: Schema.Boolean })
export type CallsConfig = typeof CallsConfig.Type

const CallPath = Schema.Struct({ callId: CallId })

/**
 * `/api/calls`. `join` is start-or-join: one huddle per channel, created on the first person
 * through the door (D1). It returns a token scoped to that one room, so nothing here needs a
 * separate "start" verb.
 */
export class CallsGroup extends HttpApiGroup.make('calls')
  .add(HttpApiEndpoint.get('config', '/config').addSuccess(CallsConfig))
  .add(HttpApiEndpoint.get('active', '/active').addSuccess(Schema.Array(Call)))
  .add(
    HttpApiEndpoint.post('join', '/channels/:channelId/join')
      .setPath(Schema.Struct({ channelId: ChannelId }))
      .addSuccess(CallCredentials)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.post('leave', '/:callId/leave')
      .setPath(CallPath)
      .addSuccess(Call)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .middleware(Authentication)
  .prefix('/calls') {}

/**
 * `/api/hooks/livekit` — unauthenticated by construction (D2). LiveKit signs the request body
 * with the API secret and puts the JWT in `Authorization`; the server verifies it against the
 * *raw* bytes, so the handler must read the body itself rather than let a schema decode it.
 *
 * Named `hooks` rather than `callHooks` because every endpoint in this API is mounted at
 * `/api/<group name>`, and any future inbound webhook belongs here too.
 */
export class HooksGroup extends HttpApiGroup.make('hooks')
  .add(HttpApiEndpoint.post('livekit', '/livekit').addSuccess(Schema.Void).addError(Unauthorized))
  .prefix('/hooks') {}
