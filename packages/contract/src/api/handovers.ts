import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { HandoverStatus } from '../domain/enums.js'
import { Handover } from '../domain/handover.js'
import { Conflict, Forbidden, NotFound } from '../errors.js'
import { HandoverId } from '../ids.js'
import { Authentication } from './middleware.js'

export const ListHandoversQuery = Schema.Struct({
  /** Defaults to `open` — the queue a head actually works from. */
  status: Schema.optional(HandoverStatus)
})

const HandoverPath = Schema.Struct({ handoverId: HandoverId })

/** The note the head sends the other head; defaults to the agent's own text, quoted. */
export const RaiseHandoverBody = Schema.Struct({
  text: Schema.optional(Schema.String.pipe(Schema.minLength(1), Schema.maxLength(4000)))
})

/**
 * A head's queue of refused cross-department attempts (docs/agent-model.md §9). Visible to the
 * head of the department the attempt came from and to admins; `raise` DMs the other head as the
 * caller, `dismiss` closes it silently. Both are idempotent-by-conflict: a resolved handover
 * cannot be resolved twice.
 */
export class HandoversGroup extends HttpApiGroup.make('handovers')
  .add(
    HttpApiEndpoint.get('list', '/')
      .setUrlParams(ListHandoversQuery)
      .addSuccess(Schema.Array(Handover))
  )
  .add(
    HttpApiEndpoint.post('raise', '/:handoverId/raise')
      .setPath(HandoverPath)
      .setPayload(RaiseHandoverBody)
      .addSuccess(Handover)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
  )
  .add(
    HttpApiEndpoint.post('dismiss', '/:handoverId/dismiss')
      .setPath(HandoverPath)
      .addSuccess(Handover)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
  )
  .middleware(Authentication)
  .prefix('/handovers') {}
