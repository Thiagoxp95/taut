import { FetchHttpClient, HttpClient, HttpClientRequest } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import type { GithubManifest } from '@taut/contract/api'
import type { FileGrantMode, GithubConnection } from '@taut/contract/domain'
import { Validation } from '@taut/contract/errors'
import type { CompanyId, RepositoryId, UserId } from '@taut/contract/ids'
import { Data, Effect, Either, Option, Redacted, Ref, Schema } from 'effect'
import {
  createHmac,
  createSign,
  randomBytes,
  timingSafeEqual as cryptoTimingSafeEqual
} from 'node:crypto'
import { AppConfig } from '../config.js'
import { findOne, nowIso, run } from '../db/sql.js'
import { GithubAppRow, toGithubConnection } from '../domain/rows.js'
import { decrypt, encrypt } from '../vault/crypto.js'

/**
 * The company's GitHub App (docs/build-plan-repositories.md D2, D8).
 *
 * One App per company, created through GitHub's *manifest* flow: Taut posts a
 * description of the App it wants, the owner names it and clicks Create, and
 * GitHub hands back the App's identity plus three secrets — the RSA private key,
 * the OAuth client secret and the webhook secret. All three are encrypted at rest
 * with `vault/crypto.ts` under the company's key with the company id as AAD, and
 * no method here returns any of them, redacted or otherwise. The only credential
 * that ever leaves this module is a freshly minted installation token, and it
 * leaves `Redacted`.
 *
 * An App matters because of what it can mint: an installation token scoped to one
 * repository with `contents: read` *or* `contents: write`. That is what makes a
 * read-only grant real rather than advisory — GitHub refuses the push, no local
 * check is trusted with it (D2). A PAT cannot be narrowed like that, which is why
 * there is no PAT path.
 *
 * github.com only for now (D10): the two hosts below are the whole surface to
 * change when GitHub Enterprise Server arrives.
 */

/** D10: the one place github.com is named. */
export const GITHUB_API = 'https://api.github.com'
export const GITHUB_WEB = 'https://github.com'

const USER_AGENT = 'Taut'
const ACCEPT = 'application/vnd.github+json'
const API_VERSION = '2022-11-28'
const REQUEST_TIMEOUT_MS = 20_000

/** The signed `state` lives exactly long enough for a human to name an App. */
export const STATE_TTL_MS = 10 * 60 * 1000
/** An installation token is good for an hour; stop trusting it a minute early. */
export const TOKEN_SKEW_MS = 60_000
/** The App JWT GitHub accepts is at most 10 minutes; 9 leaves room for clock drift. */
const JWT_LIFETIME_S = 9 * 60
const JWT_BACKDATE_S = 60

/**
 * Anything GitHub (or the flow around it) refused. Carries an operator-facing
 * sentence and never a token — `message` is rendered to the user and written to
 * logs, so a secret must not be able to reach it.
 */
export class GithubFailure extends Data.TaggedError('GithubFailure')<{
  readonly reason: string
}> {}

/** Convenience for the HTTP handlers, which may only fail with contract errors. */
export const asValidation = (error: GithubFailure): Validation =>
  new Validation({ issues: [{ path: ['github'], message: error.reason }] })

// ── payloads ─────────────────────────────────────────────────────────────────

/** `POST /app-manifests/{code}/conversions`. The three `*_secret`/`pem` fields are why D8 exists. */
const ManifestConversion = Schema.Struct({
  id: Schema.Number,
  slug: Schema.String,
  client_id: Schema.String,
  client_secret: Schema.String,
  pem: Schema.String,
  webhook_secret: Schema.optional(Schema.NullOr(Schema.String))
})

const InstallationAccount = Schema.Struct({
  account: Schema.optional(
    Schema.NullOr(Schema.Struct({ login: Schema.optional(Schema.NullOr(Schema.String)) }))
  )
})

const GithubRepoPayload = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
  full_name: Schema.String,
  private: Schema.Boolean,
  default_branch: Schema.optional(Schema.NullOr(Schema.String)),
  clone_url: Schema.optional(Schema.NullOr(Schema.String)),
  owner: Schema.optional(Schema.NullOr(Schema.Struct({ login: Schema.String })))
})

