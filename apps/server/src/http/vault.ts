import { HttpApiBuilder } from '@effect/platform'
import { CurrentUser } from '@taut/contract/api'
import { Effect } from 'effect'
import { Vault } from '../services/vault.js'
import { ServerApi } from './serverApi.js'

export const VaultLive = HttpApiBuilder.group(ServerApi, 'vault', (handlers) =>
  handlers
    .handle('list', ({ urlParams }) =>
      Effect.gen(function* () {
        const vault = yield* Vault
        return { items: yield* vault.list(yield* CurrentUser, { agentId: urlParams.agentId }) }
      })
    )
    .handle('add', ({ payload }) =>
      Effect.gen(function* () {
        const vault = yield* Vault
        return yield* vault.add(yield* CurrentUser, payload)
      })
    )
    .handle('revoke', ({ path }) =>
      Effect.gen(function* () {
        const vault = yield* Vault
        yield* vault.revoke(yield* CurrentUser, path.vaultItemId)
      })
    )
)
