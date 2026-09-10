/**
 * Repositories (docs/build-plan-repositories.md), the four properties that are
 * load-bearing rather than merely nice:
 *
 * 1. a `state` GitHub hands back through the owner's browser is believed only
 *    when it verifies — tampered, expired and replayed states are all refused;
 * 2. an `ro` grant asks GitHub for `contents: read`, so read-only is enforced by
 *    the remote and not by a local check (D2);
 * 3. an agent with no grant gets `not_found` from the credential endpoint, not
 *    `forbidden` — a repository it was not granted does not exist for it (D14);
 * 4. attaching is admin+ (D1).
 */
import { HttpClient, HttpClientResponse } from '@effect/platform'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Agent, Company } from '@taut/contract/domain'
import { CompanyId, RepositoryId, TaskId, UserId } from '@taut/contract/ids'
import { Effect, Layer, Redacted } from 'effect'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import { afterAll, describe, expect, vi } from 'vitest'
import { AgentApi } from '../src/agents/agentApi.js'
import { AppConfig } from '../src/config.js'
import { GitHubApp } from '../src/services/githubApp.js'
import { encrypt } from '../src/vault/crypto.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp, testDb } from './_harness.js'

const avatar = { kind: 'emoji', value: 'A' } as const

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

// ── 1 + 2: the GitHub App, against a GitHub that is ours ─────────────────────

const githubDir = makeTempDir()

/** One call this stub saw. `body` is decoded so a test can assert on what we asked for. */
interface Seen {
  readonly url: string
  readonly body: unknown
}

/**
 * A GitHub that answers from a script instead of the network. Every request is
 * recorded so a test can assert on the *request* — which for token minting is
 * the whole point: the permissions we ask for are the permissions the agent gets.
 */
const stubGithub = (seen: Array<Seen>, responses: Record<string, unknown>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) => {
      const body = request.body
      seen.push({
        url: url.toString(),
        body:
          body._tag === 'Uint8Array'
            ? JSON.parse(Buffer.from(body.body).toString('utf8'))
            : undefined
      })
      const match = Object.entries(responses).find(([path]) => url.pathname.includes(path))
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(match?.[1] ?? {}), {
            status: 200,
            headers: { 'content-type': 'application/json' }
          })
        )
      )
    })
  )

const COMPANY = CompanyId.make('cmp_github-test')
const REPOSITORY = RepositoryId.make('rep_widgets')
const OWNER = UserId.make('usr_owner')

/** A real RSA key: the JWT is signed for real, so a broken PEM would fail here. */
const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' }
})

/** The company and its installed App, straight into the tables. */
const seedApp = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const config = yield* AppConfig
  const masterKey = Redacted.value(config.masterKey)
  const aad = Buffer.from(COMPANY, 'utf8')
  const secret = (plaintext: string) => Buffer.from(encrypt(masterKey, COMPANY, plaintext, { aad }))

  yield* sql`
    INSERT INTO companies (id, slug, name, avatar_json, created_at)
    VALUES (${COMPANY}, 'github-test', 'GitHub Test', NULL, ${new Date().toISOString()})`
  yield* sql`
    INSERT INTO github_apps
      (company_id, app_id, app_slug, client_id, client_secret_ct, private_key_ct,
       webhook_secret_ct, installation_id, account_login, created_at, connected_at)
    VALUES (${COMPANY}, 12345, 'taut-github-test', 'Iv1.abc', ${secret('client-secret')},
            ${secret(privateKey)}, ${secret('webhook-secret')}, 999, 'acme-inc',
            ${new Date().toISOString()}, ${new Date().toISOString()})`
})

