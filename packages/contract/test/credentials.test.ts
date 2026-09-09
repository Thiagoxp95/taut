import { describe, expect, it } from '@effect/vitest'
import { Either } from 'effect'

import { credentialSecretProblem, normalizeCredentialSecret } from '../src/domain/credentials.js'

/** The shape `codex login` leaves in `~/.codex/auth.json`, shortened. */
const codexLogin = {
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: {
    id_token: 'eyJhbGci.id',
    access_token: 'eyJhbGci.access',
    refresh_token: 'rt_9f3c',
    account_id: 'acc_1234'
  },
  last_refresh: '2026-09-08T12:00:00.000Z'
}

/** The shape `claude auth login` leaves in the Keychain, shortened. */
const claudeLogin = {
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-live',
    refreshToken: 'sk-ant-ort01-refresh',
    expiresAt: 1_790_000_000_000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max'
  },
  mcpOAuth: { 'some-server': { accessToken: 'unrelated' } }
}

const toBase64 = (value: string): string => Buffer.from(value, 'utf8').toString('base64')

const right = (result: Either.Either<string, string>): string => {
  if (Either.isLeft(result)) throw new Error(`expected a usable secret, got: ${result.left}`)
  return result.right
}

const left = (result: Either.Either<string, string>): string => {
  if (Either.isRight(result)) throw new Error('expected the paste to be refused')
  return result.left
}

describe('normalizeCredentialSecret', () => {
  describe('openai.oauth', () => {
    it('accepts the base64 line the connect dialog tells operators to copy', () => {
      const stored = right(
        normalizeCredentialSecret('openai.oauth', toBase64(JSON.stringify(codexLogin)))
      )
      expect(JSON.parse(stored)).toEqual(codexLogin)
    })

    it('accepts the file pasted whole, whitespace and all', () => {
      const stored = right(
        normalizeCredentialSecret('openai.oauth', `\n${JSON.stringify(codexLogin, null, 2)}\n`)
      )
      expect(JSON.parse(stored)).toEqual(codexLogin)
    })

    it('refuses a half-copied file — the seat this exists to prevent', () => {
      const half = JSON.stringify(codexLogin).slice(0, 120)
      expect(left(normalizeCredentialSecret('openai.oauth', half))).toContain('not a Codex login')
    })

    it('refuses a login with no tokens in it', () => {
      const empty = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: {} })
      expect(left(normalizeCredentialSecret('openai.oauth', empty))).toContain('codex login')
    })

    it('refuses an API key pasted into the subscription field', () => {
      expect(left(normalizeCredentialSecret('openai.oauth', 'sk-proj-abc123'))).toContain(
        'not a Codex login'
      )
    })
  })

  describe('claude.login', () => {
    it('accepts the base64 line the connect dialog tells operators to copy', () => {
      const stored = right(
        normalizeCredentialSecret('claude.login', toBase64(JSON.stringify(claudeLogin)))
      )
      expect(JSON.parse(stored)).toEqual({ claudeAiOauth: claudeLogin.claudeAiOauth })
    })

    it("drops everything but the Claude login — MCP tokens are not the seat's business", () => {
      const stored = right(normalizeCredentialSecret('claude.login', JSON.stringify(claudeLogin)))
      expect(JSON.parse(stored).mcpOAuth).toBeUndefined()
    })

    it('normalising is idempotent, so the browser may send what the server would store', () => {
      const once = right(normalizeCredentialSecret('claude.login', JSON.stringify(claudeLogin)))
      expect(right(normalizeCredentialSecret('claude.login', once))).toBe(once)
    })

    it('sends a setup-token paste to the kind that takes one', () => {
      const message = left(normalizeCredentialSecret('claude.login', 'sk-ant-oat01-abc'))
      expect(message).toContain('not a login')
      expect(message).toContain('Claude setup token')
    })

    /**
     * The machine this was written on: `claude auth status` reports a live
     * `claude.ai` session while the Keychain record holds only `mcpOAuth`,
     * because Claude Code is authenticated through the desktop app rather than
     * a saved OAuth login. Telling that operator "you are not signed in" sends
     * them to run a command they have already run.
     */
    it('names the real fix when the record holds only MCP tokens', () => {
      const mcpOnly = { mcpOAuth: claudeLogin.mcpOAuth }
      const message = left(normalizeCredentialSecret('claude.login', JSON.stringify(mcpOnly)))
      expect(message).toContain('no saved Claude login')
      expect(message).toContain('claude auth login')
      expect(message).toContain('setup-token')
    })

    it('refuses a record whose Claude login was never populated', () => {
      const emptied = { claudeAiOauth: { ...claudeLogin.claudeAiOauth, accessToken: '' } }
      const message = left(normalizeCredentialSecret('claude.login', JSON.stringify(emptied)))
      expect(message).toContain('login is empty')
      expect(message).toContain('claude auth login')
    })

    it('refuses a login with no refresh token, which would go stale within hours', () => {
      const stale = { claudeAiOauth: { ...claudeLogin.claudeAiOauth, refreshToken: '' } }
      expect(left(normalizeCredentialSecret('claude.login', JSON.stringify(stale)))).toContain(
        'no refresh token'
      )
    })

    it('never names a command the CLI does not have', () => {
      const messages = [
        left(normalizeCredentialSecret('claude.login', JSON.stringify({ mcpOAuth: {} }))),
        left(
          normalizeCredentialSecret(
            'claude.login',
            JSON.stringify({ claudeAiOauth: { accessToken: '' } })
          )
        ),
        left(
          normalizeCredentialSecret(
            'claude.login',
            JSON.stringify({ claudeAiOauth: { accessToken: 'a', refreshToken: '' } })
          )
        )
      ]
      // `claude /login` is a slash command inside a session, not a CLI command.
      for (const message of messages) expect(message).not.toContain('claude /login')
    })
  })

  describe('one-line kinds', () => {
    it('strips a shell assignment and its quotes', () => {
      expect(right(normalizeCredentialSecret('anthropic.api_key', 'export KEY="sk-ant-abc"'))).toBe(
        'sk-ant-abc'
      )
    })

    it('refuses a key with a line break in it', () => {
      expect(left(normalizeCredentialSecret('openai.api_key', 'sk-abc\ndef'))).toContain(
        'space or a line break'
      )
    })

    it('refuses a file pasted where the Claude token belongs', () => {
      expect(left(normalizeCredentialSecret('claude.oauth', JSON.stringify(codexLogin)))).toContain(
        'setup-token'
      )
    })

    it('keeps a generic secret as typed, minus the stray newline', () => {
      expect(right(normalizeCredentialSecret('generic.secret', ' hunter2 \n'))).toBe('hunter2')
    })
  })
})

describe('credentialSecretProblem', () => {
  it('says nothing about an empty field', () => {
    expect(credentialSecretProblem('openai.oauth', '   ')).toBeUndefined()
  })

  it('says nothing about a paste that would store', () => {
    expect(
      credentialSecretProblem('openai.oauth', toBase64(JSON.stringify(codexLogin)))
    ).toBeUndefined()
  })

  it('names the fix for a bad paste', () => {
    expect(credentialSecretProblem('openai.oauth', 'not a login')).toContain('command above')
  })
})
