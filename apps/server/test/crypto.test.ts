import { Either } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  decrypt,
  decryptToString,
  deriveKey,
  encrypt,
  hint,
  VAULT_VERSION
} from '../src/vault/crypto.js'
import { TEST_MASTER_KEY_BYTES as KEY } from './_harness.js'

const COMPANY = 'cmp_test'
const ZERO_NONCE = new Uint8Array(12)

// Vectors produced with node:crypto (hkdfSync + aes-256-gcm) for KEY = 32 × 0x07.
const DERIVED_HEX = '7789396eb3a788482b28262ffac21c5c151608ad009fe4fdf0feac9548b5b833'
const VECTOR_PLAINTEXT = 'sk-ant-test-secret-1234'
const VECTOR_HEX =
  '010000000000000000000000008fdf84eb4af61d5a539666b39d5a335edfdfdeb3299855681af5ea1047aae8e434136933eed20f'

const unwrap = <A>(either: Either.Either<A, { message: string }>): A =>
  Either.match(either, {
    onLeft: (e) => {
      throw new Error(e.message)
    },
    onRight: (a) => a
  })

describe('vault/crypto', () => {
  it('derives the documented HKDF key', () => {
    expect(deriveKey(KEY, COMPANY).toString('hex')).toBe(DERIVED_HEX)
    expect(deriveKey(KEY, 'cmp_other').toString('hex')).not.toBe(DERIVED_HEX)
  })

  it('produces the known ciphertext for a fixed nonce and decrypts the known vector', () => {
    const out = encrypt(KEY, COMPANY, VECTOR_PLAINTEXT, { nonce: ZERO_NONCE })
    expect(out.toString('hex')).toBe(VECTOR_HEX)
    expect(unwrap(decryptToString(KEY, COMPANY, Buffer.from(VECTOR_HEX, 'hex')))).toBe(
      VECTOR_PLAINTEXT
    )
  })

  it('lays out [version][nonce 12][tag 16][data]', () => {
    const out = encrypt(KEY, COMPANY, 'abc')
    expect(out[0]).toBe(VAULT_VERSION)
    expect(out.length).toBe(1 + 12 + 16 + 3)
  })

  it('round-trips strings and bytes with random nonces', () => {
    const a = encrypt(KEY, COMPANY, 'hello')
    const b = encrypt(KEY, COMPANY, 'hello')
    expect(a.equals(b)).toBe(false)
    expect(unwrap(decryptToString(KEY, COMPANY, a))).toBe('hello')
    const bytes = new Uint8Array([0, 1, 2, 255])
    expect(Buffer.from(unwrap(decrypt(KEY, COMPANY, encrypt(KEY, COMPANY, bytes))))).toEqual(
      Buffer.from(bytes)
    )
  })

  it('detects tampering of data, tag and nonce', () => {
    const out = encrypt(KEY, COMPANY, 'top secret')
    for (const index of [1, 1 + 12, out.length - 1]) {
      const copy = Buffer.from(out)
      copy[index] = (copy[index] ?? 0) ^ 0x01
      const result = decrypt(KEY, COMPANY, copy)
      expect(Either.isLeft(result)).toBe(true)
      if (Either.isLeft(result)) expect(result.left.reason).toBe('auth-failed')
    }
  })

  it('binds ciphertext to the company, master key and AAD', () => {
    const aad = Buffer.from('vlt_1')
    const out = encrypt(KEY, COMPANY, 'x', { aad })
    expect(Either.isLeft(decrypt(KEY, 'cmp_other', out, { aad }))).toBe(true)
    expect(Either.isLeft(decrypt(new Uint8Array(32), COMPANY, out, { aad }))).toBe(true)
    expect(Either.isLeft(decrypt(KEY, COMPANY, out, { aad: Buffer.from('vlt_2') }))).toBe(true)
    expect(Either.isLeft(decrypt(KEY, COMPANY, out))).toBe(true)
    expect(unwrap(decryptToString(KEY, COMPANY, out, { aad }))).toBe('x')
  })

  it('rejects unknown versions and truncated input', () => {
    const out = encrypt(KEY, COMPANY, 'x')
    const wrongVersion = Buffer.from(out)
    wrongVersion[0] = 2
    const v = decrypt(KEY, COMPANY, wrongVersion)
    expect(Either.isLeft(v) && v.left.reason).toBe('bad-version')
    const s = decrypt(KEY, COMPANY, out.subarray(0, 10))
    expect(Either.isLeft(s) && s.left.reason).toBe('too-short')
  })

  it('refuses master keys that are not 32 bytes', () => {
    expect(() => encrypt(new Uint8Array(16), COMPANY, 'x')).toThrow(RangeError)
  })

  it('hint is the last 4 characters', () => {
    expect(hint('sk-ant-api03-abcdef')).toBe('cdef')
    expect(hint('ab')).toBe('ab')
  })
})
