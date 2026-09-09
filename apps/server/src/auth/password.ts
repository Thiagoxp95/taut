import { Effect } from 'effect'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Password hashing with `node:crypto` scrypt (build-plan "Auth"). Stored format:
 * `scrypt$N$r$p$<salt b64>$<hash b64>` so parameters can be raised later without a
 * migration; verification reads them back from the string.
 */
const N = 16384
const R = 8
const P = 1
const KEY_LENGTH = 64
const SALT_BYTES = 16

const derive = (password: string, salt: Buffer, n: number, r: number, p: number) =>
  Effect.async<Buffer>((resume) => {
    scrypt(password, salt, KEY_LENGTH, { N: n, r, p }, (error, key) => {
      if (error) resume(Effect.die(error))
      else resume(Effect.succeed(key))
    })
  })

export const hashPassword = (password: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const salt = randomBytes(SALT_BYTES)
    const key = yield* derive(password, salt, N, R, P)
    return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`
  })

/** Constant-time comparison; a malformed stored hash verifies as `false`, never throws. */
export const verifyPassword = (password: string, stored: string): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$')
    if (scheme !== 'scrypt' || !n || !r || !p || !saltB64 || !hashB64) return false
    const expected = Buffer.from(hashB64, 'base64')
    const actual = yield* derive(
      password,
      Buffer.from(saltB64, 'base64'),
      Number.parseInt(n, 10),
      Number.parseInt(r, 10),
      Number.parseInt(p, 10)
    )
    return actual.length === expected.length && timingSafeEqual(actual, expected)
  })

/** A real hash of a throwaway password, so a login for an unknown email costs the same time. */
export const DUMMY_HASH = `scrypt$${N}$${R}$${P}$${Buffer.alloc(SALT_BYTES, 1).toString('base64')}$${Buffer.alloc(KEY_LENGTH, 1).toString('base64')}`
