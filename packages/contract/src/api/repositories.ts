import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { Schema } from 'effect'

import { AvailableRepository, GithubConnection, Repository } from '../domain/repository.js'
import { Conflict, Forbidden, NotFound, Validation } from '../errors.js'
import { RepositoryId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

/**
 * What the browser needs to create the company's GitHub App: it renders a real
 * `<form method="POST" action={postUrl}>` with one hidden `manifest` field and
 * submits it, because GitHub's manifest flow is a form POST, not a redirect.
 * `state` is a signed, single-use, ten-minute token — it is already inside
 * `postUrl` and is returned only so the client can show it in a support
 * message (docs/build-plan-repositories.md, "The GitHub App manifest flow").
 */
export const GithubManifest = Schema.Struct({
  postUrl: Schema.String,
  manifest: Schema.String,
  state: Schema.String
})
export type GithubManifest = typeof GithubManifest.Type

/** Where to send the owner so they can install the App and pick repositories (D3). */
export const GithubInstallUrl = Schema.Struct({ url: Schema.String })

/** Attach these GitHub repositories to the company. Ids GitHub does not offer are ignored. */
export const AttachRepositoriesPayload = Schema.Struct({
  githubIds: Schema.Array(Schema.Number)
})

const RepositoryPath = Schema.Struct({ repositoryId: RepositoryId })

/**
 * The company's GitHub connection and its attached repositories
 * (docs/build-plan-repositories.md). Company scope comes from the session's
 * active company, exactly as the vault and subscriptions groups do.
 */
export class RepositoriesGroup extends HttpApiGroup.make('repositories')
  .add(
    /** Any member: the connection state, never a secret. */
    HttpApiEndpoint.get('githubConnection', '/github').addSuccess(GithubConnection)
  )
  .add(
    /**
     * Admin+. Builds the App manifest and its signed `state`. Fails with
     * `Validation` when `TAUT_PUBLIC_URL` is unset — GitHub has nowhere to
     * send the owner back to.
     */
    HttpApiEndpoint.post('githubManifest', '/github/manifest')
      .addSuccess(GithubManifest)
      .addError(Forbidden)
      .addError(Conflict)
      .addError(Validation)
  )
  .add(
    /** Admin+. `https://github.com/apps/<slug>/installations/new?state=…`. */
    HttpApiEndpoint.get('githubInstallUrl', '/github/install-url')
      .addSuccess(GithubInstallUrl)
      .addError(Forbidden)
      .addError(NotFound)
  )
  .add(
    /** Admin+. Drops the App row and every repository and grant with it. */
    HttpApiEndpoint.del('githubDisconnect', '/github').addError(Forbidden).addError(NotFound)
  )
  .add(
    /** Admin+. What the installation can see, with `attached` already resolved. */
    HttpApiEndpoint.get('available', '/available')
      .setUrlParams(PageQuery)
      .addSuccess(Page(AvailableRepository))
      .addError(Forbidden)
      .addError(NotFound)
  )
  .add(
    /** Any member: the company's attached repositories. */
    HttpApiEndpoint.get('list', '/').setUrlParams(PageQuery).addSuccess(Page(Repository))
  )
  .add(
    /** Admin+. Idempotent: attaching an already-attached repository is a no-op. */
    HttpApiEndpoint.post('attach', '/attach')
      .setPayload(AttachRepositoriesPayload)
      .addSuccess(Page(Repository))
      .addError(Forbidden)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    /** Admin+. Cascades every agent grant on it. */
    HttpApiEndpoint.del('detach', '/:repositoryId')
      .setPath(RepositoryPath)
      .addError(Forbidden)
      .addError(NotFound)
  )
  .middleware(Authentication)
  .prefix('/repositories') {}
