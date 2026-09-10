import { HttpApiEndpoint, HttpApiGroup, HttpApiSchema, Multipart } from '@effect/platform'
import { Schema } from 'effect'

import { Agent, AgentFileGrant, AgentSkill, AgentSkillDetail } from '../domain/agent.js'
import { Avatar } from '../domain/avatar.js'
import {
  AgentStatus,
  FileGrantMode,
  PermissionMode,
  RuntimeKind,
  SkillUpdatePolicy
} from '../domain/enums.js'
import { MachineInfo, ProcessEntry } from '../domain/machine.js'
import { AgentRepoGrant } from '../domain/repository.js'
import { DisplayName, Handle } from '../domain/primitives.js'
import { Conflict, Forbidden, NotFound, RuntimeUnavailable, Validation } from '../errors.js'
import { AgentId, DepartmentId, RepositoryId, SubscriptionId } from '../ids.js'
import { Page, PageQuery } from './common.js'
import { Authentication } from './middleware.js'

/** Authentication values are write-only; responses expose header names only. */
export const AgentConnector = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  url: Schema.String,
  headerNames: Schema.Array(Schema.String)
})
export type AgentConnector = typeof AgentConnector.Type

export const ConnectorInput = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  headers: Schema.Record({ key: Schema.String, value: Schema.String })
})
export type ConnectorInput = typeof ConnectorInput.Type

export const UpdateConnectorInput = Schema.Struct({
  name: Schema.String,
  url: Schema.String,
  /** Omit to keep saved authentication; an empty object clears all headers. */
  headers: Schema.optional(Schema.Record({ key: Schema.String, value: Schema.String }))
})
export type UpdateConnectorInput = typeof UpdateConnectorInput.Type

export const CreateAgentPayload = Schema.Struct({
  handle: Handle,
  name: DisplayName,
  avatar: Avatar,
  role: Schema.String,
  mandate: Schema.String,
  runtimeKind: RuntimeKind,
  pinnedSubscriptionId: Schema.optional(SubscriptionId),
  model: Schema.optional(Schema.String),
  permissionMode: Schema.optionalWith(PermissionMode, { default: () => 'plan' as const }),
  /** Headless browser inside the agent's machine. Defaults to `false`. */
  browserAccess: Schema.optional(Schema.Boolean),
  connectors: Schema.optional(Schema.Array(ConnectorInput)),
  /**
   * Department the agent joins on creation (it becomes a member of that department and
   * its channels). Admin+ or that department's head may set it; without it, admin+ only.
   */
  departmentId: Schema.optional(DepartmentId),
  /**
   * Repositories the agent may use from its first task, and how
   * (docs/build-plan-repositories.md). Each id must already be attached to the
   * company; anything else fails with `NotFound`.
   */
  repoGrants: Schema.optional(
    Schema.Array(Schema.Struct({ repositoryId: RepositoryId, mode: FileGrantMode }))
  )
})

/** `null` clears an optional field. */
export const UpdateAgentPayload = Schema.partial(
  Schema.Struct({
    name: DisplayName,
    avatar: Avatar,
    role: Schema.String,
    mandate: Schema.String,
    runtimeKind: RuntimeKind,
    pinnedSubscriptionId: Schema.NullOr(SubscriptionId),
    model: Schema.NullOr(Schema.String),
    permissionMode: PermissionMode,
    browserAccess: Schema.Boolean,
    status: AgentStatus,
    /** `false` brings an archived agent (and its DMs) back; `true` files it away. */
    archived: Schema.Boolean
  })
)

export const AgentDetail = Schema.Struct({
  agent: Agent,
  skills: Schema.Array(AgentSkill),
  fileGrants: Schema.Array(AgentFileGrant),
  /** Repositories this agent may use (docs/build-plan-repositories.md D1). */
  repoGrants: Schema.Array(AgentRepoGrant),
  connectors: Schema.optionalWith(Schema.Array(AgentConnector), { default: () => [] })
})
export type AgentDetail = typeof AgentDetail.Type

export const PutSkillPayload = Schema.Struct({
  description: Schema.NonEmptyString,
  /** Markdown body written to `<home>/skills/<name>/SKILL.md`. */
  body: Schema.String
})

// --- installing a skill from a source (docs/build-plan-skills.md) ---------

/**
 * One free-text field for every shape a skill arrives in: a link, `owner/repo`, the
 * `npx skills@latest add …` command from a page, or the markdown itself (D2/D3). Parsed by
 * `parseSkillSource`; `SKILL_SOURCE_HELP` is the text to show under the input.
 */
export const PreviewSkillPayload = Schema.Struct({ source: Schema.NonEmptyString })

/** One installable skill found at a source. `preview` returns these; `install` picks one by name. */
export const SkillCandidate = Schema.Struct({
  name: Handle,
  description: Schema.String,
  /** Repo-relative path of the skill's directory, e.g. `skills/engineering/grill-with-docs`. */
  path: Schema.String
})
export type SkillCandidate = typeof SkillCandidate.Type

