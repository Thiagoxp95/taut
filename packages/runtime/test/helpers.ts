/* eslint-disable turbo/no-undeclared-env-vars -- tests read the host PATH on purpose */
import { accessSync, constants, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'

import type { MachineSpec } from '../src/machine/types.js'

export const fixture = (name: string): Array<string> =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8').split('\n')

/** `true` when `binary` resolves on the current PATH. */
export const onPath = (binary: string): boolean =>
  (process.env['PATH'] ?? '').split(delimiter).some((dir) => {
    try {
      accessSync(join(dir, binary), constants.X_OK)
      return true
    } catch {
      return false
    }
  })

export const tempHome = async (): Promise<{ home: string; cleanup: () => Promise<void> }> => {
  const home = await mkdtemp(join(tmpdir(), 'taut-runtime-'))
  return { home, cleanup: () => rm(home, { recursive: true, force: true }) }
}

export const specFor = (home: string, overrides: Partial<MachineSpec> = {}): MachineSpec => ({
  agentId: 'agt_test',
  companyId: 'cmp_test',
  companySlug: 'acme',
  handle: 'bruno',
  homeDir: home,
  limits: { cpus: 1, memoryMb: 512 },
  network: { egress: 'allow-all' },
  ...overrides
})
