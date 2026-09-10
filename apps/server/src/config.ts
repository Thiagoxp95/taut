import { FileSystem, Path } from '@effect/platform'
import { NodeFileSystem, NodePath } from '@effect/platform-node'
import { Config, ConfigError, Data, Effect, Either, Option, Redacted } from 'effect'
import { randomBytes } from 'node:crypto'
import pkg from '../package.json' with { type: 'json' }
import { defaultWebDist } from './paths.js'

export const MASTER_KEY_BYTES = 32
const MASTER_KEY_FILE = 'master.key'

export class MasterKeyMissing extends Data.TaggedError('MasterKeyMissing')<{
  readonly message: string
}> {}

const decodeMasterKey = (raw: string): Option.Option<Uint8Array> => {
  const bytes = Buffer.from(raw.trim(), 'base64')
  return bytes.length === MASTER_KEY_BYTES ? Option.some(new Uint8Array(bytes)) : Option.none()
}

const masterKeyConfig: Config.Config<Option.Option<Redacted.Redacted<Uint8Array>>> = Config.option(
  Config.redacted('TAUT_MASTER_KEY')
).pipe(
  Config.mapOrFail((maybe) =>
    Option.match(maybe, {
      onNone: () => Either.right(Option.none()),
      onSome: (redacted) =>
        Option.match(decodeMasterKey(Redacted.value(redacted)), {
          onNone: () =>
            Either.left(
              ConfigError.InvalidData(
                ['TAUT_MASTER_KEY'],
                `must be base64 of exactly ${MASTER_KEY_BYTES} bytes (try: openssl rand -base64 32)`
              )
            ),
          onSome: (bytes) => Either.right(Option.some(Redacted.make(bytes)))
        })
    })
  )
)

const portConfig = Config.integer('PORT').pipe(
  Config.withDefault(3000),
  Config.mapOrFail((port) =>
    port >= 0 && port <= 65535
      ? Either.right(port)
      : Either.left(ConfigError.InvalidData(['PORT'], 'must be between 0 and 65535'))
  )
)

const machineProviderConfig = Config.literal(
  'local',
  'docker'
)('TAUT_MACHINE_PROVIDER').pipe(Config.withDefault('local' as const))

const instanceIdConfig = Config.option(
  Config.string('TAUT_INSTANCE_ID').pipe(
    Config.mapOrFail((value) =>
      value.length <= 63 && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
        ? Either.right(value)
        : Either.left(
            ConfigError.InvalidData(
              ['TAUT_INSTANCE_ID'],
              'must be 1–63 lowercase letters or digits, with single hyphens between segments'
            )
          )
    )
  )
)

const maxConcurrentConfig = Config.integer('TAUT_MAX_CONCURRENT_TASKS').pipe(
  Config.withDefault(4),
  Config.mapOrFail((n) =>
    n >= 1
      ? Either.right(n)
      : Either.left(ConfigError.InvalidData(['TAUT_MAX_CONCURRENT_TASKS'], 'must be >= 1'))
  )
)

/**
 * How many threads of ONE agent may run at the same time (docs/build-plan-sessions.md D4).
 * A thread is a session: its own copy of the agent with its own context and working directory,
 * so threads are safe to run in parallel — this is only a fairness cap, to stop one agent
 * eating the company's `TAUT_MAX_CONCURRENT_TASKS` slots.
 */
const maxThreadsPerAgentConfig = Config.integer('TAUT_MAX_THREADS_PER_AGENT').pipe(
  Config.withDefault(3),
  Config.mapOrFail((n) =>
    n >= 1
      ? Either.right(n)
      : Either.left(ConfigError.InvalidData(['TAUT_MAX_THREADS_PER_AGENT'], 'must be >= 1'))
  )
)

const attachmentMaxBytesConfig = Config.integer('TAUT_ATTACHMENT_MAX_BYTES').pipe(
  Config.withDefault(25 * 1024 * 1024),
  Config.mapOrFail((n) =>
    n >= 1
      ? Either.right(n)
      : Either.left(ConfigError.InvalidData(['TAUT_ATTACHMENT_MAX_BYTES'], 'must be >= 1'))
  )
)

/** D4: the whole huddle, not per publisher. Past this, `join` is a 422. */
const callMaxParticipantsConfig = Config.integer('TAUT_CALL_MAX_PARTICIPANTS').pipe(
  Config.withDefault(30),
  Config.mapOrFail((n) =>
    n >= 1
      ? Either.right(n)
      : Either.left(ConfigError.InvalidData(['TAUT_CALL_MAX_PARTICIPANTS'], 'must be >= 1'))
  )
)

