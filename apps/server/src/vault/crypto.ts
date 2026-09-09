import { Data, Either } from 'effect'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'

/**
 * Vault encryption (agent-model.md §2): AES-256-GCM with a per-company key derived by
 * HKDF-SHA256(masterKey, salt = "taut-vault-v1", info = companyId).
 *
 * Ciphertext layout: `[version u8 = 1][nonce 12][tag 16][data]`. The version byte
 * exists so `taut vault rotate-key` can re-encrypt under a new layout later.
 */
export const VAULT_VERSION = 1
export const HKDF_SALT = 'taut-vault-v1'
const KEY_BYTES = 32
const NONCE_BYTES = 12
const TAG_BYTES = 16
const HEADER_BYTES = 1 + NONCE_BYTES + TAG_BYTES

export class VaultCryptoError extends Data.TaggedError('VaultCryptoError')<{
  readonly reason: 'bad-version' | 'too-short' | 'auth-failed'
  readonly message: string
}> {}

const assertKey = (masterKey: Uint8Array): void => {
  if (masterKey.length !== KEY_BYTES) {
    throw new RangeError(`vault: master key must be ${KEY_BYTES} bytes, got ${masterKey.length}`)
  }
}

/** Company-scoped data key. Deterministic; never stored. */
export const deriveKey = (masterKey: Uint8Array, companyId: string): Buffer => {
  assertKey(masterKey)
  return Buffer.from(hkdfSync('sha256', masterKey, HKDF_SALT, companyId, KEY_BYTES))
}

export interface CryptoOptions {
  /** Additional authenticated data, e.g. the vault item id. Must match on decrypt. */
  readonly aad?: Uint8Array | undefined
  /** Tests only: fixed 12-byte nonce. Production callers must leave this unset. */
  readonly nonce?: Uint8Array | undefined
}

export const encrypt = (
  masterKey: Uint8Array,
  companyId: string,
  plaintext: string | Uint8Array,
  options: CryptoOptions = {}
): Buffer => {
  const key = deriveKey(masterKey, companyId)
  const nonce = options.nonce ? Buffer.from(options.nonce) : randomBytes(NONCE_BYTES)
  if (nonce.length !== NONCE_BYTES) {
    throw new RangeError(`vault: nonce must be ${NONCE_BYTES} bytes`)
  }
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  if (options.aad) cipher.setAAD(options.aad)
  const data = Buffer.concat([
    cipher.update(typeof plaintext === 'string' ? Buffer.from(plaintext, 'utf8') : plaintext),
    cipher.final()
  ])
  const tag = cipher.getAuthTag()
  return Buffer.concat([Buffer.from([VAULT_VERSION]), nonce, tag, data])
}

export const decrypt = (
  masterKey: Uint8Array,
  companyId: string,
  ciphertext: Uint8Array,
  options: CryptoOptions = {}
): Either.Either<Buffer, VaultCryptoError> => {
  const key = deriveKey(masterKey, companyId)
  const buf = Buffer.from(ciphertext)
  if (buf.length < HEADER_BYTES) {
    return Either.left(
      new VaultCryptoError({ reason: 'too-short', message: 'ciphertext shorter than header' })
    )
  }
  const version = buf[0]
  if (version !== VAULT_VERSION) {
    return Either.left(
      new VaultCryptoError({
        reason: 'bad-version',
        message: `unsupported vault ciphertext version ${version}`
      })
    )
  }
  const nonce = buf.subarray(1, 1 + NONCE_BYTES)
  const tag = buf.subarray(1 + NONCE_BYTES, HEADER_BYTES)
  const data = buf.subarray(HEADER_BYTES)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  if (options.aad) decipher.setAAD(options.aad)
  decipher.setAuthTag(tag)
  try {
    return Either.right(Buffer.concat([decipher.update(data), decipher.final()]))
  } catch {
    return Either.left(
      new VaultCryptoError({
        reason: 'auth-failed',
        message: 'authentication failed: wrong key, wrong company, or tampered ciphertext'
      })
    )
  }
}

/** Convenience for string secrets. */
export const decryptToString = (
  masterKey: Uint8Array,
  companyId: string,
  ciphertext: Uint8Array,
  options: CryptoOptions = {}
): Either.Either<string, VaultCryptoError> =>
  Either.map(decrypt(masterKey, companyId, ciphertext, options), (b) => b.toString('utf8'))

/** The only plaintext ever shown in the UI: the last 4 characters. */
export const hint = (plaintext: string): string => plaintext.slice(-4)
