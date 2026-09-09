import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import {
  PushDevice,
  PushEndpointPayload,
  PushKey,
  PushSubscriptionPayload
} from '../domain/push.js'
import { Validation } from '../errors.js'
import { Authentication } from './middleware.js'

/**
 * Web Push device registry (docs/build-plan.md → "PWA"). The service worker's
 * `pushManager.subscribe` result is POSTed here; the server sends notifications to
 * every registered endpoint of a user when they get a `notification` event.
 */
export class PushGroup extends HttpApiGroup.make('push')
  .add(
    /** The VAPID public key, or `{}` when push is not configured on this server. */
    HttpApiEndpoint.get('key', '/key').addSuccess(PushKey)
  )
  .add(
    /** Idempotent per endpoint: re-subscribing the same browser refreshes the keys. */
    HttpApiEndpoint.post('subscribe', '/devices')
      .setPayload(PushSubscriptionPayload)
      .addSuccess(PushDevice, { status: 201 })
      .addError(Validation)
  )
  .add(
    /** Silent when the endpoint is unknown — unsubscribing twice is not an error. */
    HttpApiEndpoint.post('unsubscribe', '/devices/remove')
      .setPayload(PushEndpointPayload)
      .addSuccess(Schema.Void)
  )
  .add(HttpApiEndpoint.get('list', '/devices').addSuccess(Schema.Array(PushDevice)))
  .middleware(Authentication)
  .prefix('/push') {}
