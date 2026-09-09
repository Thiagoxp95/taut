/**
 * Phase 7 / 2A (docs/build-plan-browser-vaults.md): the task-time wiring against the fake
 * machine provider — the `browser` MCP server + allow-list when `agent.browserAccess`, the
 * agent-runtime `vault_list` / `vault_get` endpoints, and the per-task redactor that masks a
 * secret fetched mid-task out of everything the task prints afterwards.
 */
import { HttpClient, HttpClientRequest } from '@effect/platform'
import { NodeHttpClient } from '@effect/platform-node'
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type {
  Agent,
  Channel,
  Company,
  Department,
  Task,
  VaultItemMeta
} from '@taut/contract/domain'
import type { AgentId, MessageId, TaskId } from '@taut/contract/ids'
import { Duration, Effect, Option, Redacted, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { TaskRunner } from '../src/agents/runTask.js'
import { Scheduler } from '../src/agents/scheduler.js'
import { Messages } from '../src/services/messages.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const fake = makeFakeRuntime()
const avatar = { kind: 'emoji', value: 'A' } as const
const SEAT_SECRET = 'sk-ant-api03-seat-secret-0000000000000000'
const COMPANY_SECRET = 'company-shared-token-abcdef123456'
const VERA_SECRET = 'vera-figma-token-9f8e7d6c5b4a'
const BRUNO_SECRET = 'bruno-github-pat-1a2b3c4d5e6f'
const PORTAL_SECRET = 'acme-portal-pw-77zz'
const ROTATED_SECRET = 'acme-portal-pw-88yy'

const state: {
  owner?: TestClient
  dana?: TestClient
  acme?: Company
  engineering?: Department
  design?: Department
  vera?: Agent
  bruno?: Agent
  veraDm?: Channel
  brunoDm?: Channel
  seatItem?: VaultItemMeta
  companyItem?: VaultItemMeta
  veraItem?: VaultItemMeta
  brunoItem?: VaultItemMeta
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const AuditRows = Schema.Array(
  Schema.Struct({
    purpose: Schema.String,
    agent_id: Schema.NullOr(Schema.String),
    task_id: Schema.NullOr(Schema.String)
  })
)
const EventRows = Schema.Array(Schema.Struct({ type: Schema.String, payload_json: Schema.String }))
const OwnerRows = Schema.Array(Schema.Struct({ agent_id: Schema.NullOr(Schema.String) }))
const SurvivorRows = Schema.Array(
  Schema.Struct({
    id: Schema.String,
    label: Schema.String,
    agent_id: Schema.NullOr(Schema.String)
  })
)

const waitFor = <A, E, R>(
  what: string,
  probe: Effect.Effect<Option.Option<A>, E, R>,
  timeoutMs = 10_000
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const found = yield* probe
      if (Option.isSome(found)) return found.value
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
      yield* Effect.sleep(Duration.millis(50))
    }
  })

const taskFor = (agentId: AgentId, triggerId: string) =>
  Effect.gen(function* () {
    const scheduler = yield* Scheduler
    const acme = need(state.acme, 'acme')
    return yield* scheduler.taskOf(acme.id, agentId, triggerId as Task['messageId'])
  })

const taskWith = (agentId: AgentId, triggerId: string, status: Task['status']) =>
  waitFor(
    `task of ${triggerId} to be ${status}`,
    taskFor(agentId, triggerId).pipe(Effect.map(Option.filter((t) => t.status === status)))
  )

const replyOf = (task: Task) =>
  Effect.gen(function* () {
    const messages = yield* Messages
    const acme = need(state.acme, 'acme')
    return yield* messages.byId(acme.id, task.messageId).pipe(Effect.map(Option.getOrThrow))
  })

/** Raw call to `/api/agent-runtime/*` with a bearer token. */
const runtimeCall = (token: string, method: 'GET' | 'POST', path: string, body?: unknown) =>
  Effect.gen(function* () {
    const { http } = yield* baseUrl
    const client = yield* HttpClient.HttpClient
    const url = `${http}/api/agent-runtime${path}`
    const request =
      method === 'GET'
        ? HttpClientRequest.get(url)
        : yield* HttpClientRequest.post(url).pipe(HttpClientRequest.bodyJson(body ?? {}))
    const response = yield* client.execute(
      request.pipe(HttpClientRequest.setHeader('authorization', `Bearer ${token}`))
    )
    const json = (yield* response.json) as Record<string, unknown>
    return { status: response.status, json }
  }).pipe(Effect.scoped, Effect.provide(NodeHttpClient.layer))

