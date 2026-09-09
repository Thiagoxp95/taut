import { FetchHttpClient, HttpClient, HttpClientRequest } from '@effect/platform'
import type { CredentialKind, LimitWindow, RuntimeKind } from '@taut/contract/domain'
import { DateTime, Effect, Option, Redacted, Ref, Schema } from 'effect'

/**
 * Reads a seat's real quota windows from its provider.
 *
 * The point is `resetsAt`. A rolling window starts at its first request, so a
 * seat that trips its limit late in a block returns in minutes, not in a full
 * window — which is why the old fixed `now + 5h` cooldown parked healthy seats
 * for hours (docs/build-plan-usage-limits.md).
 *
 * Best-effort by construction: `claude setup-token` mints a `user:inference`
 * token that cannot read the usage endpoint at all, so a `ProbeUnavailable`
 * is an ordinary outcome the caller falls back from, never a task failure.
 */

/** Anthropic's OAuth usage endpoint — the same data the CLI's `/usage` screen shows. */
const ANTHROPIC_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
/** OpenAI's equivalent, used by `codex`. */
const OPENAI_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage'
/** Where a `claude.login` credential trades its refresh token for a new access token. */
const ANTHROPIC_TOKEN_URL = 'https://console.anthropic.com/v1/oauth/token'
/** Claude Code's public OAuth client. A refresh is only ever for the seat's own login. */
const ANTHROPIC_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
/** Refresh this far before `expiresAt` so a probe never races the expiry. */
export const REFRESH_SKEW_MS = 5 * 60 * 1000

/** Smallest gap between two live calls for the same seat. */
export const PROBE_TTL_MS = 10 * 60 * 1000
/** Applied when a 429 arrives without a usable `Retry-After`. */
export const PROBE_DEFAULT_BACKOFF_MS = 15 * 60 * 1000
/**
 * Applied after a 401/403. A credential's scope does not change until someone
 * pastes a new one, so re-asking on every sweep only burns the seat's quota on
 * the throttled usage endpoint.
 */
export const PROBE_SCOPE_BACKOFF_MS = 6 * 60 * 60 * 1000
/** Nothing sensible comes back slower than this. */
const PROBE_TIMEOUT_MS = 15_000

const SESSION_SECONDS = 5 * 60 * 60
const WEEK_SECONDS = 7 * 24 * 60 * 60

/** The probe could not answer. Carries the operator-facing reason, not a stack. */
export class ProbeUnavailable extends Schema.TaggedError<ProbeUnavailable>()('ProbeUnavailable', {
  reason: Schema.String,
  /** True when the credential itself is the problem — wrong scope, expired, revoked. */
  credential: Schema.Boolean
}) {}

// ── provider payloads ────────────────────────────────────────────────────────

/** Every field is optional: Anthropic drops windows a plan does not have. */
const Utilization = Schema.Struct({
  utilization: Schema.optional(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optional(Schema.NullOr(Schema.String))
})

/**
 * Newer model-scoped limits arrive here instead of a dedicated
 * `seven_day_<model>` field. Fable's weekly cap is one of these.
 */
const LimitEntry = Schema.Struct({
  kind: Schema.optional(Schema.NullOr(Schema.String)),
  percent: Schema.optional(Schema.NullOr(Schema.Number)),
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
  scope: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        model: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ display_name: Schema.optional(Schema.NullOr(Schema.String)) })
          )
        )
      })
    )
  )
})

const AnthropicUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(Utilization)),
  seven_day: Schema.optional(Schema.NullOr(Utilization)),
  seven_day_opus: Schema.optional(Schema.NullOr(Utilization)),
  seven_day_sonnet: Schema.optional(Schema.NullOr(Utilization)),
  limits: Schema.optional(Schema.NullOr(Schema.Array(LimitEntry)))
})

const OpenAiWindow = Schema.Struct({
  used_percent: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Number)),
  reset_after_seconds: Schema.optional(Schema.NullOr(Schema.Number)),
  window_minutes: Schema.optional(Schema.NullOr(Schema.Number))
})

const OpenAiUsage = Schema.Struct({
  rate_limit: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        primary_window: Schema.optional(Schema.NullOr(OpenAiWindow)),
        secondary_window: Schema.optional(Schema.NullOr(OpenAiWindow))
      })
    )
  )
})

// ── decoding helpers ─────────────────────────────────────────────────────────