describe('repositories: the GitHub App', () => {
  const seen: Array<Seen> = []
  const stub = stubGithub(seen, {
    '/access_tokens': { token: 'ghs_installation_token', expires_at: '2999-01-01T00:00:00Z' }
  })

  const GithubTestLive = GitHubApp.DefaultWithoutDependencies.pipe(
    Layer.provide(stub),
    Layer.provideMerge(testDb(githubDir))
  )

  afterAll(() => removeDir(githubDir))

  layer(GithubTestLive, { excludeTestServices: true })((it) => {
    it.effect('a state that was not signed here is refused', () =>
      Effect.gen(function* () {
        const github = yield* GitHubApp
        const good = github.signState(COMPANY, OWNER)

        // Same claims, one byte of the signature changed.
        const dot = good.lastIndexOf('.')
        const signature = good.slice(dot + 1)
        const tampered = `${good.slice(0, dot)}.${signature[0] === 'A' ? 'B' : 'A'}${signature.slice(1)}`
        const refusedSignature = yield* Effect.either(github.consumeState(tampered))
        expect(refusedSignature._tag).toBe('Left')

        // Claims rewritten to another company, re-encoded, old signature kept.
        const body = Buffer.from(good.slice(0, dot), 'base64url').toString('utf8')
        const swapped = Buffer.from(body.replace(COMPANY, 'cmp_someone-else'), 'utf8').toString(
          'base64url'
        )
        const refusedClaims = yield* Effect.either(
          github.consumeState(`${swapped}.${good.slice(dot + 1)}`)
        )
        expect(refusedClaims._tag).toBe('Left')

        // Nothing invented from scratch gets through either.
        expect((yield* Effect.either(github.consumeState('not-a-state')))._tag).toBe('Left')
      })
    )

    it.effect('an expired state is refused even though its signature is valid', () =>
      Effect.gen(function* () {
        const github = yield* GitHubApp
        // Forged with the *real* key (the harness master key is known here), so
        // the only thing wrong with it is the clock.
        const config = yield* AppConfig
        const claims = Buffer.from(
          JSON.stringify({ c: COMPANY, u: OWNER, e: Date.now() - 1000, n: 'stale' }),
          'utf8'
        ).toString('base64url')
        const signature = createHmac('sha256', Buffer.from(Redacted.value(config.masterKey)))
          .update(claims)
          .digest('base64url')

        const refused = yield* Effect.either(github.consumeState(`${claims}.${signature}`))
        expect(refused._tag).toBe('Left')
      })
    )

    it.effect('a state is single use: the second callback with it is refused', () =>
      Effect.gen(function* () {
        const github = yield* GitHubApp
        const state = github.signState(COMPANY, OWNER)

        const first = yield* github.consumeState(state)
        expect(first.companyId).toBe(COMPANY)

        const replay = yield* Effect.either(github.consumeState(state))
        expect(replay._tag).toBe('Left')
      })
    )

    it.effect('a read-only grant asks GitHub for contents: read on that one repository', () =>
      Effect.gen(function* () {
        yield* seedApp
        const github = yield* GitHubApp
        seen.length = 0

        const readOnly = yield* github.installationToken(
          COMPANY,
          { id: REPOSITORY, name: 'widgets' },
          'ro'
        )
        expect(Redacted.value(readOnly.token)).toBe('ghs_installation_token')

        const minted = seen.find((call) => call.url.includes('/access_tokens'))
        expect(minted?.url).toContain('/app/installations/999/access_tokens')
        expect(minted?.body).toEqual({
          repositories: ['widgets'],
          permissions: { contents: 'read', metadata: 'read' }
        })

        // Read-write is a different ask, and a different cache entry: reusing the
        // `rw` token for an `ro` grant would hand a read-only agent a push credential.
        seen.length = 0
        yield* github.installationToken(COMPANY, { id: REPOSITORY, name: 'widgets' }, 'rw')
        expect(seen.find((call) => call.url.includes('/access_tokens'))?.body).toEqual({
          repositories: ['widgets'],
          permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' }
        })

        // The second `ro` ask is served from the cache, not from GitHub.
        seen.length = 0
        yield* github.installationToken(COMPANY, { id: REPOSITORY, name: 'widgets' }, 'ro')
        expect(seen).toHaveLength(0)
      })
    )

    it.effect('the connection never carries a secret', () =>
      Effect.gen(function* () {
        const github = yield* GitHubApp
        const connection = yield* github.connection(COMPANY)
        expect(connection.state).toBe('connected')
        expect(connection.accountLogin).toBe('acme-inc')
        expect(JSON.stringify(connection)).not.toContain('BEGIN')
        expect(JSON.stringify(connection)).not.toContain('client-secret')
        expect(JSON.stringify(connection)).not.toContain('webhook-secret')
      })
    )
  })
})

// ── 3 + 4: authorization, over the real server ───────────────────────────────

const appDir = makeTempDir()

const state: { owner?: TestClient; bob?: TestClient; acme?: Company; bruno?: Agent } = {}