const mcpConfigOf = (taskId: TaskId) =>
  need(
    fake.mcpConfigs().find((c) => c.taskId === taskId),
    `mcp config of ${taskId}`
  )

/** The work dir is the thread's, not the task's (docs/build-plan-sessions.md D3). */
const claudeMdOf = (threadId: MessageId) =>
  need(
    [...fake.files.entries()].find(([p]) => p.endsWith(`/work/${threadId}/CLAUDE.md`)),
    `CLAUDE.md of ${threadId}`
  )[1]

const agentPayload = (handle: string, departmentId: Department['id']) => ({
  handle,
  name: handle[0]!.toUpperCase() + handle.slice(1),
  avatar,
  role: 'x',
  mandate: '# Mandate\n\nAnswer briefly.',
  runtimeKind: 'claude-code' as const,
  permissionMode: 'plan' as const,
  departmentId
})

describe('phase 7b (browser MCP wiring · agent-runtime vault_list / vault_get · mid-task redaction)', () => {
  layer(testAppWith(dir, fake.layer), { excludeTestServices: true })((it) => {
    it.effect(
      'setup: seat, vera (design, browser on) and bruno (engineering, browser off), company + agent items',
      () =>
        Effect.gen(function* () {
          const owner = yield* makeClient
          yield* owner.api.auth.signup({
            payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
          })
          const acme = yield* owner.api.companies.create({
            payload: { slug: 'acme', name: 'Acme', avatar }
          })
          const me = yield* owner.api.auth.me()
          const invite = yield* owner.api.invites.create({
            payload: { email: 'dana@taut.local', role: 'member' }
          })
          const dana = yield* makeClient
          const accepted = yield* dana.api.invites.accept({
            payload: { token: invite.token, name: 'Dana', password: 'password123' }
          })
          const engineering = yield* owner.api.departments.create({
            payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
          })
          const design = yield* owner.api.departments.create({
            payload: { name: 'Design', slug: 'design', headUserId: accepted.user.id }
          })

          const seatItem = yield* owner.api.vault.add({
            payload: {
              kind: 'anthropic.api_key',
              label: 'seat',
              secret: Redacted.make(SEAT_SECRET)
            }
          })
          const seat = yield* owner.api.subscriptions.add({
            payload: { runtime: 'claude-code', label: 'Seat', credentialId: seatItem.id }
          })
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${seat.id}`

          const vera = yield* dana.api.agents.create({
            payload: { ...agentPayload('vera', design.id), browserAccess: true }
          })
          expect(vera.browserAccess).toBe(true)
          const bruno = yield* owner.api.agents.create({
            payload: agentPayload('bruno', engineering.id)
          })
          expect(bruno.browserAccess).toBe(false)

          const companyItem = yield* owner.api.vault.add({
            payload: {
              kind: 'generic.secret',
              label: 'Shared token',
              secret: Redacted.make(COMPANY_SECRET)
            }
          })
          const veraItem = yield* dana.api.vault.add({
            payload: {
              kind: 'generic.secret',
              label: 'Figma token',
              secret: Redacted.make(VERA_SECRET),
              agentId: vera.id
            }
          })
          const brunoItem = yield* owner.api.vault.add({
            payload: {
              kind: 'generic.secret',
              label: 'GitHub PAT',
              secret: Redacted.make(BRUNO_SECRET),
              agentId: bruno.id
            }
          })

          const veraDm = yield* owner.api.channels.dm({
            payload: { memberKind: 'agent', memberId: vera.id }
          })
          const brunoDm = yield* owner.api.channels.dm({
            payload: { memberKind: 'agent', memberId: bruno.id }
          })
          Object.assign(state, {
            owner,
            dana,
            acme,
            engineering,
            design,
            vera,
            bruno,
            veraDm,
            brunoDm,
            seatItem,
            companyItem,
            veraItem,
            brunoItem
          })
        })
    )

    // ── browser wiring ───────────────────────────────────────────────────────

    it.effect(
      'browserAccess on: mcp.json carries the `browser` server, claude gets both allow-list patterns, CLAUDE.md says so',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const vera = need(state.vera, 'vera')
          const dm = need(state.veraDm, 'vera dm')
          const before = fake.execs.length
          const trigger = yield* owner.api.messages.create({
            payload: { channelId: dm.id, body: 'reply with exactly: pong' }
          })
          const task = yield* taskWith(vera.id, trigger.id, 'done')
          expect((yield* replyOf(task)).body).toBe('pong')

          const exec = need(fake.execs[before], 'exec')
          const at = exec.cmd.indexOf('--allowedTools')
          expect(at).toBeGreaterThan(0)
          // Browser access also opens claude's own web tools: an agent denied `WebSearch`
          // reports having no web at all instead of falling back to `mcp__browser__*`.
          expect(exec.cmd.slice(at, at + 5)).toEqual([
            '--allowedTools',
            'mcp__taut__*',
            'mcp__browser__*',
            'WebSearch',
            'WebFetch'
          ])

          const mcp = mcpConfigOf(task.id)
          expect(mcp.servers).toEqual(['taut', 'browser'])
          const browser = need(mcp.browser, 'browser server')
          // Fake provider is `local`: node + @playwright/mcp's cli.js, profile under the agent home.
          expect(browser.command).toBe('node')
          expect(browser.args[0]).toMatch(/@playwright[\\/]mcp[\\/]cli\.js$/)
          expect(browser.args).toContain('--headless')
          expect(browser.args).not.toContain('--no-sandbox')
          const home = exec.cwd?.replace(/\/work\/[^/]+$/, '') ?? ''
          expect(home.length).toBeGreaterThan(0)
          expect(browser.args).toContain(`${home}/.taut/browser/profile`)
          expect(browser.args).toContain(`${home}/.taut/browser/out`)
          expect(browser.env?.['PLAYWRIGHT_BROWSERS_PATH']).toBeDefined()

          const claudeMd = claudeMdOf(task.threadId)
          expect(claudeMd).toContain('mcp__browser__*')
          expect(claudeMd).toContain(`${home}/.taut/browser/out`)
          expect(claudeMd).toContain('vault_get')
        })
    )

    it.effect(
      'browserAccess off: no `browser` server, only `mcp__taut__*`, nothing else changes',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const bruno = need(state.bruno, 'bruno')
          const dm = need(state.brunoDm, 'bruno dm')
          const before = fake.execs.length
          const trigger = yield* owner.api.messages.create({
            payload: { channelId: dm.id, body: 'reply with exactly: pong' }
          })
          const task = yield* taskWith(bruno.id, trigger.id, 'done')
          expect((yield* replyOf(task)).body).toBe('pong')

          const exec = need(fake.execs[before], 'exec')
          const at = exec.cmd.indexOf('--allowedTools')
          expect(exec.cmd.slice(at, at + 2)).toEqual(['--allowedTools', 'mcp__taut__*'])
          expect(exec.cmd).not.toContain('mcp__browser__*')

          const mcp = mcpConfigOf(task.id)
          expect(mcp.servers).toEqual(['taut'])
          expect(mcp.browser).toBeUndefined()
          expect(JSON.stringify(mcp)).not.toContain('playwright')

          const claudeMd = claudeMdOf(task.threadId)
          expect(claudeMd).not.toContain('mcp__browser__*')
          expect(claudeMd).not.toContain('browser')
          expect(claudeMd).toContain('vault_get')
        })
    )

    // ── vault endpoints + redaction ──────────────────────────────────────────

    it.effect(
      'vault_list / vault_get from a running task: own + company items, 403 on another agent, audit `tool`, secret masked afterwards',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const vera = need(state.vera, 'vera')
          const dm = need(state.veraDm, 'vera dm')
          const seatItem = need(state.seatItem, 'seat item')
          const companyItem = need(state.companyItem, 'company item')
          const veraItem = need(state.veraItem, 'vera item')
          const brunoItem = need(state.brunoItem, 'bruno item')
          const sql = yield* SqlClient.SqlClient

          const trigger = yield* owner.api.messages.create({
            payload: { channelId: dm.id, body: 'please wait for release, then answer' }
          })
          const running = yield* taskWith(vera.id, trigger.id, 'running')
          const mcp = yield* waitFor(
            'mcp config written',
            Effect.sync(() =>
              Option.fromNullable(fake.mcpConfigs().find((c) => c.taskId === running.id))
            )
          )
          const token = mcp.token

          // vault_list: company items + vera's own, never bruno's; metadata only.
          const listed = yield* runtimeCall(token, 'GET', '/vault')
          expect(listed.status).toBe(200)
          const items = listed.json['items'] as Array<{
            id: string
            kind: string
            label: string
            hint: string
            scope: string
          }>
          expect(items.map((i) => [i.id, i.scope])).toEqual([
            [seatItem.id, 'company'],
            [companyItem.id, 'company'],
            [veraItem.id, 'agent']
          ])
          expect(items.map((i) => i.id)).not.toContain(brunoItem.id)
          expect(items.find((i) => i.id === veraItem.id)?.hint).toBe(VERA_SECRET.slice(-4))
          expect(JSON.stringify(listed.json)).not.toContain(VERA_SECRET)
          expect(JSON.stringify(listed.json)).not.toContain(COMPANY_SECRET)

          // vault_get: own item and a company item resolve; bruno's is 403; unknown is 404.
          const own = yield* runtimeCall(token, 'POST', '/vault/get', { vaultItemId: veraItem.id })
          expect(own.status).toBe(200)
          expect(own.json).toEqual({
            id: veraItem.id,
            kind: 'generic.secret',
            label: 'Figma token',
            secret: VERA_SECRET
          })
          const shared = yield* runtimeCall(token, 'POST', '/vault/get', {
            vaultItemId: companyItem.id
          })
          expect(shared.status).toBe(200)
          expect(shared.json['secret']).toBe(COMPANY_SECRET)
          const foreign = yield* runtimeCall(token, 'POST', '/vault/get', {
            vaultItemId: brunoItem.id
          })
          expect(foreign.status).toBe(403)
          expect((foreign.json['error'] as { code: string }).code).toBe('forbidden')
          expect(JSON.stringify(foreign.json)).not.toContain(BRUNO_SECRET)
          const unknown = yield* runtimeCall(token, 'POST', '/vault/get', {
            vaultItemId: 'vlt_missing'
          })
          expect(unknown.status).toBe(404)
          const malformed = yield* runtimeCall(token, 'POST', '/vault/get', {
            vaultItemId: 'not-an-id'
          })
          expect(malformed.status).toBe(404)
          const noAuth = yield* runtimeCall('nope', 'GET', '/vault')
          expect(noAuth.status).toBe(401)

          // Audited as `tool` with the task id; the refused call left no row for bruno's item.
          const audits =
            yield* sql`SELECT purpose, agent_id, task_id FROM audit_log WHERE company_id = ${acme.id} AND vault_item_id IN (${veraItem.id}, ${companyItem.id}) ORDER BY at, rowid`.pipe(
              Effect.flatMap(Schema.decodeUnknown(AuditRows))
            )
          expect(audits).toEqual([
            { purpose: 'tool', agent_id: vera.id, task_id: running.id },
            { purpose: 'tool', agent_id: vera.id, task_id: running.id }
          ])
          const denied =
            yield* sql`SELECT purpose, agent_id, task_id FROM audit_log WHERE company_id = ${acme.id} AND vault_item_id = ${brunoItem.id}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(AuditRows))
            )
          expect(denied).toEqual([])

          // The runtime now "prints" both secrets: the task's redactor masks them before they
          // become deltas, the message body or the result summary.
          fake.release(`figma=${VERA_SECRET} shared=${COMPANY_SECRET} seat=${SEAT_SECRET} done`)
          const ended = yield* taskWith(vera.id, trigger.id, 'done')
          const reply = yield* replyOf(ended)
          expect(reply.status).toBe('sent')
          expect(reply.body).toBe(
            `figma=••••${VERA_SECRET.slice(-4)} shared=••••${COMPANY_SECRET.slice(-4)} seat=••••${SEAT_SECRET.slice(-4)} done`
          )
          const events =
            yield* sql`SELECT type, payload_json FROM events WHERE company_id = ${acme.id} AND type IN ('agent.task.delta', 'agent.task.done', 'message.created', 'message.updated') ORDER BY seq`.pipe(
              Effect.flatMap(Schema.decodeUnknown(EventRows))
            )
          for (const e of events) {
            expect(e.payload_json).not.toContain(VERA_SECRET)
            expect(e.payload_json).not.toContain(COMPANY_SECRET)
            expect(e.payload_json).not.toContain(SEAT_SECRET)
          }

          // The task is over: its redactor is gone, so the (still valid) token cannot fetch
          // a secret that nothing would mask any more.
          const late = yield* runtimeCall(token, 'POST', '/vault/get', { vaultItemId: veraItem.id })
          expect(late.status).toBe(409)
          expect((late.json['error'] as { code: string }).code).toBe('task_mismatch')
          expect(JSON.stringify(late.json)).not.toContain(VERA_SECRET)
          const runner = yield* TaskRunner
          expect(runner.registerSecret(ended.id, 'anything-long-enough')).toBe(false)
        })
    )

    // ── own-vault CRUD, and the wall around it ───────────────────────────────

    it.effect(
      "vault_add / vault_update / vault_delete write only the agent's own items; company and foreign items are 403",
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const vera = need(state.vera, 'vera')
          const dm = need(state.veraDm, 'vera dm')
          const seatItem = need(state.seatItem, 'seat item')
          const companyItem = need(state.companyItem, 'company item')
          const brunoItem = need(state.brunoItem, 'bruno item')
          const sql = yield* SqlClient.SqlClient

          const trigger = yield* owner.api.messages.create({
            payload: { channelId: dm.id, body: 'please wait for release, then answer' }
          })
          const running = yield* taskWith(vera.id, trigger.id, 'running')
          const mcp = yield* waitFor(
            'mcp config written',
            Effect.sync(() =>
              Option.fromNullable(fake.mcpConfigs().find((c) => c.taskId === running.id))
            )
          )
          const token = mcp.token

          // Create: lands in vera's own vault, metadata only in the response.
          const created = yield* runtimeCall(token, 'POST', '/vault/add', {
            kind: 'generic.secret',
            label: 'acme portal login',
            secret: PORTAL_SECRET
          })
          expect(created.status).toBe(200)
          const item = created.json['item'] as { id: string; scope: string; hint: string }
          expect(item.scope).toBe('agent')
          expect(item.hint).toBe(PORTAL_SECRET.slice(-4))
          expect(JSON.stringify(created.json)).not.toContain(PORTAL_SECRET)
          const ownedRows =
            yield* sql`SELECT agent_id FROM vault_items WHERE company_id = ${acme.id} AND id = ${item.id}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(OwnerRows))
            )
          expect(ownedRows).toEqual([{ agent_id: vera.id }])

          // It shows up in the agent's own list, and reads back.
          const listed = yield* runtimeCall(token, 'GET', '/vault')
          const ids = (listed.json['items'] as Array<{ id: string }>).map((i) => i.id)
          expect(ids).toContain(item.id)

          // Update: label + value, in place.
          const updated = yield* runtimeCall(token, 'POST', '/vault/update', {
            vaultItemId: item.id,
            label: 'acme portal login (rotated)',
            secret: ROTATED_SECRET
          })
          expect(updated.status).toBe(200)
          expect((updated.json['item'] as { label: string }).label).toBe(
            'acme portal login (rotated)'
          )
          expect(JSON.stringify(updated.json)).not.toContain(ROTATED_SECRET)
          const reread = yield* runtimeCall(token, 'POST', '/vault/get', { vaultItemId: item.id })
          expect(reread.json['secret']).toBe(ROTATED_SECRET)

          // The wall: the company vault and another agent's vault are read-only. Every write
          // shape is refused, and nothing on the other side of it changes.
          for (const target of [companyItem.id, seatItem.id, brunoItem.id]) {
            const patch = yield* runtimeCall(token, 'POST', '/vault/update', {
              vaultItemId: target,
              label: 'hijacked'
            })
            expect(patch.status).toBe(403)
            expect((patch.json['error'] as { code: string }).code).toBe('forbidden')

            const kill = yield* runtimeCall(token, 'POST', '/vault/delete', {
              vaultItemId: target
            })
            expect(kill.status).toBe(403)
            expect((kill.json['error'] as { code: string }).code).toBe('forbidden')
          }

          const survivors =
            yield* sql`SELECT id, label, agent_id FROM vault_items WHERE company_id = ${acme.id} AND id IN (${companyItem.id}, ${seatItem.id}, ${brunoItem.id}) ORDER BY rowid`.pipe(
              Effect.flatMap(Schema.decodeUnknown(SurvivorRows))
            )
          expect(survivors).toEqual([
            { id: seatItem.id, label: seatItem.label, agent_id: null },
            { id: companyItem.id, label: companyItem.label, agent_id: null },
            { id: brunoItem.id, label: brunoItem.label, agent_id: need(state.bruno, 'bruno').id }
          ])

          // A create carries no scope field at all, so there is no company-scoped write to try:
          // an `agentId` in the body is ignored, and the item still lands on the caller.
          const smuggled = yield* runtimeCall(token, 'POST', '/vault/add', {
            kind: 'generic.secret',
            label: 'smuggled',
            secret: 'smuggled-value-000000',
            agentId: need(state.bruno, 'bruno').id
          })
          expect(smuggled.status).toBe(200)
          const smuggledOwner =
            yield* sql`SELECT agent_id FROM vault_items WHERE company_id = ${acme.id} AND id = ${(smuggled.json['item'] as { id: string }).id}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(OwnerRows))
            )
          expect(smuggledOwner).toEqual([{ agent_id: vera.id }])

          // Delete: its own items, and only those.
          const gone = yield* runtimeCall(token, 'POST', '/vault/delete', { vaultItemId: item.id })
          expect(gone.status).toBe(200)
          expect(gone.json).toEqual({ deleted: true })
          const afterDelete = yield* runtimeCall(token, 'GET', '/vault')
          expect(
            (afterDelete.json['items'] as Array<{ id: string }>).map((i) => i.id)
          ).not.toContain(item.id)
          const missing = yield* runtimeCall(token, 'POST', '/vault/delete', {
            vaultItemId: item.id
          })
          expect(missing.status).toBe(404)

          // Every write is audited against vera and the task; the refusals left no rows.
          const audits =
            yield* sql`SELECT purpose, agent_id, task_id FROM audit_log WHERE company_id = ${acme.id} AND vault_item_id = ${item.id} ORDER BY at, rowid`.pipe(
              Effect.flatMap(Schema.decodeUnknown(AuditRows))
            )
          expect(audits.map((a) => a.purpose)).toEqual([
            'agent_add',
            'agent_update',
            'tool',
            'agent_revoke'
          ])
          for (const row of audits) {
            expect(row.agent_id).toBe(vera.id)
            expect(row.task_id).toBe(running.id)
          }
          const refused =
            yield* sql`SELECT purpose, agent_id, task_id FROM audit_log WHERE company_id = ${acme.id} AND vault_item_id = ${brunoItem.id} AND purpose LIKE 'agent_%'`.pipe(
              Effect.flatMap(Schema.decodeUnknown(AuditRows))
            )
          expect(refused).toEqual([])

          fake.release('done')
          yield* taskWith(vera.id, trigger.id, 'done')
        })
    )

    it.effect('the redactor is dropped on cancel too', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const vera = need(state.vera, 'vera')
        const dm = need(state.veraDm, 'vera dm')
        const runner = yield* TaskRunner
        const trigger = yield* owner.api.messages.create({
          payload: { channelId: dm.id, body: 'please hang forever' }
        })
        const running = yield* taskWith(vera.id, trigger.id, 'running')
        yield* waitFor(
          'mcp config written',
          Effect.sync(() =>
            Option.fromNullable(fake.mcpConfigs().find((c) => c.taskId === running.id))
          )
        )
        expect(runner.registerSecret(running.id, 'registered-while-running')).toBe(true)
        yield* owner.api.tasks.cancel({ path: { taskId: running.id } })
        yield* waitFor(
          'redactor removed',
          Effect.sync(() =>
            runner.registerSecret(running.id, 'registered-after-cancel')
              ? Option.none()
              : Option.some(true)
          )
        )
        const after = yield* owner.api.tasks.get({ path: { taskId: running.id } })
        expect(after.status).toBe('cancelled')
      })
    )
  })
})