/** The client refetches by calling `join` again, so this is a ceiling, not a session length. */
const callTokenTtlConfig = Config.integer('TAUT_CALL_TOKEN_TTL_SECONDS').pipe(
  Config.withDefault(6 * 60 * 60),
  Config.mapOrFail((n) =>
    n >= 60
      ? Either.right(n)
      : Either.left(ConfigError.InvalidData(['TAUT_CALL_TOKEN_TTL_SECONDS'], 'must be >= 60'))
  )
)

/**
 * `RoomServiceClient` speaks HTTP to the SFU from inside the network; browsers speak
 * WebSocket to it from outside. Same host in a default compose deployment, so the
 * internal url is derived from the public one unless it is set explicitly.
 */
const internalLivekitUrl = (publicUrl: string): string =>
  publicUrl.startsWith('ws') ? `http${publicUrl.slice(2)}` : publicUrl

/** A positive-integer knob with a default; every trigger/signal budget below is one. */
const positive = (name: string, fallback: number, min = 1) =>
  Config.integer(name).pipe(
    Config.withDefault(fallback),
    Config.mapOrFail((n) =>
      n >= min ? Either.right(n) : Either.left(ConfigError.InvalidData([name], `must be >= ${min}`))
    )
  )

const rawConfig = Config.all({
  port: portConfig,
  // ── Phase 4: agent execution ────────────────────────────────────────────────
  /** `local` spawns runtimes on this host (dev); `docker` gives every agent a container. */
  machineProvider: machineProviderConfig,
  /** Stable installation identity, isolating Docker resources on a shared daemon. */
  instanceId: instanceIdConfig,
  /** Existing, installation-owned network exposing the API to agent containers. */
  dockerNetwork: Config.option(Config.string('TAUT_DOCKER_NETWORK')),
  /** Public browser origin, used by integration redirects and external callbacks. */
  publicUrl: Config.option(Config.string('TAUT_PUBLIC_URL')),
  /** Internal API origin reachable from agent machines; defaults to publicUrl. */
  agentApiUrl: Config.option(Config.string('TAUT_AGENT_API_URL')),
  maxConcurrentTasks: maxConcurrentConfig,
  maxThreadsPerAgent: maxThreadsPerAgentConfig,
  /** Stream a small "using tool X" line into the reply for every tool call. */
  showTools: Config.boolean('TAUT_SHOW_TOOLS').pipe(Config.withDefault(false)),
  /** Docker image for agent machines. Defaults to `@taut/runtime`'s `DEFAULT_IMAGE`. */
  agentImage: Config.option(Config.string('TAUT_AGENT_IMAGE')),
  /**
   * DEV ONLY: when a company has no usable `claude-code` subscription, run `claude` with the
   * host user's own login (no key injected). Never enable in production.
   */
  devHostLogin: Config.boolean('TAUT_DEV_HOST_LOGIN').pipe(Config.withDefault(false)),
  /** Command that starts the `taut` MCP server inside the machine, e.g. `node /opt/taut/mcp.js`. */
  mcpCommand: Config.option(Config.string('TAUT_MCP_COMMAND')),
  dataDir: Config.string('TAUT_DATA_DIR').pipe(Config.withDefault('./data')),
  /** Per-file cap for chat attachments, human uploads and agent-sent files alike (D6). */
  attachmentMaxBytes: attachmentMaxBytesConfig,
  masterKey: masterKeyConfig,
  cookieSecure: Config.option(Config.boolean('TAUT_COOKIE_SECURE')),
  webDist: Config.string('TAUT_WEB_DIST').pipe(Config.withDefault(defaultWebDist)),
  nodeEnv: Config.string('NODE_ENV').pipe(Config.withDefault('development')),
  // ── Phase 8: PWA / Web Push ──────────────────────────────────────────
  /** VAPID keypair (`pnpm --filter @taut/server exec node -e ...`, see docs/deploy.md). Push is off when unset. */
  vapidPublicKey: Config.option(Config.string('TAUT_VAPID_PUBLIC_KEY')),
  vapidPrivateKey: Config.option(Config.redacted('TAUT_VAPID_PRIVATE_KEY')),
  /** `mailto:` or `https:` contact the push service can reach, required by the VAPID spec. */
  vapidSubject: Config.string('TAUT_VAPID_SUBJECT').pipe(
    Config.withDefault('mailto:admin@taut.local')
  ),
  // ── Calls: self-hosted LiveKit (docs/build-plan-calls.md D3) ─────────────
  /** `wss://…` as the *browser* must reach the SFU. Huddles are off when unset. */
  livekitUrl: Config.option(Config.string('TAUT_LIVEKIT_URL')),
  livekitApiKey: Config.option(Config.string('TAUT_LIVEKIT_API_KEY')),
  /** Signs join tokens and verifies webhook bodies; never logged, never sent to a client. */
  livekitApiSecret: Config.option(Config.redacted('TAUT_LIVEKIT_API_SECRET')),
  /** `http(s)://` for `RoomServiceClient`; `http://livekit:7880` in compose. */
  livekitInternalUrl: Config.option(Config.string('TAUT_LIVEKIT_INTERNAL_URL')),
  callMaxParticipants: callMaxParticipantsConfig,
  callTokenTtlSeconds: callTokenTtlConfig,
  // ── Triggers & signals (docs/build-plan-triggers.md D7, D19, D23, D25) ────
  /**
   * D7: the bus is not rate-limited, so a misconfigured `message.created` trigger must
   * degrade into silence rather than into a bill. Counted in memory by `TriggerRunner`:
   * this is a safety valve, not accounting, and a restart clearing it is correct.
   */
  triggerMaxFiresPerHour: positive('TAUT_TRIGGER_MAX_FIRES_PER_HOUR', 20),
  /** D19: the coarsest tick a human would still call a timer. */
  signalTickSeconds: positive('TAUT_SIGNAL_TICK_SECONDS', 5),
  /**
   * D23: chain depth is time-scoped. A signal delivered within this window of the task that
   * emitted it inherits `depth + 1`; one delivered later starts at 0, so a watcher that
   * re-arms itself every three minutes is never capped out while ten immediate hops are.
   */
  signalChainWindowSeconds: positive('TAUT_SIGNAL_CHAIN_WINDOW_SECONDS', 60),
  /** D23: hops inside that window before an emit is refused. `Signal.depth` bounds it too. */
  maxSignalDepth: positive('TAUT_MAX_SIGNAL_DEPTH', 10),
  /** D25: how many undelivered signals one agent may hold. The other of the two valves. */
  maxPendingSignals: positive('TAUT_MAX_PENDING_SIGNALS', 50)
})

