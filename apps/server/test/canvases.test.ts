import { layer } from '@effect/vitest'
import { SqlClient } from '@effect/sql'
import { Effect, Schema } from 'effect'
import { Canvas, CanvasDocument } from '@taut/contract/domain'
import { afterAll, describe, expect } from 'vitest'
import { TaskTokens } from '../src/agents/tokens.js'
import { Tasks } from '../src/services/tasks.js'
import { baseUrl, makeClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const

describe('agent canvases', () => {
  layer(testAppWith(dir, makeFakeRuntime().layer), { excludeTestServices: true })((it) => {
    it.effect(
      'creates a persistent preview in the task conversation and announces it without HTML',
      () =>
        Effect.gen(function* () {
          const owner = yield* makeClient
          yield* owner.api.auth.signup({
            payload: { email: 'canvas@taut.local', password: 'password123', name: 'Owner' }
          })
          const company = yield* owner.api.companies.create({
            payload: { slug: 'canvases', name: 'Canvases', avatar }
          })
          const me = yield* owner.api.auth.me()
          const dept = yield* owner.api.departments.create({
            payload: { name: 'Design', slug: 'design', headUserId: me.user.id }
          })
          const agent = yield* owner.api.agents.create({
            payload: {
              handle: 'designer',
              name: 'Designer',
              avatar,
              role: 'Design',
              mandate: '# Design',
              runtimeKind: 'claude-code',
              permissionMode: 'plan',
              departmentId: dept.id
            }
          })
          const channels = yield* owner.api.channels.list({ urlParams: {} })
          const channel = channels.items.find((c) => c.name === 'design')!
          const root = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: 'Show me a yellow sidebar' }
          })
          const tasks = yield* Tasks
          const task = yield* tasks.create(company.id, {
            agentId: agent.id,
            channelId: channel.id,
            threadId: root.id,
            messageId: root.id,
            triggerUserId: me.user.id
          })
          const tokens = yield* TaskTokens
          const token = yield* tokens.mint({
            companyId: company.id,
            agentId: agent.id,
            taskId: task.id
          })
          const { http } = yield* baseUrl
          const cookie = yield* owner.cookieHeader
          const html =
            '<!doctype html><style>aside{background:yellow}</style><aside>Sidebar</aside>'
          const created = yield* Effect.promise(() =>
            fetch(`${http}/api/agent-runtime/canvases/create`, {
              method: 'POST',
              headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
              body: JSON.stringify({ title: 'Yellow sidebar', html })
            })
          )
          expect(created.status).toBe(200)
          const raw = yield* Effect.promise(() => created.json())
          const body = yield* Schema.decodeUnknown(Schema.Struct({ canvas: Canvas }))(raw)
          expect(body.canvas).toMatchObject({
            title: 'Yellow sidebar',
            channelId: channel.id,
            threadId: root.id,
            agentId: agent.id,
            open: true,
            revision: 1
          })
          expect(raw).not.toHaveProperty('canvas.html')
          const response = yield* Effect.promise(() =>
            fetch(`${http}/api/channels/${channel.id}/canvases/${body.canvas.id}`, {
              headers: { cookie }
            })
          )
          expect(response.status).toBe(200)
          const document = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknown(CanvasDocument))
          )
          expect(document.html).toBe(html)
          const sql = yield* SqlClient.SqlClient
          const events =
            yield* sql`SELECT payload_json FROM events WHERE type = 'canvas.changed' AND company_id = ${company.id}`
          expect(events).toHaveLength(1)
          expect(JSON.parse(String(events[0]!.payload_json))).toMatchObject({
            action: 'create',
            canvas: { id: body.canvas.id }
          })
          expect(JSON.stringify(events)).not.toContain('background:yellow')
        })
    )
  })
})