export const InstallSkillPayload = Schema.Struct({
  source: Schema.NonEmptyString,
  /** Which skill to take; required when `preview` returned more than one. */
  name: Schema.optional(Handle),
  /**
   * Plainly optional rather than defaulted-on-decode: `optionalWith({ default })` makes the
   * field *required* on the Type side, so every caller would have to send a value it does not
   * care about. The server applies D9's `notify` when this is absent.
   */
  updatePolicy: Schema.optional(SkillUpdatePolicy)
})

export const SkillSettingsPayload = Schema.Struct({ updatePolicy: SkillUpdatePolicy })

/** An entry in the agent's home folder. `path` is relative to home. */
export const FileEntry = Schema.Struct({
  path: Schema.String,
  kind: Schema.Literal('file', 'dir'),
  size: Schema.NonNegativeInt,
  modifiedAt: Schema.DateTimeUtc
})
export type FileEntry = typeof FileEntry.Type

export const ListFilesQuery = Schema.Struct({
  ...PageQuery.fields,
  /** Directory to list, relative to home. Defaults to home. */
  path: Schema.optional(Schema.String)
})

export const UploadFilePayload = HttpApiSchema.Multipart(
  Schema.Struct({
    /** Destination directory relative to home (usually `inbox`). */
    path: Schema.String,
    file: Multipart.SingleFileSchema
  })
)

export const GrantRepoPayload = Schema.Struct({ mode: FileGrantMode })

export const GrantFilePayload = Schema.Struct({ path: Schema.NonEmptyString, mode: FileGrantMode })
export const RevokeFileGrantQuery = Schema.Struct({ path: Schema.NonEmptyString })

/** `path` is relative to home and must name a file, not a directory. */
export const ReadFileQuery = Schema.Struct({ path: Schema.NonEmptyString })

/** Raw bytes; the server sets the real `content-type` from the file's extension. */
export const FileContent = Schema.Uint8ArrayFromSelf.pipe(
  HttpApiSchema.withEncoding({ kind: 'Uint8Array', contentType: 'application/octet-stream' })
)

const AgentPath = Schema.Struct({ agentId: AgentId })
const ConnectorPath = Schema.Struct({ agentId: AgentId, connectorId: Schema.String })
const SkillPath = Schema.Struct({ agentId: AgentId, name: Handle })
const AgentRepoPath = Schema.Struct({ agentId: AgentId, repositoryId: RepositoryId })

