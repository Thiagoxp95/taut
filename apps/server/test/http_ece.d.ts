/**
 * `http_ece` (a transitive dependency of `web-push`, pulled in directly as a devDependency)
 * ships no types. Only what `phase8.test.ts` uses is declared: decrypting a captured push
 * the way a browser's service worker would.
 */
declare module 'http_ece' {
  import type { ECDH } from 'node:crypto'

  interface DecryptParams {
    /** Taut only ever sends the modern encoding. */
    readonly version: 'aes128gcm'
    /** The receiver's key agreement object, with its private key generated. */
    readonly privateKey: ECDH
    /** The receiver's public key, base64url. */
    readonly dh: string
    /** The 16-byte auth secret, base64url. */
    readonly authSecret: string
  }

  export function decrypt(buffer: Buffer, params: DecryptParams): Buffer
}
