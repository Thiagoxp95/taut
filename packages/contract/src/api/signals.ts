import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { Signal, SignalStatus } from '../domain/signal.js'
import { Forbidden, NotFound } from '../errors.js'
import { AgentId, SignalId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

/**
 * The human half of signals (docs/build-plan-triggers.md D26): see what an agent has armed, and
 * kill a reminder you no longer want. Emitting is **not** exposed over HTTP in this pass — agents
 * emit through their tool surface (`emit_signal`), which is where the D23–D25 budgets live.
 */
export const ListSignalsQuery = Schema.Struct({
  ...PageQuery.fields,
  /** The emitting agent. The thread affordance passes it to show one agent's pending wakes. */
  agentId: Schema.optional(AgentId),
  /** Absent = every status; the thread row asks for `pending`. */
  status: Schema.optional(SignalStatus)
})

const SignalPath = Schema.Struct({ signalId: SignalId })

export class SignalsGroup extends HttpApiGroup.make('signals')
  .add(
    HttpApiEndpoint.get('list', '/')
      .setUrlParams(ListSignalsQuery)
      .addSuccess(Page(Signal))
      .addError(Forbidden)
  )
  .add(
    /** Cancels a pending signal; already delivered or already cancelled is a no-op, not an error. */
    HttpApiEndpoint.del('delete', '/:signalId')
      .setPath(SignalPath)
      .addError(Forbidden)
      .addError(NotFound)
  )
  .middleware(Authentication)
  .prefix('/signals') {}
