import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Projects } from '../services/projects.js'
import { ServerApi } from './serverApi.js'

/**
 * The projects group (docs/build-plan-projects.md). Thin by design: every
 * decision — who may connect, what a sync does to the mirror, what happens when
 * Linear refuses — lives in `services/projects.ts`, and nothing here touches the
 * API key.
 */
export const ProjectsLive = HttpApiBuilder.group(ServerApi, 'projects', (handlers) =>
  handlers
    .handle('linearConnection', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.connection(yield* CurrentUser)
      })
    )
    .handle('connectLinear', ({ payload }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.connect(yield* CurrentUser, payload.apiKey)
      })
    )
    .handle('disconnectLinear', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        yield* projects.disconnect(yield* CurrentUser)
      })
    )
    .handle('sync', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return { items: yield* projects.sync(yield* CurrentUser) }
      })
    )
    .handle('move', ({ path, payload }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.move(yield* CurrentUser, path.projectId, payload.statusId)
      })
    )
    .handle('linearUsers', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return { items: yield* projects.linearUsers(yield* CurrentUser) }
      })
    )
    .handle('linkLinearUser', ({ path, payload }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.linkLinearUser(yield* CurrentUser, path.linearUserId, payload.member)
      })
    )
    /**
     * One ticket and everything hanging off it (docs/build-plan-issues.md). Thin
     * exactly like the rest of this file: which ref resolves, who may write, what
     * a thread is and when Linear is called all live in the service.
     */
    .handle('issue', ({ path }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.issue(yield* CurrentUser, path.issueId)
      })
    )
    .handle('issueActivity', ({ path }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.issueActivity(yield* CurrentUser, path.issueId)
      })
    )
    .handle('updateIssue', ({ path, payload }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.updateIssue(yield* CurrentUser, path.issueId, payload)
      })
    )
    .handle('deleteIssue', ({ path }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        yield* projects.deleteIssue(yield* CurrentUser, path.issueId)
      })
    )
    .handle('openIssueThread', ({ path, payload }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.openIssueThread(yield* CurrentUser, path.issueId, payload.body)
      })
    )
    .handle('issueOptions', ({ path }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.issueOptions(yield* CurrentUser, path.projectId)
      })
    )
    .handle('createIssue', ({ path, payload }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.fileIssue(yield* CurrentUser, path.projectId, payload)
      })
    )
    .handle('list', () =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return { items: yield* projects.list(yield* CurrentUser) }
      })
    )
    .handle('issues', ({ path }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return { items: yield* projects.issues(yield* CurrentUser, path.projectId) }
      })
    )
    .handle('get', ({ path }) =>
      Effect.gen(function* () {
        const projects = yield* Projects
        return yield* projects.get(yield* CurrentUser, path.projectId)
      })
    )
)
