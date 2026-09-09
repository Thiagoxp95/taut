import { Schema } from 'effect'

import { AgentId, CompanyId, RepositoryId } from '../ids.js'
import { FileGrantMode } from './enums.js'

/**
 * A GitHub repository attached to a company (docs/build-plan-repositories.md D1).
 *
 * The company owns the repository; agents hold *grants* against it
 * (`AgentRepoGrant`). Attaching and detaching is admin+; granting is whoever may
 * manage the agent — the same split the vault already uses.
 */
export class Repository extends Schema.Class<Repository>('Repository')({
  id: RepositoryId,
  companyId: CompanyId,
  /** GitHub's numeric repo id — the identity that survives a rename. */
  githubId: Schema.Number,
  /** `octocat` in `octocat/hello-world`. */
  owner: Schema.String,
  /** `hello-world` in `octocat/hello-world`. */
  name: Schema.String,
  /** `octocat/hello-world`, denormalised for display and for path lookup. */
  fullName: Schema.String,
  /** The branch a read-only agent reads and a read-write agent branches from. */
  defaultBranch: Schema.String,
  private: Schema.Boolean,
  /** `https://github.com/octocat/hello-world.git` — what the clone uses. */
  cloneUrl: Schema.String,
  attachedAt: Schema.DateTimeUtc
}) {}

/**
 * A repository an agent may use, and how (docs/build-plan-repositories.md D13).
 *
 * `ro` gets a detached worktree on the default branch and a `contents: read`
 * token; `rw` gets its own branch, a `contents: write` + `pull_requests: write`
 * token, and a pre-push hook that refuses the default branch.
 */
export class AgentRepoGrant extends Schema.Class<AgentRepoGrant>('AgentRepoGrant')({
  agentId: AgentId,
  repositoryId: RepositoryId,
  mode: FileGrantMode
}) {}

/**
 * Where the company stands with GitHub. Metadata only — no key, no secret, no
 * token is ever part of this shape (docs/build-plan-repositories.md D8).
 *
 * `none` → no app yet · `app-created` → the App exists but is installed nowhere
 * · `connected` → installed, repositories can be listed and attached.
 */
export class GithubConnection extends Schema.Class<GithubConnection>('GithubConnection')({
  companyId: CompanyId,
  state: Schema.Literal('none', 'app-created', 'connected'),
  /** The App's slug, which builds the install URL. Absent while `none`. */
  appSlug: Schema.optional(Schema.String),
  /** The account the App is installed on, e.g. `acme-inc`. Present only when `connected`. */
  accountLogin: Schema.optional(Schema.String),
  connectedAt: Schema.optional(Schema.DateTimeUtc)
}) {}

/**
 * One row of GitHub's installation repository list: a candidate for attaching.
 * The installation's own picker decides what appears here; Taut's list then
 * decides which of those the company actually uses (D3).
 */
export class AvailableRepository extends Schema.Class<AvailableRepository>('AvailableRepository')({
  githubId: Schema.Number,
  owner: Schema.String,
  name: Schema.String,
  fullName: Schema.String,
  defaultBranch: Schema.String,
  private: Schema.Boolean,
  cloneUrl: Schema.String,
  /** Already attached to this company. */
  attached: Schema.Boolean
}) {}