// TODO(plan): `memory(search)` is deferred (docs/agent-model.md "Deferred").
export class AgentsGroup extends HttpApiGroup.make('agents')
  .add(HttpApiEndpoint.get('list', '/').setUrlParams(PageQuery).addSuccess(Page(Agent)))
  .add(
    HttpApiEndpoint.post('create', '/')
      .setPayload(CreateAgentPayload)
      .addSuccess(Agent, { status: 201 })
      .addError(Forbidden)
      .addError(Conflict)
      .addError(NotFound)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.get('get', '/:agentId')
      .setPath(AgentPath)
      .addSuccess(AgentDetail)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.patch('update', '/:agentId')
      .setPath(AgentPath)
      .setPayload(UpdateAgentPayload)
      .addSuccess(Agent)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.del('delete', '/:agentId')
      .setPath(AgentPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post('addConnector', '/:agentId/connectors')
      .setPath(AgentPath)
      .setPayload(ConnectorInput)
      .addSuccess(AgentConnector, { status: 201 })
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.put('updateConnector', '/:agentId/connectors/:connectorId')
      .setPath(ConnectorPath)
      .setPayload(UpdateConnectorInput)
      .addSuccess(AgentConnector)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.del('removeConnector', '/:agentId/connectors/:connectorId')
      .setPath(ConnectorPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  // skills
  .add(
    /** Any member: the row plus the `SKILL.md` body, so an editor can load before it saves. */
    HttpApiEndpoint.get('getSkill', '/:agentId/skills/:name')
      .setPath(SkillPath)
      .addSuccess(AgentSkillDetail)
      .addError(NotFound)
  )
  .add(
    HttpApiEndpoint.put('putSkill', '/:agentId/skills/:name')
      .setPath(SkillPath)
      .setPayload(PutSkillPayload)
      .addSuccess(AgentSkill)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.del('deleteSkill', '/:agentId/skills/:name')
      .setPath(SkillPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /**
     * What is installable at `source`, without installing anything (D3/D4). A repo with many
     * skills returns many candidates; the UI then asks which one.
     */
    HttpApiEndpoint.post('previewSkill', '/:agentId/skills/preview')
      .setPath(AgentPath)
      .setPayload(PreviewSkillPayload)
      .addSuccess(Schema.Array(SkillCandidate))
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    /**
     * Install from a source. A human who may manage the agent gets an `active` skill; an agent
     * installing for itself gets a `pending` one that a human must approve (D7).
     */
    HttpApiEndpoint.post('installSkill', '/:agentId/skills/install')
      .setPath(AgentPath)
      .setPayload(InstallSkillPayload)
      .addSuccess(AgentSkill, { status: 201 })
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Conflict)
      .addError(Validation)
  )
  .add(
    /** Accept a `pending` skill: its files move into `skills/` and the agent starts using it (D7). */
    HttpApiEndpoint.post('approveSkill', '/:agentId/skills/:name/approve')
      .setPath(SkillPath)
      .addSuccess(AgentSkill)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /** Look upstream now instead of waiting for the daily tick (D9/D10). */
    HttpApiEndpoint.post('checkSkill', '/:agentId/skills/:name/check')
      .setPath(SkillPath)
      .addSuccess(AgentSkillDetail)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    /** Apply the upstream change. Refetches the whole skill directory, siblings included (D5). */
    HttpApiEndpoint.post('updateSkill', '/:agentId/skills/:name/update')
      .setPath(SkillPath)
      .addSuccess(AgentSkill)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    /** Change how an installed skill tracks upstream (D9). */
    HttpApiEndpoint.patch('skillSettings', '/:agentId/skills/:name')
      .setPath(SkillPath)
      .setPayload(SkillSettingsPayload)
      .addSuccess(AgentSkill)
      .addError(NotFound)
      .addError(Forbidden)
  )
  // files
  .add(
    HttpApiEndpoint.get('listFiles', '/:agentId/files')
      .setPath(AgentPath)
      .setUrlParams(ListFilesQuery)
      .addSuccess(Page(FileEntry))
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    HttpApiEndpoint.post('uploadFile', '/:agentId/files')
      .setPath(AgentPath)
      .setPayload(UploadFilePayload)
      .addSuccess(FileEntry, { status: 201 })
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.post('grantFile', '/:agentId/files/grants')
      .setPath(AgentPath)
      .setPayload(GrantFilePayload)
      .addSuccess(AgentFileGrant, { status: 201 })
      .addError(NotFound)
      .addError(Forbidden)
      .addError(Validation)
  )
  .add(
    HttpApiEndpoint.del('revokeFileGrant', '/:agentId/files/grants')
      .setPath(AgentPath)
      .setUrlParams(RevokeFileGrantQuery)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /**
     * Bytes of one file inside the home (managers only). Backs the Workspace tab's
     * browser output gallery (docs/build-plan-workspace.md D12); the content type
     * comes from the extension so `<img src>` works.
     */
    HttpApiEndpoint.get('readFile', '/:agentId/files/content')
      .setPath(AgentPath)
      .setUrlParams(ReadFileQuery)
      .addSuccess(FileContent)
      .addError(NotFound)
      .addError(Forbidden)
  )
  // repositories (docs/build-plan-repositories.md)
  .add(
    /** Any member: which repositories this agent may use, and how. */
    HttpApiEndpoint.get('listRepoGrants', '/:agentId/repositories')
      .setPath(AgentPath)
      .addSuccess(Schema.Array(AgentRepoGrant))
      .addError(NotFound)
  )
  .add(
    /**
     * Grant or change access. Managers only (admin+ or the head of the agent's
     * department). `NotFound` when the repository is not attached to the company.
     */
    HttpApiEndpoint.put('grantRepo', '/:agentId/repositories/:repositoryId')
      .setPath(AgentRepoPath)
      .setPayload(GrantRepoPayload)
      .addSuccess(AgentRepoGrant)
      .addError(NotFound)
      .addError(Forbidden)
  )
  .add(
    /** Managers only. Idempotent. */
    HttpApiEndpoint.del('revokeRepo', '/:agentId/repositories/:repositoryId')
      .setPath(AgentRepoPath)
      .addError(NotFound)
      .addError(Forbidden)
  )
  // machine (docs/build-plan-workspace.md D5, D13) — every one gated on "may manage the agent" (D3)
  .add(
    HttpApiEndpoint.get('getMachine', '/:agentId/machine')
      .setPath(AgentPath)
      .addSuccess(MachineInfo)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(RuntimeUnavailable)
  )
  .add(
    /** Create-or-reuse and start the box; idempotent. */
    HttpApiEndpoint.post('startMachine', '/:agentId/machine/start')
      .setPath(AgentPath)
      .addSuccess(MachineInfo)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(RuntimeUnavailable)
  )
  .add(
    /** Stop the box; the home dir stays. Idempotent. */
    HttpApiEndpoint.post('stopMachine', '/:agentId/machine/stop')
      .setPath(AgentPath)
      .addSuccess(MachineInfo)
      .addError(NotFound)
      .addError(Forbidden)
      .addError(RuntimeUnavailable)
  )
  .add(
    /** `ps` inside the box, parsed; empty when the box is not running. */
    HttpApiEndpoint.get('listProcesses', '/:agentId/machine/processes')
      .setPath(AgentPath)
      .addSuccess(Schema.Array(ProcessEntry))
      .addError(NotFound)
      .addError(Forbidden)
      .addError(RuntimeUnavailable)
  )
  .middleware(Authentication)
  .prefix('/agents') {}
