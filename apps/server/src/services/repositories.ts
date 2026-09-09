import { SqlClient } from '@effect/sql'
import type { CurrentUserShape, GithubManifest } from '@taut/contract/api'
import { AvailableRepository } from '@taut/contract/domain'
import type {
  AgentRepoGrant,
  FileGrantMode,
  GithubConnection,
  Repository
} from '@taut/contract/domain'
import { Forbidden, NotFound, type Unauthorized, Validation } from '@taut/contract/errors'
import { AgentId, type CompanyId, RepositoryId, newRepositoryId } from '@taut/contract/ids'
import { Effect, Option, Schema } from 'effect'
import { findAll, findOne, nowIso, run } from '../db/sql.js'
import { AgentRepoGrantRow, RepositoryRow, toAgentRepoGrant, toRepository } from '../domain/rows.js'
import { type Actor, actor, requireAdmin } from './access.js'
import { makeAgentAccess } from './agentAccess.js'
import { type GithubFailure, GitHubApp, asValidation } from './githubApp.js'
import { EventPublisher } from './publisher.js'

const COLUMNS =
  'id, company_id, github_id, owner, name, full_name, default_branch, private, clone_url, attached_at'

/**
 * Repositories a company has attached, and which agent may use which of them
 * (docs/build-plan-repositories.md D1).
 *
 * The split is the vault's: the company owns the asset — attaching and detaching
 * is admin+ — and whoever may manage an agent hands it out, so a department head
 * can give their own agent a repository without touching anyone else's. A grant
 * only ever names a repository already attached to the company, so GitHub's
 * installation picker and Taut's own list both have to say yes before an agent
 * sees a line of code (D3).
 *
 * `grantsOf` is the seam the runtime uses: it is what turns rows into worktrees
 * and instruction lines, and an agent with no grants gets an empty array and a
 * task path byte-identical to the one it had before this feature existed (D14).
 */