/**
 * Development only: reuse `<dataDir>/master.key` if present, otherwise generate one,
 * persist it with mode 0600 and warn. Production must set TAUT_MASTER_KEY explicitly.
 */
const loadOrCreateDevKey = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  dataDir: string
): Effect.Effect<Redacted.Redacted<Uint8Array>, MasterKeyMissing> =>
  Effect.gen(function* () {
    const keyFile = path.join(dataDir, MASTER_KEY_FILE)
    if (yield* fs.exists(keyFile)) {
      const decoded = decodeMasterKey(yield* fs.readFileString(keyFile))
      if (Option.isSome(decoded)) return Redacted.make(decoded.value)
      return yield* new MasterKeyMissing({
        message: `${keyFile} exists but is not base64 of ${MASTER_KEY_BYTES} bytes; delete it or set TAUT_MASTER_KEY`
      })
    }
    const bytes = new Uint8Array(randomBytes(MASTER_KEY_BYTES))
    yield* fs.writeFileString(keyFile, Buffer.from(bytes).toString('base64') + '\n', {
      mode: 0o600
    })
    yield* Effect.logWarning(
      `TAUT_MASTER_KEY not set: generated a development key at ${keyFile}. Set TAUT_MASTER_KEY explicitly in production.`
    )
    return Redacted.make(bytes)
  }).pipe(
    Effect.catchTags({
      BadArgument: (error) =>
        Effect.fail(
          new MasterKeyMissing({ message: `cannot read/write master key: ${error.message}` })
        ),
      SystemError: (error) =>
        Effect.fail(
          new MasterKeyMissing({ message: `cannot read/write master key: ${error.message}` })
        )
    })
  )

/**
 * All process configuration. The only module allowed to read the environment
 * (through Effect `Config`); everything else depends on this service.
 */
