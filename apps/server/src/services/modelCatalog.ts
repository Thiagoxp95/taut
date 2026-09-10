import { FetchHttpClient, HttpClient, HttpClientRequest } from '@effect/platform'
import type { CredentialKind, ModelOption, ReasoningEffort, RuntimeKind } from '@taut/contract'
import { RuntimeReasoningEfforts } from '@taut/contract'
import { DateTime, Effect, Option, Redacted, Ref, Schema } from 'effect'

import { bearerFrom } from './usageProbe.js'

/**
 * The models a runtime can actually reach (docs/build-plan-run-overrides.md D6).
 *
 * Every list in Taut used to be a string array somebody had to remember to edit
 * when a provider shipped. This asks the provider instead, with the seat's own
 * credential — the same one that will run the task, so a model in the list is a
 * model that seat is allowed to call.
 *
 * Nothing here is allowed to fail. A provider outage, a scope-less token, a
 * runtime with no models endpoint at all: each of those answers the short
 * built-in list with one line saying why, because a dropdown that cannot open
 * is worse than a dropdown that is a little behind.
 */

const ANTHROPIC_MODELS_URL = 'https://api.anthropic.com/v1/models?limit=100'
const OPENAI_MODELS_URL = 'https://api.openai.com/v1/models'
// Codex CLI 0.154.0's authenticated discovery protocol, verified against the
// backend. This version identifies the protocol client, not a model allow-list.
const CODEX_MODELS_URL = 'https://chatgpt.com/backend-api/codex/models?client_version=0.154.0'
/** OpenCode has no key of its own; models.dev is the catalogue it resolves against. */
const MODELS_DEV_URL = 'https://models.dev/api.json'
const ANTHROPIC_VERSION = '2023-06-01'

/** A catalogue is worth re-reading occasionally, not on every popup open. */
export const CATALOG_TTL_MS = 30 * 60 * 1000
/** A provider that just refused stays refused for this long. */
export const CATALOG_ERROR_TTL_MS = 5 * 60 * 1000
const CATALOG_TIMEOUT_MS = 10_000

/**
 * What the dropdown shows when the provider cannot be asked. Deliberately
 * short: it is a floor, not a catalogue, and every entry is a model id the
 * corresponding CLI has accepted.
 */
export const FALLBACK_MODELS: Record<RuntimeKind, ReadonlyArray<ModelOption>> = {
  'claude-code': [
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1' },
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' }
  ],
  codex: [
    { id: 'gpt-6-astra', label: 'GPT-6-Astra' },
    { id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
    { id: 'gpt-5.6-luna', label: 'GPT-5.6-Luna' }
  ],
  cursor: [
    { id: 'auto', label: 'Auto' },
    { id: 'sonnet-4.5', label: 'Sonnet 4.5' },
    { id: 'gpt-5', label: 'GPT-5' }
  ],
  opencode: [
    { id: 'anthropic/claude-sonnet-4-5', label: 'Claude Sonnet 4.5', group: 'anthropic' },
    { id: 'openai/gpt-5', label: 'GPT-5', group: 'openai' }
  ]
}

/**
 * The floor under the context meter (docs/build-plan-context-meter.md D6), used when
 * models.dev cannot be reached and the runtime did not state a window of its own.
 *
 * Same posture as `FALLBACK_MODELS`: short, hand-checked, and never the first answer.
 * A denominator that is merely plausible turns the ring into a confident wrong number,
 * so anything not listed here resolves to nothing and the meter shows raw tokens instead.
 *
 * Keys are matched exactly first, then by prefix, because a runtime may report a dated
 * build (`claude-sonnet-4-5-20250929`) of a model the catalogue lists undated.
 */
export const FALLBACK_CONTEXT_WINDOWS: Record<RuntimeKind, Readonly<Record<string, number>>> = {
  'claude-code': {
    'claude-opus-4-1': 200_000,
    'claude-opus-4': 200_000,
    'claude-sonnet-4-5': 200_000,
    'claude-sonnet-4': 200_000,
    'claude-haiku-4-5': 200_000
  },
  codex: { 'gpt-5-codex': 400_000, 'gpt-5': 400_000, 'o4-mini': 200_000, 'gpt-4.1': 1_047_576 },
  // Cursor reports no usage at all, so there is nothing for a denominator to divide (D5).
  cursor: {},
  opencode: {}
}

/** models.dev provider key for a runtime's bare model ids. OpenCode ids carry their own. */
const MODELS_DEV_PROVIDER: Partial<Record<RuntimeKind, string>> = {
  'claude-code': 'anthropic',
  codex: 'openai'
}

/** Windows are a property of the model, not of a seat, so one cache serves everyone. */
const CONTEXT_WINDOW_TTL_MS = 6 * 60 * 60 * 1000

const lookupWindow = (
  table: Readonly<Record<string, number>>,
  model: string
): number | undefined => {
  const exact = table[model]
  if (exact !== undefined) return exact
  // `claude-sonnet-4-5-20250929` against a catalogue that lists `claude-sonnet-4-5`.
  let best: { readonly key: string; readonly value: number } | undefined
  for (const [key, value] of Object.entries(table)) {
    if (!model.startsWith(key)) continue
    if (best === undefined || key.length > best.key.length) best = { key, value }
  }
  return best?.value
}

// ── provider payloads ────────────────────────────────────────────────────────

const AnthropicModels = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      display_name: Schema.optional(Schema.NullOr(Schema.String))
    })
  )
})

