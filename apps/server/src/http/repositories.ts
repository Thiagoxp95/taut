import { HttpApiBuilder, HttpServerRequest, HttpServerResponse } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { AppConfig } from '../config.js'
import { Repositories } from '../services/repositories.js'
import { ServerApi } from './serverApi.js'

export const RepositoriesLive = HttpApiBuilder.group(ServerApi, 'repositories', (handlers) =>
  handlers
    .handle('githubConnection', () =>
      Effect.gen(function* () {
        const repositories = yield* Repositories
        return yield* repositories.connection(yield* CurrentUser)
      })
    )
    .handle('githubManifest', () =>
      Effect.gen(function* () {
        const repositories = yield* Repositories
        return yield* repositories.manifest(yield* CurrentUser)
      })
    )
    .handle('githubInstallUrl', () =>
      Effect.gen(function* () {
        const repositories = yield* Repositories
        return yield* repositories.installUrl(yield* CurrentUser)
      })
    )
    .handle('githubDisconnect', () =>
      Effect.gen(function* () {
        const repositories = yield* Repositories
        yield* repositories.disconnect(yield* CurrentUser)
      })
    )
    .handle('available', () =>
      Effect.gen(function* () {
        const repositories = yield* Repositories
        return { items: yield* repositories.available(yield* CurrentUser) }
      })
    )
    .handle('list', () =>
      Effect.gen(function* () {
        const repositories = yield* Repositories
        return { items: yield* repositories.list(yield* CurrentUser) }
      })
    )
    .handle('attach', ({ payload }) =>
      Effect.gen(function* () {
        const repositories = yield* Repositories
        return { items: yield* repositories.attach(yield* CurrentUser, payload.githubIds) }
      })
    )
    .handle('detach', ({ path }) =>
      Effect.gen(function* () {
        const repositories = yield* Repositories
        yield* repositories.detach(yield* CurrentUser, path.repositoryId)
      })
    )
)

/**
 * Where the browser lands after either leg of the flow, with what happened in the
 * query. `reason` is its own parameter: folding it into `github` would leave the
 * page reading `error&reason=…` as the outcome and matching none of its states.
 */
const settingsUrl = (base: string, outcome: string, reason?: string): string => {
  const query = new URLSearchParams({ github: outcome })
  if (reason !== undefined) query.set('reason', reason)
  return `${base.replace(/\/+$/, '')}/settings/repositories?${query.toString()}`
}

/**
 * The two legs GitHub drives through the owner's browser
 * (docs/build-plan-repositories.md, "The GitHub App manifest flow"): the manifest
 * callback and the post-install `setup_url`.
 *
 * They are a plain `HttpRouter` next to the `TautApi` groups rather than
 * `HttpApi` endpoints, for two reasons. GitHub redirects here from *its* pages,
 * so there is no session cookie to authenticate with — the signed, single-use
 * `state` is the authentication, which is why `Authentication` (and therefore the
 * `repositories` group) is the wrong middleware. And the answer is a `302` to the
 * web app, which `HttpApi`'s success schemas cannot express: every endpoint there
 * encodes a body at a status the endpoint declares. `static.ts` already
 * establishes the pattern for routes the contract does not describe.
 *
 * Anything that goes wrong — a tampered `state`, an expired one, a `state`
 * replayed after it was spent, GitHub refusing the exchange — is the same 302
 * with `?github=error&reason=…`. The browser is a human's, not a client's; there
 * is nothing here for it to decode.
 */
export const GithubRedirectLive = HttpApiBuilder.Router.use((router) =>
  Effect.gen(function* () {
    const repositories = yield* Repositories
    const config = yield* AppConfig

    if (config.publicUrl === undefined || config.publicUrl.trim() === '') {
      // The manifest endpoint refuses to build a flow that cannot come back, so
      // these two would never be reached anyway. Registering them regardless
      // keeps the route table the same in every deployment.
      yield* Effect.logDebug(
        'github: TAUT_PUBLIC_URL is unset, the GitHub connect flow is unavailable'
      )
    }
    const base = config.publicUrl ?? ''

    const query = (request: HttpServerRequest.HttpServerRequest, key: string): string =>
      new URL(request.url, 'http://localhost').searchParams.get(key) ?? ''

    /** One shape for both legs: never throw at the browser, always land on the settings page. */
    const redirect = (outcome: Effect.Effect<string, { readonly message: string }>) =>
      outcome.pipe(
        Effect.map((result) => settingsUrl(base, result)),
        Effect.catchAll((error) =>
          Effect.logWarning(`github: connect flow refused — ${error.message}`).pipe(
            Effect.as(settingsUrl(base, 'error', error.message))
          )
        ),
        Effect.map((location) => HttpServerResponse.empty({ status: 302, headers: { location } }))
      )

    yield* router.get(
      '/api/repositories/github/callback',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        return yield* redirect(
          repositories
            .completeManifest(query(request, 'state'), query(request, 'code'))
            .pipe(Effect.as('app-created'))
        )
      })
    )

    yield* router.get(
      '/api/repositories/github/setup',
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest
        const installationId = Number(query(request, 'installation_id'))
        return yield* redirect(
          Number.isSafeInteger(installationId) && installationId > 0
            ? repositories
                .completeInstall(query(request, 'state'), installationId)
                .pipe(Effect.as('connected'))
            : Effect.fail({ message: 'GitHub did not send an installation id' })
        )
      })
    )
  })
)