describe('repositories: authorization', () => {
  afterAll(() => removeDir(appDir))

  layer(testApp(appDir), { excludeTestServices: true })((it) => {
    it.effect('setup: an owner, a plain member, and one agent with no grants', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const invite = yield* owner.api.invites.create({
          payload: { email: 'bob@taut.local', role: 'member' }
        })
        const bob = yield* makeClient
        yield* bob.api.invites.accept({
          payload: { token: invite.token, name: 'Bob', password: 'password123' }
        })
        const bruno = yield* owner.api.agents.create({
          payload: {
            handle: 'bruno',
            name: 'Bruno',
            avatar,
            role: 'x',
            mandate: 'x',
            runtimeKind: 'claude-code',
            permissionMode: 'plan'
          }
        })
        Object.assign(state, { owner, bob, acme, bruno })
      })
    )

    it.effect('a member may not attach a repository, and may not disconnect GitHub', () =>
      Effect.gen(function* () {
        const bob = need(state.bob, 'bob')
        const owner = need(state.owner, 'owner')

        const attach = yield* Effect.either(
          bob.api.repositories.attach({ payload: { githubIds: [1] } })
        )
        expect(attach._tag).toBe('Left')
        if (attach._tag === 'Left') expect(attach.left._tag).toBe('Forbidden')

        const disconnect = yield* Effect.either(bob.api.repositories.githubDisconnect())
        expect(disconnect._tag).toBe('Left')
        if (disconnect._tag === 'Left') expect(disconnect.left._tag).toBe('Forbidden')

        // The admin gets past the authorization check and stops on the real
        // reason: this company has never connected GitHub.
        const asOwner = yield* Effect.either(
          owner.api.repositories.attach({ payload: { githubIds: [1] } })
        )
        expect(asOwner._tag).toBe('Left')
        if (asOwner._tag === 'Left') expect(asOwner.left._tag).toBe('NotFound')
      })
    )

    it.effect('a member may still read the connection state and the (empty) list', () =>
      Effect.gen(function* () {
        const bob = need(state.bob, 'bob')
        expect((yield* bob.api.repositories.githubConnection()).state).toBe('none')
        expect((yield* bob.api.repositories.list({ urlParams: {} })).items).toEqual([])
      })
    )

    it.effect('a new agent has no repository grants', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const bruno = need(state.bruno, 'bruno')
        const detail = yield* owner.api.agents.get({ path: { agentId: bruno.id } })
        expect(detail.repoGrants).toEqual([])
      })
    )

    it.effect("granting is admin+ or the head of the agent's department, and never a member", () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const bob = need(state.bob, 'bob')
        const acme = need(state.acme, 'acme')
        const bruno = need(state.bruno, 'bruno')
        const sql = yield* SqlClient.SqlClient

        // A repository straight into the table: attaching one needs a live
        // GitHub, and what is under test here is the grant, not the attach.
        const repositoryId = RepositoryId.make('rep_acme-widgets')
        yield* sql`
          INSERT INTO repositories
            (id, company_id, github_id, owner, name, full_name, default_branch, private, clone_url, attached_at)
          VALUES (${repositoryId}, ${acme.id}, 42, 'acme', 'widgets', 'acme/widgets', 'main', 0,
                  'https://github.com/acme/widgets.git', ${new Date().toISOString()})`

        const asMember = yield* Effect.either(
          bob.api.agents.grantRepo({
            path: { agentId: bruno.id, repositoryId },
            payload: { mode: 'rw' }
          })
        )
        expect(asMember._tag).toBe('Left')
        if (asMember._tag === 'Left') expect(asMember.left._tag).toBe('Forbidden')

        const granted = yield* owner.api.agents.grantRepo({
          path: { agentId: bruno.id, repositoryId },
          payload: { mode: 'ro' }
        })
        expect(granted).toMatchObject({ agentId: bruno.id, repositoryId, mode: 'ro' })

        // The same call again is the mode change, not a second row.
        const upgraded = yield* owner.api.agents.grantRepo({
          path: { agentId: bruno.id, repositoryId },
          payload: { mode: 'rw' }
        })
        expect(upgraded.mode).toBe('rw')
        expect(
          yield* owner.api.agents.listRepoGrants({ path: { agentId: bruno.id } })
        ).toHaveLength(1)
        expect(
          (yield* owner.api.agents.get({ path: { agentId: bruno.id } })).repoGrants[0]?.mode
        ).toBe('rw')

        // A repository id from no company at all is `NotFound`, not `Forbidden`.
        const stranger = yield* Effect.either(
          owner.api.agents.grantRepo({
            path: { agentId: bruno.id, repositoryId: RepositoryId.make('rep_nothing') },
            payload: { mode: 'ro' }
          })
        )
        expect(stranger._tag).toBe('Left')
        if (stranger._tag === 'Left') expect(stranger.left._tag).toBe('NotFound')

        yield* owner.api.agents.revokeRepo({ path: { agentId: bruno.id, repositoryId } })
        expect(yield* owner.api.agents.listRepoGrants({ path: { agentId: bruno.id } })).toEqual([])
      })
    )

    it.effect('an agent with no grant is told the repository does not exist (D14)', () =>
      Effect.gen(function* () {
        const acme = need(state.acme, 'acme')
        const bruno = need(state.bruno, 'bruno')
        const api = yield* AgentApi

        const refused = yield* Effect.either(
          api.gitCredential(
            { taskId: TaskId.make('tsk_none'), agentId: bruno.id, companyId: acme.id },
            { host: 'github.com', path: '/acme/widgets.git' }
          )
        )
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') {
          // `not_found`, never `forbidden`: being refused must not tell an agent
          // that a repository it cannot see exists.
          expect(refused.left.status).toBe(404)
          expect(refused.left.code).toBe('not_found')
        }

        const noPr = yield* Effect.either(
          api.githubOpenPr(
            { taskId: TaskId.make('tsk_none'), agentId: bruno.id, companyId: acme.id },
            { repo: 'acme/widgets', title: 't', body: 'b', head: 'taut/bruno/abc' }
          )
        )
        expect(noPr._tag).toBe('Left')
        if (noPr._tag === 'Left') expect(noPr.left.status).toBe(404)
      })
    )

    it.effect('a host Taut has no credentials for is also not found', () =>
      Effect.gen(function* () {
        const acme = need(state.acme, 'acme')
        const bruno = need(state.bruno, 'bruno')
        const api = yield* AgentApi

        const refused = yield* Effect.either(
          api.gitCredential(
            { taskId: TaskId.make('tsk_none'), agentId: bruno.id, companyId: acme.id },
            { host: 'gitlab.com', path: '/acme/widgets.git' }
          )
        )
        expect(refused._tag).toBe('Left')
        if (refused._tag === 'Left') expect(refused.left.status).toBe(404)
      })
    )
  })
})