const InstallationRepositories = Schema.Struct({
  repositories: Schema.Array(GithubRepoPayload)
})

const AccessToken = Schema.Struct({
  token: Schema.String,
  expires_at: Schema.String
})

const PullRequest = Schema.Struct({
  number: Schema.Number,
  html_url: Schema.String
})

// ── public shapes ────────────────────────────────────────────────────────────

/** One repository the installation can see, normalised out of GitHub's payload. */
export interface GithubRepo {
  readonly githubId: number
  readonly owner: string
  readonly name: string
  readonly fullName: string
  readonly defaultBranch: string
  readonly private: boolean
  readonly cloneUrl: string
}

/** What `state` proves: this browser round-trip belongs to that user of that company. */
export interface StateClaims {
  readonly companyId: CompanyId
  readonly userId: UserId
}

/** A minted installation token. Unwrap at the last possible moment, log never. */
export interface InstallationToken {
  readonly token: Redacted.Redacted<string>
  /** ISO-8601, straight from GitHub, so the caller can tell the agent when to re-ask. */
  readonly expiresAt: string
}

/** What `openPullRequest` needs about the repository it is opening against. */
export interface PullRequestTarget {
  readonly repositoryId: RepositoryId
  readonly owner: string
  readonly name: string
}

export interface OpenPullRequestInput {
  readonly title: string
  readonly body: string
  readonly head: string
  readonly base: string
}

// ── state ────────────────────────────────────────────────────────────────────

const b64url = (buffer: Buffer): string => buffer.toString('base64url')

/** Constant-time compare that also survives a length mismatch. */
const equalSignatures = (a: Buffer, b: Buffer): boolean =>
  a.length === b.length && cryptoTimingSafeEqual(a, b)

const StateClaimsJson = Schema.Struct({
  c: Schema.String,
  u: Schema.String,
  /** Expiry, epoch milliseconds. */
  e: Schema.Number,
  /** Nonce: what makes the state single-use. */
  n: Schema.String
})