const OpenAiModels = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String }))
})

const CodexModels = Schema.Struct({
  models: Schema.Array(
    Schema.Struct({
      slug: Schema.String,
      display_name: Schema.optional(Schema.String),
      visibility: Schema.String,
      priority: Schema.optional(Schema.Number)
    })
  )
})

/**
 * models.dev keys providers, then models, and every model carries far more than
 * a name. Only the fields the dropdown and the context meter need are decoded;
 * the rest is allowed to change shape without breaking us. It is also the one
 * catalogue that states a context window for all four runtimes' models, which
 * is why the meter resolves its denominator here and not per provider.
 */
const ModelsDev = Schema.Record({
  key: Schema.String,
  value: Schema.Struct({
    name: Schema.optional(Schema.String),
    models: Schema.Record({
      key: Schema.String,
      value: Schema.Struct({
        name: Schema.optional(Schema.String),
        /** The context meter's denominator (docs/build-plan-context-meter.md D6). */
        limit: Schema.optional(Schema.Struct({ context: Schema.optional(Schema.Number) }))
      })
    })
  })
})

/**
 * OpenAI's `/v1/models` lists embeddings, TTS, moderation and a decade of
 * deprecated chat models next to the ones `codex` can drive. Codex takes a
 * reasoning model, so that is what survives the filter.
 */
const CODEX_MODEL = /^(gpt-[5-9]\d*(?:\.\d+)?|gpt-4\.1|o[34])(-|$)/
const CODEX_NOT_MODEL = /(audio|realtime|transcribe|tts|image|search|embedding|moderation)/

const titleCase = (id: string): string =>
  id
    .split(/[-_]/)
    .map((part) => (part.length <= 2 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1)))
    .join(' ')

// ── cache ────────────────────────────────────────────────────────────────────

interface Entry {
  readonly models: ReadonlyArray<ModelOption>
  readonly source: 'live' | 'fallback'
  readonly note?: string
  readonly at: number
}

export interface CatalogInput {
  /** Cache key — the credential id, so two seats on one login share a read. */
  readonly key: string
  readonly runtime: RuntimeKind
  /** Absent when no seat could be resolved; the answer is then the fallback. */
  readonly credential?: {
    readonly kind: CredentialKind
    readonly secret: Redacted.Redacted<string>
  }
  readonly refresh?: boolean | undefined
}

export interface Catalog {
  readonly runtime: RuntimeKind
  readonly source: 'live' | 'fallback'
  readonly models: ReadonlyArray<ModelOption>
  readonly reasoningEfforts: ReadonlyArray<ReasoningEffort>
  readonly note?: string
  readonly fetchedAt: DateTime.Utc
}

