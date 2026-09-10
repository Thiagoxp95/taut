import { layer } from '@effect/vitest'
import { Effect, Option, Schema } from 'effect'
import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect } from 'vitest'
import { TaskTokens } from '../src/agents/tokens.js'
import { Channels } from '../src/services/channels.js'
import { Messages } from '../src/services/messages.js'
import { Tasks } from '../src/services/tasks.js'
import { EventPublisher } from '../src/services/publisher.js'
import { baseUrl, makeClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const

const setup = Effect.gen(function* () {
  const suffix = randomUUID().slice(0, 8)
  const owner = yield* makeClient
  const handle = `head-${suffix}`
  yield* owner.api.auth.signup({
    payload: { email: `${handle}@taut.local`, password: 'password123', name: 'Head' }
  })
  const company = yield* owner.api.companies.create({
    payload: { slug: `inbox-${suffix}`, name: 'Inbox', avatar }
  })
  const me = yield* owner.api.auth.me()
  const department = yield* owner.api.departments.create({
    payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
  })
  const createAgent = (handle: string) =>
    owner.api.agents.create({
      payload: {
        handle,
        name: handle,
        avatar,
        role: 'Engineer',
        mandate: '# Engineer',
        runtimeKind: 'claude-code',
        permissionMode: 'plan',
        departmentId: department.id
      }
    })
  const agent = yield* createAgent('worker')
  const teammate = yield* createAgent('clarifier')
  const channels = yield* Channels
  const messages = yield* Messages
  const tasks = yield* Tasks
  const tokens = yield* TaskTokens
  const channelId = yield* channels.ensureDm(
    company.id,
    { memberKind: 'agent', memberId: agent.id },
    { memberKind: 'agent', memberId: teammate.id }
  )
  const root = yield* messages.postAsAgent(company.id, {
    agentId: teammate.id,
    channelId,
    body: 'Please DM the department head.'
  })
  const task = yield* tasks.create(company.id, {
    agentId: agent.id,
    channelId,
    threadId: root.id,
    messageId: root.id,
    triggerMessageId: root.id
  })
  const token = yield* tokens.mint({ companyId: company.id, agentId: agent.id, taskId: task.id })
  const { http } = yield* baseUrl
  const send = (body: Record<string, unknown>, credential = token) =>
    Effect.promise(() =>
      fetch(`${http}/api/agent-runtime/send`, {
        method: 'POST',
        headers: { authorization: `Bearer ${credential}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to: `@${handle}`, text: 'banana', ...body })
      })
    )
  return {
    owner,
    me,
    company,
    agent,
    teammate,
    channels,
    messages,
    tasks,
    tokens,
    channelId,
    root,
    send,
    http
  }
})

describe('agent DMs and human inbox', () => {
  layer(testAppWith(dir, makeFakeRuntime().layer), { excludeTestServices: true })((it) => {
    it.effect(
      'a finished reply becomes the newest preview and marking it read clears earlier messages',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          yield* s.send({})
          const dm = Option.getOrThrow(
            yield* s.channels.dmOf(s.company.id, s.me.user.id, {
              memberKind: 'agent',
              memberId: s.agent.id
            })
          )
          const publisher = yield* EventPublisher
          const streaming = yield* publisher.transact(s.company.id, (emit) =>
            s.messages.createStreaming(emit, {
              companyId: s.company.id,
              channelId: dm,
              agentId: s.agent.id,
              threadId: null
            })
          )
          const interim = yield* s.messages.postAsAgent(s.company.id, {
            agentId: s.agent.id,
            channelId: dm,
            body: 'Still checking'
          })
          yield* Effect.sleep('5 millis')
          yield* publisher.transact(s.company.id, (emit) =>
            s.messages.finalizeAgentMessage(emit, s.company.id, streaming.id, {
              status: 'sent',
              appendBody: 'Final answer'
            })
          )
          const inbox = yield* s.owner.api.channels.inbox()
          expect(inbox.items[0]?.body).toBe('Final answer')
          expect(inbox.items[0]?.seq).toBeGreaterThanOrEqual(interim.seq)
          yield* s.owner.api.channels.markRead({
            path: { channelId: dm },
            payload: { lastReadSeq: inbox.items[0]!.seq }
          })
          expect((yield* s.owner.api.channels.inbox()).items[0]?.unread).toBe(0)
        })
    )
    it.effect('opens a first DM to the head instead of posting in the agent conversation', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const response = yield* s.send({})
        expect(response.status).toBe(200)
        const dm = yield* s.channels.dmOf(s.company.id, s.me.user.id, {
          memberKind: 'agent',
          memberId: s.agent.id
        })
        expect(Option.isSome(dm)).toBe(true)
        const id = Option.getOrThrow(dm)
        const history = yield* s.owner.api.messages.list({ urlParams: { channelId: id } })
        expect(history.items.some((m) => m.body.includes('banana'))).toBe(true)
        const again = yield* s.send({ text: 'second message' })
        expect(again.status).toBe(200)
        const listed = yield* s.owner.api.channels.list({ urlParams: {} })
        expect(listed.items.filter((c) => c.kind === 'dm')).toHaveLength(1)
      })
    )
    it.effect(
      'a delegated agent opens its own DM instead of returning into another agent’s private DM',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          const origin = yield* s.owner.api.channels.dm({
            payload: { memberKind: 'agent', memberId: s.teammate.id }
          })
          const request = yield* s.owner.api.messages.create({
            payload: { channelId: origin.id, body: 'Tell worker to DM me banana' }
          })
          const parent = yield* s.tasks.create(s.company.id, {
            agentId: s.teammate.id,
            channelId: origin.id,
            threadId: request.id,
            messageId: request.id,
            triggerUserId: s.me.user.id
          })
          const child = yield* s.tasks.create(s.company.id, {
            agentId: s.agent.id,
            channelId: s.channelId,
            threadId: s.root.id,
            messageId: s.root.id,
            parentTaskId: parent.id
          })
          const token = yield* s.tokens.mint({
            companyId: s.company.id,
            agentId: s.agent.id,
            taskId: child.id
          })
          const response = yield* s.send({}, token)
          expect(response.status).toBe(200)
          const dm = Option.getOrThrow(
            yield* s.channels.dmOf(s.company.id, s.me.user.id, {
              memberKind: 'agent',
              memberId: s.agent.id
            })
          )
          expect(dm).not.toBe(origin.id)
          expect(
            yield* s.channels.isMember(origin.id, { memberKind: 'agent', memberId: s.agent.id })
          ).toBe(false)
        })
    )
    it.effect('an explicit DM leaves the current public conversation', () =>
      Effect.gen(function* () {
        const s = yield* setup
        const list = yield* s.owner.api.channels.list({ urlParams: {} })
        const channel = list.items.find((c) => c.kind === 'channel')!
        const root = yield* s.owner.api.messages.create({
          payload: { channelId: channel.id, body: 'DM me banana' }
        })
        const task = yield* s.tasks.create(s.company.id, {
          agentId: s.agent.id,
          channelId: channel.id,
          threadId: root.id,
          messageId: root.id,
          triggerUserId: s.me.user.id
        })
        const token = yield* s.tokens.mint({
          companyId: s.company.id,
          agentId: s.agent.id,
          taskId: task.id
        })
        expect((yield* s.send({ delivery: 'dm' }, token)).status).toBe(200)
        expect(
          Option.isSome(
            yield* s.channels.dmOf(s.company.id, s.me.user.id, {
              memberKind: 'agent',
              memberId: s.agent.id
            })
          )
        ).toBe(true)
      })
    )
    it.effect(
      'inbox retains unread incoming DMs and thread replies until read, scoped to the recipient',
      () =>
        Effect.gen(function* () {
          const s = yield* setup
          expect((yield* s.send({})).status).toBe(200)
          const cookie = yield* s.owner.cookieHeader
          const InboxPage = Schema.Struct({
            items: Schema.Array(
              Schema.Struct({
                channelId: Schema.String,
                messageId: Schema.String,
                body: Schema.String,
                unread: Schema.Number,
                seq: Schema.Number
              })
            )
          })
          const inbox = Effect.gen(function* () {
            const response = yield* Effect.promise(() =>
              fetch(`${s.http}/api/channels/inbox`, { headers: { cookie } })
            )
            expect(response.status).toBe(200)
            return yield* Effect.promise(() => response.json()).pipe(
              Effect.flatMap(Schema.decodeUnknown(InboxPage))
            )
          })
          const first = yield* inbox
          expect(first.items).toHaveLength(1)
          expect(first.items[0]).toMatchObject({ unread: 1 })
          expect(first.items[0]?.body).toContain('banana')
          const dm = Option.getOrThrow(
            yield* s.channels.dmOf(s.company.id, s.me.user.id, {
              memberKind: 'agent',
              memberId: s.agent.id
            })
          )
          const history = yield* s.owner.api.messages.list({ urlParams: { channelId: dm } })
          const reply = yield* s.messages.postAsAgent(s.company.id, {
            agentId: s.agent.id,
            channelId: dm,
            threadId: history.items[0]!.id,
            body: 'Thread follow-up'
          })
          const refreshed = yield* inbox
          expect(refreshed.items[0]).toMatchObject({
            unread: 2,
            body: 'Thread follow-up',
            messageId: reply.id
          })
          yield* s.owner.api.channels.markRead({
            path: { channelId: dm },
            payload: { lastReadSeq: reply.seq }
          })
          expect((yield* inbox).items[0]?.unread).toBe(0)
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
          const otherCookie = yield* outsider.cookieHeader
          const other = yield* Effect.promise(() =>
            fetch(`${s.http}/api/channels/inbox`, { headers: { cookie: otherCookie } })
          ).pipe(
            Effect.flatMap((r) => Effect.promise(() => r.json())),
            Effect.flatMap(Schema.decodeUnknown(InboxPage))
          )
          expect(other.items).toEqual([])
        })
    )
  })
})