export class GitHubApp extends Effect.Service<GitHubApp>()('GitHubApp', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const config = yield* AppConfig
    const masterKey = Redacted.value(config.masterKey)
    const client = (yield* HttpClient.HttpClient).pipe(
      HttpClient.transformResponse(Effect.timeout(REQUEST_TIMEOUT_MS))
    )

    /** Nonces already spent, with the moment they stop mattering. Single process, in memory. */
    const spentStates = yield* Ref.make(new Map<string, number>())
    /** One-use browser handoffs, separate from the state GitHub must return. */
    const browserHandoffs = yield* Ref.make(
      new Map<string, { readonly manifest: GithubManifest; readonly expiresAt: number }>()
    )
    /** `(companyId, repositoryId, mode)` → token, dropped `TOKEN_SKEW_MS` before it expires. */
    const tokenCache = yield* Ref.make(
      new Map<string, { readonly token: string; readonly expiresAt: string }>()
    )

    // ── queries ──────────────────────────────────────────────────────────────

    const COLUMNS =
      'company_id, app_id, app_slug, client_id, installation_id, account_login, created_at, connected_at'

    const appRow = findOne({
      Request: Schema.String,
      Result: GithubAppRow,
      execute: (companyId) =>
        sql`SELECT ${sql.literal(COLUMNS)} FROM github_apps WHERE company_id = ${companyId}`
    })

    /** The only statement that reads ciphertext. Its result never escapes this module. */
    const secretsRow = findOne({
      Request: Schema.String,
      Result: Schema.Struct({
        app_id: Schema.Number,
        installation_id: Schema.NullOr(Schema.Number),
        private_key_ct: Schema.Uint8ArrayFromSelf
      }),
      execute: (companyId) => sql`
        SELECT app_id, installation_id, private_key_ct FROM github_apps
        WHERE company_id = ${companyId}`
    })

    const insertApp = run({
      Request: Schema.Struct({
        companyId: Schema.String,
        appId: Schema.Number,
        appSlug: Schema.String,
        clientId: Schema.String,
        clientSecretCt: Schema.Uint8ArrayFromSelf,
        privateKeyCt: Schema.Uint8ArrayFromSelf,
        webhookSecretCt: Schema.NullOr(Schema.Uint8ArrayFromSelf),
        createdAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO github_apps
          (company_id, app_id, app_slug, client_id, client_secret_ct, private_key_ct,
           webhook_secret_ct, installation_id, account_login, created_at, connected_at)
        VALUES (${r.companyId}, ${r.appId}, ${r.appSlug}, ${r.clientId},
                ${Buffer.from(r.clientSecretCt)}, ${Buffer.from(r.privateKeyCt)},
                ${r.webhookSecretCt === null ? null : Buffer.from(r.webhookSecretCt)},
                NULL, NULL, ${r.createdAt}, NULL)
        ON CONFLICT (company_id) DO UPDATE SET
          app_id = excluded.app_id, app_slug = excluded.app_slug,
          client_id = excluded.client_id, client_secret_ct = excluded.client_secret_ct,
          private_key_ct = excluded.private_key_ct,
          webhook_secret_ct = excluded.webhook_secret_ct,
          installation_id = NULL, account_login = NULL, connected_at = NULL`
    })

    const markInstalled = run({
      Request: Schema.Struct({
        companyId: Schema.String,
        installationId: Schema.Number,
        accountLogin: Schema.NullOr(Schema.String),
        connectedAt: Schema.String
      }),
      execute: (r) => sql`
        UPDATE github_apps
        SET installation_id = ${r.installationId}, account_login = ${r.accountLogin},
            connected_at = ${r.connectedAt}
        WHERE company_id = ${r.companyId}`
    })

    const deleteApp = run({
      Request: Schema.String,
      execute: (companyId) => sql`DELETE FROM github_apps WHERE company_id = ${companyId}`
    })

    // ── signed state ─────────────────────────────────────────────────────────

    const sign = (payload: string): Buffer =>
      createHmac('sha256', Buffer.from(masterKey)).update(payload).digest()

    /**
     * A single-use, ten-minute HMAC over `{companyId, userId, exp, nonce}`. GitHub
     * hands `state` back through the owner's *browser*, so the callback has no
     * session to trust and this token is the whole authentication: nothing that
     * arrives in the query string is believed until the signature checks out.
     */
    const signState = (companyId: CompanyId, userId: UserId): string => {
      const claims = {
        c: companyId,
        u: userId,
        e: Date.now() + STATE_TTL_MS,
        n: randomBytes(12).toString('base64url')
      }
      const body = b64url(Buffer.from(JSON.stringify(claims), 'utf8'))
      return `${body}.${b64url(sign(body))}`
    }

    /**
     * Verify and spend a `state`. Fails for a bad signature, an expired claim and a
     * nonce already used — the three ways an attacker gets to pick the company a
     * callback writes to. Expired nonces are swept here so the map cannot grow.
     */
    const consumeState = (state: string): Effect.Effect<StateClaims, GithubFailure> =>
      Effect.gen(function* () {
        const refused = new GithubFailure({
          reason: 'this GitHub link is invalid or has expired; start the connection again'
        })
        const dot = state.indexOf('.')
        if (dot <= 0) return yield* refused
        const body = state.slice(0, dot)
        const signature = Buffer.from(state.slice(dot + 1), 'base64url')
        if (!equalSignatures(signature, sign(body))) return yield* refused

        const decoded = yield* Schema.decodeUnknown(Schema.parseJson(StateClaimsJson))(
          Buffer.from(body, 'base64url').toString('utf8')
        ).pipe(Effect.mapError(() => refused))

        const now = Date.now()
        if (decoded.e <= now) return yield* refused

        const spent = yield* Ref.modify(spentStates, (map) => {
          const already = map.has(decoded.n)
          const next = new Map(map)
          for (const [nonce, expiry] of next) if (expiry <= now) next.delete(nonce)
          next.set(decoded.n, decoded.e)
          return [already, next] as const
        })
        if (spent) return yield* refused

        return { companyId: decoded.c, userId: decoded.u } as StateClaims
      })

    // ── HTTP ─────────────────────────────────────────────────────────────────

    const headers = (authorization?: string) => ({
      accept: ACCEPT,
      'user-agent': USER_AGENT,
      'x-github-api-version': API_VERSION,
      ...(authorization === undefined ? {} : { authorization })
    })

    /**
     * One GitHub call, decoded. Every failure becomes a `GithubFailure` whose
     * `reason` is built from the status and our own words: GitHub's body can
     * contain the request we sent, so it is never echoed.
     */
    const call = <A, I>(
      request: HttpClientRequest.HttpClientRequest,
      result: Schema.Schema<A, I>,
      what: string
    ): Effect.Effect<A, GithubFailure> =>
      client.execute(request).pipe(
        Effect.mapError((error) =>
          error._tag === 'ResponseError'
            ? new GithubFailure({
                reason: `GitHub refused to ${what} (HTTP ${error.response.status})`
              })
            : new GithubFailure({ reason: `cannot reach GitHub to ${what}` })
        ),
        Effect.flatMap((response) =>
          response.status >= 200 && response.status < 300
            ? response.json.pipe(
                Effect.mapError(
                  () => new GithubFailure({ reason: `GitHub sent unreadable JSON for ${what}` })
                )
              )
            : Effect.fail(
                new GithubFailure({
                  reason: `GitHub refused to ${what} (HTTP ${response.status})`
                })
              )
        ),
        Effect.flatMap((body) =>
          Schema.decodeUnknown(result)(body).pipe(
            Effect.mapError(
              () => new GithubFailure({ reason: `GitHub sent an unexpected payload for ${what}` })
            )
          )
        )
      )

    // ── App JWT ──────────────────────────────────────────────────────────────

    /**
     * RS256 by hand over `node:crypto` (D: no new dependency). Nine-minute life,
     * backdated a minute against clock drift; `iss` is the App id. The signature
     * is over the decrypted PEM, which exists only inside this function's frame.
     */
    const appJwt = (appId: number, pem: string): string => {
      const header = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' }), 'utf8'))
      const now = Math.floor(Date.now() / 1000)
      const claims = b64url(
        Buffer.from(
          JSON.stringify({ iat: now - JWT_BACKDATE_S, exp: now + JWT_LIFETIME_S, iss: appId }),
          'utf8'
        )
      )
      const signed = `${header}.${claims}`
      const signature = createSign('RSA-SHA256').update(signed).end().sign(pem)
      return `${signed}.${b64url(signature)}`
    }

    /** The App JWT for a company, or a `GithubFailure` if there is no App / the key will not decrypt. */
    const jwtFor = (
      companyId: CompanyId
    ): Effect.Effect<
      { readonly jwt: string; readonly installationId: number | null },
      GithubFailure
    > =>
      Effect.gen(function* () {
        const row = yield* secretsRow(companyId)
        if (Option.isNone(row)) {
          return yield* new GithubFailure({ reason: 'this company has no GitHub App yet' })
        }
        const pem = decrypt(masterKey, companyId, row.value.private_key_ct, {
          aad: Buffer.from(companyId, 'utf8')
        })
        if (Either.isLeft(pem)) {
          return yield* new GithubFailure({
            reason: "the GitHub App's private key cannot be decrypted with this TAUT_MASTER_KEY"
          })
        }
        const jwt = yield* Effect.try({
          try: () => appJwt(row.value.app_id, pem.right.toString('utf8')),
          catch: () =>
            new GithubFailure({ reason: 'the stored GitHub App private key is not a usable PEM' })
        })
        return { jwt, installationId: row.value.installation_id }
      })

    const requireInstallation = (
      companyId: CompanyId
    ): Effect.Effect<{ readonly jwt: string; readonly installationId: number }, GithubFailure> =>
      jwtFor(companyId).pipe(
        Effect.flatMap((app) =>
          app.installationId === null
            ? Effect.fail(
                new GithubFailure({
                  reason: 'the GitHub App is not installed on any account yet'
                })
              )
            : Effect.succeed({ jwt: app.jwt, installationId: app.installationId })
        )
      )

    // ── the manifest flow ────────────────────────────────────────────────────

    const publicUrl = (): Effect.Effect<string, Validation> =>
      config.publicUrl === undefined || config.publicUrl.trim() === ''
        ? Effect.fail(
            new Validation({
              issues: [
                {
                  path: ['TAUT_PUBLIC_URL'],
                  message:
                    'TAUT_PUBLIC_URL is unset: GitHub has nowhere to send the owner back to. Set it to the URL this server is reachable at and try again.'
                }
              ]
            })
          )
        : Effect.succeed(config.publicUrl.replace(/\/+$/, ''))

    /**
     * The App Taut asks GitHub to create. `default_permissions` is the ceiling for
     * every token this App can ever mint; the per-repository token minted for a
     * task narrows it further to `contents: read` or `contents: write` (D2).
     * `default_events: []` and no `hook_attributes`: nothing here reacts to a push (D9).
     */
    const manifest = (
      companyId: CompanyId,
      userId: UserId,
      companyName: string
    ): Effect.Effect<GithubManifest, Validation> =>
      Effect.gen(function* () {
        const base = yield* publicUrl()
        const state = signState(companyId, userId)
        const body = {
          name: `Taut · ${companyName}`.slice(0, 34),
          url: base,
          redirect_url: `${base}/api/repositories/github/callback`,
          setup_url: `${base}/api/repositories/github/setup`,
          setup_on_update: false,
          public: false,
          default_permissions: {
            contents: 'write',
            pull_requests: 'write',
            metadata: 'read'
          },
          default_events: [] as ReadonlyArray<string>
        }
        const token = randomBytes(32).toString('base64url')
        const result: GithubManifest = {
          postUrl: `${GITHUB_WEB}/settings/apps/new?state=${encodeURIComponent(state)}`,
          manifest: JSON.stringify(body),
          state,
          browserUrl: `${base}/api/repositories/github/start?token=${token}`
        }
        yield* Ref.update(browserHandoffs, (map) => {
          const next = new Map(map)
          for (const [key, value] of next) if (value.expiresAt <= Date.now()) next.delete(key)
          // Bound abandoned handoffs, including manifests submitted directly by web clients.
          if (next.size >= 1000) {
            const oldest = next.keys().next().value
            if (oldest !== undefined) next.delete(oldest)
          }
          next.set(token, { manifest: result, expiresAt: Date.now() + STATE_TTL_MS })
          return next
        })
        return result
      })

    const takeBrowserManifest = (token: string): Effect.Effect<GithubManifest, GithubFailure> =>
      Ref.modify(browserHandoffs, (map) => {
        const entry = map.get(token)
        const next = new Map(map)
        next.delete(token)
        return [entry, next] as const
      }).pipe(
        Effect.flatMap((entry) =>
          entry !== undefined && entry.expiresAt > Date.now()
            ? Effect.succeed(entry.manifest)
            : Effect.fail(
                new GithubFailure({
                  reason:
                    'This GitHub link is invalid or has expired. Return to Taut and connect again.'
                })
              )
        )
      )

    /**
     * Step 3: trade the one-time `code` for the App and store it. The response is
     * the only time GitHub ever shows the private key, so it goes straight into
     * `encrypt(...)` — it is never logged, never returned and never held past this
     * function.
     */
    const convertManifest = (
      companyId: CompanyId,
      code: string
    ): Effect.Effect<string, GithubFailure> =>
      Effect.gen(function* () {
        const converted = yield* call(
          HttpClientRequest.post(
            `${GITHUB_API}/app-manifests/${encodeURIComponent(code)}/conversions`
          ).pipe(HttpClientRequest.setHeaders(headers())),
          ManifestConversion,
          'create the App'
        )
        const aad = Buffer.from(companyId, 'utf8')
        yield* insertApp({
          companyId,
          appId: converted.id,
          appSlug: converted.slug,
          clientId: converted.client_id,
          clientSecretCt: encrypt(masterKey, companyId, converted.client_secret, { aad }),
          privateKeyCt: encrypt(masterKey, companyId, converted.pem, { aad }),
          webhookSecretCt:
            converted.webhook_secret === null || converted.webhook_secret === undefined
              ? null
              : encrypt(masterKey, companyId, converted.webhook_secret, { aad }),
          createdAt: nowIso()
        })
        yield* Effect.logInfo(`github: app created for company ${companyId}`)
        return converted.slug
      })

    /** Step 5: remember which installation this company's App now lives in. */
    const recordInstallation = (
      companyId: CompanyId,
      installationId: number
    ): Effect.Effect<void, GithubFailure> =>
      Effect.gen(function* () {
        const app = yield* jwtFor(companyId)
        const installation = yield* call(
          HttpClientRequest.get(`${GITHUB_API}/app/installations/${installationId}`).pipe(
            HttpClientRequest.setHeaders(headers(`Bearer ${app.jwt}`))
          ),
          InstallationAccount,
          'read the installation'
        )
        yield* markInstalled({
          companyId,
          installationId,
          accountLogin: installation.account?.login ?? null,
          connectedAt: nowIso()
        })
        yield* Effect.logInfo(`github: installed for company ${companyId}`)
      })

    const connection = (companyId: CompanyId): Effect.Effect<GithubConnection> =>
      appRow(companyId).pipe(
        Effect.map((row) => toGithubConnection(companyId, Option.getOrUndefined(row)))
      )

    const installUrl = (
      companyId: CompanyId,
      userId: UserId
    ): Effect.Effect<string, GithubFailure> =>
      appRow(companyId).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new GithubFailure({ reason: 'this company has no GitHub App yet' })),
            onSome: (row) =>
              Effect.succeed(
                `${GITHUB_WEB}/apps/${row.app_slug}/installations/new?state=${encodeURIComponent(
                  signState(companyId, userId)
                )}`
              )
          })
        )
      )

    /** Forgets the App entirely. Its cached tokens go with it, or they would outlive the row. */
    const disconnect = (companyId: CompanyId): Effect.Effect<void> =>
      deleteApp(companyId).pipe(
        Effect.zipRight(
          Ref.update(tokenCache, (map) => {
            const next = new Map(map)
            for (const key of next.keys()) if (key.startsWith(`${companyId}:`)) next.delete(key)
            return next
          })
        )
      )

    // ── repositories & tokens ────────────────────────────────────────────────

    const normalise = (r: typeof GithubRepoPayload.Type): GithubRepo => {
      const slash = r.full_name.indexOf('/')
      const owner = r.owner?.login ?? (slash > 0 ? r.full_name.slice(0, slash) : r.full_name)
      return {
        githubId: r.id,
        owner,
        name: r.name,
        fullName: r.full_name,
        defaultBranch: r.default_branch ?? 'main',
        private: r.private,
        cloneUrl: r.clone_url ?? `${GITHUB_WEB}/${r.full_name}.git`
      }
    }

    /**
     * What the installation can see — the left half of D3, before the company picks.
     * Read on demand rather than kept in sync: there are no webhooks in this phase (D9).
     */
    const listInstallationRepositories = (
      companyId: CompanyId
    ): Effect.Effect<ReadonlyArray<GithubRepo>, GithubFailure> =>
      Effect.gen(function* () {
        const app = yield* requireInstallation(companyId)
        const token = yield* call(
          HttpClientRequest.post(
            `${GITHUB_API}/app/installations/${app.installationId}/access_tokens`
          ).pipe(HttpClientRequest.setHeaders(headers(`Bearer ${app.jwt}`))),
          AccessToken,
          'mint an installation token'
        )
        const out: Array<GithubRepo> = []
        // 100 at a time; a company with more than ten pages of repositories can
        // still find one, the picker is searchable.
        for (let page = 1; page <= 10; page += 1) {
          const listed = yield* call(
            HttpClientRequest.get(
              `${GITHUB_API}/installation/repositories?per_page=100&page=${page}`
            ).pipe(HttpClientRequest.setHeaders(headers(`Bearer ${token.token}`))),
            InstallationRepositories,
            'list the installation repositories'
          )
          for (const repo of listed.repositories) out.push(normalise(repo))
          if (listed.repositories.length < 100) break
        }
        return out
      })

    /**
     * The permission set a mode buys (D2). `ro` genuinely cannot push: GitHub
     * rejects it at the remote, which is the entire point of using an App.
     */
    const permissionsFor = (mode: FileGrantMode): Record<string, string> =>
      mode === 'ro'
        ? { contents: 'read', metadata: 'read' }
        : { contents: 'write', pull_requests: 'write', metadata: 'read' }

    /**
     * A token for exactly one repository at exactly one mode, cached per
     * `(companyId, repositoryId, mode)` until a minute before it expires. The
     * cache key includes the mode on purpose: reusing an `rw` token for an `ro`
     * grant would hand a read-only agent a push credential.
     */
    const installationToken = (
      companyId: CompanyId,
      repository: { readonly id: RepositoryId; readonly name: string },
      mode: FileGrantMode
    ): Effect.Effect<InstallationToken, GithubFailure> =>
      Effect.gen(function* () {
        const key = `${companyId}:${repository.id}:${mode}`
        const cached = (yield* Ref.get(tokenCache)).get(key)
        if (cached !== undefined && Date.parse(cached.expiresAt) - TOKEN_SKEW_MS > Date.now()) {
          return { token: Redacted.make(cached.token), expiresAt: cached.expiresAt }
        }
        const app = yield* requireInstallation(companyId)
        const minted = yield* call(
          HttpClientRequest.post(
            `${GITHUB_API}/app/installations/${app.installationId}/access_tokens`
          ).pipe(
            HttpClientRequest.setHeaders(headers(`Bearer ${app.jwt}`)),
            HttpClientRequest.bodyUnsafeJson({
              repositories: [repository.name],
              permissions: permissionsFor(mode)
            })
          ),
          AccessToken,
          'mint a repository token'
        )
        yield* Ref.update(tokenCache, (map) =>
          new Map(map).set(key, { token: minted.token, expiresAt: minted.expires_at })
        )
        return { token: Redacted.make(minted.token), expiresAt: minted.expires_at }
      })

    /**
     * Open the pull request on the agent's behalf (D7). Always at `rw`: the caller
     * has already refused an `ro` grant, and a token minted at `ro` could not do
     * this anyway.
     */
    const openPullRequest = (
      companyId: CompanyId,
      target: PullRequestTarget,
      input: OpenPullRequestInput
    ): Effect.Effect<{ readonly url: string; readonly number: number }, GithubFailure> =>
      Effect.gen(function* () {
        const minted = yield* installationToken(
          companyId,
          { id: target.repositoryId, name: target.name },
          'rw'
        )
        const pr = yield* call(
          HttpClientRequest.post(`${GITHUB_API}/repos/${target.owner}/${target.name}/pulls`).pipe(
            HttpClientRequest.setHeaders(headers(`Bearer ${Redacted.value(minted.token)}`)),
            HttpClientRequest.bodyUnsafeJson({
              title: input.title,
              body: input.body,
              head: input.head,
              base: input.base
            })
          ),
          PullRequest,
          'open the pull request'
        )
        return { url: pr.html_url, number: pr.number }
      })

    return {
      signState,
      consumeState,
      manifest,
      takeBrowserManifest,
      convertManifest,
      recordInstallation,
      connection,
      installUrl,
      disconnect,
      listInstallationRepositories,
      installationToken,
      openPullRequest,
      /** Exposed for the tests that assert what `ro` actually asks GitHub for. */
      permissionsFor
    } as const
  }),
  dependencies: [FetchHttpClient.layer]
}) {}
