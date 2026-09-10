import { layer } from '@effect/vitest'
import { SqlClient } from '@effect/sql'
import { AgentSearchResponse } from '@taut/taut-mcp/protocol'
import { Effect, Redacted, Schema } from 'effect'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect } from 'vitest'
import { TaskTokens } from '../src/agents/tokens.js'
import { Channels } from '../src/services/channels.js'
import { Messages } from '../src/services/messages.js'
import { Tasks } from '../src/services/tasks.js'
import { baseUrl, makeClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const
const results = (response: Response) =>
  Effect.promise(() => response.json()).pipe(
    Effect.flatMap(Schema.decodeUnknown(AgentSearchResponse))
  )

const setup = Effect.gen(function* () {
  const suffix = randomUUID().slice(0, 8)
  const owner = yield* makeClient
  yield* owner.api.auth.signup({
    payload: { email: `head-${suffix}@taut.local`, password: 'password123', name: 'Head' }
  })
  const company = yield* owner.api.companies.create({
    payload: { slug: `discovery-${suffix}`, name: 'Discovery', avatar }
  })
  const me = yield* owner.api.auth.me()
  const department = yield* owner.api.departments.create({
    payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
  })
  const otherDepartment = yield* owner.api.departments.create({
    payload: { name: 'Finance', slug: 'finance', headUserId: me.user.id }
  })
  const createAgent = (handle: string, departmentId = department.id) =>
    owner.api.agents.create({
      payload: {
        handle,
        name: handle,
        avatar,
        role: 'Engineer',
        mandate: '# Private mandate\nDo not publish these standing instructions.',
        runtimeKind: 'claude-code',
        permissionMode: 'plan',
        departmentId
      }
    })
  const worker = yield* createAgent('worker')
  const specialist = yield* createAgent('database')
  yield* createAgent('foreign-database', otherDepartment.id)
  yield* owner.api.agents.putSkill({
    path: { agentId: specialist.id, name: 'production-sql' },
    payload: { description: 'Review and run production database SQL', body: 'PRIVATE PROCEDURE' }
  })
  const channels = yield* Channels
  const messages = yield* Messages
  const tasks = yield* Tasks
  const tokens = yield* TaskTokens
  const channelId = yield* channels.ensureDm(
    company.id,
    { memberKind: 'agent', memberId: worker.id },
    { memberKind: 'user', memberId: me.user.id }
  )
  const root = yield* messages.postAsAgent(company.id, {
    agentId: worker.id,
    channelId,
    body: 'Find a specialist'
  })
  const task = yield* tasks.create(company.id, {
    agentId: worker.id,
    channelId,
    threadId: root.id,
    messageId: root.id,
    triggerMessageId: root.id
  })
  const token = yield* tokens.mint({ companyId: company.id, agentId: worker.id, taskId: task.id })
  const { http } = yield* baseUrl
  const search = (body: Record<string, unknown> = {}, credential = token) =>
    Effect.promise(() =>
      fetch(`${http}/api/agent-runtime/agents/search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    )
  const runtimeCall = (path: string, body?: Record<string, unknown>) =>
    Effect.promise(() =>
      fetch(`${http}/api/agent-runtime${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
    )
  return {
    owner,
    company,
    department,
    otherDepartment,
    worker,
    specialist,
    createAgent,
    search,
    runtimeCall
  }
})

describe('department agent discovery', () => {
  layer(testAppWith(dir, makeFakeRuntime().layer), { excludeTestServices: true })((it) => {
    it.effect('discovering a specialist grants no access to its private credentials', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const secret = 'production-private-credential-123456'
        const credential = yield* s.owner.api.vault.add({
          payload: {
            agentId: s.specialist.id,
            kind: 'generic.secret',
            label: 'Private production database',
            secret: Redacted.make(secret)
          }
        })
        const discovery = yield* s.search()
        const raw = yield* Effect.promise(() => discovery.json())
        expect(JSON.stringify(raw)).not.toContain(credential.id)
        expect(JSON.stringify(raw)).not.toContain(secret)
        const listed = yield* s.runtimeCall('/vault')
        expect(listed.status).toBe(200)
        expect(JSON.stringify(yield* Effect.promise(() => listed.json()))).not.toContain(
          credential.id
        )
        const denied = yield* s.runtimeCall('/vault/get', { vaultItemId: credential.id })
        expect(denied.status).toBe(403)
        expect(JSON.stringify(yield* Effect.promise(() => denied.json()))).not.toContain(secret)
      })
    )
    it.effect('finds a teammate by capability and exposes only a public summary', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const response = yield* s.search({ query: 'PRODUCTION sql' })
        expect(response.status).toBe(200)
        const raw = yield* Effect.promise(() => response.json())
        const body = yield* Schema.decodeUnknown(AgentSearchResponse)(raw)
        expect(body.agents).toHaveLength(1)
        expect(body.agents[0]).toEqual({
          id: s.specialist.id,
          handle: 'database',
          name: 'database',
          role: 'Engineer',
          status: 'active',
          skills: expect.arrayContaining([
            { name: 'production-sql', description: 'Review and run production database SQL' }
          ])
        })
        expect(body.hasMore).toBe(false)
        expect(JSON.stringify(raw)).not.toContain('PRIVATE PROCEDURE')
        expect(JSON.stringify(raw)).not.toContain('Private mandate')
        const listed = yield* s.search()
        const all = yield* Effect.promise(() => listed.json()).pipe(
          Effect.flatMap(Schema.decodeUnknown(AgentSearchResponse))
        )
        expect(all.agents.map((a) => a.handle)).toEqual(['database'])
      })
    )
    it.effect(
      'uses current memberships, deduplicates shared departments and excludes archived agents',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          for (const agent of [s.worker, s.specialist]) {
            yield* s.owner.api.departments.addMember({
              path: { departmentId: s.otherDepartment.id },
              payload: { memberKind: 'agent', memberId: agent.id }
            })
          }
          const peers = yield* results(yield* s.search())
          expect(peers.agents.map((a) => a.handle)).toEqual(['database', 'foreign-database'])
          yield* s.owner.api.agents.delete({ path: { agentId: s.specialist.id } })
          expect((yield* results(yield* s.search())).agents.map((a) => a.handle)).toEqual([
            'foreign-database'
          ])
          for (const department of [s.department, s.otherDepartment]) {
            yield* s.owner.api.departments.removeMember({
              path: { departmentId: department.id, memberKind: 'agent', memberId: s.worker.id }
            })
          }
          expect(yield* results(yield* s.search())).toEqual({ agents: [], hasMore: false })
        })
    )
    it.effect('matches handles and roles, bounds results and reports paused teammates', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const second = yield* s.createAgent('alpha')
        yield* s.owner.api.agents.update({
          path: { agentId: second.id },
          payload: { status: 'paused' }
        })
        const limited = yield* results(yield* s.search({ query: 'engineer', limit: 1 }))
        expect(limited.agents.map((a) => [a.handle, a.status])).toEqual([['alpha', 'paused']])
        expect(limited.hasMore).toBe(true)
        expect(
          (yield* results(yield* s.search({ query: ' @DATABASE ' }))).agents.map((a) => a.id)
        ).toEqual([s.specialist.id])
        expect(yield* results(yield* s.search({ query: 'no-such-capability' }))).toEqual({
          agents: [],
          hasMore: false
        })
      })
    )
    it.effect('never searches pending skills, private mandates or skill bodies', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE agent_skills SET state = 'pending' WHERE agent_id = ${s.specialist.id} AND name = 'production-sql'`
        for (const query of ['production', 'PRIVATE PROCEDURE', 'standing instructions']) {
          expect((yield* results(yield* s.search({ query }))).agents).toEqual([])
        }
        const peers = yield* results(yield* s.search())
        expect(peers.agents[0]?.skills.some((skill) => skill.name === 'production-sql')).toBe(false)
      })
    )
    it.effect(
      'requires a task token, validates bounds and cannot be widened by request fields',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          expect((yield* s.search({}, 'invalid-token')).status).toBe(401)
          for (const body of [
            { limit: 0 },
            { limit: 51 },
            { limit: 1.5 },
            { query: 'x'.repeat(201) }
          ]) {
            expect((yield* s.search(body)).status).toBe(422)
          }
          const peers = yield* results(
            yield* s.search({
              departmentId: s.otherDepartment.id,
              agentId: s.specialist.id,
              companyId: 'other-company'
            })
          )
          expect(peers.agents.map((a) => a.handle)).toEqual(['database'])
        })
    )
  })
})
