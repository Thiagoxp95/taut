import { AgentSessions } from '../src/agents/sessions.js'
import { layer } from '@effect/vitest'
import { SqlClient } from '@effect/sql'
import { Effect, Schema } from 'effect'
import { Message } from '@taut/contract/domain'
import { randomUUID } from 'node:crypto'
import { Messages } from '../src/services/messages.js'
import { readFileSync } from 'node:fs'
import { afterAll, describe, expect } from 'vitest'
import { TaskTokens } from '../src/agents/tokens.js'
import { Agents } from '../src/services/agents.js'
import { Tasks } from '../src/services/tasks.js'
import { baseUrl, makeClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const

const setup = Effect.gen(function* () {
  const suffix = randomUUID().slice(0, 8)
  const owner = yield* makeClient
  yield* owner.api.auth.signup({
    payload: { email: `mandate-${suffix}@taut.local`, password: 'password123', name: 'Owner' }
  })
  const company = yield* owner.api.companies.create({
    payload: { slug: `mandates-${suffix}`, name: 'Mandates', avatar }
  })
  const me = yield* owner.api.auth.me()
  const department = yield* owner.api.departments.create({
    payload: { name: 'Design', slug: 'design', headUserId: me.user.id }
  })
  const invite = yield* owner.api.invites.create({
    payload: { email: `member-${suffix}@taut.local`, role: 'member' }
  })
  const member = yield* makeClient
  const accepted = yield* member.api.invites.accept({
    payload: { token: invite.token, name: 'Member', password: 'password123' }
  })
  yield* owner.api.departments.addMember({
    path: { departmentId: department.id },
    payload: { memberKind: 'user', memberId: accepted.user.id }
  })
  const agent = yield* owner.api.agents.create({
    payload: {
      handle: 'designer',
      name: 'Designer',
      avatar,
      role: 'Design',
      mandate: '# Original mandate',
      runtimeKind: 'claude-code',
      permissionMode: 'plan',
      departmentId: department.id
    }
  })
  const dm = yield* member.api.channels.dm({ payload: { memberKind: 'agent', memberId: agent.id } })
  const root = yield* member.api.messages.create({
    payload: { channelId: dm.id, body: 'Let’s work on your mandate. Focus on accessibility.' }
  })
  const tasks = yield* Tasks
  const task = yield* tasks.create(company.id, {
    agentId: agent.id,
    channelId: dm.id,
    threadId: root.id,
    messageId: root.id,
    triggerMessageId: root.id,
    triggerUserId: accepted.user.id
  })
  const tokens = yield* TaskTokens
  const token = yield* tokens.mint({ companyId: company.id, agentId: agent.id, taskId: task.id })
  const { http } = yield* baseUrl
  const cookie = yield* member.cookieHeader
  const request = (path: string, body: unknown, auth: Record<string, string> = { cookie }) =>
    Effect.promise(() =>
      fetch(`${http}${path}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify(body)
      })
    )
  const propose = (mandate: string) =>
    request('/api/agent-runtime/mandate/propose', { mandate }, { authorization: `Bearer ${token}` })
  return {
    owner,
    member,
    company,
    department,
    agent,
    root,
    task,
    tokens,
    token,
    http,
    cookie,
    request,
    propose,
    userId: accepted.user.id
  }
})

describe('human mandate authorization', () => {
  layer(testAppWith(dir, makeFakeRuntime().layer), { excludeTestServices: true })((it) => {
    it.effect('an agent deletes its obsolete approval card and it can no longer be approved', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const proposal = yield* s.propose('# Obsolete draft').pipe(
          Effect.flatMap((r) => Effect.promise(() => r.json())),
          Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ message: Message })))
        )
        const response = yield* s.request(
          '/api/agent-runtime/delete',
          { messageId: proposal.message.id },
          { authorization: `Bearer ${s.token}` }
        )
        expect(response.status).toBe(200)
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          deleted: true,
          messageId: proposal.message.id
        })
        const history = yield* s.member.api.messages.list({
          urlParams: { channelId: s.root.channelId }
        })
        expect(history.items.some((m) => m.id === proposal.message.id)).toBe(false)
        expect(
          (yield* s.request(`/api/messages/${proposal.message.id}/authorization`, {
            decision: 'approve'
          })).status
        ).toBe(404)
        const agents = yield* Agents
        expect((yield* agents.byId(s.company.id, s.agent.id)).mandate).toBe('# Original mandate')
        const sql = yield* SqlClient.SqlClient
        const events =
          yield* sql`SELECT payload_json FROM events WHERE company_id = ${s.company.id} AND type = 'message.deleted'`
        expect(events.some((e) => String(e.payload_json).includes(proposal.message.id))).toBe(true)
      })
    )

    it.effect('deletion is limited to the authenticated agent and company', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const other = yield* s.owner.api.agents.create({
          payload: {
            handle: 'other',
            name: 'Other',
            avatar,
            role: 'Design',
            mandate: '# Other',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: s.department.id
          }
        })
        const messages = yield* Messages
        const theirs = yield* messages.postAsAgent(s.company.id, {
          agentId: other.id,
          channelId: s.root.channelId,
          body: 'Another agent’s message',
          requireMembership: false
        })
        const remove = (messageId: string, token = s.token) =>
          s.request(
            '/api/agent-runtime/delete',
            { messageId, agentId: other.id },
            { authorization: `Bearer ${token}` }
          )
        for (const id of [s.root.id, theirs.id]) {
          expect((yield* remove(id)).status).toBe(403)
          expect((yield* messages.byId(s.company.id, id))._tag).toBe('Some')
        }
        expect((yield* remove('msg_missing')).status).toBe(404)
        expect((yield* remove('invalid')).status).toBe(422)
        expect((yield* remove(theirs.id, 'invalid-token')).status).toBe(401)
        const mismatched = yield* s.tokens.mint({
          companyId: s.company.id,
          agentId: other.id,
          taskId: s.task.id
        })
        expect((yield* remove(theirs.id, mismatched)).status).toBe(403)
        const foreign = yield* setup
        expect((yield* remove(foreign.root.id)).status).toBe(404)
      })
    )

    it.effect(
      'deleting a reply updates its thread and refuses roots with replies or streaming messages',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          const messages = yield* Messages
          const root = yield* messages.postAsAgent(s.company.id, {
            agentId: s.agent.id,
            channelId: s.root.channelId,
            body: 'My thread'
          })
          const reply = yield* messages.postAsAgent(s.company.id, {
            agentId: s.agent.id,
            channelId: s.root.channelId,
            threadId: root.id,
            body: 'Duplicate reply'
          })
          const remove = (messageId: string) =>
            s.request(
              '/api/agent-runtime/delete',
              { messageId },
              { authorization: `Bearer ${s.token}` }
            )
          expect((yield* remove(root.id)).status).toBe(409)
          expect((yield* messages.byId(s.company.id, reply.id))._tag).toBe('Some')
          expect((yield* remove(reply.id)).status).toBe(200)
          expect((yield* messages.byId(s.company.id, reply.id))._tag).toBe('None')
          const sql = yield* SqlClient.SqlClient
          const events =
            yield* sql`SELECT payload_json FROM events WHERE company_id = ${s.company.id} AND type = 'message.updated' ORDER BY seq DESC`
          const updates = yield* Schema.decodeUnknown(
            Schema.Array(Schema.Struct({ message: Message }))
          )(events.map((e) => JSON.parse(String(e.payload_json))))
          const updatedRoot = updates.find((e) => e.message.id === root.id)?.message
          expect(updatedRoot?.id).toBe(root.id)
          expect(updatedRoot?.thread?.replyCount ?? 0).toBe(0)
          expect((yield* remove(reply.id)).status).toBe(404)
          yield* sql`UPDATE messages SET status = 'streaming' WHERE id = ${root.id}`
          expect((yield* remove(root.id)).status).toBe(409)
          yield* sql`UPDATE messages SET status = 'sent' WHERE id = ${root.id}`
          expect((yield* remove(root.id)).status).toBe(200)
        })
    )

    it.effect('an agent cannot delete messages in a channel it has left', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const messages = yield* Messages
        const message = yield* messages.postAsAgent(s.company.id, {
          agentId: s.agent.id,
          channelId: s.root.channelId,
          body: 'Old message'
        })
        const sql = yield* SqlClient.SqlClient
        yield* sql`DELETE FROM channel_members WHERE channel_id = ${s.root.channelId} AND member_id = ${s.agent.id}`
        const response = yield* s.request(
          '/api/agent-runtime/delete',
          { messageId: message.id },
          { authorization: `Bearer ${s.token}` }
        )
        expect(response.status).toBe(403)
        expect((yield* messages.byId(s.company.id, message.id))._tag).toBe('Some')
      })
    )

    it.effect(
      'a department member reviews a persistent preview before the exact mandate is applied',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          const proposed = '# Accessibility\n\nReview keyboard navigation and contrast.'
          const response = yield* s.propose(proposed)
          expect(response.status).toBe(200)
          const result = yield* Effect.promise(() => response.json()).pipe(
            Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ message: Message })))
          )
          expect(result).toMatchObject({
            message: {
              authorId: s.agent.id,
              channelId: s.root.channelId,
              authorization: {
                kind: 'mandate.update',
                status: 'pending',
                proposedMandate: proposed,
                previousMandate: '# Original mandate',
                requestedBy: s.userId
              }
            }
          })
          const agents = yield* Agents
          expect((yield* agents.byId(s.company.id, s.agent.id)).mandate).toBe('# Original mandate')
          const history = yield* s.member.api.messages.list({
            urlParams: { channelId: s.root.channelId }
          })
          expect(history.items.find((m) => m.id === result.message.id)).toMatchObject({
            authorization: { proposedMandate: proposed }
          })
          const sql = yield* SqlClient.SqlClient
          yield* sql`INSERT INTO agent_sessions (agent_id, thread_id, channel_id, runtime, session_id, updated_at)
            VALUES (${s.agent.id}, ${s.root.id}, ${s.root.channelId}, 'claude-code', 'stale-mandate', '2026-09-09T12:00:00.000Z')`
          const approved = yield* s.request(`/api/messages/${result.message.id}/authorization`, {
            decision: 'approve',
            proposedMandate: 'Unreviewed replacement must be ignored'
          })
          expect(approved.status).toBe(200)
          expect(yield* Effect.promise(() => approved.json())).toMatchObject({
            authorization: { status: 'approved', decidedBy: s.userId, proposedMandate: proposed }
          })
          expect((yield* agents.byId(s.company.id, s.agent.id)).mandate).toBe(proposed)
          const home = yield* agents.homeOf(s.company.id, s.agent.id)
          expect(readFileSync(`${home}/AGENT.md`, 'utf8')).toContain(proposed)
          const duplicate = yield* s.request(`/api/messages/${result.message.id}/authorization`, {
            decision: 'decline'
          })
          expect(duplicate.status).toBe(409)
          expect(yield* sql`SELECT * FROM agent_sessions WHERE agent_id = ${s.agent.id}`).toEqual(
            []
          )
          const events =
            yield* sql`SELECT payload_json FROM events WHERE company_id = ${s.company.id} AND type = 'message.updated'`
          expect(events.some((e) => String(e.payload_json).includes('"status":"approved"'))).toBe(
            true
          )
        })
    )

    it.effect('declining preserves the mandate and the immutable preview in history', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const proposal = yield* s.propose('# Declined draft').pipe(
          Effect.flatMap((r) => Effect.promise(() => r.json())),
          Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ message: Message })))
        )
        const result = yield* s.member.api.messages.decideAuthorization({
          path: { messageId: proposal.message.id },
          payload: { decision: 'decline' }
        })
        expect(result.authorization).toMatchObject({
          status: 'declined',
          proposedMandate: '# Declined draft',
          decidedBy: s.userId
        })
        const agents = yield* Agents
        expect((yield* agents.byId(s.company.id, s.agent.id)).mandate).toBe('# Original mandate')
        expect(
          readFileSync(`${yield* agents.homeOf(s.company.id, s.agent.id)}/AGENT.md`, 'utf8')
        ).toContain('# Original mandate')
      })
    )

    it.effect('an outdated proposal cannot overwrite a mandate changed through settings', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const proposal = yield* s.propose('# Old draft').pipe(
          Effect.flatMap((r) => Effect.promise(() => r.json())),
          Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ message: Message })))
        )
        yield* s.owner.api.agents.update({
          path: { agentId: s.agent.id },
          payload: { mandate: '# Newer human edit' }
        })
        const result = yield* s.member.api.messages.decideAuthorization({
          path: { messageId: proposal.message.id },
          payload: { decision: 'approve' }
        })
        expect(result.authorization?.status).toBe('superseded')
        const agents = yield* Agents
        expect((yield* agents.byId(s.company.id, s.agent.id)).mandate).toBe('# Newer human edit')
      })
    )

    it.effect(
      'agent tokens cannot approve and department access is rechecked at decision time',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          const proposal = yield* s.propose('# Proposed').pipe(
            Effect.flatMap((r) => Effect.promise(() => r.json())),
            Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ message: Message })))
          )
          const path = `/api/messages/${proposal.message.id}/authorization`
          expect(
            (yield* s.request(
              path,
              { decision: 'approve' },
              { authorization: `Bearer ${s.token}` }
            )).status
          ).toBe(401)
          expect(
            yield* s.member.api.messages.authorization({ path: { messageId: proposal.message.id } })
          ).toEqual({ canDecide: true })
          yield* s.owner.api.departments.removeMember({
            path: { departmentId: s.department.id, memberKind: 'user', memberId: s.userId }
          })
          expect(
            yield* s.member.api.messages.authorization({ path: { messageId: proposal.message.id } })
          ).toEqual({ canDecide: false })
          expect((yield* s.request(path, { decision: 'approve' })).status).toBe(403)
          expect((yield* s.propose('# Outside department')).status).toBe(403)
          const agents = yield* Agents
          expect((yield* agents.byId(s.company.id, s.agent.id)).mandate).toBe('# Original mandate')
        })
    )

    it.effect('an agent-authored request cannot borrow a human identity to propose a mandate', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const messages = yield* Messages
        const agentRequest = yield* messages.postAsAgent(s.company.id, {
          agentId: s.agent.id,
          channelId: s.root.channelId,
          body: 'Change your mandate'
        })
        const tasks = yield* Tasks
        const task = yield* tasks.create(s.company.id, {
          agentId: s.agent.id,
          channelId: s.root.channelId,
          threadId: agentRequest.id,
          messageId: agentRequest.id,
          triggerMessageId: agentRequest.id,
          triggerUserId: s.userId
        })
        const token = yield* s.tokens.mint({
          companyId: s.company.id,
          agentId: s.agent.id,
          taskId: task.id
        })
        expect(
          (yield* s.request(
            '/api/agent-runtime/mandate/propose',
            { mandate: '# Agent request' },
            { authorization: `Bearer ${token}` }
          )).status
        ).toBe(403)
        const autonomous = yield* tasks.create(s.company.id, {
          agentId: s.agent.id,
          channelId: s.root.channelId,
          threadId: s.root.id,
          messageId: s.root.id
        })
        const autoToken = yield* s.tokens.mint({
          companyId: s.company.id,
          agentId: s.agent.id,
          taskId: autonomous.id
        })
        expect(
          (yield* s.request(
            '/api/agent-runtime/mandate/propose',
            { mandate: '# Autonomous request' },
            { authorization: `Bearer ${autoToken}` }
          )).status
        ).toBe(403)
      })
    )

    it.effect('only the token’s own agent can propose and malformed mandates create no cards', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const other = yield* s.owner.api.agents.create({
          payload: {
            handle: 'other',
            name: 'Other',
            avatar,
            role: 'Design',
            mandate: '# Other mandate',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: s.department.id
          }
        })
        const mismatched = yield* s.tokens.mint({
          companyId: s.company.id,
          agentId: other.id,
          taskId: s.task.id
        })
        expect(
          (yield* s.request(
            '/api/agent-runtime/mandate/propose',
            { mandate: '# Changed' },
            { authorization: `Bearer ${mismatched}` }
          )).status
        ).toBe(403)
        for (const mandate of ['', '   ', 'x'.repeat(100_001)])
          expect((yield* s.propose(mandate)).status).toBe(422)
        const history = yield* s.member.api.messages.list({
          urlParams: { channelId: s.root.channelId }
        })
        expect(history.items.filter((m) => m.authorization !== undefined)).toHaveLength(0)
      })
    )

    it.effect('private proposal access is scoped to the company and conversation', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const proposal = yield* s.propose('# Private proposal').pipe(
          Effect.flatMap((r) => Effect.promise(() => r.json())),
          Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ message: Message })))
        )
        const outsider = yield* makeClient
        yield* outsider.api.auth.signup({
          payload: {
            email: `outsider-${randomUUID()}@taut.local`,
            password: 'password123',
            name: 'Outsider'
          }
        })
        yield* outsider.api.companies.create({
          payload: { slug: `other-${randomUUID().slice(0, 8)}`, name: 'Other', avatar }
        })
        const crossCompany = yield* s.request(
          `/api/messages/${proposal.message.id}/authorization`,
          { decision: 'approve' },
          { cookie: yield* outsider.cookieHeader }
        )
        expect(crossCompany.status).toBe(404)
        const invite = yield* s.owner.api.invites.create({
          payload: { email: `peer-${randomUUID()}@taut.local`, role: 'member' }
        })
        const peer = yield* makeClient
        const accepted = yield* peer.api.invites.accept({
          payload: { token: invite.token, name: 'Peer', password: 'password123' }
        })
        yield* s.owner.api.departments.addMember({
          path: { departmentId: s.department.id },
          payload: { memberKind: 'user', memberId: accepted.user.id }
        })
        const hidden = yield* peer.api.messages
          .authorization({ path: { messageId: proposal.message.id } })
          .pipe(Effect.flip)
        expect(hidden._tag).toBe('Forbidden')
      })
    )

    it.effect(
      'a reply finishing after approval cannot restore a session with the old mandate',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          const proposal = yield* s.propose('# Approved during a reply').pipe(
            Effect.flatMap((r) => Effect.promise(() => r.json())),
            Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ message: Message })))
          )
          yield* s.member.api.messages.decideAuthorization({
            path: { messageId: proposal.message.id },
            payload: { decision: 'approve' }
          })
          const sessions = yield* AgentSessions
          yield* sessions.set(
            s.agent.id,
            s.root.id,
            s.root.channelId,
            'claude-code',
            'old-session',
            s.root.id,
            '# Original mandate'
          )
          expect((yield* sessions.get(s.agent.id, s.root.id, 'claude-code'))._tag).toBe('None')
          yield* sessions.set(
            s.agent.id,
            s.root.id,
            s.root.channelId,
            'claude-code',
            'new-session',
            s.root.id,
            '# Approved during a reply'
          )
          expect((yield* sessions.get(s.agent.id, s.root.id, 'claude-code'))._tag).toBe('Some')
        })
    )

    it.effect('concurrent decisions commit exactly one result', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const proposal = yield* s.propose('# Concurrent draft').pipe(
          Effect.flatMap((r) => Effect.promise(() => r.json())),
          Effect.flatMap(Schema.decodeUnknown(Schema.Struct({ message: Message })))
        )
        const path = `/api/messages/${proposal.message.id}/authorization`
        const results = yield* Effect.all(
          [s.request(path, { decision: 'approve' }), s.request(path, { decision: 'decline' })],
          { concurrency: 'unbounded' }
        )
        expect(results.map((r) => r.status).sort()).toEqual([200, 409])
        const winner = results.find((r) => r.status === 200)!
        const message = yield* Effect.promise(() => winner.json()).pipe(
          Effect.flatMap(Schema.decodeUnknown(Message))
        )
        const agents = yield* Agents
        expect((yield* agents.byId(s.company.id, s.agent.id)).mandate).toBe(
          message.authorization?.status === 'approved' ? '# Concurrent draft' : '# Original mandate'
        )
      })
    )
  })
})