const isoToUtc = (value: string | null | undefined): DateTime.Utc | undefined => {
  if (value === null || value === undefined) return undefined
  const parsed = DateTime.make(new Date(value))
  return Option.getOrUndefined(parsed)
}

const epochToUtc = (seconds: number | null | undefined): DateTime.Utc | undefined => {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return undefined
  return Option.getOrUndefined(DateTime.make(new Date(seconds * 1000)))
}

const window = (
  kind: LimitWindow['kind'],
  label: string,
  percentUsed: number | null | undefined,
  resetsAt: DateTime.Utc | undefined,
  windowSeconds: number | undefined
): LimitWindow | undefined => {
  if (percentUsed === null || percentUsed === undefined || !Number.isFinite(percentUsed)) {
    return undefined
  }
  return {
    kind,
    label,
    percentUsed: Math.max(0, percentUsed),
    ...(resetsAt === undefined ? {} : { resetsAt }),
    ...(windowSeconds === undefined ? {} : { windowSeconds })
  } as LimitWindow
}

const compact = (windows: ReadonlyArray<LimitWindow | undefined>): ReadonlyArray<LimitWindow> =>
  windows.filter((w): w is LimitWindow => w !== undefined)

/**
 * `five_hour` / `seven_day` / `seven_day_<model>` first, then anything in the
 * generic `limits` array that names a model we have not already covered. The
 * legacy per-model fields have gone null before, so both paths must work.
 */
export const fromAnthropic = (payload: typeof AnthropicUsage.Type): ReadonlyArray<LimitWindow> => {
  const named = compact([
    window(
      'session',
      'Session',
      payload.five_hour?.utilization,
      isoToUtc(payload.five_hour?.resets_at),
      SESSION_SECONDS
    ),
    window(
      'weekly',
      'Weekly',
      payload.seven_day?.utilization,
      isoToUtc(payload.seven_day?.resets_at),
      WEEK_SECONDS
    ),
    window(
      'weekly-model',
      'Opus',
      payload.seven_day_opus?.utilization,
      isoToUtc(payload.seven_day_opus?.resets_at),
      WEEK_SECONDS
    ),
    window(
      'weekly-model',
      'Sonnet',
      payload.seven_day_sonnet?.utilization,
      isoToUtc(payload.seven_day_sonnet?.resets_at),
      WEEK_SECONDS
    )
  ])

  const seen = new Set(named.map((w) => w.label.toLowerCase()))
  const scoped: LimitWindow[] = []
  for (const entry of payload.limits ?? []) {
    if (entry.kind !== 'weekly_scoped') continue
    const label = entry.scope?.model?.display_name?.trim()
    if (label === undefined || label === '') continue
    if (seen.has(label.toLowerCase())) continue
    const w = window('weekly-model', label, entry.percent, isoToUtc(entry.resets_at), WEEK_SECONDS)
    if (w === undefined) continue
    seen.add(label.toLowerCase())
    scoped.push(w)
  }
  return [...named, ...scoped]
}

/**
 * OpenAI reports the same two windows in headers and in the body. The headers
 * win when present; `window_minutes` names the real window length, which for
 * Codex is not a fixed 5h/7d pair.
 */
