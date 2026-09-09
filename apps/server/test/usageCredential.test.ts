/**
 * The read-only credential a seat probes with
 * (docs/build-plan-usage-limits.md, "The usage credential").
 *
 * A Claude seat runs on the bare `claude setup-token` value, which is
 * `user:inference` and gets a 401 from `/api/oauth/usage` forever. So the seat
 * carries a second credential for reading quota, and the two are kept apart on
 * purpose: neither list will accept the other's kind, and the usage one is
 * never injected into a runtime.
 *
 * Nothing here talks to a provider. `setUsageCredential` is a local write and
 * the page presses Check itself.
 */
import { layer } from '@effect/vitest'
import { RuntimeCredentialKinds, RuntimeUsageCredentialKinds } from '@taut/contract/domain'
import type { Subscription, VaultItemMeta } from '@taut/contract/domain'
import { Effect, Redacted } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { injectionFor } from '../src/services/vault.js'
import { makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const avatar = { kind: 'emoji', value: 'A' } as const
const SETUP_TOKEN = 'sk-ant-oat01-seat-000000000000000000000000'

/** What `claude /login` leaves behind, shortened; expiry far enough out to need no renewal. */
const CLAUDE_LOGIN = JSON.stringify({
  claudeAiOauth: {
    accessToken: 'sk-ant-oat01-usage-000000000000000000000',
    refreshToken: 'sk-ant-ort01-refresh-00000000000000000',
    expiresAt: Date.now() + 30 * 24 * 60 * 60 * 1000,
    scopes: ['user:inference', 'user:profile'],
    subscriptionType: 'max'
  },
  mcpOAuth: { 'some-server': { accessToken: 'not the seat trip business' } }
})

const state: {
  owner?: TestClient
  seat?: Subscription
  token?: VaultItemMeta
  login?: VaultItemMeta
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

describe('a seat usage credential', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('setup: a Claude seat on a setup-token, plus a login in the vault', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        yield* owner.api.companies.create({ payload: { slug: 'acme', name: 'Acme', avatar } })

        const token = yield* owner.api.vault.add({
          payload: {
            kind: 'claude.oauth',
            label: 'Thiago Claude',
            secret: Redacted.make(SETUP_TOKEN)
          }
        })
        const login = yield* owner.api.vault.add({
          payload: {
            kind: 'claude.login',
            label: 'Thiago Claude usage',
            secret: Redacted.make(CLAUDE_LOGIN)
          }
        })
        const seat = yield* owner.api.subscriptions.add({
          payload: {
            runtime: 'claude-code',
            label: 'Claude Code seat',
            credentialId: token.id
          }
        })

        expect(seat.usageCredentialId).toBeUndefined()
        Object.assign(state, { owner, seat, token, login })
      })
    )

    it.effect('injects a login as the same token variable a setup-token uses', () =>
      Effect.sync(() => {
        expect(injectionFor('claude.login')).toEqual({
          via: 'env',
          envVar: 'CLAUDE_CODE_OAUTH_TOKEN'
        })
        expect(injectionFor('claude.oauth')).toEqual({
          via: 'env',
          envVar: 'CLAUDE_CODE_OAUTH_TOKEN'
        })
        expect(RuntimeUsageCredentialKinds['claude-code']).toEqual(['claude.login'])
        // A login runs a seat as well as reading it, and is what the connect
        // dialog offers first; the setup-token stays accepted behind it.
        expect(RuntimeCredentialKinds['claude-code'][0]).toBe('claude.login')
      })
    )

    it.effect('attaches the login to the seat', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const seat = need(state.seat, 'seat')
        const login = need(state.login, 'login')
        const attached = yield* owner.api.subscriptions.setUsageCredential({
          path: { subscriptionId: seat.id },
          payload: { usageCredentialId: login.id }
        })
        expect(attached.usageCredentialId).toBe(login.id)
        // The seat still runs on its own token; only the reader changed.
        expect(attached.credentialId).toBe(need(state.token, 'token').id)
      })
    )

    it.effect('survives a round trip through the list', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const seat = need(state.seat, 'seat')
        const listed = yield* owner.api.subscriptions.list({ urlParams: {} })
        const found = listed.items.find((item) => item.id === seat.id)
        expect(found?.usageCredentialId).toBe(need(state.login, 'login').id)
      })
    )

    it.effect('refuses the setup-token as a usage credential — it cannot read usage', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const seat = need(state.seat, 'seat')
        const failure = yield* Effect.flip(
          owner.api.subscriptions.setUsageCredential({
            path: { subscriptionId: seat.id },
            payload: { usageCredentialId: need(state.token, 'token').id }
          })
        )
        expect(failure._tag).toBe('Validation')
      })
    )

    it.effect('takes a login as the seat credential — one paste runs it and reads it', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const both = yield* owner.api.subscriptions.add({
          payload: {
            runtime: 'claude-code',
            label: 'One paste',
            credentialId: need(state.login, 'login').id
          }
        })
        expect(both.credentialId).toBe(need(state.login, 'login').id)
        // Nothing to attach: the probe falls back to the seat's own credential.
        expect(both.usageCredentialId).toBeUndefined()
        yield* owner.api.subscriptions.remove({ path: { subscriptionId: both.id } })
      })
    )

    it.effect('says why a seat with no usage credential has no strip', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const seat = need(state.seat, 'seat')
        yield* owner.api.subscriptions.setUsageCredential({
          path: { subscriptionId: seat.id },
          payload: {}
        })
        const checked = yield* owner.api.subscriptions.check({
          path: { subscriptionId: seat.id }
        })
        expect(checked.limits).toEqual([])
        expect(checked.limitsError).toContain('no usage credential')
        expect(checked.limitsError).toContain('inference-only')
      })
    )

    it.effect('detaches back to nothing', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const seat = need(state.seat, 'seat')
        const detached = yield* owner.api.subscriptions.setUsageCredential({
          path: { subscriptionId: seat.id },
          payload: {}
        })
        expect(detached.usageCredentialId).toBeUndefined()
      })
    )
  })
})
