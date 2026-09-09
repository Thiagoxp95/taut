import { SqlClient } from '@effect/sql'
import type { CurrentUserShape } from '@taut/contract/api'
import {
  type CredentialKind,
  EXHAUSTED_PCT,
  type LimitWindow,
  type ModelCatalog,
  RuntimeCredentialKinds,
  RuntimeKind,
  RuntimeUsageCredentialKinds,
  type Subscription,
  SubscriptionStatus
} from '@taut/contract/domain'
import {
  type Forbidden,
  NotFound,
  RuntimeUnavailable,
  type Unauthorized,
  Validation,
  type VaultLocked
} from '@taut/contract/errors'
import { CompanyId, SubscriptionId, VaultItemId, newSubscriptionId } from '@taut/contract/ids'
import { DateTime, Effect, Option, Redacted, Schema } from 'effect'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import { SubscriptionRow, toSubscription, utcDay } from '../domain/rows.js'
import { actor, requireAdmin } from './access.js'
import { ModelCatalogs, NO_SEAT_KEY, needsCredential } from './modelCatalog.js'
import { type Emit, EventPublisher } from './publisher.js'
import { RuntimeDetector } from './runtimeDetector.js'
import {
  ProbeUnavailable,
  UsageProbe,
  claudeLoginNeedsRefresh,
  parseClaudeLogin,
  supports as probeSupports
} from './usageProbe.js'
import { Vault } from './vault.js'

const COLUMNS =
  'id, company_id, runtime, label, credential_id, usage_credential_id, default_model, status, weight, cooldown_until, limits_json, limits_checked_at, limits_error, tasks_today, tasks_today_date, last_checked_at'

/**
 * Fallback cooldown when the provider will not say when the window resets
 * (docs/build-plan-usage-limits.md). It is a guess and is treated as one: a
 * successful probe always overrides it, and a probe showing headroom clears it.
 */
export const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000
/** Claude's rolling usage window — the longest a Claude seat can owe. */
export const CLAUDE_COOLDOWN_MS = 5 * 60 * 60 * 1000

export interface AddSubscriptionInput {
  readonly runtime: RuntimeKind
  readonly label: string
  readonly credentialId: VaultItemId
  readonly usageCredentialId?: VaultItemId | undefined
  readonly defaultModel?: string | undefined
  readonly weight?: number | undefined
}

/**
 * The company's runtime pool (docs/agent-model.md §4): one row per seat, many per runtime.
 * `pick` implements rotation — healthy ∧ not cooling down ∧ weight > 0 → lowest `tasksToday`
 * → highest `weight`; `weight: 0` drains a seat. `tasksToday` is per UTC day
 * (`tasks_today_date`), reset lazily on the first pick/markUsed of a new day.
 */