export class Repositories extends Effect.Service<Repositories>()('Repositories', {
  effect: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const publisher = yield* EventPublisher
    const github = yield* GitHubApp
    const access = yield* makeAgentAccess

    // ── queries ──────────────────────────────────────────────────────────────

    const Key = Schema.Struct({ companyId: Schema.String, repositoryId: RepositoryId })

    const listOf = findAll({
      Request: Schema.String,
      Result: RepositoryRow,
      execute: (companyId) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM repositories
        WHERE company_id = ${companyId} ORDER BY full_name ASC, rowid ASC`
    })

    const byId = findOne({
      Request: Key,
      Result: RepositoryRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM repositories
        WHERE company_id = ${r.companyId} AND id = ${r.repositoryId}`
    })

    const byGithubId = findOne({
      Request: Schema.Struct({ companyId: Schema.String, githubId: Schema.Number }),
      Result: RepositoryRow,
      execute: (r) => sql`
        SELECT ${sql.literal(COLUMNS)} FROM repositories
        WHERE company_id = ${r.companyId} AND github_id = ${r.githubId}`
    })

    const insertRepository = run({
      Request: Schema.Struct({
        id: RepositoryId,
        companyId: Schema.String,
        githubId: Schema.Number,
        owner: Schema.String,
        name: Schema.String,
        fullName: Schema.String,
        defaultBranch: Schema.String,
        private: Schema.Number,
        cloneUrl: Schema.String,
        attachedAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO repositories
          (id, company_id, github_id, owner, name, full_name, default_branch, private, clone_url, attached_at)
        VALUES (${r.id}, ${r.companyId}, ${r.githubId}, ${r.owner}, ${r.name}, ${r.fullName},
                ${r.defaultBranch}, ${r.private}, ${r.cloneUrl}, ${r.attachedAt})`
    })

    const deleteRepository = run({
      Request: Key,
      execute: (r) => sql`
        DELETE FROM repositories WHERE company_id = ${r.companyId} AND id = ${r.repositoryId}`
    })

    const deleteRepositories = run({
      Request: Schema.String,
      execute: (companyId) => sql`DELETE FROM repositories WHERE company_id = ${companyId}`
    })

    const grantRows = findAll({
      Request: AgentId,
      Result: AgentRepoGrantRow,
      execute: (agentId) => sql`
        SELECT agent_id, repository_id, mode FROM agent_repos
        WHERE agent_id = ${agentId} ORDER BY repository_id ASC`
    })

    const grantRow = findOne({
      Request: Schema.Struct({ agentId: AgentId, repositoryId: RepositoryId }),
      Result: AgentRepoGrantRow,
      execute: (r) => sql`
        SELECT agent_id, repository_id, mode FROM agent_repos
        WHERE agent_id = ${r.agentId} AND repository_id = ${r.repositoryId}`
    })

    /**
     * Every grant of one agent joined to its repository, in one statement. The
     * join is what enforces D14 downstream: a repository that was detached has no
     * row left, so it cannot come back as a worktree or a credential.
     */
    const grantedRepositories = findAll({
      Request: AgentId,
      Result: Schema.Struct({ ...RepositoryRow.fields, mode: Schema.Literal('ro', 'rw') }),
      execute: (agentId) => sql`
        SELECT r.id, r.company_id, r.github_id, r.owner, r.name, r.full_name,
               r.default_branch, r.private, r.clone_url, r.attached_at, g.mode
        FROM agent_repos g JOIN repositories r ON r.id = g.repository_id
        WHERE g.agent_id = ${agentId} ORDER BY r.full_name ASC`
    })

    const upsertGrant = run({
      Request: Schema.Struct({
        agentId: AgentId,
        repositoryId: RepositoryId,
        mode: Schema.Literal('ro', 'rw'),
        grantedAt: Schema.String
      }),
      execute: (r) => sql`
        INSERT INTO agent_repos (agent_id, repository_id, mode, granted_at)
        VALUES (${r.agentId}, ${r.repositoryId}, ${r.mode}, ${r.grantedAt})
        ON CONFLICT (agent_id, repository_id) DO UPDATE SET mode = excluded.mode`
    })

    const deleteGrant = run({
      Request: Schema.Struct({ agentId: AgentId, repositoryId: RepositoryId }),
      execute: (r) => sql`
        DELETE FROM agent_repos WHERE agent_id = ${r.agentId} AND repository_id = ${r.repositoryId}`
    })

    const agentInCompany = findOne({
      Request: Schema.Struct({ companyId: Schema.String, agentId: AgentId }),
      Result: Schema.Struct({ id: AgentId }),
      execute: (r) =>
        sql`SELECT id FROM agents WHERE company_id = ${r.companyId} AND id = ${r.agentId}`
    })

    const companyName = findOne({
      Request: Schema.String,
      Result: Schema.Struct({ name: Schema.String }),
      execute: (companyId) => sql`SELECT name FROM companies WHERE id = ${companyId}`
    })

    // ── helpers ──────────────────────────────────────────────────────────────

    const load = (
      companyId: CompanyId,
      repositoryId: RepositoryId
    ): Effect.Effect<RepositoryRow, NotFound> =>
      byId({ companyId, repositoryId }).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.fail(new NotFound({ entity: 'Repository', id: repositoryId })),
            onSome: Effect.succeed
          })
        )
      )

    /** `Repositories` only ever fails with contract errors; GitHub's own refusals become 422. */
    const orValidation = <A>(
      effect: Effect.Effect<A, GithubFailure>
    ): Effect.Effect<A, Validation> => effect.pipe(Effect.mapError(asValidation))

    const requireAgent = (
      who: Actor,
      agentId: AgentId
    ): Effect.Effect<void, NotFound | Forbidden> =>
      Effect.gen(function* () {
        const row = yield* agentInCompany({ companyId: who.companyId, agentId })
        if (Option.isNone(row)) return yield* new NotFound({ entity: 'Agent', id: agentId })
        yield* access.requireManageAgent(who, agentId)
      })

    // ── the GitHub connection ────────────────────────────────────────────────

    const connection = (me: CurrentUserShape): Effect.Effect<GithubConnection, Unauthorized> =>
      actor(me).pipe(Effect.flatMap((who) => github.connection(who.companyId)))

    const manifest = (
      me: CurrentUserShape
    ): Effect.Effect<GithubManifest, Unauthorized | Forbidden | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const company = yield* companyName(who.companyId)
        return yield* github.manifest(
          who.companyId,
          who.userId,
          Option.match(company, { onNone: () => 'Taut', onSome: (c) => c.name })
        )
      })

    const installUrl = (
      me: CurrentUserShape
    ): Effect.Effect<{ readonly url: string }, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const state = yield* github.connection(who.companyId)
        if (state.state === 'none') {
          return yield* new NotFound({ entity: 'GithubApp', id: who.companyId })
        }
        return { url: yield* orValidation(github.installUrl(who.companyId, who.userId)) }
      })

    /**
     * Forget the App and everything downstream of it. Detaching every repository
     * cascades into `agent_repos`, so no agent is left holding a grant on a
     * repository Taut can no longer mint a token for.
     */
    const disconnect = (
      me: CurrentUserShape
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const current = yield* github.connection(who.companyId)
        if (current.state === 'none') {
          return yield* new NotFound({ entity: 'GithubApp', id: who.companyId })
        }
        const attached = yield* listOf(who.companyId)
        yield* publisher.transact(who.companyId, (emit) =>
          Effect.gen(function* () {
            yield* deleteRepositories(who.companyId)
            yield* github.disconnect(who.companyId)
            for (const row of attached) {
              yield* emit({ type: 'repository.detached', payload: { repositoryId: row.id } })
            }
            yield* emit({
              type: 'repository.github.changed',
              payload: {
                connection: yield* github.connection(who.companyId)
              }
            })
          })
        )
      })

    /**
     * Step 3 of the manifest flow, reached through the browser: authenticated by
     * the signed `state` alone, because GitHub's redirect carries no cookie we can
     * rely on. Returns the company so the caller can log it; never the App.
     */
    const completeManifest = (state: string, code: string): Effect.Effect<CompanyId, Validation> =>
      Effect.gen(function* () {
        const claims = yield* orValidation(github.consumeState(state))
        yield* orValidation(github.convertManifest(claims.companyId, code))
        yield* publisher.transact(claims.companyId, (emit) =>
          github
            .connection(claims.companyId)
            .pipe(
              Effect.flatMap((connection) =>
                emit({ type: 'repository.github.changed', payload: { connection } })
              )
            )
        )
        return claims.companyId
      })

    /** Step 5, same authentication: the installation id arrives through the browser too. */
    const completeInstall = (
      state: string,
      installationId: number
    ): Effect.Effect<CompanyId, Validation> =>
      Effect.gen(function* () {
        const claims = yield* orValidation(github.consumeState(state))
        yield* orValidation(github.recordInstallation(claims.companyId, installationId))
        yield* publisher.transact(claims.companyId, (emit) =>
          github
            .connection(claims.companyId)
            .pipe(
              Effect.flatMap((connection) =>
                emit({ type: 'repository.github.changed', payload: { connection } })
              )
            )
        )
        return claims.companyId
      })

    // ── attach / detach / list ───────────────────────────────────────────────

    /** GitHub's side of D3, with Taut's side (`attached`) already resolved onto it. */
    const available = (
      me: CurrentUserShape
    ): Effect.Effect<
      ReadonlyArray<AvailableRepository>,
      Unauthorized | Forbidden | NotFound | Validation
    > =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const current = yield* github.connection(who.companyId)
        if (current.state !== 'connected') {
          return yield* new NotFound({ entity: 'GithubInstallation', id: who.companyId })
        }
        const [candidates, attached] = yield* Effect.all([
          orValidation(github.listInstallationRepositories(who.companyId)),
          listOf(who.companyId)
        ])
        const already = new Set(attached.map((r) => r.github_id))
        return candidates.map(
          (repo) => new AvailableRepository({ ...repo, attached: already.has(repo.githubId) })
        )
      })

    const list = (me: CurrentUserShape): Effect.Effect<ReadonlyArray<Repository>, Unauthorized> =>
      actor(me).pipe(
        Effect.flatMap((who) => listOf(who.companyId)),
        Effect.map((rows) => rows.map(toRepository))
      )

    /**
     * Attach by GitHub id, idempotently: an id already attached is left exactly as
     * it is, and an id the installation does not offer is ignored rather than
     * failing the batch — the picker and this list can drift between two clicks.
     * Returns the company's whole list so the caller renders one truth.
     */
    const attach = (
      me: CurrentUserShape,
      githubIds: ReadonlyArray<number>
    ): Effect.Effect<ReadonlyArray<Repository>, Unauthorized | Forbidden | NotFound | Validation> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        const current = yield* github.connection(who.companyId)
        if (current.state !== 'connected') {
          return yield* new NotFound({ entity: 'GithubInstallation', id: who.companyId })
        }
        const candidates = yield* orValidation(github.listInstallationRepositories(who.companyId))
        const wanted = new Set(githubIds)
        const chosen = candidates.filter((repo) => wanted.has(repo.githubId))

        yield* publisher.transact(who.companyId, (emit) =>
          Effect.forEach(
            chosen,
            (repo) =>
              Effect.gen(function* () {
                const existing = yield* byGithubId({
                  companyId: who.companyId,
                  githubId: repo.githubId
                })
                if (Option.isSome(existing)) return
                const id = newRepositoryId()
                yield* insertRepository({
                  id,
                  companyId: who.companyId,
                  githubId: repo.githubId,
                  owner: repo.owner,
                  name: repo.name,
                  fullName: repo.fullName,
                  defaultBranch: repo.defaultBranch,
                  private: repo.private ? 1 : 0,
                  cloneUrl: repo.cloneUrl,
                  attachedAt: nowIso()
                })
                const row = yield* load(who.companyId, id).pipe(Effect.orDie)
                yield* emit({
                  type: 'repository.attached',
                  payload: { repository: toRepository(row) }
                })
              }),
            { discard: true }
          )
        )
        return (yield* listOf(who.companyId)).map(toRepository)
      })

    /** Detach cascades into `agent_repos` through the foreign key: no orphan grants. */
    const detach = (
      me: CurrentUserShape,
      repositoryId: RepositoryId
    ): Effect.Effect<void, Unauthorized | Forbidden | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAdmin(who)
        yield* load(who.companyId, repositoryId)
        yield* publisher.transact(who.companyId, (emit) =>
          deleteRepository({ companyId: who.companyId, repositoryId }).pipe(
            Effect.zipRight(emit({ type: 'repository.detached', payload: { repositoryId } }))
          )
        )
      })

    // ── grants ───────────────────────────────────────────────────────────────

    const listGrants = (
      me: CurrentUserShape,
      agentId: AgentId
    ): Effect.Effect<ReadonlyArray<AgentRepoGrant>, Unauthorized | NotFound> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        const agent = yield* agentInCompany({ companyId: who.companyId, agentId })
        if (Option.isNone(agent)) return yield* new NotFound({ entity: 'Agent', id: agentId })
        return (yield* grantRows(agentId)).map(toAgentRepoGrant)
      })

    /**
     * Grant, or change the mode of an existing grant. `NotFound` when the
     * repository is not attached to *this* company, which is also what a caller
     * guessing at another company's ids gets.
     */
    const grant = (
      me: CurrentUserShape,
      agentId: AgentId,
      repositoryId: RepositoryId,
      mode: FileGrantMode
    ): Effect.Effect<AgentRepoGrant, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAgent(who, agentId)
        yield* load(who.companyId, repositoryId)
        yield* publisher.transact(who.companyId, (emit) =>
          upsertGrant({ agentId, repositoryId, mode, grantedAt: nowIso() }).pipe(
            Effect.zipRight(
              emit({ type: 'repository.grant.changed', payload: { agentId, repositoryId, mode } })
            )
          )
        )
        return toAgentRepoGrant(
          yield* grantRow({ agentId, repositoryId }).pipe(Effect.flatMap(Effect.orDie))
        )
      })

    /** Idempotent: revoking a grant that is not there is not an error worth raising. */
    const revoke = (
      me: CurrentUserShape,
      agentId: AgentId,
      repositoryId: RepositoryId
    ): Effect.Effect<void, Unauthorized | NotFound | Forbidden> =>
      Effect.gen(function* () {
        const who = yield* actor(me)
        yield* requireAgent(who, agentId)
        yield* load(who.companyId, repositoryId)
        yield* publisher.transact(who.companyId, (emit) =>
          deleteGrant({ agentId, repositoryId }).pipe(
            Effect.zipRight(
              emit({ type: 'repository.grant.revoked', payload: { agentId, repositoryId } })
            )
          )
        )
      })

    /**
     * Grant an agent a repository with no session in hand: the create-agent form
     * has already been authorized to create the agent, and `Agents.create` calls
     * this inside its own transaction. A repository that is not attached to the
     * company is `NotFound`, exactly as it is through the endpoint.
     */
    const grantInternal = (
      companyId: CompanyId,
      agentId: AgentId,
      repositoryId: RepositoryId,
      mode: FileGrantMode
    ): Effect.Effect<void, NotFound> =>
      load(companyId, repositoryId).pipe(
        Effect.zipRight(upsertGrant({ agentId, repositoryId, mode, grantedAt: nowIso() }))
      )

    return {
      connection,
      manifest,
      installUrl,
      disconnect,
      completeManifest,
      completeInstall,
      available,
      list,
      attach,
      detach,
      listGrants,
      grant,
      revoke,
      grantInternal,
      /** The agent's grants as rows, for `AgentDetail` (no session: `Agents` already has one). */
      grantsOfAgent: (agentId: AgentId): Effect.Effect<ReadonlyArray<AgentRepoGrant>> =>
        grantRows(agentId).pipe(Effect.map((rows) => rows.map(toAgentRepoGrant))),
      /**
       * Every repository this agent may use, with its mode. The runtime's whole
       * view of the feature: worktrees, instruction lines, `git-credential` and
       * `github_open_pr` all start here, and an empty array means the agent runs
       * exactly as it did before repositories existed (D14).
       */
      grantsOf: (
        agentId: AgentId
      ): Effect.Effect<
        ReadonlyArray<{ readonly repository: Repository; readonly mode: FileGrantMode }>
      > =>
        grantedRepositories(agentId).pipe(
          Effect.map((rows) =>
            rows.map((row) => ({ repository: toRepository(row), mode: row.mode }))
          )
        )
    } as const
  })
}) {}

/** `octocat/hello-world`, `/octocat/hello-world.git`, `octocat/hello-world.git` → `octocat/hello-world`. */
export const repoPathToFullName = (path: string): string | undefined => {
  const trimmed = path
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const parts = trimmed.split('/')
  if (parts.length !== 2) return undefined
  const [owner, name] = parts
  if (owner === undefined || name === undefined || owner === '' || name === '') return undefined
  return `${owner}/${name}`
}

/** The user a GitHub installation token authenticates as over HTTPS. */
export const GIT_CREDENTIAL_USERNAME = 'x-access-token'
