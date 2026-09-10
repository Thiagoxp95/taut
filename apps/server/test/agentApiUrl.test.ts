import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import { Effect, Redacted } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { makeClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

for (const internal of [true, false]) {
  const dir = makeTempDir()
  afterAll(() => removeDir(dir))
  const fake = makeFakeRuntime()
  describe(internal ? 'agent API URL override' : 'public URL callback fallback', () => {
    layer(
      testAppWith(dir, fake.layer, {
        TAUT_PUBLIC_URL: 'https://taut.example.com/',
        ...(internal ? { TAUT_AGENT_API_URL: 'http://taut-api:3000/' } : {})
      })
    )('runtime callback', (it) => {
      it.effect('writes the reachable API address into the agent MCP configuration', () =>
        Effect.gen(function* () {
          const owner = yield* makeClient
          const avatar = { kind: 'emoji', value: 'A' } as const
          yield* owner.api.auth.signup({
            payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
          })
          yield* owner.api.companies.create({
            payload: { slug: 'callback', name: 'Callback', avatar }
          })
          const me = yield* owner.api.auth.me()
          const department = yield* owner.api.departments.create({
            payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
          })
          const credential = yield* owner.api.vault.add({
            payload: {
              kind: 'anthropic.api_key',
              label: 'Test',
              secret: Redacted.make('test-secret')
            }
          })
          const seat = yield* owner.api.subscriptions.add({
            payload: { runtime: 'claude-code', label: 'Test', credentialId: credential.id }
          })
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${seat.id}`
          const agent = yield* owner.api.agents.create({
            payload: {
              handle: 'worker',
              name: 'Worker',
              avatar,
              role: 'Engineer',
              mandate: 'Answer briefly.',
              runtimeKind: 'claude-code',
              permissionMode: 'plan',
              departmentId: department.id
            }
          })
          const dm = yield* owner.api.channels.dm({
            payload: { memberKind: 'agent', memberId: agent.id }
          })
          yield* owner.api.messages.create({
            payload: { channelId: dm.id, body: 'reply with pong' }
          })
          for (let i = 0; i < 100 && fake.mcpConfigs().length === 0; i++)
            yield* Effect.sleep('50 millis')
          expect(fake.mcpConfigs()[0]?.url).toBe(
            internal ? 'http://taut-api:3000' : 'https://taut.example.com'
          )
        })
      )
    })
  })
}
