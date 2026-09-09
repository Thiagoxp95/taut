import { SqlClient } from '@effect/sql'
import { SqlError } from '@effect/sql/SqlError'
import type { Event, EventBody } from '@taut/contract/events'
import type { CompanyId } from '@taut/contract/ids'
import { Effect } from 'effect'
import { Bus } from '../realtime/bus.js'
import { EventLog } from '../realtime/eventLog.js'

/** Appends an event to the company log inside the surrounding transaction. */
export type Emit = (body: EventBody) => Effect.Effect<Event>

const isSqlError = (u: unknown): u is SqlError => u instanceof SqlError

/**
 * The one way mutations reach the event log (build-plan "Realtime"): `transact` runs
 * `body` inside `sql.withTransaction`, every `emit` appends to `events` in that same
 * transaction, and only after commit are the appended events published on `Bus`.
 * A rolled-back transaction publishes nothing.
 */
export class EventPublisher extends Effect.Service<EventPublisher>()('EventPublisher', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const log = yield* EventLog
    const bus = yield* Bus

    const transact = <A, E, R>(
      companyId: CompanyId,
      body: (emit: Emit) => Effect.Effect<A, E, R>
    ): Effect.Effect<A, Exclude<E, SqlError>, R> =>
      Effect.gen(function* () {
        const pending: Array<Event> = []
        const emit: Emit = (b) =>
          log.append(companyId, b).pipe(
            Effect.orDie,
            Effect.tap((event) =>
              Effect.sync(() => {
                pending.push(event)
              })
            )
          )
        const result = yield* sql
          .withTransaction(body(emit))
          .pipe(Effect.catchIf(isSqlError, (error) => Effect.die(error)))
        yield* Effect.forEach(
          pending,
          (event) => bus.publish({ _tag: 'Event', companyId, event }),
          { discard: true }
        )
        return result
      })

    return { transact } as const
  })
}) {}
