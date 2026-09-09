import { FileSystem, HttpApiBuilder, HttpServerResponse } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Agents } from '../services/agents.js'
import { contentDisposition, isInlineMimeType } from '../services/attachments.js'
import { contentTypeOf, Workspace } from '../services/workspace.js'
import { ServerApi } from './serverApi.js'

export const AgentsLive = HttpApiBuilder.group(ServerApi, 'agents', (handlers) =>
  handlers
    .handle('list', () =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return { items: yield* agents.list(yield* CurrentUser) }
      })
    )
    .handle('create', ({ payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.create(yield* CurrentUser, payload)
      })
    )
    .handle('get', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.get(yield* CurrentUser, path.agentId)
      })
    )
    .handle('update', ({ path, payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.update(yield* CurrentUser, path.agentId, payload)
      })
    )
    .handle('delete', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        yield* agents.delete(yield* CurrentUser, path.agentId)
      })
    )
    .handle('getSkill', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.getSkill(yield* CurrentUser, path.agentId, path.name)
      })
    )
    .handle('putSkill', ({ path, payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.putSkill(yield* CurrentUser, path.agentId, path.name, payload)
      })
    )
    .handle('deleteSkill', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        yield* agents.deleteSkill(yield* CurrentUser, path.agentId, path.name)
      })
    )
    // docs/build-plan-skills.md — absorbing a skill from a link, a repo, or a pasted command
    .handle('previewSkill', ({ path, payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.previewSkill(yield* CurrentUser, path.agentId, payload.source)
      })
    )
    .handle('installSkill', ({ path, payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.installSkill(yield* CurrentUser, path.agentId, payload)
      })
    )
    .handle('approveSkill', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.approveSkill(yield* CurrentUser, path.agentId, path.name)
      })
    )
    .handle('checkSkill', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.checkSkill(yield* CurrentUser, path.agentId, path.name)
      })
    )
    .handle('updateSkill', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.updateSkillNow(yield* CurrentUser, path.agentId, path.name)
      })
    )
    .handle('skillSettings', ({ path, payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.setSkillPolicy(
          yield* CurrentUser,
          path.agentId,
          path.name,
          payload.updatePolicy
        )
      })
    )
    .handle('listFiles', ({ path, urlParams }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return { items: yield* agents.listFiles(yield* CurrentUser, path.agentId, urlParams.path) }
      })
    )
    .handle('uploadFile', ({ path, payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.uploadFile(yield* CurrentUser, path.agentId, payload)
      })
    )
    .handle('grantFile', ({ path, payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.grantFile(yield* CurrentUser, path.agentId, payload)
      })
    )
    .handle('revokeFileGrant', ({ path, urlParams }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        yield* agents.revokeFileGrant(yield* CurrentUser, path.agentId, urlParams.path)
      })
    )
    // repositories (docs/build-plan-repositories.md)
    .handle('listRepoGrants', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.listRepoGrants(yield* CurrentUser, path.agentId)
      })
    )
    .handle('grantRepo', ({ path, payload }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        return yield* agents.grantRepo(
          yield* CurrentUser,
          path.agentId,
          path.repositoryId,
          payload.mode
        )
      })
    )
    .handle('revokeRepo', ({ path }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        yield* agents.revokeRepo(yield* CurrentUser, path.agentId, path.repositoryId)
      })
    )
    /**
     * Raw bytes of one file in the home, for the Workspace tab's browser output gallery
     * (docs/build-plan-workspace.md D12). Same shape as `attachments.content`: streamed,
     * `inline` only for the image allow-list, `nosniff`, no caching (the file may change).
     */
    .handleRaw('readFile', ({ path, urlParams }) =>
      Effect.gen(function* () {
        const agents = yield* Agents
        const fs = yield* FileSystem.FileSystem
        const file = yield* agents.readFile(yield* CurrentUser, path.agentId, urlParams.path)
        const mime = contentTypeOf(urlParams.path)
        const name = urlParams.path.slice(urlParams.path.lastIndexOf('/') + 1)
        return HttpServerResponse.stream(fs.stream(file.path), {
          contentType: mime,
          contentLength: file.size,
          headers: {
            'content-disposition': contentDisposition(
              isInlineMimeType(mime) ? 'inline' : 'attachment',
              name
            ),
            'x-content-type-options': 'nosniff',
            'cache-control': 'private, no-store'
          }
        })
      })
    )
    // machine (docs/build-plan-workspace.md D5, D13)
    .handle('getMachine', ({ path }) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace
        return yield* workspace.info(yield* CurrentUser, path.agentId)
      })
    )
    .handle('startMachine', ({ path }) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace
        return yield* workspace.start(yield* CurrentUser, path.agentId)
      })
    )
    .handle('stopMachine', ({ path }) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace
        return yield* workspace.stop(yield* CurrentUser, path.agentId)
      })
    )
    .handle('listProcesses', ({ path }) =>
      Effect.gen(function* () {
        const workspace = yield* Workspace
        return yield* workspace.processes(yield* CurrentUser, path.agentId)
      })
    )
)