// ── the browser legs: real routes, real 302 ──────────────────────────────────

const redirectDir = makeTempDir()

describe('repositories: the GitHub callback and setup redirects', () => {
  afterAll(() => removeDir(redirectDir))

  layer(testApp(redirectDir, { TAUT_PUBLIC_URL: 'https://taut.example' }), {
    excludeTestServices: true
  })((it) => {
    it.effect('expired browser handoffs are refused', () =>
      Effect.gen(function* () {
        const github = yield* GitHubApp
        const manifest = yield* github.manifest(COMPANY, OWNER, 'Example')
        const token = new URL(manifest.browserUrl).searchParams.get('token') ?? ''
        const now = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000 + 1)
        try {
          expect((yield* Effect.either(github.takeBrowserManifest(token)))._tag).toBe('Left')
        } finally {
          now.mockRestore()
        }
      })
    )

    it.effect('desktop handoff serves the manifest without browser cookies and only once', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'handoff@taut.local', password: 'password123', name: 'Owner' }
        })
        yield* owner.api.companies.create({
          payload: { slug: 'handoff', name: 'Acme "Tools" <script>alert(1)</script>', avatar }
        })
        const manifest = yield* owner.api.repositories.githubManifest()
        expect(manifest.browserUrl).toBeTypeOf('string')
        const { http } = yield* baseUrl
        const url = new URL(manifest.browserUrl)
        const response = yield* Effect.promise(() => fetch(`${http}${url.pathname}${url.search}`))
        expect(response.status).toBe(200)
        expect(response.headers.get('content-type')).toContain('text/html')
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(response.headers.get('referrer-policy')).toBe('no-referrer')
        const html = yield* Effect.promise(() => response.text())
        expect(html).toContain('method="POST"')
        expect(html).toContain('https://github.com/settings/apps/new?state=')
        expect(html).toContain('name="manifest"')
        expect(html).toContain('&quot;default_permissions&quot;')
        expect(html).not.toContain('<script>alert(1)</script>')
        const replay = yield* Effect.promise(() =>
          fetch(`${http}${url.pathname}${url.search}`, { redirect: 'manual' })
        )
        expect(replay.status).toBe(302)
        expect(replay.headers.get('location')).toContain('github=error')
        const github = yield* GitHubApp
        expect((yield* github.consumeState(manifest.state)).userId).toBeDefined()
      })
    )

    it.effect('both legs answer a bad state with a 302 back to the settings page', () =>
      Effect.gen(function* () {
        const { http } = yield* baseUrl

        const start = yield* Effect.promise(() =>
          fetch(`${http}/api/repositories/github/start?token=forged`, { redirect: 'manual' })
        )
        expect(start.status).toBe(302)
        expect(start.headers.get('location')).toContain('github=error')

        const callback = yield* Effect.promise(() =>
          fetch(`${http}/api/repositories/github/callback?code=abc&state=forged`, {
            redirect: 'manual'
          })
        )
        expect(callback.status).toBe(302)
        expect(callback.headers.get('location')).toContain(
          'https://taut.example/settings/repositories?github=error'
        )

        const setup = yield* Effect.promise(() =>
          fetch(`${http}/api/repositories/github/setup?installation_id=1&state=forged`, {
            redirect: 'manual'
          })
        )
        expect(setup.status).toBe(302)
        expect(setup.headers.get('location')).toContain(
          'https://taut.example/settings/repositories?github=error'
        )

        // Mounting these next to the API must not shadow the typed group.
        const connection = yield* Effect.promise(() =>
          fetch(`${http}/api/repositories/github`, { redirect: 'manual' })
        )
        expect(connection.status).toBe(401)
      })
    )
  })
})
