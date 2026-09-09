import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Departments } from '../services/departments.js'
import { ServerApi } from './serverApi.js'

export const DepartmentsLive = HttpApiBuilder.group(ServerApi, 'departments', (handlers) =>
  handlers
    .handle('list', () =>
      Effect.gen(function* () {
        const departments = yield* Departments
        return { items: yield* departments.list(yield* CurrentUser) }
      })
    )
    .handle('create', ({ payload }) =>
      Effect.gen(function* () {
        const departments = yield* Departments
        return yield* departments.create(yield* CurrentUser, payload)
      })
    )
    .handle('get', ({ path }) =>
      Effect.gen(function* () {
        const departments = yield* Departments
        return yield* departments.get(yield* CurrentUser, path.departmentId)
      })
    )
    .handle('update', ({ path, payload }) =>
      Effect.gen(function* () {
        const departments = yield* Departments
        return yield* departments.update(yield* CurrentUser, path.departmentId, payload)
      })
    )
    .handle('delete', ({ path }) =>
      Effect.gen(function* () {
        const departments = yield* Departments
        yield* departments.delete(yield* CurrentUser, path.departmentId)
      })
    )
    .handle('addMember', ({ path, payload }) =>
      Effect.gen(function* () {
        const departments = yield* Departments
        return yield* departments.addMember(yield* CurrentUser, path.departmentId, payload)
      })
    )
    .handle('removeMember', ({ path }) =>
      Effect.gen(function* () {
        const departments = yield* Departments
        yield* departments.removeMember(yield* CurrentUser, path.departmentId, {
          memberKind: path.memberKind,
          memberId: path.memberId
        })
      })
    )
    .handle('setHead', ({ path, payload }) =>
      Effect.gen(function* () {
        const departments = yield* Departments
        return yield* departments.setHead(yield* CurrentUser, path.departmentId, payload.headUserId)
      })
    )
)
