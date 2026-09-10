import { layer } from '@effect/vitest'
import { CanvasCreateResponse, CanvasListResponse } from '@taut/taut-mcp/protocol'
import type { AgentId, ChannelId, MessageId } from '@taut/contract/ids'
import { Effect, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { TaskTokens } from '../src/agents/tokens.js'
import { Canvases } from '../src/services/canvases.js'
import { Tasks } from '../src/services/tasks.js'
import { baseUrl, connect, makeClient, type SocketClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const
let fixtureNumber = 0

const setup = Effect.gen(function* () {
  const suffix = ++fixtureNumber
  const owner = yield* makeClient
  yield* owner.api.auth.signup({
    payload: { email: `canvas-owner-${suffix}@taut.local`, password: 'password123', name: 'Owner' }
  })
  const company = yield* owner.api.companies.create({
    payload: { slug: `canvas-life-${suffix}`, name: 'Canvas lifecycle', avatar }
  })
  const me = yield* owner.api.auth.me()
  const dept = yield* owner.api.departments.create({
    payload: { name: 'Design', slug: 'design', headUserId: me.user.id }
  })
  const createAgent = (handle: string) =>
    owner.api.agents.create({
      payload: {
        handle,
        name: handle,
        avatar,
        role: 'Design',
        mandate: '# Design',
        runtimeKind: 'claude-code',
        permissionMode: 'plan',
        departmentId: dept.id
      }
    })
  const agent = yield* createAgent('designer')
  const otherAgent = yield* createAgent('reviewer')
  const channels = yield* owner.api.channels.list({ urlParams: {} })
  const channel = channels.items.find((c) => c.name === 'design')!
  const root = yield* owner.api.messages.create({
    payload: { channelId: channel.id, body: 'Canvas request' }
  })
  const otherRoot = yield* owner.api.messages.create({
    payload: { channelId: channel.id, body: 'Another conversation' }
  })
  const tasks = yield* Tasks
  const tokens = yield* TaskTokens
  const tokenFor = (
    scope: { agentId?: AgentId; channelId?: ChannelId; threadId?: MessageId } = {
      threadId: root.id
    }
  ) =>
    Effect.gen(function* () {
      const agentId = scope.agentId ?? agent.id
      const channelId = scope.channelId ?? channel.id
      const threadId =
        scope.threadId ??
        (channelId === channel.id
          ? root.id
          : (yield* owner.api.messages.create({
              payload: { channelId, body: 'Private canvas request' }
            })).id)
      const task = yield* tasks.create(company.id, {
        agentId,
        channelId,
        threadId,
        messageId: threadId,
        triggerUserId: me.user.id
      })
      return yield* tokens.mint({ companyId: company.id, agentId, taskId: task.id })
    })
  const token = yield* tokenFor()
  const { http, ws } = yield* baseUrl
  const cookie = yield* owner.cookieHeader
  const request = (credential: string | undefined, action: string, input?: unknown) =>
    Effect.promise(() =>
      fetch(`${http}/api/agent-runtime/canvases${action}`, {
        method: input === undefined ? 'GET' : 'POST',
        headers: {
          ...(credential === undefined ? {} : { authorization: `Bearer ${credential}` }),
          'content-type': 'application/json'
        },
        ...(input === undefined ? {} : { body: JSON.stringify(input) })
      })
    )
  const change = (credential: string, action: string, input: unknown) =>
    Effect.gen(function* () {
      const response = yield* request(credential, action, input)
      expect(response.status).toBe(200)
      return yield* Effect.promise(() => response.json()).pipe(
        Effect.tap((body) =>
          Effect.sync(() => expect(JSON.stringify(body)).not.toContain('"html"'))
        ),
        Effect.flatMap(Schema.decodeUnknown(CanvasCreateResponse)),
        Effect.map((body) => body.canvas)
      )
    })
  const list = (credential: string) =>
    Effect.gen(function* () {
      const response = yield* request(credential, '')
      expect(response.status).toBe(200)
      return yield* Effect.promise(() => response.json()).pipe(
        Effect.tap((body) =>
          Effect.sync(() => expect(JSON.stringify(body)).not.toContain('"html"'))
        ),
        Effect.flatMap(Schema.decodeUnknown(CanvasListResponse)),
        Effect.map((body) => body.items)
      )
    })
  const read = (channelId: ChannelId, id?: string, userCookie: string = cookie) =>
    Effect.promise(() =>
      fetch(`${http}/api/channels/${channelId}/canvases${id === undefined ? '' : `/${id}`}`, {
        headers: { cookie: userCookie }
      })
    )
  return {
    owner,
    company,
    me,
    dept,
    agent,
    otherAgent,
    channel,
    root,
    otherRoot,
    tokenFor,
    token,
    change,
    list,
    read,
    request,
    cookie,
    ws
  }
})

const readUntilCanvas = (socket: SocketClient, id: string) =>
  Effect.promise(async () => {
    const canvases = []
    for (let count = 0; count < 100; count++) {
      const frame = await socket.next()
      if (frame.type !== 'event' || frame.event.type !== 'canvas.changed') continue
      canvases.push(frame.event.payload.canvas)
      if (frame.event.payload.canvas.id === id) return canvases
    }
    throw new Error('Canvas sentinel did not arrive')
  })

describe('canvas lifecycle and authorization', () => {
  layer(testAppWith(dir, makeFakeRuntime().layer), { excludeTestServices: true })((it) => {
    it.effect(
      'keeps multiple documents independent while updates and presentation advance revisions',
      () =>
        Effect.gen(function* () {
          const f = yield* setup
          const first = yield* f.change(f.token, '/create', {
            title: 'Yellow',
            html: '<aside>Yellow</aside>'
          })
          const second = yield* f.change(f.token, '/create', {
            title: 'Blue',
            html: '<aside>Blue</aside>',
            open: false
          })
          expect(first).toMatchObject({ open: true, revision: 1 })
          expect(second).toMatchObject({ open: false, revision: 1 })
          expect(first.id).not.toBe(second.id)
          const revised = yield* f.change(f.token, '/update', {
            canvasId: second.id,
            html: '<aside>Green</aside>'
          })
          expect(revised).toMatchObject({ title: 'Blue', open: false, revision: 2 })
          const closed = yield* f.change(f.token, '/close', { canvasId: first.id })
          expect(closed).toMatchObject({ open: false, revision: 2 })
          const reopened = yield* f.change(f.token, '/open', { canvasId: first.id })
          expect(reopened).toMatchObject({ open: true, revision: 3 })
          const presentedAgain = yield* f.change(f.token, '/open', { canvasId: first.id })
          expect(presentedAgain).toMatchObject({ open: true, revision: 4 })
          const retitled = yield* f.change(f.token, '/update', {
            canvasId: first.id,
            title: 'Golden sidebar'
          })
          expect(retitled).toMatchObject({ open: true, revision: 5 })
          const readFirst = yield* f.read(f.channel.id, first.id)
          expect(yield* Effect.promise(() => readFirst.json())).toMatchObject({
            html: '<aside>Yellow</aside>',
            title: 'Golden sidebar'
          })
          const readSecond = yield* f.read(f.channel.id, second.id)
          expect(yield* Effect.promise(() => readSecond.json())).toMatchObject({
            html: '<aside>Green</aside>',
            title: 'Blue',
            open: false,
            revision: 2
          })
          const items = yield* f.list(f.token)
          expect(items.map((item) => item.id).sort()).toEqual([first.id, second.id].sort())
          expect(JSON.stringify(items)).not.toContain('<aside>')
        })
    )

    it.effect('scopes listing and mutations to the agent and task thread, across task tokens', () =>
      Effect.gen(function* () {
        const f = yield* setup
        const own = yield* f.change(f.token, '/create', { title: 'Own', html: '<p>Own</p>' })
        const otherAgentToken = yield* f.tokenFor({ agentId: f.otherAgent.id, threadId: f.root.id })
        const otherThreadToken = yield* f.tokenFor({ threadId: f.otherRoot.id })
        for (const token of [otherAgentToken, otherThreadToken]) {
          expect(yield* f.list(token)).toEqual([])
          for (const action of ['/update', '/open', '/close']) {
            const result = yield* f.request(token, action, {
              canvasId: own.id,
              ...(action === '/update' ? { title: 'Hijacked' } : {})
            })
            expect(result.status).toBe(404)
          }
        }
        const theirs = yield* f.change(otherAgentToken, '/create', {
          title: 'Other agent',
          html: '<p>Theirs</p>'
        })
        const elsewhere = yield* f.change(otherThreadToken, '/create', {
          title: 'Other thread',
          html: '<p>Elsewhere</p>'
        })
        expect((yield* f.list(f.token)).map((c) => c.id)).toEqual([own.id])
        expect((yield* f.list(otherAgentToken)).map((c) => c.id)).toEqual([theirs.id])
        expect((yield* f.list(otherThreadToken)).map((c) => c.id)).toEqual([elsewhere.id])
        const nextTaskToken = yield* f.tokenFor()
        expect((yield* f.list(nextTaskToken)).map((c) => c.id)).toEqual([own.id])
        expect(yield* f.change(nextTaskToken, '/close', { canvasId: own.id })).toMatchObject({
          open: false,
          revision: 2
        })
      })
    )

    it.effect(
      'rejects unauthenticated, invalid and oversized documents without creating or mutating a canvas',
      () =>
        Effect.gen(function* () {
          const f = yield* setup
          expect(
            (yield* f.request(undefined, '/create', { title: 'No auth', html: '<p>x</p>' })).status
          ).toBe(401)
          expect((yield* f.request(undefined, '')).status).toBe(401)
          const invalid = [
            { title: '', html: '<p>x</p>' },
            { title: ' ', html: '<p>x</p>' },
            { title: 'x'.repeat(201), html: '<p>x</p>' },
            { title: 'Preview', html: '' },
            { title: 'Preview', html: '   ' },
            { title: 'Preview', html: 'x'.repeat(1_000_001) },
            // Below one million UTF-16 characters but above one million UTF-8 bytes.
            { title: 'Preview', html: 'é'.repeat(500_001) }
          ]
          for (const input of invalid)
            expect((yield* f.request(f.token, '/create', input)).status).toBe(422)
          expect(yield* f.list(f.token)).toEqual([])
          const own = yield* f.change(f.token, '/create', {
            title: 'Original',
            html: '<p>Original</p>'
          })
          expect((yield* f.request(f.token, '/update', { canvasId: own.id })).status).toBe(422)
          for (const input of invalid)
            expect(
              (yield* f.request(f.token, '/update', { canvasId: own.id, ...input })).status
            ).toBe(422)
          expect(yield* f.list(f.token)).toEqual([own])
        })
    )

    it.effect(
      'hides channel metadata and HTML from another company and from private DM nonmembers',
      () =>
        Effect.gen(function* () {
          const f = yield* setup
          const outsider = yield* makeClient
          yield* outsider.api.auth.signup({
            payload: {
              email: 'canvas-outsider@taut.local',
              password: 'password123',
              name: 'Outsider'
            }
          })
          yield* outsider.api.companies.create({
            payload: { slug: 'canvas-outsider', name: 'Other company', avatar }
          })
          const outsiderCookie = yield* outsider.cookieHeader
          const canvas = yield* f.change(f.token, '/create', {
            title: 'Company secret',
            html: '<p>Company HTML secret</p>'
          })
          for (const id of [undefined, canvas.id]) {
            const denied = yield* f.read(f.channel.id, id, outsiderCookie)
            expect(denied.status).toBe(404)
            expect(yield* Effect.promise(() => denied.text())).not.toContain('secret')
          }
          const invite = yield* f.owner.api.invites.create({
            payload: { email: 'canvas-nonmember@taut.local', role: 'member' }
          })
          const nonmember = yield* makeClient
          const accepted = yield* nonmember.api.invites.accept({
            payload: { token: invite.token, name: 'Nonmember', password: 'password123' }
          })
          const nonmemberCookie = yield* nonmember.cookieHeader
          const dm = yield* f.owner.api.channels.dm({
            payload: { memberKind: 'agent', memberId: f.agent.id }
          })
          const dmToken = yield* f.tokenFor({ channelId: dm.id })
          const privateCanvas = yield* f.change(dmToken, '/create', {
            title: 'Private title',
            html: '<p>Private HTML</p>'
          })
          for (const id of [undefined, privateCanvas.id]) {
            const denied = yield* f.read(dm.id, id, nonmemberCookie)
            expect(denied.status).toBe(403)
            expect(yield* Effect.promise(() => denied.text())).not.toContain('Private')
          }
          expect((yield* f.read(dm.id, privateCanvas.id)).status).toBe(200)
          const canvases = yield* Canvases
          expect(yield* canvases.visibleTo(f.company.id, dm.id, accepted.user.id)).toBe(false)
          expect(yield* canvases.visibleTo(f.company.id, dm.id, f.me.user.id)).toBe(true)
          expect(
            yield* canvases.visibleTo(f.company.id, dm.id, (yield* outsider.api.auth.me()).user.id)
          ).toBe(false)
        })
    )

    it.effect(
      'filters private canvas events on both live sockets and replay while delivering a visible sentinel',
      () =>
        Effect.gen(function* () {
          const f = yield* setup
          const invite = yield* f.owner.api.invites.create({
            payload: { email: 'canvas-socket@taut.local', role: 'member' }
          })
          const member = yield* makeClient
          const accepted = yield* member.api.invites.accept({
            payload: { token: invite.token, name: 'Viewer', password: 'password123' }
          })
          yield* f.owner.api.departments.addMember({
            path: { departmentId: f.dept.id },
            payload: { memberKind: 'user', memberId: accepted.user.id }
          })
          const memberCookie = yield* member.cookieHeader
          const dm = yield* f.owner.api.channels.dm({
            payload: { memberKind: 'agent', memberId: f.agent.id }
          })
          const privateToken = yield* f.tokenFor({ channelId: dm.id })
          const memberSocket = yield* Effect.acquireRelease(
            connect(`${f.ws}/ws`, memberCookie),
            (socket) => Effect.promise(() => socket.close())
          )
          const ownerSocket = yield* Effect.acquireRelease(
            connect(`${f.ws}/ws`, f.cookie),
            (socket) => Effect.promise(() => socket.close())
          )
          const initial = yield* Effect.promise(() => memberSocket.next())
          expect(initial.type).toBe('resync')
          if (initial.type !== 'resync') throw new Error('Expected initial cursor')
          expect((yield* Effect.promise(() => ownerSocket.next())).type).toBe('resync')
          const privateCanvas = yield* f.change(privateToken, '/create', {
            title: 'Private socket title',
            html: '<p>Private socket HTML</p>'
          })
          const sentinel = yield* f.change(f.token, '/create', {
            title: 'Visible sentinel',
            html: '<p>Visible HTML</p>'
          })
          expect((yield* readUntilCanvas(memberSocket, sentinel.id)).map((c) => c.id)).toEqual([
            sentinel.id
          ])
          const ownerEvents = yield* readUntilCanvas(ownerSocket, sentinel.id)
          expect(ownerEvents.map((c) => c.id)).toEqual([privateCanvas.id, sentinel.id])
          expect(JSON.stringify(ownerEvents)).not.toContain('Private socket HTML')
          const memberReplay = yield* Effect.acquireRelease(
            connect(`${f.ws}/ws?since=${initial.head}`, memberCookie),
            (socket) => Effect.promise(() => socket.close())
          )
          const ownerReplay = yield* Effect.acquireRelease(
            connect(`${f.ws}/ws?since=${initial.head}`, f.cookie),
            (socket) => Effect.promise(() => socket.close())
          )
          expect((yield* readUntilCanvas(memberReplay, sentinel.id)).map((c) => c.id)).toEqual([
            sentinel.id
          ])
          expect((yield* readUntilCanvas(ownerReplay, sentinel.id)).map((c) => c.id)).toEqual([
            privateCanvas.id,
            sentinel.id
          ])
        }).pipe(Effect.scoped)
    )
  })
})