export const fromOpenAi = (
  payload: typeof OpenAiUsage.Type,
  headers: Readonly<Record<string, string>>,
  now: Date = new Date()
): ReadonlyArray<LimitWindow> => {
  const header = (name: string): number | undefined => {
    const raw = headers[name]
    if (raw === undefined) return undefined
    const parsed = Number.parseFloat(raw)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  const resets = (w: typeof OpenAiWindow.Type | null | undefined): DateTime.Utc | undefined => {
    if (w === null || w === undefined) return undefined
    return (
      epochToUtc(w.reset_at) ??
      (w.reset_after_seconds === null || w.reset_after_seconds === undefined
        ? undefined
        : epochToUtc(now.getTime() / 1000 + w.reset_after_seconds))
    )
  }
  const seconds = (w: typeof OpenAiWindow.Type | null | undefined, fallback: number) =>
    w?.window_minutes === null || w?.window_minutes === undefined ? fallback : w.window_minutes * 60

  const primary = payload.rate_limit?.primary_window
  const secondary = payload.rate_limit?.secondary_window
  return compact([
    window(
      'session',
      'Session',
      header('x-codex-primary-used-percent') ?? primary?.used_percent,
      resets(primary),
      seconds(primary, SESSION_SECONDS)
    ),
    window(
      'weekly',
      'Weekly',
      header('x-codex-secondary-used-percent') ?? secondary?.used_percent,
      resets(secondary),
      seconds(secondary, WEEK_SECONDS)
    )
  ])
}

// ── credential shapes ────────────────────────────────────────────────────────

/**
 * What Taut stores for `openai.oauth` is base64 of the whole `~/.codex/auth.json`,
 * so the bearer token has to be dug out of it. `claude.oauth` stores the token
 * itself; a full `claude login` credential file is accepted too, because that
 * is the one with the scope the usage endpoint needs.
 */
export const bearerFrom = (
  kind: CredentialKind,
  secret: string
): { token: string; account?: string } | undefined => {
  const raw = secret.trim()
  if (raw === '') return undefined

  const asJson = (text: string): Record<string, unknown> | undefined => {
    try {
      const parsed: unknown = JSON.parse(text)
      return typeof parsed === 'object' && parsed !== null
        ? (parsed as Record<string, unknown>)
        : undefined
    } catch {
      return undefined
    }
  }
  const decoded =
    asJson(raw) ??
    asJson(
      ((): string => {
        try {
          return Buffer.from(raw, 'base64').toString('utf8')
        } catch {
          return ''
        }
      })()
    )

  if (decoded === undefined) {
    // A bare token: `sk-ant-oat01-…` or an `sk-…` key.
    return kind === 'claude.oauth' || kind === 'openai.oauth' ? { token: raw } : undefined
  }

  if (kind === 'claude.oauth' || kind === 'claude.login') {
    const oauth = decoded['claudeAiOauth'] as Record<string, unknown> | undefined
    const token = (oauth?.['accessToken'] ?? decoded['accessToken']) as string | undefined
    return typeof token === 'string' && token !== '' ? { token } : undefined
  }

  const tokens = decoded['tokens'] as Record<string, unknown> | undefined
  const token = (tokens?.['access_token'] ?? decoded['access_token']) as string | undefined
  const account = (tokens?.['account_id'] ?? decoded['account_id']) as string | undefined
  if (typeof token !== 'string' || token === '') return undefined
  return account === undefined ? { token } : { token, account }
}

// ── claude.login refresh ─────────────────────────────────────────────────────

/**
 * A `claude login` access token lives hours, its refresh token weeks. Without a
 * refresh a pasted login would light the strip up for one afternoon and then go
 * back to showing an error, so the probe rotates it in place.
 */
const ClaudeLogin = Schema.Struct({
  claudeAiOauth: Schema.Struct({
    accessToken: Schema.String,
    refreshToken: Schema.optional(Schema.NullOr(Schema.String)),
    expiresAt: Schema.optional(Schema.NullOr(Schema.Number)),
    scopes: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    subscriptionType: Schema.optional(Schema.NullOr(Schema.String))
  })
})
type ClaudeLogin = typeof ClaudeLogin.Type

const RefreshResponse = Schema.Struct({
  access_token: Schema.String,
  refresh_token: Schema.optional(Schema.NullOr(Schema.String)),
  expires_in: Schema.optional(Schema.NullOr(Schema.Number))
})

const decodeLogin = Schema.decodeUnknownOption(ClaudeLogin)

/** The stored `claude.login` JSON, or `None` when it is some other shape. */
export const parseClaudeLogin = (secret: string): Option.Option<ClaudeLogin> => {
  try {
    return decodeLogin(JSON.parse(secret))
  } catch {
    return Option.none()
  }
}

/** True when the login's access token is spent (or about to be) and can be renewed. */
export const claudeLoginNeedsRefresh = (login: ClaudeLogin): boolean => {
  const { expiresAt, refreshToken } = login.claudeAiOauth
  if (refreshToken === undefined || refreshToken === null || refreshToken === '') return false
  if (expiresAt === undefined || expiresAt === null) return true
  return Date.now() >= expiresAt - REFRESH_SKEW_MS
}

// ── service ──────────────────────────────────────────────────────────────────

interface Gate {
  /** Earliest wall-clock time the next live call for this seat is allowed. */
  readonly notBefore: number
}

export interface ProbeInput {
  /** Cache/backoff key; the seat's id in production. */
  readonly key: string
  readonly runtime: RuntimeKind
  readonly credentialKind: CredentialKind
  readonly secret: Redacted.Redacted<string>
  /** Skip the TTL (an operator pressed Check). The 429 backoff still applies. */
  readonly force?: boolean | undefined
}

export class UsageProbe extends Effect.Service<UsageProbe>()('UsageProbe', {
  effect: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.transformResponse(Effect.timeout(PROBE_TIMEOUT_MS))
    )
    const gates = yield* Ref.make(new Map<string, Gate>())

    const decodeAnthropic = Schema.decodeUnknown(AnthropicUsage)
    const decodeOpenAi = Schema.decodeUnknown(OpenAiUsage)
    const decodeRefresh = Schema.decodeUnknown(RefreshResponse)

    /**
     * `/api/oauth/usage` hands out hour-long `Retry-After` windows to anything
     * that polls it, so a refusal has to stick for the whole window rather than
     * being retried on the next sweep.
     */
    const holdOff = (key: string, ms: number) =>
      Ref.update(gates, (map) => new Map(map).set(key, { notBefore: Date.now() + ms }))

    const open = (key: string, force: boolean) =>
      Ref.get(gates).pipe(
        Effect.map((map) => {
          const gate = map.get(key)
          if (gate === undefined) return true
          if (Date.now() >= gate.notBefore) return true
          // A forced check still cannot punch through a provider-imposed 429.
          return force && gate.notBefore - Date.now() <= PROBE_TTL_MS
        })
      )

    const request = (input: ProbeInput) =>
      Effect.gen(function* () {
        const auth = bearerFrom(input.credentialKind, Redacted.value(input.secret))
        if (auth === undefined) {
          return yield* new ProbeUnavailable({
            reason: 'this credential does not carry a usage-readable token',
            credential: true
          })
        }

        const anthropic =
          input.credentialKind === 'claude.oauth' || input.credentialKind === 'claude.login'
        const req = HttpClientRequest.get(anthropic ? ANTHROPIC_USAGE_URL : OPENAI_USAGE_URL).pipe(
          HttpClientRequest.setHeaders({
            authorization: `Bearer ${auth.token}`,
            accept: 'application/json',
            'user-agent': 'Taut',
            ...(anthropic ? { 'anthropic-beta': 'oauth-2025-04-20' } : {}),
            ...(auth.account === undefined ? {} : { 'chatgpt-account-id': auth.account })
          })
        )

        const response = yield* client.execute(req).pipe(
          Effect.catchTag('ResponseError', (error) => {
            const status = error.response.status
            if (status === 429) {
              const after = Number.parseFloat(error.response.headers['retry-after'] ?? '')
              const ms =
                Number.isFinite(after) && after > 0 ? after * 1000 : PROBE_DEFAULT_BACKOFF_MS
              return holdOff(input.key, ms).pipe(
                Effect.zipRight(
                  new ProbeUnavailable({
                    reason: `provider is throttling usage reads; retrying in ${Math.round(ms / 60000)}m`,
                    credential: false
                  })
                )
              )
            }
            if (status === 401 || status === 403) {
              // A setup-token has `user:inference` only. Sit out a full TTL
              // rather than re-asking on every sweep with the same token.
              return holdOff(input.key, PROBE_SCOPE_BACKOFF_MS).pipe(
                Effect.zipRight(
                  new ProbeUnavailable({
                    reason:
                      'the stored credential cannot read usage — a `claude setup-token` is inference-only',
                    credential: true
                  })
                )
              )
            }
            return new ProbeUnavailable({
              reason: `provider returned HTTP ${status}`,
              credential: false
            })
          }),
          Effect.catchTag('RequestError', (error) =>
            Effect.fail(
              new ProbeUnavailable({
                reason: `cannot reach provider: ${error.reason}`,
                credential: false
              })
            )
          ),
          Effect.catchTag('TimeoutException', () =>
            Effect.fail(
              new ProbeUnavailable({ reason: 'provider did not answer in time', credential: false })
            )
          )
        )

        const body = yield* response.json.pipe(
          Effect.mapError(
            () =>
              new ProbeUnavailable({ reason: 'provider sent unreadable JSON', credential: false })
          )
        )

        const windows = anthropic
          ? yield* decodeAnthropic(body).pipe(Effect.map(fromAnthropic))
          : yield* decodeOpenAi(body).pipe(
              Effect.map((payload) => fromOpenAi(payload, response.headers))
            )

        if (windows.length === 0) {
          return yield* new ProbeUnavailable({
            reason: 'provider reported no quota windows for this account',
            credential: false
          })
        }
        // A good read earns the seat its TTL before the next live call.
        yield* holdOff(input.key, PROBE_TTL_MS)
        return windows
      }).pipe(
        Effect.catchTag('ParseError', (error) =>
          Effect.fail(
            new ProbeUnavailable({
              reason: `unexpected usage payload: ${error.message}`,
              credential: false
            })
          )
        )
      )

    /**
     * `Some(windows)` on a fresh read, `None` when the seat is inside its TTL or
     * a provider backoff — the caller should keep whatever it already stored.
     */
    const probe = (
      input: ProbeInput
    ): Effect.Effect<Option.Option<ReadonlyArray<LimitWindow>>, ProbeUnavailable> =>
      Effect.gen(function* () {
        if (!supports(input.runtime, input.credentialKind)) return Option.none()
        if (!(yield* open(input.key, input.force === true))) return Option.none()
        return Option.some(yield* request(input))
      })

    /**
     * Trade a `claude.login`'s refresh token for a fresh access token and hand
     * back the JSON to re-store. Fails as `ProbeUnavailable` like everything
     * else here: a login the provider will not renew is an operator problem to
     * read on the seat, not a task failure.
     */
    const refreshClaudeLogin = (
      secret: Redacted.Redacted<string>
    ): Effect.Effect<string, ProbeUnavailable> =>
      Effect.gen(function* () {
        const login = parseClaudeLogin(Redacted.value(secret))
        if (Option.isNone(login)) {
          return yield* new ProbeUnavailable({
            reason: 'the stored usage credential is not a Claude login',
            credential: true
          })
        }
        const refreshToken = login.value.claudeAiOauth.refreshToken
        if (refreshToken === undefined || refreshToken === null || refreshToken === '') {
          return yield* new ProbeUnavailable({
            reason: 'this Claude login has no refresh token — paste a fresh one',
            credential: true
          })
        }

        const response = yield* client
          .execute(
            HttpClientRequest.post(ANTHROPIC_TOKEN_URL).pipe(
              HttpClientRequest.setHeaders({ accept: 'application/json', 'user-agent': 'Taut' }),
              HttpClientRequest.bodyUnsafeJson({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
                client_id: ANTHROPIC_CLIENT_ID
              })
            )
          )
          .pipe(
            Effect.catchTag('ResponseError', (error) =>
              Effect.fail(
                new ProbeUnavailable({
                  reason:
                    error.response.status === 400 || error.response.status === 401
                      ? 'this Claude login expired — paste a fresh one'
                      : `could not renew the Claude login (HTTP ${error.response.status})`,
                  credential: true
                })
              )
            ),
            Effect.catchTag('RequestError', (error) =>
              Effect.fail(
                new ProbeUnavailable({
                  reason: `cannot reach provider: ${error.reason}`,
                  credential: false
                })
              )
            ),
            Effect.catchTag('TimeoutException', () =>
              Effect.fail(
                new ProbeUnavailable({
                  reason: 'provider did not answer in time',
                  credential: false
                })
              )
            )
          )

        const body = yield* response.json.pipe(
          Effect.mapError(
            () =>
              new ProbeUnavailable({ reason: 'provider sent unreadable JSON', credential: false })
          )
        )
        const renewed = yield* decodeRefresh(body).pipe(
          Effect.mapError(
            () =>
              new ProbeUnavailable({
                reason: 'provider sent an unexpected refresh payload',
                credential: false
              })
          )
        )

        const seconds = renewed.expires_in ?? 0
        return JSON.stringify({
          claudeAiOauth: {
            ...login.value.claudeAiOauth,
            accessToken: renewed.access_token,
            refreshToken: renewed.refresh_token ?? refreshToken,
            expiresAt: seconds > 0 ? Date.now() + seconds * 1000 : 0
          }
        })
      })

    return { probe, refreshClaudeLogin } as const
  }),
  dependencies: [FetchHttpClient.layer]
}) {}

/** Runtimes whose provider exposes a usage endpoint we can read. */
export const supports = (runtime: RuntimeKind, kind: CredentialKind): boolean =>
  (runtime === 'claude-code' && kind === 'claude.login') ||
  (runtime === 'codex' && kind === 'openai.oauth')
