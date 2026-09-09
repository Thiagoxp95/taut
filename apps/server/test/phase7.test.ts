/**
 * Phase 7 / 1A (docs/build-plan-browser-vaults.md): `Agent.browserAccess` and the two vault
 * scopes (company items vs agent items) — the authorization table, `resolveForSpawn` /
 * `resolveForTool` / `listForAgent`, and the cascade when an agent is deleted.
 */
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Agent, Company, Department, VaultItemMeta } from '@taut/contract/domain'
import { AgentId } from '@taut/contract/ids'
import { Effect, Redacted, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Vault } from '../src/services/vault.js'
import { makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const avatar = { kind: 'emoji', value: 'A' } as const
const COMPANY_SECRET = 'sk-ant-api03-company-secret-000000000000'
const MILA_SECRET = 'figma-token-for-mila-only-1234'
const BRUNO_SECRET = 'github-pat-for-bruno-only-5678'

const state: {
  owner?: TestClient
  dana?: TestClient
  bob?: TestClient
  acme?: Company
  engineering?: Department
  design?: Department
  mila?: Agent
  bruno?: Agent
  companyItem?: VaultItemMeta
  milaItem?: VaultItemMeta
  brunoItem?: VaultItemMeta
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const CountRows = Schema.Array(Schema.Struct({ n: Schema.Number }))
const AuditRows = Schema.Array(Schema.Struct({ purpose: Schema.String, agent_id: Schema.String }))
const EventRows = Schema.Array(Schema.Struct({ type: Schema.String, payload_json: Schema.String }))

const agentPayload = (handle: string, departmentId: Department['id']) => ({
  handle,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  avatar,
  role: 'x',
  mandate: 'x',
  runtimeKind: 'claude-code' as const,
  permissionMode: 'plan' as const,
  departmentId
})

describe('phase 7 (browser access · agent vaults)', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('setup: owner (head of engineering), dana (head of design), plain member bob', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const me = yield* owner.api.auth.me()

        const invite = (email: string) =>
          owner.api.invites.create({ payload: { email, role: 'member' } })
        const dana = yield* makeClient
        const danaAccepted = yield* dana.api.invites.accept({
          payload: {
            token: (yield* invite('dana@taut.local')).token,
            name: 'Dana',
            password: 'password123'
          }
        })
        const bob = yield* makeClient
        yield* bob.api.invites.accept({
          payload: {
            token: (yield* invite('bob@taut.local')).token,
            name: 'Bob',
            password: 'password123'
          }
        })

        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const design = yield* owner.api.departments.create({
          payload: { name: 'Design', slug: 'design', headUserId: danaAccepted.user.id }
        })
        Object.assign(state, { owner, dana, bob, acme, engineering, design })
      })
    )

    // ── browser access ───────────────────────────────────────────────────────

    it.effect(
      'browserAccess: off by default; admin and department head may set it, a member may not',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const bob = need(state.bob, 'bob')
          const acme = need(state.acme, 'acme')
          const engineering = need(state.engineering, 'engineering')
          const design = need(state.design, 'design')
          const sql = yield* SqlClient.SqlClient

          // Admin creates with the flag on; absent = false.
          const bruno = yield* owner.api.agents.create({
            payload: { ...agentPayload('bruno', engineering.id), browserAccess: true }
          })
          expect(bruno.browserAccess).toBe(true)
          const quiet = yield* owner.api.agents.create({
            payload: agentPayload('quiet', engineering.id)
          })
          expect(quiet.browserAccess).toBe(false)

          // The head of design creates her own agent with it on.
          const mila = yield* dana.api.agents.create({
            payload: { ...agentPayload('mila', design.id), browserAccess: true }
          })
          expect(mila.browserAccess).toBe(true)

          // Head may toggle her agent; a plain member may not; a head may not touch another department's agent.
          const off = yield* dana.api.agents.update({
            path: { agentId: mila.id },
            payload: { browserAccess: false }
          })
          expect(off.browserAccess).toBe(false)
          const byBob = yield* Effect.flip(
            bob.api.agents.update({ path: { agentId: mila.id }, payload: { browserAccess: true } })
          )
          expect(byBob._tag).toBe('Forbidden')
          const wrongDept = yield* Effect.flip(
            dana.api.agents.update({
              path: { agentId: bruno.id },
              payload: { browserAccess: false }
            })
          )
          expect(wrongDept._tag).toBe('Forbidden')
          const on = yield* owner.api.agents.update({
            path: { agentId: mila.id },
            payload: { browserAccess: true }
          })
          expect(on.browserAccess).toBe(true)

          // A patch that does not mention it leaves it alone; `get` and `list` carry it.
          const renamed = yield* dana.api.agents.update({
            path: { agentId: mila.id },
            payload: { name: 'Mila B' }
          })
          expect(renamed.browserAccess).toBe(true)
          const detail = yield* bob.api.agents.get({ path: { agentId: mila.id } })
          expect(detail.agent.browserAccess).toBe(true)
          expect(Object.keys(detail)).toEqual(['agent', 'skills', 'fileGrants', 'repoGrants'])
          const listed = yield* bob.api.agents.list({ urlParams: {} })
          expect(listed.items.map((a) => [a.handle, a.browserAccess])).toEqual([
            ['bruno', true],
            ['quiet', false],
            ['mila', true]
          ])

          // `agent.created` / `agent.updated` payloads carry the flag.
          const events =
            yield* sql`SELECT type, payload_json FROM events WHERE company_id = ${acme.id} AND type IN ('agent.created', 'agent.updated') ORDER BY seq`.pipe(
              Effect.flatMap(Schema.decodeUnknown(EventRows))
            )
          const flags = events.map((e) => {
            const payload = JSON.parse(e.payload_json) as {
              agent: { handle: string; browserAccess: boolean }
            }
            return [e.type, payload.agent.handle, payload.agent.browserAccess] as const
          })
          expect(flags).toContainEqual(['agent.created', 'bruno', true])
          expect(flags).toContainEqual(['agent.created', 'quiet', false])
          expect(flags).toContainEqual(['agent.updated', 'mila', false])
          expect(flags.filter(([t, h]) => t === 'agent.updated' && h === 'mila').at(-1)).toEqual([
            'agent.updated',
            'mila',
            true
          ])

          Object.assign(state, { mila: on, bruno })
        })
    )

    // ── company vault (unchanged) ────────────────────────────────────────────

    it.effect('company vault: admin adds, any member lists, a member may not add', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dana = need(state.dana, 'dana')
        const bob = need(state.bob, 'bob')

        const denied = yield* Effect.flip(
          dana.api.vault.add({
            payload: {
              kind: 'generic.secret',
              label: 'nope',
              secret: Redacted.make(COMPANY_SECRET)
            }
          })
        )
        expect(denied._tag).toBe('Forbidden')

        const item = yield* owner.api.vault.add({
          payload: {
            kind: 'anthropic.api_key',
            label: 'Acme Anthropic key',
            secret: Redacted.make(COMPANY_SECRET)
          }
        })
        expect(item.agentId).toBeUndefined()
        expect(item.hint).toBe(COMPANY_SECRET.slice(-4))
        expect(JSON.stringify(item)).not.toContain(COMPANY_SECRET)

        const listed = yield* bob.api.vault.list({ urlParams: {} })
        expect(listed.items.map((i) => i.id)).toEqual([item.id])
        state.companyItem = item
      })
    )

    // ── agent vault ──────────────────────────────────────────────────────────

    it.effect(
      'agent vault add: head of the department or admin; a member or another head is Forbidden; unknown agent is NotFound',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const bob = need(state.bob, 'bob')
          const acme = need(state.acme, 'acme')
          const mila = need(state.mila, 'mila')
          const bruno = need(state.bruno, 'bruno')
          const sql = yield* SqlClient.SqlClient

          const add = (client: TestClient, agentId: AgentId, label: string, secret: string) =>
            client.api.vault.add({
              payload: { kind: 'generic.secret', label, secret: Redacted.make(secret), agentId }
            })

          // dana heads design → mila's vault is hers to fill.
          const milaItem = yield* add(dana, mila.id, 'Figma token', MILA_SECRET)
          expect(milaItem.agentId).toBe(mila.id)
          expect(milaItem.companyId).toBe(acme.id)
          expect(milaItem.hint).toBe(MILA_SECRET.slice(-4))
          expect(JSON.stringify(milaItem)).not.toContain(MILA_SECRET)

          // bob is a plain member; dana does not head engineering.
          expect((yield* Effect.flip(add(bob, mila.id, 'x', 'x-secret-1')))._tag).toBe('Forbidden')
          expect((yield* Effect.flip(add(dana, bruno.id, 'x', 'x-secret-2')))._tag).toBe(
            'Forbidden'
          )

          // Admin may fill any agent's vault; an unknown agent is NotFound (not Forbidden).
          const brunoItem = yield* add(owner, bruno.id, 'GitHub PAT', BRUNO_SECRET)
          expect(brunoItem.agentId).toBe(bruno.id)
          const missing = yield* Effect.flip(
            add(owner, AgentId.make('agt_missing'), 'x', 'x-secret-3')
          )
          expect(missing._tag).toBe('NotFound')

          // Rows carry the scope; the event carries the meta (with `agentId`), never the secret.
          const rows =
            yield* sql`SELECT COUNT(*) AS n FROM vault_items WHERE company_id = ${acme.id} AND agent_id IS NOT NULL`.pipe(
              Effect.flatMap(Schema.decodeUnknown(CountRows))
            )
          expect(need(rows[0], 'count').n).toBe(2)
          const events =
            yield* sql`SELECT type, payload_json FROM events WHERE company_id = ${acme.id} AND type = 'vault.item.created' ORDER BY seq`.pipe(
              Effect.flatMap(Schema.decodeUnknown(EventRows))
            )
          const scopes = events.map(
            (e) => (JSON.parse(e.payload_json) as { item: { agentId?: string } }).item.agentId
          )
          expect(scopes).toEqual([undefined, mila.id, bruno.id])
          for (const e of events) {
            expect(e.payload_json).not.toContain(MILA_SECRET)
            expect(e.payload_json).not.toContain(BRUNO_SECRET)
          }

          Object.assign(state, { milaItem, brunoItem })
        })
    )

    it.effect(
      "vault.list: company list excludes agent items; ?agentId lists only that agent's items for its managers",
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const bob = need(state.bob, 'bob')
          const mila = need(state.mila, 'mila')
          const bruno = need(state.bruno, 'bruno')
          const companyItem = need(state.companyItem, 'companyItem')
          const milaItem = need(state.milaItem, 'milaItem')
          const brunoItem = need(state.brunoItem, 'brunoItem')

          // Company scope: every member, company items only.
          for (const client of [owner, dana, bob]) {
            const company = yield* client.api.vault.list({ urlParams: {} })
            expect(company.items.map((i) => i.id)).toEqual([companyItem.id])
          }

          // Agent scope: only that agent's items, only for admin+ or the head of its department.
          const byHead = yield* dana.api.vault.list({ urlParams: { agentId: mila.id } })
          expect(byHead.items.map((i) => i.id)).toEqual([milaItem.id])
          const byAdmin = yield* owner.api.vault.list({ urlParams: { agentId: bruno.id } })
          expect(byAdmin.items.map((i) => i.id)).toEqual([brunoItem.id])
          const adminOnMila = yield* owner.api.vault.list({ urlParams: { agentId: mila.id } })
          expect(adminOnMila.items.map((i) => i.id)).toEqual([milaItem.id])

          const byMember = yield* Effect.flip(
            bob.api.vault.list({ urlParams: { agentId: mila.id } })
          )
          expect(byMember._tag).toBe('Forbidden')
          const otherHead = yield* Effect.flip(
            dana.api.vault.list({ urlParams: { agentId: bruno.id } })
          )
          expect(otherHead._tag).toBe('Forbidden')
          const unknown = yield* Effect.flip(
            owner.api.vault.list({ urlParams: { agentId: AgentId.make('agt_missing') } })
          )
          expect(unknown._tag).toBe('NotFound')
        })
    )

    // ── resolve (server-internal) ────────────────────────────────────────────

    it.effect(
      'resolveForSpawn / resolveForTool: company item for any agent; agent item only for its agent; listForAgent',
      () =>
        Effect.gen(function* () {
          const acme = need(state.acme, 'acme')
          const mila = need(state.mila, 'mila')
          const bruno = need(state.bruno, 'bruno')
          const companyItem = need(state.companyItem, 'companyItem')
          const milaItem = need(state.milaItem, 'milaItem')
          const brunoItem = need(state.brunoItem, 'brunoItem')
          const vault = yield* Vault
          const sql = yield* SqlClient.SqlClient

          // Company item: every agent of the company.
          for (const agent of [mila, bruno]) {
            const resolved = yield* vault.resolveForSpawn(companyItem.id, agent.id)
            expect(Redacted.value(resolved.secret)).toBe(COMPANY_SECRET)
            expect(resolved.injection).toEqual({ via: 'env', envVar: 'ANTHROPIC_API_KEY' })
          }

          // Agent item: its agent only.
          const own = yield* vault.resolveForSpawn(milaItem.id, mila.id)
          expect(Redacted.value(own.secret)).toBe(MILA_SECRET)
          expect(own.injection).toEqual({ via: 'none' })
          expect(own.item.lastUsedBy).toBe(mila.id)
          const foreign = yield* Effect.flip(vault.resolveForSpawn(milaItem.id, bruno.id))
          expect(foreign._tag).toBe('Forbidden')
          const foreignTool = yield* Effect.flip(vault.resolveForTool(brunoItem.id, mila.id))
          expect(foreignTool._tag).toBe('Forbidden')
          const gone = yield* Effect.flip(
            vault.resolveForSpawn(milaItem.id, AgentId.make('agt_missing'))
          )
          expect(gone._tag).toBe('NotFound')

          // `vault_get` path: same rule, audited as `tool`.
          const viaTool = yield* vault.resolveForTool(milaItem.id, mila.id)
          expect(Redacted.value(viaTool.secret)).toBe(MILA_SECRET)

          const audits =
            yield* sql`SELECT purpose, agent_id FROM audit_log WHERE company_id = ${acme.id} AND vault_item_id = ${milaItem.id} ORDER BY at, rowid`.pipe(
              Effect.flatMap(Schema.decodeUnknown(AuditRows))
            )
          expect(audits).toEqual([
            { purpose: 'spawn', agent_id: mila.id },
            { purpose: 'tool', agent_id: mila.id }
          ])
          const denied =
            yield* sql`SELECT COUNT(*) AS n FROM audit_log WHERE company_id = ${acme.id} AND vault_item_id = ${milaItem.id} AND agent_id = ${bruno.id}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(CountRows))
            )
          expect(need(denied[0], 'count').n).toBe(0)

          // What the agent-runtime `vault_list` will show: company items + its own, nothing else.
          const forMila = yield* vault.listForAgent(mila.id)
          expect(forMila.map((i) => i.id)).toEqual([companyItem.id, milaItem.id])
          expect(JSON.stringify(forMila)).not.toContain(MILA_SECRET)
          const forBruno = yield* vault.listForAgent(bruno.id)
          expect(forBruno.map((i) => i.id)).toEqual([companyItem.id, brunoItem.id])
          const forNobody = yield* Effect.flip(vault.listForAgent(AgentId.make('agt_missing')))
          expect(forNobody._tag).toBe('NotFound')
        })
    )

    // ── revoke + cascade ─────────────────────────────────────────────────────

    it.effect('vault.revoke follows the stored scope; archiving an agent keeps its items', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dana = need(state.dana, 'dana')
        const bob = need(state.bob, 'bob')
        const acme = need(state.acme, 'acme')
        const mila = need(state.mila, 'mila')
        const bruno = need(state.bruno, 'bruno')
        const companyItem = need(state.companyItem, 'companyItem')
        const milaItem = need(state.milaItem, 'milaItem')
        const brunoItem = need(state.brunoItem, 'brunoItem')
        const sql = yield* SqlClient.SqlClient

        const revoke = (client: TestClient, item: VaultItemMeta) =>
          client.api.vault.revoke({ path: { vaultItemId: item.id } })

        expect((yield* Effect.flip(revoke(bob, milaItem)))._tag).toBe('Forbidden')
        expect((yield* Effect.flip(revoke(dana, brunoItem)))._tag).toBe('Forbidden')
        expect((yield* Effect.flip(revoke(dana, companyItem)))._tag).toBe('Forbidden')
        yield* revoke(dana, milaItem)
        expect((yield* Effect.flip(revoke(dana, milaItem)))._tag).toBe('NotFound')
        expect((yield* dana.api.vault.list({ urlParams: { agentId: mila.id } })).items).toEqual([])

        // Archiving bruno keeps his credentials: unarchiving him has to give back a working
        // agent, and nothing else can read them meanwhile.
        yield* owner.api.agents.delete({ path: { agentId: bruno.id } })
        const left =
          yield* sql`SELECT COUNT(*) AS n FROM vault_items WHERE company_id = ${acme.id} AND id = ${brunoItem.id}`.pipe(
            Effect.flatMap(Schema.decodeUnknown(CountRows))
          )
        expect(need(left[0], 'count').n).toBe(1)
        expect(
          (yield* owner.api.vault.list({ urlParams: { agentId: bruno.id } })).items.map((i) => i.id)
        ).toEqual([brunoItem.id])
        const company = yield* bob.api.vault.list({ urlParams: {} })
        expect(company.items.map((i) => i.id)).toEqual([companyItem.id])
      })
    )
  })
})
