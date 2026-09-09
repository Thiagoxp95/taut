import { Effect, HashMap, Option, PubSub, Queue, Stream, SynchronizedRef } from 'effect'
import type { CompanyId } from '@taut/contract/ids'
import type { BusMessage } from './events.js'

/**
 * In-process fan-out, one `PubSub` per company (agent-model.md §6 "Bus").
 * Single container in MVP; this interface is what a Redis/NATS bus would implement later.
 */
export class Bus extends Effect.Service<Bus>()('Bus', {
  scoped: Effect.gen(function* () {
    const topics = yield* SynchronizedRef.make(HashMap.empty<string, PubSub.PubSub<BusMessage>>())
    /** Every message of every company — for the scheduler and the memory ingest, which span companies. */
    const all = yield* PubSub.unbounded<BusMessage>()

    yield* Effect.addFinalizer(() => PubSub.shutdown(all))
    yield* Effect.addFinalizer(() =>
      SynchronizedRef.get(topics).pipe(
        Effect.flatMap((map) =>
          Effect.forEach(HashMap.values(map), (pubsub) => PubSub.shutdown(pubsub), {
            discard: true
          })
        )
      )
    )

    const topic = (companyId: CompanyId) =>
      SynchronizedRef.modifyEffect(topics, (map) =>
        Option.match(HashMap.get(map, companyId), {
          onSome: (pubsub) => Effect.succeed([pubsub, map] as const),
          onNone: () =>
            PubSub.unbounded<BusMessage>().pipe(
              Effect.map((pubsub) => [pubsub, HashMap.set(map, companyId, pubsub)] as const)
            )
        })
      )

    const publish = (message: BusMessage): Effect.Effect<void> =>
      topic(message.companyId).pipe(
        Effect.flatMap((pubsub) => PubSub.publish(pubsub, message)),
        Effect.zipRight(PubSub.publish(all, message)),
        Effect.asVoid
      )

    /** Scoped subscription; released with the scope. Subscribe BEFORE replaying so nothing is missed. */
    const subscribe = (companyId: CompanyId) =>
      topic(companyId).pipe(Effect.flatMap((pubsub) => PubSub.subscribe(pubsub)))

    const stream = (companyId: CompanyId): Stream.Stream<BusMessage> =>
      Stream.unwrapScoped(subscribe(companyId).pipe(Effect.map((queue) => Stream.fromQueue(queue))))

    /** Scoped subscription to every company's messages. */
    const subscribeAll = () => PubSub.subscribe(all)

    const streamAll = (): Stream.Stream<BusMessage> =>
      Stream.unwrapScoped(subscribeAll().pipe(Effect.map((queue) => Stream.fromQueue(queue))))

    return { publish, subscribe, stream, subscribeAll, streamAll } as const
  })
}) {}

export type BusSubscription = Queue.Dequeue<BusMessage>
