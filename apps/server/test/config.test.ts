import { it } from '@effect/vitest'
import { ConfigError, ConfigProvider, Effect, Layer, Redacted } from 'effect'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect } from 'vitest'
import { AppConfig, MasterKeyMissing } from '../src/config.js'
import { makeTempDir, removeDir, TEST_MASTER_KEY, TEST_MASTER_KEY_BYTES } from './_harness.js'

const dirs: Array<string> = []
const fresh = () => {
  const dir = makeTempDir()
  dirs.push(dir)
  return dir
}
afterAll(() => dirs.forEach(removeDir))

const load = (entries: Record<string, string>) =>
  AppConfig.pipe(
    Effect.provide(
      AppConfig.Default.pipe(
        Layer.provide(
          Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(entries))))
        )
      )
    )
  )

describe('AppConfig', () => {
  it.effect('applies defaults and decodes TAUT_MASTER_KEY', () =>
    Effect.gen(function* () {
      const dir = fresh()
      const config = yield* load({ TAUT_DATA_DIR: dir, TAUT_MASTER_KEY: TEST_MASTER_KEY })
      expect(config.port).toBe(3000)
      expect(config.dataDir).toBe(dir)
      expect(config.cookieSecure).toBe(false)
      expect(config.production).toBe(false)
      expect(Buffer.from(Redacted.value(config.masterKey))).toEqual(
        Buffer.from(TEST_MASTER_KEY_BYTES)
      )
      expect(config.version).toMatch(/^\d+\.\d+\.\d+/)
    })
  )

  it.effect('in development generates <dataDir>/master.key (0600) once and reuses it', () =>
    Effect.gen(function* () {
      const dir = fresh()
      const first = yield* load({ TAUT_DATA_DIR: dir })
      const keyFile = join(dir, 'master.key')
      expect(statSync(keyFile).mode & 0o777).toBe(0o600)
      expect(Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64').length).toBe(32)
      const second = yield* load({ TAUT_DATA_DIR: dir })
      expect(Buffer.from(Redacted.value(second.masterKey))).toEqual(
        Buffer.from(Redacted.value(first.masterKey))
      )
    })
  )

  it.effect(
    'in production fails clearly without TAUT_MASTER_KEY and defaults cookieSecure=true',
    () =>
      Effect.gen(function* () {
        const dir = fresh()
        const failure = yield* Effect.flip(load({ TAUT_DATA_DIR: dir, NODE_ENV: 'production' }))
        expect(failure).toBeInstanceOf(MasterKeyMissing)
        expect(String(failure)).toContain('TAUT_MASTER_KEY')
        const ok = yield* load({
          TAUT_DATA_DIR: dir,
          NODE_ENV: 'production',
          TAUT_MASTER_KEY: TEST_MASTER_KEY
        })
        expect(ok.cookieSecure).toBe(true)
        expect(ok.production).toBe(true)
      })
  )

  it.effect('rejects a master key that is not 32 bytes and honours boolean overrides', () =>
    Effect.gen(function* () {
      const dir = fresh()
      const failure = yield* Effect.flip(
        load({ TAUT_DATA_DIR: dir, TAUT_MASTER_KEY: Buffer.alloc(16).toString('base64') })
      )
      expect(ConfigError.isConfigError(failure) && ConfigError.isInvalidData(failure)).toBe(true)
      const config = yield* load({
        TAUT_DATA_DIR: dir,
        TAUT_MASTER_KEY: TEST_MASTER_KEY,
        TAUT_COOKIE_SECURE: 'true',
        PORT: '0'
      })
      expect(config.cookieSecure).toBe(true)
      expect(config.port).toBe(0)
    })
  )
})
