import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Channel, Company, Department, User } from '@taut/contract/domain'
import type { Event } from '@taut/contract/events'
import { UserId } from '@taut/contract/ids'
import { Chunk, Effect, Schema, Stream } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { EventLog } from '../src/realtime/eventLog.js'
import { baseUrl, connect, eventFrame, makeClient, sleep, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const avatar = { kind: 'emoji', value: 'A' } as const

/** State threaded through the ordered tests below (one server, one database). */
const state: {
  owner?: TestClient
  dana?: TestClient
  bob?: TestClient
  ownerUser?: User
  danaUser?: User
  acme?: Company
  engineering?: Department
  design?: Department
  engineeringChannel?: Channel
  dm?: Channel
  lastMessageSeq?: number
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const NotificationRows = Schema.Array(
  Schema.Struct({ user_id: Schema.String, kind: Schema.String })
)

describe('domain (auth → companies → invites → departments → channels → messages → ws)', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('signup → me → login', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        const signedUp = yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        expect(signedUp.user.email).toBe('owner@taut.local')
        expect(yield* owner.cookieHeader).toContain('taut_session=ses_')

        const me = yield* owner.api.auth.me()
        expect(me.user.id).toBe(signedUp.user.id)
        expect(me.memberships).toEqual([])
        expect(me.activeCompanyId).toBeUndefined()

        const duplicate = yield* Effect.flip(
          owner.api.auth.signup({
            payload: { email: 'OWNER@taut.local', password: 'password123', name: 'Dup' }
          })
        )
        expect(duplicate._tag).toBe('Conflict')

        const again = yield* makeClient
        const wrong = yield* Effect.flip(
          again.api.auth.login({ payload: { email: 'owner@taut.local', password: 'nope-nope' } })
        )
        expect(wrong._tag).toBe('Unauthorized')
        const ok = yield* again.api.auth.login({
          payload: { email: 'owner@taut.local', password: 'password123' }
        })
        expect(ok.user.id).toBe(signedUp.user.id)
        yield* again.api.auth.logout()
        const loggedOut = yield* Effect.flip(again.api.auth.me())
        expect(loggedOut._tag).toBe('Unauthorized')

        state.owner = owner
        state.ownerUser = signedUp.user
      })
    )

    it.effect(
      'company create makes the creator owner and the active company; more than one is allowed',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = yield* owner.api.companies.create({
            payload: { slug: 'acme', name: 'Acme', avatar }
          })
          expect(acme.slug).toBe('acme')
          const me = yield* owner.api.auth.me()
          expect(me.activeCompanyId).toBe(acme.id)
          expect(me.memberships).toEqual([{ company: acme, role: 'owner' }])

          const second = yield* owner.api.companies.create({
            payload: { slug: 'acme-2', name: 'Acme 2', avatar }
          })
          const afterSecond = yield* owner.api.auth.me()
          expect(afterSecond.activeCompanyId).toBe(second.id)
          const both = yield* owner.api.companies.list({ urlParams: {} })
          expect(new Set(both.items.map((i) => i.company.id))).toEqual(
            new Set([acme.id, second.id])
          )

          // The rest of this suite lives in acme, so drop the second one and go back.
          yield* owner.api.companies.delete({ path: { companyId: second.id } })
          yield* owner.api.companies.switch({ path: { companyId: acme.id } })

          const list = yield* owner.api.companies.list({ urlParams: {} })
          expect(list.items.map((i) => i.company.id)).toEqual([acme.id])
          state.acme = acme
        })
    )

    it.effect('invite → accept creates the user + membership and logs them in', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const acme = need(state.acme, 'acme')
        const invite = yield* owner.api.invites.create({
          payload: { email: 'dana@taut.local', role: 'member' }
        })
        expect(invite.token.length).toBeGreaterThan(30)
        expect((yield* owner.api.invites.list({ urlParams: {} })).items.map((i) => i.id)).toEqual([
          invite.id
        ])

        const dana = yield* makeClient
        const accepted = yield* dana.api.invites.accept({
          payload: { token: invite.token, name: 'Dana', password: 'password123' }
        })
        expect(accepted.company.id).toBe(acme.id)
        expect(accepted.membership.role).toBe('member')
        const me = yield* dana.api.auth.me()
        expect(me.user.email).toBe('dana@taut.local')
        expect(me.activeCompanyId).toBe(acme.id)

        const twice = yield* Effect.flip(
          dana.api.invites.accept({ payload: { token: invite.token } })
        )
        expect(twice._tag).toBe('Conflict')
        const forbidden = yield* Effect.flip(
          dana.api.invites.create({ payload: { email: 'x@taut.local', role: 'member' } })
        )
        expect(forbidden._tag).toBe('Forbidden')

        const members = yield* owner.api.companies.members({
          path: { companyId: acme.id },
          urlParams: {}
        })
        expect(members.items.map((m) => [m.user.email, m.role])).toEqual([
          ['owner@taut.local', 'owner'],
          ['dana@taut.local', 'member']
        ])
        state.dana = dana
        state.danaUser = accepted.user
      })
    )

    it.effect(
      'departments: admin creates (+ default channel); head manages, plain member cannot',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const ownerUser = need(state.ownerUser, 'ownerUser')
          const danaUser = need(state.danaUser, 'danaUser')

          const engineering = yield* owner.api.departments.create({
            payload: { name: 'Engineering', slug: 'engineering', headUserId: ownerUser.id }
          })
          const design = yield* owner.api.departments.create({
            payload: { name: 'Design', slug: 'design', headUserId: danaUser.id }
          })
          const channels = yield* owner.api.channels.list({ urlParams: {} })
          expect(channels.items.map((c) => [c.name, c.departmentId])).toEqual([
            ['engineering', engineering.id],
            ['design', design.id]
          ])

          const memberCreates = yield* Effect.flip(
            dana.api.departments.create({
              payload: { name: 'Ops', slug: 'ops', headUserId: danaUser.id }
            })
          )
          expect(memberCreates._tag).toBe('Forbidden')

          // dana heads Design: she may add members there …
          const added = yield* dana.api.departments.addMember({
            path: { departmentId: design.id },
            payload: { memberKind: 'user', memberId: ownerUser.id }
          })
          expect(added.memberId).toBe(ownerUser.id)
          // … but not in Engineering, where she is a plain member of the company.
          const denied = yield* Effect.flip(
            dana.api.departments.addMember({
              path: { departmentId: engineering.id },
              payload: { memberKind: 'user', memberId: danaUser.id }
            })
          )
          expect(denied._tag).toBe('Forbidden')

          // owner (admin) adds dana to Engineering → she joins its channels too
          yield* owner.api.departments.addMember({
            path: { departmentId: engineering.id },
            payload: { memberKind: 'user', memberId: danaUser.id }
          })
          const detail = yield* owner.api.departments.get({
            path: { departmentId: engineering.id }
          })
          expect(detail.members.map((m) => m.memberId).sort()).toEqual(
            [ownerUser.id, danaUser.id].sort()
          )
          const engineeringChannel = need(channels.items[0], 'engineering channel')
          const chMembers = yield* dana.api.channels.members({
            path: { channelId: engineeringChannel.id },
            urlParams: {}
          })
          expect(chMembers.items.map((m) => m.memberId).sort()).toEqual(
            [ownerUser.id, danaUser.id].sort()
          )
          const unknownHead = yield* Effect.flip(
            owner.api.departments.setHead({
              path: { departmentId: design.id },
              payload: { headUserId: UserId.make('usr_nobody') }
            })
          )
          expect(unknownHead._tag).toBe('NotFound')

          state.engineering = engineering
          state.design = design
          state.engineeringChannel = engineeringChannel
        })
    )

    it.effect('company isolation: a user of company B gets 404 for A’s resources', () =>
      Effect.gen(function* () {
        const acme = need(state.acme, 'acme')
        const channel = need(state.engineeringChannel, 'engineering channel')
        const bob = yield* makeClient
        yield* bob.api.auth.signup({
          payload: { email: 'bob@beta.local', password: 'password123', name: 'Bob' }
        })
        yield* bob.api.companies.create({ payload: { slug: 'beta', name: 'Beta', avatar } })

        const getChannel = yield* Effect.flip(
          bob.api.channels.get({ path: { channelId: channel.id } })
        )
        expect(getChannel._tag).toBe('NotFound')
        const post = yield* Effect.flip(
          bob.api.messages.create({ payload: { channelId: channel.id, body: 'hi' } })
        )
        expect(post._tag).toBe('NotFound')
        const list = yield* Effect.flip(
          bob.api.messages.list({ urlParams: { channelId: channel.id } })
        )
        expect(list._tag).toBe('NotFound')
        const company = yield* Effect.flip(bob.api.companies.get({ path: { companyId: acme.id } }))
        expect(company._tag).toBe('NotFound')
        expect((yield* bob.api.channels.list({ urlParams: {} })).items).toEqual([])
        state.bob = bob
      })
    )

    it.effect('dm open is find-or-create and symmetric', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dana = need(state.dana, 'dana')
        const ownerUser = need(state.ownerUser, 'ownerUser')
        const danaUser = need(state.danaUser, 'danaUser')
        const first = yield* owner.api.channels.dm({
          payload: { memberKind: 'user', memberId: danaUser.id }
        })
        expect(first.kind).toBe('dm')
        expect(first.departmentId).toBeUndefined()
        const second = yield* owner.api.channels.dm({
          payload: { memberKind: 'user', memberId: danaUser.id }
        })
        const fromDana = yield* dana.api.channels.dm({
          payload: { memberKind: 'user', memberId: ownerUser.id }
        })
        expect(second.id).toBe(first.id)
        expect(fromDana.id).toBe(first.id)
        const members = yield* dana.api.channels.members({
          path: { channelId: first.id },
          urlParams: {}
        })
        expect(members.items).toHaveLength(2)
        const self = yield* Effect.flip(
          owner.api.channels.dm({ payload: { memberKind: 'user', memberId: ownerUser.id } })
        )
        expect(self._tag).toBe('Validation')
        state.dm = first
      })
    )

    it.effect(
      'message create appends message.created with the next seq, mentions, notifications',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const acme = need(state.acme, 'acme')
          const danaUser = need(state.danaUser, 'danaUser')
          const channel = need(state.engineeringChannel, 'engineering channel')
          const log = yield* EventLog
          const sql = yield* SqlClient.SqlClient

          const before = yield* log.latestSeq(acme.id)
          const message = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: 'hello @dana, welcome!' }
          })
          expect(message.body).toBe('hello @dana, welcome!')
          expect(message.authorKind).toBe('user')

          const events = Chunk.toReadonlyArray(
            yield* log.since(acme.id, before).pipe(Stream.runCollect)
          )
          const created = events[0]
          expect(created?.type).toBe('message.created')
          expect(created?.seq).toBe(before + 1)
          if (created?.type === 'message.created') {
            expect(created.payload.message.id).toBe(message.id)
            expect(created.payload.mentions).toEqual([
              { memberKind: 'user', memberId: danaUser.id, handle: 'dana' }
            ])
          }
          const notification = events.find(
            (e): e is Extract<Event, { type: 'notification' }> => e.type === 'notification'
          )
          expect(notification?.payload.notification.userId).toBe(danaUser.id)
          expect(notification?.payload.notification.kind).toBe('mention')
          expect(notification?.payload.notification.eventSeq).toBe(before + 1)
          const unread = events.filter((e) => e.type === 'unread.changed')
          expect(unread).toHaveLength(1)
          if (unread[0]?.type === 'unread.changed') {
            expect(unread[0].payload).toMatchObject({
              userId: danaUser.id,
              channelId: channel.id,
              unread: 1,
              mentions: 1
            })
          }
          const rows =
            yield* sql`SELECT user_id, kind FROM notifications WHERE company_id = ${acme.id}`.pipe(
              Effect.flatMap(Schema.decodeUnknown(NotificationRows))
            )
          expect(rows).toEqual([{ user_id: danaUser.id, kind: 'mention' }])

          // list newest-first with cursor paging; thread; edit; markRead clears the counters
          const beforeReply = yield* log.latestSeq(acme.id)
          const reply = yield* dana.api.messages.create({
            payload: { channelId: channel.id, threadId: message.id, body: 'thanks!' }
          })
          expect(reply.threadId).toBe(message.id)
          // A reply re-publishes its root, so open clients update the reply bar.
          const replyEvents = Chunk.toReadonlyArray(
            yield* log.since(acme.id, beforeReply).pipe(Stream.runCollect)
          )
          expect(
            replyEvents.some(
              (e) => e.type === 'message.updated' && e.payload.message.id === message.id
            )
          ).toBe(true)
          const second = yield* dana.api.messages.create({
            payload: { channelId: channel.id, body: 'second top-level' }
          })
          const page1 = yield* owner.api.messages.list({
            urlParams: { channelId: channel.id, limit: 1 }
          })
          expect(page1.items.map((m) => m.id)).toEqual([second.id])
          expect(page1.nextCursor).toBe(second.id)
          const page2 = yield* owner.api.messages.list({
            urlParams: { channelId: channel.id, limit: 1, before: second.id }
          })
          expect(page2.items.map((m) => m.id)).toEqual([message.id])
          const thread = yield* owner.api.messages.thread({
            path: { threadId: message.id },
            urlParams: {}
          })
          expect(thread.items.map((m) => m.id)).toEqual([reply.id])
          // A reply is never itself a thread root.
          expect(thread.items[0]?.thread).toBeUndefined()

          // The root advertises its thread: count, last reply, and who replied.
          expect(page2.items[0]?.thread?.replyCount).toBe(1)
          expect(page2.items[0]?.thread?.participants).toEqual([{ kind: 'user', id: danaUser.id }])
          expect(page2.items[0]?.thread?.lastReplyAt).toBeDefined()
          // A top-level message with no replies carries no summary.
          expect(page1.items[0]?.thread).toBeUndefined()

          const edited = yield* owner.api.messages.edit({
            path: { messageId: message.id },
            payload: { body: 'hello @dana (edited)' }
          })
          expect(edited.editedAt).toBeDefined()
          // Editing the root must not drop its reply bar.
          expect(edited.thread?.replyCount).toBe(1)
          const notAuthor = yield* Effect.flip(
            dana.api.messages.edit({ path: { messageId: message.id }, payload: { body: 'x' } })
          )
          expect(notAuthor._tag).toBe('Forbidden')

          const head = yield* log.latestSeq(acme.id)
          const read = yield* dana.api.channels.markRead({
            path: { channelId: channel.id },
            payload: { lastReadSeq: head }
          })
          expect(read.lastReadSeq).toBe(head)
          const afterRead = Chunk.toReadonlyArray(
            yield* log.since(acme.id, head).pipe(Stream.runCollect)
          )
          expect(afterRead.map((e) => e.type)).toEqual(['unread.changed'])
          if (afterRead[0]?.type === 'unread.changed') {
            expect(afterRead[0].payload).toMatchObject({
              userId: danaUser.id,
              unread: 0,
              mentions: 0
            })
          }
          state.lastMessageSeq = before + 1
        })
    )

    it.effect('ws: replay from ?since, per-user filtering, live delivery, resume', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dana = need(state.dana, 'dana')
        const danaUser = need(state.danaUser, 'danaUser')
        const channel = need(state.engineeringChannel, 'engineering channel')
        const { ws } = yield* baseUrl
        const cookie = yield* dana.cookieHeader

        // replay everything: dana sees message.created but only her own unread events, and
        // no notification at all — a catch-up must not re-fire alerts she already lived through
        const socket = yield* connect(`${ws}/ws?since=0`, cookie)
        const seen: Array<ReturnType<typeof eventFrame>> = []
        let lastSeq = 0
        while (true) {
          const event = eventFrame(yield* Effect.promise(socket.next))
          seen.push(event)
          lastSeq = event.seq
          if (event.type === 'unread.changed' && event.payload.unread === 0) break
        }
        expect(seen.some((e) => e.type === 'message.created')).toBe(true)
        expect(seen.some((e) => e.type === 'notification')).toBe(false)
        for (const event of seen) {
          if (event.type === 'unread.changed') expect(event.payload.userId).toBe(danaUser.id)
        }
        expect(seen.map((e) => e.seq)).toEqual([...seen.map((e) => e.seq)].sort((a, b) => a - b))

        // live
        const live = yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: 'live one' }
        })
        const liveEvent = eventFrame(yield* Effect.promise(socket.next))
        expect(liveEvent.type).toBe('message.created')
        if (liveEvent.type === 'message.created') expect(liveEvent.payload.message.id).toBe(live.id)
        expect(liveEvent.seq).toBeGreaterThan(lastSeq)
        const liveSeq = liveEvent.seq
        yield* Effect.promise(socket.close)

        // resume: nothing at or before `since` is replayed
        const offline = yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: 'while dana was away' }
        })
        const resumed = yield* connect(`${ws}/ws?since=${liveSeq}`, cookie)
        const first = eventFrame(yield* Effect.promise(resumed.next))
        expect(first.seq).toBeGreaterThan(liveSeq)
        let found = first.type === 'message.created' && first.payload.message.id === offline.id
        while (!found) {
          const e = eventFrame(yield* Effect.promise(resumed.next))
          found = e.type === 'message.created' && e.payload.message.id === offline.id
        }
        // trailing per-user events (dana's unread.changed) may still be queued before the pong
        resumed.ws.send(JSON.stringify({ type: 'ping' }))
        let frame = yield* Effect.promise(resumed.next)
        while (frame.type !== 'pong') frame = yield* Effect.promise(resumed.next)
        expect(frame).toEqual({ type: 'pong' })
        yield* Effect.promise(resumed.close)
        yield* sleep(20)
      })
    )
  })
})
