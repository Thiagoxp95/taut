import { Effect } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { adapters } from '../src/adapters/index.js'
import { makeLocalProvider } from '../src/machine/local.js'
import type { Machine } from '../src/machine/types.js'
import { onPath, specFor, tempHome } from './helpers.js'

describe('detect() against the real binaries on this machine', () => {
  let cleanup = async () => {}
  let machine: Machine
  beforeAll(async () => {
    const t = await tempHome()
    cleanup = t.cleanup
    machine = await Effect.runPromise(makeLocalProvider().ensure(specFor(t.home)))
  })
  afterAll(() => cleanup())

  for (const adapter of Object.values(adapters)) {
    const present = onPath(adapter.binary)
    it.skipIf(!present)(
      `${adapter.kind}: ${adapter.binary} is installed with a version`,
      async () => {
        const result = await Effect.runPromise(adapter.detect(machine))
        expect(result.installed).toBe(true)
        expect(result.version).toMatch(/\d+\.\d+/)
      }
    )
    it.skipIf(present)(`${adapter.kind}: ${adapter.binary} is reported missing`, async () => {
      const result = await Effect.runPromise(adapter.detect(machine))
      expect(result).toMatchObject({ installed: false })
      expect(result.error).toContain(adapter.binary)
    })
  }
})
