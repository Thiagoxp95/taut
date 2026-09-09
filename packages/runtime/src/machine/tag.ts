import { Context } from 'effect'

import type { MachineProvider } from './types.js'

/** The provider the server picked (`local` in dev, `docker` in prod). */
export class MachineProviderTag extends Context.Tag('@taut/runtime/MachineProvider')<
  MachineProviderTag,
  MachineProvider
>() {}
