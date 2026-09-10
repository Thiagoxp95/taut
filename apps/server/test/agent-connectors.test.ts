import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { ConnectorInput } from '@taut/contract/api'
import { Effect, Either, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Agents } from '../src/services/agents.js'
import { decryptToString } from '../src/vault/crypto.js'
import { makeClient } from './_client.js'
import { makeTempDir, removeDir, TEST_MASTER_KEY_BYTES, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const
const payload = {
  handle: 'connector-agent',
  name: 'Connector agent',
  avatar,
  role: '',
  mandate: '',
  runtimeKind: 'claude-code',
  permissionMode: 'plan'
} as const
const connector = {
  name: 'Internal tools',
  url: 'http://localhost:4010/mcp',
  headers: { Authorization: 'Bearer connector-secret' }
}
const setup = Effect.gen(function* () {
  const owner = yield* makeClient
  const suffix = crypto.randomUUID()
  yield* owner.api.auth.signup({
    payload: { email: `${suffix}@taut.local`, password: 'password123', name: 'Owner' }
  })
  const company = yield* owner.api.companies.create({
    payload: { slug: `c-${suffix}`, name: 'Company', avatar }
  })
  return { owner, company }
})

describe('per-agent connectors', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('connector changes invalidate resumable sessions and publish agent updates', () =>
      Effect.gen(function* () {
        const { owner, company } = yield* setup
        const agent = yield* owner.api.agents.create({ payload })
        const dm = yield* owner.api.channels.dm({
          payload: { memberKind: 'agent', memberId: agent.id }
        })
        const sql = yield* SqlClient.SqlClient
        const threadId = `msg_${crypto.randomUUID()}`
        yield* sql`INSERT INTO messages (id, company_id, channel_id, author_kind, author_id, body, status, created_at)
          VALUES (${threadId}, ${company.id}, ${dm.id}, 'agent', ${agent.id}, 'root', 'sent', '2026-01-01T00:00:00.000Z')`
        const seedSession = sql`INSERT INTO agent_sessions (agent_id, thread_id, channel_id, runtime, session_id, updated_at)
          VALUES (${agent.id}, ${threadId}, ${dm.id}, 'claude-code', 'stale-session', '2026-01-01T00:00:00.000Z')`
        yield* seedSession
        const added = yield* owner.api.agents.addConnector({
          path: { agentId: agent.id },
          payload: connector
        })
        expect(yield* sql`SELECT * FROM agent_sessions WHERE agent_id = ${agent.id}`).toEqual([])
        yield* seedSession
        yield* owner.api.agents.updateConnector({
          path: { agentId: agent.id, connectorId: added.id },
          payload: connector
        })
        expect(yield* sql`SELECT * FROM agent_sessions WHERE agent_id = ${agent.id}`).toEqual([])
        yield* seedSession
        yield* owner.api.agents.removeConnector({
          path: { agentId: agent.id, connectorId: added.id }
        })
        expect(yield* sql`SELECT * FROM agent_sessions WHERE agent_id = ${agent.id}`).toEqual([])
        const updates =
          yield* sql`SELECT payload_json FROM events WHERE company_id = ${company.id} AND type = 'agent.updated'`
        expect(updates).toHaveLength(3)
        expect(JSON.stringify(updates)).not.toContain('connector-secret')
      })
    )
    it.effect(
      'existing agents have no connectors; configured secrets stay encrypted and out of public metadata',
      () =>
        Effect.gen(function* () {
          const { owner, company } = yield* setup
          const agent = yield* owner.api.agents.create({ payload })
          expect((yield* owner.api.agents.get({ path: { agentId: agent.id } })).connectors).toEqual(
            []
          )
          const added = yield* owner.api.agents.addConnector({
            path: { agentId: agent.id },
            payload: connector
          })
          expect(added).toMatchObject({
            name: 'Internal tools',
            url: connector.url,
            headerNames: ['Authorization']
          })
          const detail = yield* owner.api.agents.get({ path: { agentId: agent.id } })
          expect(detail.connectors).toEqual([added])
          expect(JSON.stringify(detail)).not.toContain('connector-secret')
          const sql = yield* SqlClient.SqlClient
          const rows =
            yield* sql`SELECT headers_ciphertext FROM agent_connectors WHERE id = ${added.id}`.pipe(
              Effect.flatMap(
                Schema.decodeUnknown(
                  Schema.Array(Schema.Struct({ headers_ciphertext: Schema.Uint8ArrayFromSelf }))
                )
              )
            )
          const bytes = rows[0]!.headers_ciphertext
          expect(Buffer.from(bytes).toString()).not.toContain('connector-secret')
          expect(
            Either.getOrThrow(
              decryptToString(TEST_MASTER_KEY_BYTES, company.id, bytes, {
                aad: Buffer.from(added.id)
              })
            )
          ).toBe(JSON.stringify(connector.headers))
          expect(
            Either.isLeft(
              decryptToString(TEST_MASTER_KEY_BYTES, 'other-company', bytes, {
                aad: Buffer.from(added.id)
              })
            )
          ).toBe(true)
          const agents = yield* Agents
          expect(Object.values(yield* agents.connectorsForRuntime(agent.id))).toEqual([
            { url: connector.url, headers: connector.headers }
          ])
          const events =
            yield* sql`SELECT payload_json FROM events WHERE company_id = ${company.id}`
          expect(JSON.stringify(events)).not.toContain('connector-secret')
        })
    )

    it.effect(
      'creates connectors with an agent, preserves omitted headers, replaces or clears explicitly, and removes',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* setup
          const agent = yield* owner.api.agents.create({
            payload: { ...payload, connectors: [connector] }
          })
          const added = (yield* owner.api.agents.get({ path: { agentId: agent.id } }))
            .connectors[0]!
          const path = { agentId: agent.id, connectorId: added.id }
          const agents = yield* Agents
          yield* owner.api.agents.updateConnector({
            path,
            payload: { name: 'Renamed', url: 'https://example.com/mcp' }
          })
          expect(Object.values(yield* agents.connectorsForRuntime(agent.id))).toEqual([
            { url: 'https://example.com/mcp', headers: connector.headers }
          ])
          yield* owner.api.agents.updateConnector({
            path,
            payload: { ...connector, headers: { 'X-API-Key': 'replacement' } }
          })
          expect(Object.values(yield* agents.connectorsForRuntime(agent.id))[0]?.headers).toEqual({
            'X-API-Key': 'replacement'
          })
          yield* owner.api.agents.updateConnector({ path, payload: { ...connector, headers: {} } })
          expect(Object.values(yield* agents.connectorsForRuntime(agent.id))[0]?.headers).toEqual(
            {}
          )
          yield* owner.api.agents.removeConnector({ path })
          expect((yield* owner.api.agents.get({ path: { agentId: agent.id } })).connectors).toEqual(
            []
          )
          expect(yield* agents.connectorsForRuntime(agent.id)).toEqual({})
        })
    )

    it.effect('rejects members and cross-company access to connector mutations', () =>
      Effect.gen(function* () {
        const { owner } = yield* setup
        const agent = yield* owner.api.agents.create({
          payload: { ...payload, connectors: [connector] }
        })
        const added = (yield* owner.api.agents.get({ path: { agentId: agent.id } })).connectors[0]!
        const sibling = yield* owner.api.agents.create({
          payload: { ...payload, handle: 'sibling-agent' }
        })
        const agents = yield* Agents
        expect(yield* agents.connectorsForRuntime(sibling.id)).toEqual({})
        expect(
          (yield* Effect.flip(
            owner.api.agents.updateConnector({
              path: { agentId: sibling.id, connectorId: added.id },
              payload: connector
            })
          ))._tag
        ).toBe('NotFound')
        expect(
          (yield* Effect.flip(
            owner.api.agents.removeConnector({
              path: { agentId: sibling.id, connectorId: added.id }
            })
          ))._tag
        ).toBe('NotFound')
        const invite = yield* owner.api.invites.create({
          payload: { email: `${crypto.randomUUID()}@taut.local`, role: 'member' }
        })
        const member = yield* makeClient
        yield* member.api.invites.accept({
          payload: { token: invite.token, name: 'Member', password: 'password123' }
        })
        const { owner: outsider } = yield* setup
        for (const [client, tag] of [
          [member, 'Forbidden'],
          [outsider, 'NotFound']
        ] as const) {
          expect(
            (yield* Effect.flip(
              client.api.agents.addConnector({ path: { agentId: agent.id }, payload: connector })
            ))._tag
          ).toBe(tag)
          expect(
            (yield* Effect.flip(
              client.api.agents.updateConnector({
                path: { agentId: agent.id, connectorId: added.id },
                payload: connector
              })
            ))._tag
          ).toBe(tag)
          expect(
            (yield* Effect.flip(
              client.api.agents.removeConnector({
                path: { agentId: agent.id, connectorId: added.id }
              })
            ))._tag
          ).toBe(tag)
        }
      })
    )

    it.effect(
      'rejects unsafe URLs and malformed headers, and rolls back invalid agent creation',
      () =>
        Effect.gen(function* () {
          const { owner } = yield* setup
          const agent = yield* owner.api.agents.create({ payload })
          const invalidInputs: ReadonlyArray<ConnectorInput> = [
            { ...connector, url: 'file:///etc/passwd' },
            { ...connector, url: 'https://user:secret@example.com/mcp' },
            { ...connector, url: 'https://example.com/mcp?token=secret' },
            { ...connector, url: 'https://example.com/mcp#secret' },
            { ...connector, headers: { 'Bad Header': 'value' } },
            { ...connector, headers: { Authorization: 'value\r\nInjected: header' } },
            { ...connector, headers: { Authorization: 'one', authorization: 'two' } }
          ]
          for (const bad of invalidInputs) {
            expect(
              (yield* Effect.flip(
                owner.api.agents.addConnector({ path: { agentId: agent.id }, payload: bad })
              ))._tag
            ).toBe('Validation')
          }
          expect(
            (yield* Effect.flip(
              owner.api.agents.create({
                payload: {
                  ...payload,
                  handle: 'invalid-agent',
                  connectors: [connector, { ...connector, url: 'bad-url' }]
                }
              })
            ))._tag
          ).toBe('Validation')
          const listed = yield* owner.api.agents.list({ urlParams: {} })
          expect(listed.items.map((a) => a.handle)).toEqual(['connector-agent'])
          expect((yield* owner.api.agents.get({ path: { agentId: agent.id } })).connectors).toEqual(
            []
          )
        })
    )
  })
})
