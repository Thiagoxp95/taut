import { DockerProviderLive, LocalProviderLive, type MachineProviderTag } from '@taut/runtime'
import { Effect, Layer } from 'effect'
import { AppConfig } from '../config.js'

/**
 * `MachineProviderTag` from `TAUT_MACHINE_PROVIDER`: `local` (spawn on this host; dev) or
 * `docker` (one container per agent; `TAUT_AGENT_IMAGE` overrides the image). Tests replace
 * this layer with a fake provider (see `test/_fakeRuntime.ts`).
 */
export const MachineProviderFromConfig: Layer.Layer<MachineProviderTag, never, AppConfig> =
  Layer.unwrapEffect(
    Effect.gen(function* () {
      const config = yield* AppConfig
      if (config.machineProvider === 'docker') {
        yield* Effect.logInfo(
          `machines: docker provider${config.agentImage === undefined ? '' : ` (image ${config.agentImage})`}`
        )
        return DockerProviderLive(
          config.agentImage === undefined ? {} : { image: config.agentImage }
        )
      }
      yield* Effect.logInfo('machines: local provider (runtimes spawn on this host; dev only)')
      return LocalProviderLive()
    })
  )
