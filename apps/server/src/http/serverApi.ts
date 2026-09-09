import { HttpApiEndpoint, HttpApiGroup } from '@effect/platform'
import { TautApi } from '@taut/contract/api'
import { Schema } from 'effect'

export const Health = Schema.Struct({
  ok: Schema.Literal(true),
  version: Schema.String
})

/** `GET /api/health` — server-only, not part of the shared contract the web client derives from. */
export const HealthGroup = HttpApiGroup.make('health')
  .add(HttpApiEndpoint.get('get', '/health').addSuccess(Health))
  .prefix('/api')

/** The contract's `TautApi` plus the health probe. Every group layer is built against this. */
export const ServerApi = TautApi.add(HealthGroup)
