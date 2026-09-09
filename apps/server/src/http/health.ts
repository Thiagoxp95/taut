import { HttpApiBuilder } from '@effect/platform'
import { Effect } from 'effect'
import { AppConfig } from '../config.js'
import { ServerApi } from './serverApi.js'

/** `GET /api/health` → `{ ok: true, version }`. */
export const HealthLive = HttpApiBuilder.group(ServerApi, 'health', (handlers) =>
  handlers.handle('get', () =>
    AppConfig.pipe(Effect.map((config) => ({ ok: true as const, version: config.version })))
  )
)