export class Subscriptions extends Effect.Service<Subscriptions>()('Subscriptions', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const publisher = yield* EventPublisher
    const vault = yield* Vault
    const detector = yield* RuntimeDetector
    const usage = yield* UsageProbe
    const catalogs = yield* ModelCatalogs

    // ── queries ──────────────────────────────────────────────────────────────

    const Key = Schema.Struct({ companyId: CompanyId, subscriptionId: SubscriptionId })

    const listOf = findAll({
      Request: CompanyId,
      Result: SubscriptionRow,
      execute: (companyId) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM subscriptions
        WHERE company_id = ${companyId} ORDER BY created_at ASC, rowid ASC`
    })

    const byId = findOne({
      Request: Key,
      Result: SubscriptionRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM subscriptions
        WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    const insert = run({
      Request: Schema.Struct({
        id: SubscriptionId,
        companyId: CompanyId,
        runtime: RuntimeKind,
        label: Schema.String,
        credentialId: VaultItemId,
        usageCredentialId: Schema.NullOr(VaultItemId),
        defaultModel: Schema.NullOr(Schema.String),
        status: SubscriptionStatus,
        weight: Schema.Number,
        lastCheckedAt: Schema.String,
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO subscriptions
          (id, company_id, runtime, label, credential_id, usage_credential_id, default_model, status, weight, last_checked_at, created_at)
        VALUES (${r.id}, ${r.companyId}, ${r.runtime}, ${r.label}, ${r.credentialId}, ${r.usageCredentialId}, ${r.defaultModel},
                ${r.status}, ${r.weight}, ${r.lastCheckedAt}, ${r.createdAt})`
    })

    const remove = run({
      Request: Key,
      execute: (r) =>
        sql`DELETE FROM subscriptions WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    const updateWeight = run({
      Request: Schema.Struct({ ...Key.fields, weight: Schema.Number }),
      execute: (r) => sql`
        UPDATE subscriptions SET weight = ${r.weight}
        WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    const updateUsageCredential = run({
      Request: Schema.Struct({ ...Key.fields, usageCredentialId: Schema.NullOr(VaultItemId) }),
      execute: (r) => sql`
        UPDATE subscriptions SET usage_credential_id = ${r.usageCredentialId}
        WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    const updateStatus = run({
      Request: Schema.Struct({ ...Key.fields, status: SubscriptionStatus, at: Schema.String }),
      execute: (r) => sql`
        UPDATE subscriptions SET status = ${r.status}, last_checked_at = ${r.at}
        WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    const updateCooldown = run({
      Request: Schema.Struct({ ...Key.fields, until: Schema.NullOr(Schema.String) }),
      execute: (r) => sql`
        UPDATE subscriptions SET cooldown_until = ${r.until}
        WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    /** Replaces the cached snapshot wholesale; `error` and `json` are mutually exclusive. */
    const updateLimits = run({
      Request: Schema.Struct({
        ...Key.fields,
        json: Schema.NullOr(Schema.String),
        error: Schema.NullOr(Schema.String),
        at: Schema.String
      }),
      execute: (r) => sql`
        UPDATE subscriptions
        SET limits_json = COALESCE(${r.json}, limits_json),
            limits_error = ${r.error},
            limits_checked_at = ${r.at}
        WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    /** Every seat currently parked, across companies — the sweep's work list. */
    const coolingSeats = findAll({
      Request: Schema.Struct({ now: Schema.String }),
      Result: Schema.Struct({ id: SubscriptionId, company_id: CompanyId }),
      execute: (r) => sql`
        SELECT id, company_id FROM subscriptions
        WHERE cooldown_until IS NOT NULL AND cooldown_until > ${r.now}`
    })

    /** Rows whose counter belongs to another day restart at 0 for `today`. */
    const rollDay = run({
      Request: Schema.Struct({ companyId: CompanyId, today: Schema.String }),
      execute: (r) => sql`
        UPDATE subscriptions SET tasks_today = 0, tasks_today_date = ${r.today}
        WHERE company_id = ${r.companyId}
          AND (tasks_today_date IS NULL OR tasks_today_date <> ${r.today})`
    })

    const bump = run({
      Request: Schema.Struct({ ...Key.fields, today: Schema.String }),
      execute: (r) => sql`
        UPDATE subscriptions SET tasks_today = tasks_today + 1, tasks_today_date = ${r.today}
        WHERE company_id = ${r.companyId} AND id = ${r.subscriptionId}`
    })

    /** §4 rotation order. `now` is ISO so the lexical comparison is chronological. */
    const eligible = findAll({
      Request: Schema.Struct({ companyId: CompanyId, runtime: RuntimeKind, now: Schema.String }),
      Result: SubscriptionRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM subscriptions
        WHERE company_id = ${r.companyId} AND runtime = ${r.runtime}
          AND status = 'ok' AND weight > 0
          AND (cooldown_until IS NULL OR cooldown_until <= ${r.now})
        ORDER BY tasks_today ASC, weight DESC, created_at ASC, rowid ASC
        LIMIT 1`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    const load = (
      companyId: CompanyId,
      subscriptionId: SubscriptionId
    ): Effect.Effect<Subscription, NotFound> =>
      byId({ companyId, subscriptionId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Subscription', id: subscriptionId })),
            onSome: (row) => Effect.succeed(toSubscription(row))
          })
        )
      )

    const emitUpdated = (emit: Emit, companyId: CompanyId, subscriptionId: SubscriptionId) =>
      load(companyId, subscriptionId).pipe(
        Effect.orDie,
        Effect.tap((subscription) =>
          emit({ type: 'subscription.updated', payload: { subscription } })
        )
      )

    /**
     * When the seat genuinely comes back, from the provider's own numbers.
     *
     * The earliest reset among *spent* windows, because a seat is blocked until
     * the tightest exhausted window rolls over and free again the moment it
     * does. `undefined` means nothing is spent — the seat should not be parked
     * at all, which is how a stale countdown gets cleared.
     */
    const blockedUntil = (windows: ReadonlyArray<LimitWindow>): DateTime.Utc | undefined => {
      let earliest: DateTime.Utc | undefined
      for (const w of windows) {
        if (w.percentUsed < EXHAUSTED_PCT) continue
        const resetsAt = w.resetsAt
        if (resetsAt === undefined) continue
        if (earliest === undefined || DateTime.lessThan(resetsAt, earliest)) earliest = resetsAt
      }
      return earliest
    }

    /** The session window, which is what a runtime hits first when it trips a limit. */
    const sessionReset = (windows: ReadonlyArray<LimitWindow>): DateTime.Utc | undefined =>
      windows.find((w) => w.kind === 'session')?.resetsAt

    /** The guess, clamped so it can never outlast one real window of the runtime. */
    const fallbackUntil = (runtime: RuntimeKind, requested: number): string => {
      const ceiling = runtime === 'claude-code' ? CLAUDE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS
      return new Date(Date.now() + Math.min(requested, ceiling)).toISOString()
    }

    /**
     * A `claude login` access token lives hours. Renew it before the probe uses
     * it and write the rotation back, so a seat pasted once keeps reporting.
     * A refusal here is the probe's refusal: the seat shows why, nothing fails.
     */
    const rotateIfStale = (
      companyId: CompanyId,
      credentialId: VaultItemId,
      kind: CredentialKind,
      resolved: { readonly secret: Redacted.Redacted<string> }
    ): Effect.Effect<
      Redacted.Redacted<string>,
      ProbeUnavailable | NotFound | Forbidden | VaultLocked
    > =>
      Effect.gen(function* () {
        if (kind !== 'claude.login') return resolved.secret
        const login = parseClaudeLogin(Redacted.value(resolved.secret))
        if (Option.isNone(login) || !claudeLoginNeedsRefresh(login.value)) return resolved.secret

        const renewed = yield* usage.refreshClaudeLogin(resolved.secret)
        yield* vault.rewriteForProbe(companyId, credentialId, renewed)
        return Redacted.make(renewed)
      })

    /**
     * The credential a task is about to run on, renewed if it is about to go
     * stale.
     *
     * A `claude.login` seat is one paste doing two jobs: the runtime gets its
     * `accessToken`, which lives hours, and the probe reads usage with the same
     * record. So the token has to be current at spawn, not just at probe time.
     * The rotation is written back to the vault, so every later spawn and every
     * probe sees the renewed pair.
     *
     * Never fails. A refusal here means the paste is spent, and the honest way
     * to say that is the runtime's own `auth-failed` on the seat a moment
     * later — not a task that dies before it starts with a vault error.
     */
    const freshenSeatSecret = (
      companyId: CompanyId,
      credentialId: VaultItemId,
      kind: CredentialKind,
      secret: Redacted.Redacted<string>
    ): Effect.Effect<Redacted.Redacted<string>> =>
      rotateIfStale(companyId, credentialId, kind, { secret }).pipe(
        Effect.catchAll((error) =>
          Effect.logWarning(
            `could not renew credential ${credentialId}: ${'reason' in error ? error.reason : error.message}`
          ).pipe(Effect.as(secret))
        )
      )

    /**
     * Read the seat's quota windows and cache them. Returns what the provider
     * said, or `None` when it said nothing usable — inside the probe's TTL, in a
     * 429 backoff, an unsupported runtime, or a credential that cannot read
     * usage. Never fails: the caller always has a fallback.
     */
    const refreshLimits = (
      companyId: CompanyId,
      subscription: Subscription,
      force: boolean
    ): Effect.Effect<Option.Option<ReadonlyArray<LimitWindow>>> =>
      Effect.gen(function* () {
        // The seat's own credential is what runs tasks; the usage credential,
        // when attached, is the only one allowed to read quota. A Claude seat
        // has to have one — `claude setup-token` is inference-only.
        const credentialId = subscription.usageCredentialId ?? subscription.credentialId
        const credential = yield* vault.metaById(companyId, credentialId)
        if (!probeSupports(subscription.runtime, credential.kind)) {
          return yield* new ProbeUnavailable({
            reason:
              subscription.runtime === 'claude-code'
                ? 'no usage credential on this seat — a `claude setup-token` is inference-only'
                : `a ${credential.kind} credential cannot read usage`,
            credential: true
          })
        }

        const resolved = yield* vault.resolveForProbe(companyId, credentialId)
        const secret = yield* rotateIfStale(companyId, credentialId, credential.kind, resolved)
        const windows = yield* usage.probe({
          key: subscription.id,
          runtime: subscription.runtime,
          credentialKind: credential.kind,
          secret,
          force
        })
        if (Option.isNone(windows)) return Option.none()

        yield* updateLimits({
          companyId,
          subscriptionId: subscription.id,
          json: JSON.stringify(windows.value),
          error: null,
          at: nowIso()
        })
        return windows
      }).pipe(
        // A probe is diagnostics. It records why it could not answer and gets
        // out of the way; nothing it does may fail a check or a task.
        Effect.catchTag('ProbeUnavailable', (error) =>
          updateLimits({
            companyId,
            subscriptionId: subscription.id,
            json: null,
            error: error.reason,
            at: nowIso()
          }).pipe(Effect.as(Option.none<ReadonlyArray<LimitWindow>>()))
        ),
        Effect.catchAll(() => Effect.succeed(Option.none<ReadonlyArray<LimitWindow>>())),
        Effect.orDie
      )

    /** `detect()` for the runtime → `ok` | `binary-missing`. Credential checks are Phase 4. */
    const detectStatus = (runtime: RuntimeKind): Effect.Effect<SubscriptionStatus> =>
      detector
        .detect(runtime)
        .pipe(Effect.map((d): SubscriptionStatus => (d.installed ? 'ok' : 'binary-missing')))

    const notEligible = (s: Subscription, now: string): string | undefined =>
      s.status !== 'ok'
        ? `subscription ${s.id} is ${s.status}`
        : s.weight === 0
          ? `subscription ${s.id} is draining (weight 0)`
          : s.cooldownUntil !== undefined && DateTime.formatIso(s.cooldownUntil) > now
            ? `subscription ${s.id} is cooling down until ${DateTime.formatIso(s.cooldownUntil)}`
            : undefined

    // ── endpoints ────────────────────────────────────────────────────────────

    const list = (me: CurrentUserShape): Effect.Effect<ReadonlyArray<Subscription>, Unauthorized> =>
      actor(me).pipe(
        Effect.flatMap((who) => listOf(who.companyId)),
        Effect.map((rows) => {
          const today = utcDay()
          return rows.map((row) => toSubscription(row, today))
        })
      )

    /**
     * A usage credential is read-only by construction, so it is validated on its
     * own list rather than the runtime's inference kinds: a Claude seat runs on
     * `claude.oauth` and reads quota with `claude.login`, never the reverse.
     */
    const checkUsageKind = (
      companyId: CompanyId,
      runtime: RuntimeKind,
      usageCredentialId: VaultItemId
    ): Effect.Effect<void, NotFound | Validation> =>
      Effect.gen(function* () {
        const credential = yield* vault.metaById(companyId, usageCredentialId)
        const accepted = RuntimeUsageCredentialKinds[runtime]
        if (!accepted.includes(credential.kind)) {
          return yield* new Validation({
            issues: [
              {
                path: ['usageCredentialId'],
                message:
                  accepted.length === 0
                    ? `${runtime} has no usage endpoint to read`
                    : `${runtime} reads usage with ${accepted.join(', ')}; got ${credential.kind}`
              }
            ]
          })
        }
      })

    const add = (
      me: CurrentUserShape,
      input: AddSubscriptionInput
    ): Effect.Effect<Subscription, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const credential = yield* vault.metaById(who.companyId, input.credentialId)
        const accepted = RuntimeCredentialKinds[input.runtime]
        if (!accepted.includes(credential.kind)) {
          return yield* new Validation({
            issues: [
              {
                path: ['credentialId'],
                message: `${input.runtime} accepts ${accepted.join(', ')}; got ${credential.kind}`
              }
            ]
          })
        }
        if (input.usageCredentialId !== undefined) {
          yield* checkUsageKind(who.companyId, input.runtime, input.usageCredentialId)
        }
        const status = yield* detectStatus(input.runtime)
        return yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            const id = newSubscriptionId()
            const now = nowIso()
            yield* insert({
              id,
              companyId: who.companyId,
              runtime: input.runtime,
              label: input.label,
              credentialId: input.credentialId,
              usageCredentialId: input.usageCredentialId ?? null,
              defaultModel: input.defaultModel ?? null,
              status,
              weight: input.weight ?? 1,
              lastCheckedAt: now,
              createdAt: now
            })
            const subscription = yield* load(who.companyId, id).pipe(Effect.orDie)
            yield* emit({ type: 'subscription.created', payload: { subscription } })
            return subscription
          })
        )
      })

    const del = (
      me: CurrentUserShape,
      subscriptionId: SubscriptionId
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        yield* load(who.companyId, subscriptionId)
        yield* publisher.transact(who.companyId, (emit) =>
          remove({ companyId: who.companyId, subscriptionId }).pipe(
            Effect.zipRight(emit({ type: 'subscription.deleted', payload: { subscriptionId } }))
          )
        )
      })

    const setWeight = (
      me: CurrentUserShape,
      subscriptionId: SubscriptionId,
      weight: number
    ): Effect.Effect<Subscription, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        yield* load(who.companyId, subscriptionId)
        return yield* publisher.transact(who.companyId, (emit) =>
          updateWeight({ companyId: who.companyId, subscriptionId, weight }).pipe(
            Effect.zipRight(emitUpdated(emit, who.companyId, subscriptionId))
          )
        )
      })

    /**
     * Attach or detach the seat's read-only usage credential.
     *
     * It does not probe. Every other write on this service is local, and a
     * background call to a provider hidden inside a PATCH is the kind of thing
     * that turns a test suite into a network client. The page presses Check
     * itself once the attach lands, which is the same request an operator would
     * have made anyway.
     */
    const setUsageCredential = (
      me: CurrentUserShape,
      subscriptionId: SubscriptionId,
      usageCredentialId: VaultItemId | undefined
    ): Effect.Effect<Subscription, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const current = yield* load(who.companyId, subscriptionId)
        if (usageCredentialId !== undefined) {
          yield* checkUsageKind(who.companyId, current.runtime, usageCredentialId)
        }
        yield* publisher.transact(who.companyId, (emit) =>
          updateUsageCredential({
            companyId: who.companyId,
            subscriptionId,
            usageCredentialId: usageCredentialId ?? null
          }).pipe(Effect.zipRight(emitUpdated(emit, who.companyId, subscriptionId)))
        )
        return yield* load(who.companyId, subscriptionId)
      })

    const check = (
      me: CurrentUserShape,
      subscriptionId: SubscriptionId
    ): Effect.Effect<Subscription, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const current = yield* load(who.companyId, subscriptionId)
        const status = yield* detectStatus(current.runtime)
        yield* publisher.transact(who.companyId, (emit) =>
          updateStatus({ companyId: who.companyId, subscriptionId, status, at: nowIso() }).pipe(
            Effect.zipRight(emitUpdated(emit, who.companyId, subscriptionId))
          )
        )
        // Check is also the operator's manual way out of a stale countdown, so
        // it refreshes quota and releases the seat if the window has rolled.
        yield* refreshCooldown(who.companyId, subscriptionId, true)
        return yield* load(who.companyId, subscriptionId)
      })

    /**
     * Hand a parked seat straight back to the rotation.
     *
     * Cooldown is per-seat but a limit is per-model: one model out of quota
     * parks a seat whose other models still have room, and `check` will not
     * release it because the provider still reports a block. The operator can
     * see what the provider cannot, so this writes the release directly and
     * skips the probe entirely.
     */
    const clearCooldown = (
      me: CurrentUserShape,
      subscriptionId: SubscriptionId
    ): Effect.Effect<Subscription, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        yield* load(who.companyId, subscriptionId)
        return yield* publisher.transact(who.companyId, (emit) =>
          updateCooldown({ companyId: who.companyId, subscriptionId, until: null }).pipe(
            Effect.zipRight(emitUpdated(emit, who.companyId, subscriptionId))
          )
        )
      })

    // ── scheduler hooks (Phase 4) ────────────────────────────────────────────

    /**
     * The seat a new task runs on. `pinnedId` skips rotation but still has to be eligible.
     * Fails with `RuntimeUnavailable` when the pool for `runtime` is exhausted.
     */
    const pick = (
      companyId: CompanyId,
      runtime: RuntimeKind,
      pinnedId?: SubscriptionId | undefined
    ): Effect.Effect<Subscription, RuntimeUnavailable> =>
      Effect.gen(function* () {
        const now = nowIso()
        yield* rollDay({ companyId, today: utcDay() })
        if (pinnedId !== undefined) {
          const pinned = yield* load(companyId, pinnedId).pipe(
            Effect.mapError(
              () => new RuntimeUnavailable({ runtime, reason: `pinned ${pinnedId} not found` })
            )
          )
          const reason = notEligible(pinned, now)
          if (reason !== undefined) return yield* new RuntimeUnavailable({ runtime, reason })
          return pinned
        }
        const rows = yield* eligible({ companyId, runtime, now })
        const first = rows[0]
        if (first === undefined) {
          return yield* new RuntimeUnavailable({
            runtime,
            reason: 'no healthy subscription available (pool exhausted or cooling down)'
          })
        }
        return toSubscription(first)
      })

    /** Count a task start against the seat (after `pick`). */
    const markUsed = (
      companyId: CompanyId,
      subscriptionId: SubscriptionId
    ): Effect.Effect<Subscription, NotFound> =>
      Effect.gen(function* () {
        yield* load(companyId, subscriptionId)
        const today = utcDay()
        return yield* publisher.transact(companyId, (emit) =>
          rollDay({ companyId, today }).pipe(
            Effect.zipRight(bump({ companyId, subscriptionId, today })),
            Effect.zipRight(emitUpdated(emit, companyId, subscriptionId))
          )
        )
      })

    /**
     * Rate-limit / usage-cap seen mid-task: park the seat until it actually
     * returns.
     *
     * The provider is asked first, because a rolling window starts at its first
     * request: a seat that trips its limit 40 minutes before the block rolls
     * over is free in 40 minutes, not in a full window. `cooldownMs` is only
     * the floor-of-last-resort for when the provider will not say.
     */
    const markRateLimited = (
      companyId: CompanyId,
      subscriptionId: SubscriptionId,
      cooldownMs: number = DEFAULT_COOLDOWN_MS
    ): Effect.Effect<Subscription, NotFound> =>
      Effect.gen(function* () {
        const seat = yield* load(companyId, subscriptionId)
        const probed = yield* refreshLimits(companyId, seat, true)
        const until = Option.match(probed, {
          onNone: () => fallbackUntil(seat.runtime, cooldownMs),
          onSome: (windows) => {
            // The runtime saw a limit the snapshot has not caught up to yet, so
            // trust the refusal and wait out the session window rather than
            // handing the seat straight back to the scheduler.
            const reset = blockedUntil(windows) ?? sessionReset(windows)
            return reset === undefined
              ? fallbackUntil(seat.runtime, cooldownMs)
              : DateTime.formatIso(reset)
          }
        })
        return yield* publisher.transact(companyId, (emit) =>
          updateCooldown({ companyId, subscriptionId, until }).pipe(
            Effect.zipRight(emitUpdated(emit, companyId, subscriptionId))
          )
        )
      })

    /**
     * Re-read a parked seat's quota and let it back in when the provider says
     * the window has rolled over.
     *
     * Without this a cooldown only ever expires on its own clock, so a seat that
     * came back early kept counting down a number that was never true. Returns
     * true when the seat was released.
     */
    const refreshCooldown = (
      companyId: CompanyId,
      subscriptionId: SubscriptionId,
      force = false
    ): Effect.Effect<boolean, NotFound> =>
      Effect.gen(function* () {
        const seat = yield* load(companyId, subscriptionId)
        const probed = yield* refreshLimits(companyId, seat, force)
        if (Option.isNone(probed)) return false

        const reset = blockedUntil(probed.value)
        const until = reset === undefined ? null : DateTime.formatIso(reset)
        const current =
          seat.cooldownUntil === undefined ? null : DateTime.formatIso(seat.cooldownUntil)
        if (until === current) return false

        yield* publisher.transact(companyId, (emit) =>
          updateCooldown({ companyId, subscriptionId, until }).pipe(
            Effect.zipRight(emitUpdated(emit, companyId, subscriptionId))
          )
        )
        return until === null
      })

    /**
     * One pass over every parked seat, for the background sweep. Each seat is
     * independent, so one failure never stops the rest.
     */
    const sweepCooldowns = (): Effect.Effect<number> =>
      coolingSeats({ now: nowIso() }).pipe(
        Effect.flatMap((rows) =>
          Effect.forEach(
            rows,
            (row) =>
              refreshCooldown(row.company_id, row.id).pipe(Effect.orElseSucceed(() => false)),
            { concurrency: 2 }
          )
        ),
        Effect.map((released) => released.filter(Boolean).length),
        Effect.orElseSucceed(() => 0)
      )

    /**
     * The models `runtime` can reach, asked of the provider with a seat's own
     * credential (docs/build-plan-run-overrides.md D6).
     *
     * The seat is `subscriptionId` when one is named and otherwise whatever
     * rotation would pick, so the list matches the seat the run will land on.
     * Nothing here fails: a runtime with no seat, a locked vault or a provider
     * that will not answer all come back as the fallback list with a reason.
     */
    const models = (
      me: CurrentUserShape,
      query: {
        readonly runtime: RuntimeKind
        readonly subscriptionId?: SubscriptionId | undefined
        readonly refresh?: boolean | undefined
      }
    ): Effect.Effect<ModelCatalog, Unauthorized> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        /**
         * Rotation's pick first, so the list matches the seat a run would land
         * on. A seat that is cooling down or draining is still perfectly able
         * to answer "which models exist", though — asking the provider is not
         * running a task — so a refusal falls back to any seat of this runtime
         * rather than dropping straight to the built-in list.
         */
        const found: Effect.Effect<Subscription, unknown> =
          query.subscriptionId === undefined
            ? pick(who.companyId, query.runtime).pipe(
                Effect.orElse(() =>
                  listOf(who.companyId).pipe(
                    Effect.map((rows) => rows.find((row) => row.runtime === query.runtime)),
                    Effect.flatMap(Effect.fromNullable),
                    Effect.map((row) => toSubscription(row, utcDay()))
                  )
                )
              )
            : load(who.companyId, query.subscriptionId)
        const seat = yield* Effect.option(found)

        // A seat of the wrong runtime would answer another provider's catalogue.
        const usable = Option.filter(seat, (row) => row.runtime === query.runtime)

        const credential = yield* Option.match(usable, {
          onNone: () => Effect.succeedNone,
          onSome: (row) =>
            Effect.all([
              vault.metaById(who.companyId, row.credentialId),
              vault.resolveForProbe(who.companyId, row.credentialId)
            ]).pipe(
              Effect.flatMap(([meta, secret]) =>
                rotateIfStale(who.companyId, row.credentialId, meta.kind, secret).pipe(
                  Effect.map((fresh) => Option.some({ kind: meta.kind, secret: fresh }))
                )
              ),
              Effect.orElseSucceed(() =>
                Option.none<{ kind: CredentialKind; secret: Redacted.Redacted<string> }>()
              )
            )
        })

        const key = Option.match(usable, {
          onNone: () => NO_SEAT_KEY,
          onSome: (row) => (Option.isSome(credential) ? row.credentialId : NO_SEAT_KEY)
        })

        const catalog = yield* catalogs.get({
          key,
          runtime: query.runtime,
          ...(Option.isSome(credential) ? { credential: credential.value } : {}),
          refresh: query.refresh
        })

        // `needsCredential` runtimes with no seat get a plainer reason than the
        // provider layer can give: nothing was asked, because there was nobody to ask.
        return (
          catalog.source === 'fallback' &&
          Option.isNone(credential) &&
          needsCredential(query.runtime)
            ? {
                ...catalog,
                note: `no usable ${query.runtime} seat to ask the provider with — showing the built-in list`
              }
            : catalog
        ) as ModelCatalog
      })

    /** The runtime rejected the credential: park the seat as `auth-failed` until `check` clears it. */
    const markAuthFailed = (
      companyId: CompanyId,
      subscriptionId: SubscriptionId
    ): Effect.Effect<Subscription, NotFound> =>
      Effect.gen(function* () {
        yield* load(companyId, subscriptionId)
        return yield* publisher.transact(companyId, (emit) =>
          updateStatus({ companyId, subscriptionId, status: 'auth-failed', at: nowIso() }).pipe(
            Effect.zipRight(emitUpdated(emit, companyId, subscriptionId))
          )
        )
      })

    return {
      list,
      add,
      remove: del,
      setWeight,
      setUsageCredential,
      check,
      clearCooldown,
      models,
      pick,
      markUsed,
      markRateLimited,
      markAuthFailed,
      freshenSeatSecret,
      refreshCooldown,
      sweepCooldowns,
      /** Lookup for other services (agents validate `pinnedSubscriptionId`). */
      byId: load
    } as const
  })
}) {}
