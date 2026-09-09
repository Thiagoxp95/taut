import { HttpServer } from '@effect/platform'
import { NodeRuntime } from '@effect/platform-node'
import { Duration, Effect, Layer } from 'effect'
import { AppConfig } from './config.js'
import { AppLive } from './layers.js'
import { WS_PATH } from './realtime/ws.js'
import { Attachments } from './services/attachments.js'
import { Subscriptions } from './services/subscriptions.js'

/** Uploads never sent (docs/build-plan-attachments.md D7) go after a day; once, at start. */
const ORPHAN_ATTACHMENT_AGE = Duration.hours(24)

const announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const config = yield* AppConfig
    const { address } = yield* HttpServer.HttpServer
    if (address._tag === 'TcpAddress') {
      yield* Effect.logInfo(
        `Taut ${config.version} listening on http://localhost:${address.port} (ws://localhost:${address.port}${WS_PATH}) — data: ${config.dataDir}`
      )
    }
  })
)

const sweepOrphans = Layer.effectDiscard(
  Effect.gen(function* () {
    const attachments = yield* Attachments
    const removed = yield* attachments.sweepOrphans(ORPHAN_ATTACHMENT_AGE)
    if (removed > 0) yield* Effect.logInfo(`attachments: removed ${removed} orphan upload(s)`)
    // Files whose row went with a deleted channel or message. The row cascades, the bytes do
    // not, so whatever a delete path missed is swept here on the same one-day grace.
    const bytes = yield* attachments.sweepBlobs(ORPHAN_ATTACHMENT_AGE)
    if (bytes > 0) yield* Effect.logInfo(`attachments: removed ${bytes} unreferenced file(s)`)
  })
)

/**
 * A parked seat used to sit out a guessed cooldown to the last second, even
 * after its window had rolled over. This re-reads the provider's numbers and
 * hands the seat back the moment it is genuinely free
 * (docs/build-plan-usage-limits.md). The interval is long because the usage
 * endpoint throttles hard; the probe's own TTL is the real floor.
 */
const COOLDOWN_SWEEP = Duration.minutes(10)

const sweepCooldowns = Layer.scopedDiscard(
  Effect.gen(function* () {
    const subscriptions = yield* Subscriptions
    yield* subscriptions.sweepCooldowns().pipe(
      Effect.tap((released) =>
        released > 0
          ? Effect.logInfo(`subscriptions: ${released} seat(s) back in rotation early`)
          : Effect.void
      ),
      Effect.delay(COOLDOWN_SWEEP),
      Effect.forever,
      Effect.forkScoped
    )
  })
)

const MainLive = Layer.mergeAll(announce, sweepOrphans, sweepCooldowns).pipe(
  Layer.provideMerge(AppLive)
)

NodeRuntime.runMain(Layer.launch(MainLive))
