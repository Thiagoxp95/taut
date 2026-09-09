import { NodeContext } from '@effect/platform-node'
import type { MachineProviderTag } from '@taut/runtime'
import { ConfigProvider, Layer } from 'effect'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppConfig } from '../src/config.js'
import { DbLive } from '../src/db/migrator.js'
import { AppLive, appLive } from '../src/layers.js'

export const TEST_MASTER_KEY_BYTES = new Uint8Array(Buffer.alloc(32, 7))
export const TEST_MASTER_KEY = Buffer.from(TEST_MASTER_KEY_BYTES).toString('base64')

export const makeTempDir = (): string => mkdtempSync(join(tmpdir(), 'taut-server-test-'))
export const removeDir = (dir: string): void => rmSync(dir, { recursive: true, force: true })

/** Config from an explicit map only (never the real environment). PORT=0 → random port. */
export const testConfig = (dir: string, extra: Record<string, string> = {}) =>
  Layer.setConfigProvider(
    ConfigProvider.fromMap(
      new Map([
        ['TAUT_DATA_DIR', dir],
        ['PORT', '0'],
        ['TAUT_MASTER_KEY', TEST_MASTER_KEY],
        ...Object.entries(extra)
      ])
    )
  )

/** Migrated SQLite at `<dir>/taut.db` plus `AppConfig` and Node platform services. */
export const testDb = (dir: string, extra?: Record<string, string>) =>
  DbLive.pipe(
    Layer.provideMerge(NodeContext.layer),
    Layer.provideMerge(AppConfig.Default),
    Layer.provide(testConfig(dir, extra))
  )

/** The whole server on a random port against a temp data dir (machine provider from config). */
export const testApp = (dir: string, extra?: Record<string, string>) =>
  AppLive.pipe(Layer.provide(testConfig(dir, extra)))

/** Same, with an explicit machine provider (a fake in the scheduler tests). */
export const testAppWith = (
  dir: string,
  provider: Layer.Layer<MachineProviderTag>,
  extra?: Record<string, string>
) => appLive(provider).pipe(Layer.provide(testConfig(dir, extra)))
