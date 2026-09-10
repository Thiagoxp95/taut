import { Either } from 'effect'

import type { CredentialKind } from './enums.js'

/**
 * What an operator pasted → the exact bytes a runtime needs.
 *
 * Every credential enters Taut as one pasted string, and the paste is where
 * seats break. A Codex subscription login is a ~5 kB JSON file: a half-copy of
 * it still looks plausible, stores without complaint, and only surfaces later
 * as `auth-failed` on the subscriptions page. So the paste is checked once,
 * here, and this module runs in both places that see plaintext — the browser
 * field while it is being filled in, and `Vault.add` before anything is
 * encrypted.
 *
 * `Right` is what gets stored (canonical, trimmed, decoded). `Left` is the one
 * sentence shown under the field — it names the fix, never the format.
 */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const str = (value: unknown): string => (typeof value === 'string' ? value : '')

/** `export FOO="bar"` / `FOO=bar` → `bar`; operators paste the whole shell line. */
const stripAssignment = (value: string): string => {
  const match = /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=\s*(.+)$/.exec(value)
  const body = (match?.[1] ?? value).trim()
  return /^(["']).*\1$/.test(body) ? body.slice(1, -1).trim() : body
}

const parseJson = (value: string): Record<string, unknown> | null => {
  try {
    const parsed: unknown = JSON.parse(value)
    return isRecord(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * The Codex login is copied as base64 so no newline, quote or shell mangling can
 * survive into the field; a raw `{…}` paste is still accepted for anyone who
 * copies the file by hand.
 */
const fromBase64 = (value: string): string | null => {
  const clean = value.replace(/\s+/g, '')
  if (clean.length === 0 || clean.length % 4 !== 0) return null
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(clean)) return null
  try {
    const bytes = Uint8Array.from(atob(clean), (character) => character.charCodeAt(0))
    return new TextDecoder().decode(bytes)
  } catch {
    return null
  }
}

/** API keys and the Claude token are a single opaque word — anything else is a mis-paste. */
const oneLine = (value: string, what: string): Either.Either<string, string> => {
  const key = stripAssignment(value)
  if (key === '') return Either.left(`Paste the ${what}.`)
  if (/\s/.test(key)) {
    return Either.left(`Paste only the ${what} — this has a space or a line break in it.`)
  }
  return Either.right(key)
}

export const normalizeCredentialSecret = (
  kind: CredentialKind,
  raw: string
): Either.Either<string, string> => {
  const trimmed = raw.trim()
  if (trimmed === '') return Either.left('Nothing pasted yet.')

  switch (kind) {
    case 'openai.oauth': {
      const login = parseJson(trimmed) ?? parseJson(fromBase64(trimmed) ?? '')
      if (login === null) {
        return Either.left(
          'That is not a Codex login. Run the command above — it copies one long line — then paste that line.'
        )
      }
      const tokens = isRecord(login['tokens']) ? login['tokens'] : undefined
      if (str(tokens?.['access_token']) === '' && str(login['OPENAI_API_KEY']) === '') {
        return Either.left(
          'This login is empty — Codex is not signed in on that machine. Run `codex login` there, then copy again.'
        )
      }
      return Either.right(JSON.stringify(login))
    }

    case 'claude.oauth': {
      if (trimmed.startsWith('{')) {
        return Either.left(
          'That is a file, not a token. `claude setup-token` prints one line — paste that line.'
        )
      }
      return oneLine(trimmed, 'token')
    }

    /**
     * A whole Claude seat in one paste. This is the `claude login` credentials
     * record, not the `setup-token` line: it runs the runtime *and* reads
     * `/api/oauth/usage`, which the setup-token's `user:inference` scope cannot.
     * Its `refreshToken` is what keeps both halves alive past the access
     * token's few hours, so a record without one is refused here.
     */
    case 'claude.login': {
      if (/^sk-ant-/.test(trimmed)) {
        return Either.left(
          'That is a token, not a login. Pick "Claude setup token" above to use it, or run the command above to copy the full login.'
        )
      }
      const login = parseJson(trimmed) ?? parseJson(fromBase64(trimmed) ?? '')
      if (login === null) {
        return Either.left(
          'That is not a Claude login. Run the command above — it copies one long line — then paste that line.'
        )
      }
      /**
       * The record also holds `mcpOAuth`, tokens for whatever MCP servers that
       * machine signed into. Those records do not establish that a usable
       * Claude login was exported, even when `claude auth status` succeeds.
       * Check the actual tokens without inferring the active sign-in method.
       */
      const nested = isRecord(login['claudeAiOauth']) ? login['claudeAiOauth'] : undefined
      const oauth = nested ?? login
      if (nested === undefined && !('accessToken' in login)) {
        return Either.left(
          'That machine has no saved Claude login — the record it copied holds only MCP tokens. Run `claude auth login` there and copy again, or use `claude setup-token` with the "Claude setup token" kind above.'
        )
      }
      if (str(oauth['accessToken']) === '') {
        return Either.left(
          'This saved login is empty: it has no Claude access token. Run `claude auth login` on that machine, then copy again. To connect using `claude setup-token`, choose Subscription in the provider dialog (or Claude setup token in the vault).'
        )
      }
      if (str(oauth['refreshToken']) === '') {
        return Either.left(
          'This login has no refresh token, so the seat would stop working within hours. Sign in again with `claude auth login`, then copy.'
        )
      }
      return Either.right(JSON.stringify({ claudeAiOauth: oauth }))
    }

    case 'anthropic.api_key':
    case 'openai.api_key':
    case 'cursor.api_key':
      return oneLine(trimmed, 'key')

    case 'generic.secret':
      return Either.right(trimmed)
  }
}

/** `true` when the paste would store cleanly — the field's own gate before submit. */
export const isCredentialSecretUsable = (kind: CredentialKind, raw: string): boolean =>
  Either.isRight(normalizeCredentialSecret(kind, raw))

/** The message to show under the field, or `undefined` while the paste is fine or empty. */
export const credentialSecretProblem = (kind: CredentialKind, raw: string): string | undefined => {
  if (raw.trim() === '') return undefined
  const result = normalizeCredentialSecret(kind, raw)
  return Either.isLeft(result) ? result.left : undefined
}