export class AppConfig extends Effect.Service<AppConfig>()('AppConfig', {
  effect: Effect.gen(function* () {
    const raw = yield* rawConfig
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const production = raw.nodeEnv === 'production'
    const dataDir = path.resolve(raw.dataDir)
    yield* fs.makeDirectory(dataDir, { recursive: true })

    if (raw.devHostLogin) {
      yield* Effect.logWarning(
        "TAUT_DEV_HOST_LOGIN=true: agents without a claude-code subscription will run `claude` with THIS host user's login. Development only."
      )
    }

    if (Option.isSome(raw.vapidPublicKey) !== Option.isSome(raw.vapidPrivateKey)) {
      yield* Effect.logWarning(
        'TAUT_VAPID_PUBLIC_KEY and TAUT_VAPID_PRIVATE_KEY must both be set: push notifications stay disabled.'
      )
    }

    const livekitUrl = Option.getOrUndefined(raw.livekitUrl)
    const livekitApiKey = Option.getOrUndefined(raw.livekitApiKey)
    const livekitApiSecret = Option.getOrUndefined(raw.livekitApiSecret)
    const livekitParts = [livekitUrl, livekitApiKey, livekitApiSecret]
    const livekitSet = livekitParts.filter((part) => part !== undefined).length
    if (livekitSet > 0 && livekitSet < livekitParts.length) {
      yield* Effect.logWarning(
        'TAUT_LIVEKIT_URL, TAUT_LIVEKIT_API_KEY and TAUT_LIVEKIT_API_SECRET must all be set: huddles stay disabled.'
      )
    }

    /**
     * D3: set together or not at all, exactly like `vapid` below. `Calls` reports
     * `{ enabled: false }` when this is `undefined` and the UI explains the missing setup.
     */
    const livekit =
      livekitUrl !== undefined && livekitApiKey !== undefined && livekitApiSecret !== undefined
        ? ({
            url: livekitUrl,
            apiKey: livekitApiKey,
            apiSecret: livekitApiSecret,
            internalUrl: Option.getOrElse(raw.livekitInternalUrl, () =>
              internalLivekitUrl(livekitUrl)
            ),
            maxParticipants: raw.callMaxParticipants,
            tokenTtlSeconds: raw.callTokenTtlSeconds
          } as const)
        : undefined

    const masterKey = yield* Option.match(raw.masterKey, {
      onSome: Effect.succeed,
      onNone: () =>
        production
          ? Effect.fail(
              new MasterKeyMissing({
                message:
                  'TAUT_MASTER_KEY is required when NODE_ENV=production. Generate one with `openssl rand -base64 32`.'
              })
            )
          : loadOrCreateDevKey(fs, path, dataDir)
    })

    return {
      port: raw.port,
      dataDir,
      attachmentMaxBytes: raw.attachmentMaxBytes,
      /** 32 raw bytes. Only `vault/crypto.ts` should ever unwrap this. */
      masterKey,
      cookieSecure: Option.getOrElse(raw.cookieSecure, () => production),
      webDist: path.resolve(raw.webDist),
      machineProvider: raw.machineProvider,
      instanceId: Option.getOrUndefined(raw.instanceId),
      dockerNetwork: Option.getOrUndefined(raw.dockerNetwork),
      publicUrl: Option.getOrUndefined(raw.publicUrl),
      agentApiUrl: Option.getOrUndefined(raw.agentApiUrl),
      maxConcurrentTasks: raw.maxConcurrentTasks,
      maxThreadsPerAgent: raw.maxThreadsPerAgent,
      showTools: raw.showTools,
      agentImage: Option.getOrUndefined(raw.agentImage),
      devHostLogin: raw.devHostLogin,
      mcpCommand: Option.getOrUndefined(raw.mcpCommand),
      nodeEnv: raw.nodeEnv,
      production,
      version: pkg.version,
      /** Set together or not at all; `PushSender` disables itself when `undefined`. */
      vapid:
        Option.isSome(raw.vapidPublicKey) && Option.isSome(raw.vapidPrivateKey)
          ? ({
              publicKey: raw.vapidPublicKey.value,
              privateKey: raw.vapidPrivateKey.value,
              subject: raw.vapidSubject
            } as const)
          : undefined,
      livekit,
      triggerMaxFiresPerHour: raw.triggerMaxFiresPerHour,
      signalTickSeconds: raw.signalTickSeconds,
      signalChainWindowSeconds: raw.signalChainWindowSeconds,
      maxSignalDepth: raw.maxSignalDepth,
      maxPendingSignals: raw.maxPendingSignals
    } as const
  }),
  dependencies: [NodeFileSystem.layer, NodePath.layer]
}) {}