export class ModelCatalogs extends Effect.Service<ModelCatalogs>()('ModelCatalogs', {
  effect: Effect.gen(function* () {
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.filterStatusOk,
      HttpClient.transformResponse(Effect.timeout(CATALOG_TIMEOUT_MS))
    )
    const cache = yield* Ref.make(new Map<string, Entry>())

    const decodeAnthropic = Schema.decodeUnknown(AnthropicModels)
    const decodeOpenAi = Schema.decodeUnknown(OpenAiModels)
    const decodeCodex = Schema.decodeUnknown(CodexModels)
    const decodeModelsDev = Schema.decodeUnknown(ModelsDev)

    const json = (request: HttpClientRequest.HttpClientRequest) =>
      client.execute(request).pipe(Effect.flatMap((response) => response.json))

    /** Anthropic answers the same list to an API key and to an OAuth access token. */
    const anthropic = (kind: CredentialKind, secret: string) =>
      Effect.gen(function* () {
        const auth =
          kind === 'anthropic.api_key'
            ? { 'x-api-key': secret.trim() }
            : ((): Record<string, string> => {
                const bearer = bearerFrom(kind, secret)
                return bearer === undefined
                  ? {}
                  : {
                      authorization: `Bearer ${bearer.token}`,
                      'anthropic-beta': 'oauth-2025-04-20'
                    }
              })()
        if (Object.keys(auth).length === 0) {
          return yield* Effect.fail('this credential carries no token to ask with' as const)
        }
        const payload = yield* json(
          HttpClientRequest.get(ANTHROPIC_MODELS_URL).pipe(
            HttpClientRequest.setHeaders({
              accept: 'application/json',
              'anthropic-version': ANTHROPIC_VERSION,
              'user-agent': 'Taut',
              ...auth
            })
          )
        )
        const decoded = yield* decodeAnthropic(payload)
        return decoded.data.map((model): ModelOption => ({
          id: model.id,
          label: model.display_name ?? titleCase(model.id)
        }))
      })

    /** ChatGPT seats use Codex's account catalogue; API keys use the public API. */
    const openai = (kind: CredentialKind, secret: string) =>
      Effect.gen(function* () {
        if (kind === 'openai.oauth') {
          const bearer = bearerFrom(kind, secret)
          if (bearer === undefined)
            return yield* Effect.fail('this credential carries no token to ask with')
          const payload = yield* json(
            HttpClientRequest.get(CODEX_MODELS_URL).pipe(
              HttpClientRequest.setHeaders({
                accept: 'application/json',
                authorization: `Bearer ${bearer.token}`,
                'user-agent': 'Taut',
                ...(bearer.account === undefined ? {} : { 'chatgpt-account-id': bearer.account })
              })
            )
          )
          const decoded = yield* decodeCodex(payload)
          return decoded.models
            .filter((model) => model.visibility === 'list')
            .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
            .map((model): ModelOption => ({
              id: model.slug,
              label: model.display_name ?? model.slug
            }))
        }
        if (kind !== 'openai.api_key')
          return yield* Effect.fail('this credential cannot list Codex models')
        const payload = yield* json(
          HttpClientRequest.get(OPENAI_MODELS_URL).pipe(
            HttpClientRequest.setHeaders({
              accept: 'application/json',
              authorization: `Bearer ${secret.trim()}`,
              'user-agent': 'Taut'
            })
          )
        )
        const decoded = yield* decodeOpenAi(payload)
        return decoded.data
          .filter((model) => CODEX_MODEL.test(model.id) && !CODEX_NOT_MODEL.test(model.id))
          .map((model): ModelOption => ({ id: model.id, label: model.id }))
          .sort((a, b) => a.id.localeCompare(b.id))
      })

    /**
     * OpenCode names a model `provider/model` and resolves it against
     * models.dev, so that is the list — grouped by provider, which is also what
     * the dropdown sections on.
     */
    const opencode = Effect.gen(function* () {
      const payload = yield* json(
        HttpClientRequest.get(MODELS_DEV_URL).pipe(
          HttpClientRequest.setHeaders({ accept: 'application/json', 'user-agent': 'Taut' })
        )
      )
      const decoded = yield* decodeModelsDev(payload)
      const options: ModelOption[] = []
      for (const [providerId, provider] of Object.entries(decoded)) {
        for (const [modelId, model] of Object.entries(provider.models)) {
          options.push({
            id: `${providerId}/${modelId}`,
            label: model.name ?? modelId,
            group: provider.name ?? providerId
          })
        }
      }
      return options.sort(
        (a, b) => (a.group ?? '').localeCompare(b.group ?? '') || a.label.localeCompare(b.label)
      )
    })

    /** Cursor publishes no models API; `cursor-agent` resolves names server-side. */
    const live = (input: CatalogInput): Effect.Effect<ReadonlyArray<ModelOption>, string> => {
      if (input.runtime === 'opencode') return opencode.pipe(Effect.mapError(asReason))
      if (input.runtime === 'cursor') {
        return Effect.fail('Cursor publishes no models API')
      }
      const credential = input.credential
      if (credential === undefined) {
        return Effect.fail('no usable seat for this runtime yet')
      }
      const secret = Redacted.value(credential.secret)
      const call =
        input.runtime === 'claude-code'
          ? anthropic(credential.kind, secret)
          : openai(credential.kind, secret)
      return call.pipe(Effect.mapError(asReason))
    }

    const get = (input: CatalogInput): Effect.Effect<Catalog> =>
      Effect.gen(function* () {
        const key = `${input.runtime}:${input.key}`
        const cached = (yield* Ref.get(cache)).get(key)
        const ttl = cached?.source === 'live' ? CATALOG_TTL_MS : CATALOG_ERROR_TTL_MS
        const fresh = cached !== undefined && Date.now() - cached.at < ttl
        const entry =
          fresh && input.refresh !== true
            ? cached
            : yield* live(input).pipe(
                Effect.map((models): Entry =>
                  models.length === 0
                    ? {
                        models: FALLBACK_MODELS[input.runtime],
                        source: 'fallback',
                        note: 'the provider listed no models this runtime can drive',
                        at: Date.now()
                      }
                    : { models, source: 'live', at: Date.now() }
                ),
                Effect.catchAll((reason) =>
                  Effect.succeed<Entry>({
                    models: FALLBACK_MODELS[input.runtime],
                    source: 'fallback',
                    note: reason,
                    at: Date.now()
                  })
                ),
                Effect.tap((next) => Ref.update(cache, (map) => new Map(map).set(key, next)))
              )

        const now = yield* DateTime.now
        return {
          runtime: input.runtime,
          source: entry.source,
          models: entry.models,
          reasoningEfforts: RuntimeReasoningEfforts[input.runtime],
          ...(entry.note === undefined ? {} : { note: entry.note }),
          fetchedAt: DateTime.unsafeMake(entry.at > 0 ? entry.at : DateTime.toEpochMillis(now))
        }
      })

    // ── context windows ──────────────────────────────────────────────────────

    /** models.dev, decoded to `provider/model → context tokens`. One read for everyone. */
    const windows = yield* Ref.make<
      { readonly at: number; readonly table: Record<string, number> } | undefined
    >(undefined)

    const windowTable = Effect.gen(function* () {
      const cached = yield* Ref.get(windows)
      if (cached !== undefined && Date.now() - cached.at < CONTEXT_WINDOW_TTL_MS) {
        return cached.table
      }
      const decoded = yield* json(
        HttpClientRequest.get(MODELS_DEV_URL).pipe(
          HttpClientRequest.setHeaders({ accept: 'application/json', 'user-agent': 'Taut' })
        )
      ).pipe(Effect.flatMap(decodeModelsDev))
      const table: Record<string, number> = {}
      for (const [providerId, provider] of Object.entries(decoded)) {
        for (const [modelId, model] of Object.entries(provider.models)) {
          const context = model.limit?.context
          if (context !== undefined && context > 0) table[`${providerId}/${modelId}`] = context
        }
      }
      yield* Ref.set(windows, { at: Date.now(), table })
      return table
    }).pipe(
      // A meter is an ornament: an unreachable catalogue means no percentage, never an error.
      Effect.catchAll(() => Effect.succeed<Record<string, number>>({}))
    )

    /**
     * How many tokens `model` can hold on `runtime` (docs/build-plan-context-meter.md D6).
     *
     * models.dev first, the built-in floor second, nothing third. Nothing is a real answer
     * and the caller must honour it: with no denominator the meter shows the token count and
     * draws no ring, which is the truthful rendering of "we do not know how big this is".
     */
    const contextWindow = (
      runtime: RuntimeKind,
      model: string
    ): Effect.Effect<Option.Option<number>> =>
      Effect.gen(function* () {
        const provider = MODELS_DEV_PROVIDER[runtime]
        // OpenCode ids are already `provider/model`; the others need theirs prepended.
        const key = model.includes('/')
          ? model
          : provider === undefined
            ? undefined
            : `${provider}/${model}`
        if (key !== undefined) {
          const live = lookupWindow(yield* windowTable, key)
          if (live !== undefined) return Option.some(live)
        }
        const floor = lookupWindow(FALLBACK_CONTEXT_WINDOWS[runtime], model)
        return floor === undefined ? Option.none() : Option.some(floor)
      })

    return { get, contextWindow } as const
  }),
  dependencies: [FetchHttpClient.layer]
}) {}

/** Any failure the provider call can produce, as the one line the popup shows. */
const asReason = (error: unknown): string => {
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const tagged = error as { _tag?: string; response?: { status?: number }; message?: string }
    const status = tagged.response?.status
    if (status === 401 || status === 403) return 'the seat credential may not list models'
    if (status !== undefined) return `the provider answered HTTP ${status}`
    if (tagged._tag === 'TimeoutException') return 'the provider did not answer in time'
    if (typeof tagged.message === 'string' && tagged.message !== '') return tagged.message
  }
  return 'the provider could not be reached'
}

/** Whether `runtime` needs a seat credential before it can answer anything live. */
export const needsCredential = (runtime: RuntimeKind): boolean =>
  runtime === 'claude-code' || runtime === 'codex'

/** Cache-key for a runtime with no resolvable seat, so those share one entry. */
export const NO_SEAT_KEY = 'no-seat'

/** Reasoning efforts a runtime honours, for callers that only want the list. */
export const effortsFor = (runtime: RuntimeKind): ReadonlyArray<ReasoningEffort> =>
  RuntimeReasoningEfforts[runtime]
