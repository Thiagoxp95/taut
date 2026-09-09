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
