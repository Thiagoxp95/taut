import { layer } from '@effect/vitest'
import type { Company, User } from '@taut/contract/domain'
import { Effect } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { baseUrl, connect, eventFrame, makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const avatar = { kind: 'emoji', value: 'A' } as const

const state: { owner?: TestClient; ownerUser?: User; acme?: Company; token?: string } = {}
const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

/** The contract fixes the web asked for after Phase 2 (docs/CHANGELOG.md "Contract defects"). */
describe('contract fixes (message.seq · invites.preview · companies.update/delete · notification ids)', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('invites.preview is public and names the inviter, company and role', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        const signedUp = yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const invite = yield* owner.api.invites.create({
          payload: { email: 'dana@taut.local', role: 'admin' }
        })

        const anonymous = yield* makeClient
        const preview = yield* anonymous.api.invites.preview({ path: { token: invite.token } })
        expect(preview.email).toBe('dana@taut.local')
        expect(preview.role).toBe('admin')
        expect(preview.inviterName).toBe('Owner')
        expect(preview.company.id).toBe(acme.id)
        expect(preview.acceptedAt).toBeUndefined()
        const unknown = yield* Effect.flip(
          anonymous.api.invites.preview({ path: { token: 'nope' } })
        )
        expect(unknown._tag).toBe('NotFound')

        Object.assign(state, { owner, ownerUser: signedUp.user, acme, token: invite.token })
      })
    )

    it.effect(
      'message.seq equals the seq of its message.created event; nextCursor is a MessageId',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const me = need(state.ownerUser, 'owner user')
          const { ws } = yield* baseUrl
          const department = yield* owner.api.departments.create({
            payload: { name: 'Engineering', slug: 'engineering', headUserId: me.id }
          })
          const channel = need(
            (yield* owner.api.channels.list({ urlParams: { departmentId: department.id } }))
              .items[0],
            '#engineering'
          )

          const socket = yield* connect(`${ws}/ws?since=0`, yield* owner.cookieHeader)
          // Drain the replay (company + department + channel events) up to the current head.
          let head = 0
          for (;;) {
            const frame = yield* Effect.promise(socket.next)
            if (frame.type !== 'event') continue
            head = frame.event.seq
            if (frame.event.type === 'channel.created') break
          }

          const first = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: 'one' }
          })
          const live = eventFrame(yield* Effect.promise(socket.next))
          expect(live.type).toBe('message.created')
          expect(live.seq).toBe(head + 1)
          expect(first.seq).toBe(live.seq)
          if (live.type === 'message.created') expect(live.payload.message.seq).toBe(live.seq)
          expect(first.error).toBeUndefined()
          yield* Effect.promise(socket.close)

          const second = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: 'two' }
          })
          expect(second.seq).toBeGreaterThan(first.seq)

          const page = yield* owner.api.messages.list({
            urlParams: { channelId: channel.id, limit: 1 }
          })
          expect(page.items.map((m) => m.id)).toEqual([second.id])
          expect(page.nextCursor).toBe(second.id)
          // The branded cursor feeds straight back into `before`.
          const older = yield* owner.api.messages.list({
            urlParams: { channelId: channel.id, limit: 1, before: need(page.nextCursor, 'cursor') }
          })
          expect(older.items.map((m) => m.id)).toEqual([first.id])
          expect(older.items[0]?.seq).toBe(first.seq)
        })
    )

    it.effect('notification events carry channelId + messageId', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const token = need(state.token, 'token')
        const { ws } = yield* baseUrl
        const dana = yield* makeClient
        yield* dana.api.invites.accept({
          payload: { token, name: 'Dana', password: 'password123' }
        })
        const dm = yield* dana.api.channels.dm({
          payload: { memberKind: 'user', memberId: need(state.ownerUser, 'owner').id }
        })
        const socket = yield* connect(`${ws}/ws?since=0`, yield* owner.cookieHeader)
        const message = yield* dana.api.messages.create({
          payload: { channelId: dm.id, body: 'hi owner' }
        })
        let seen = false
        for (let i = 0; i < 200 && !seen; i++) {
          const frame = yield* Effect.promise(socket.next)
          if (frame.type !== 'event' || frame.event.type !== 'notification') continue
          expect(frame.event.payload.notification.kind).toBe('dm')
          expect(frame.event.payload.channelId).toBe(dm.id)
          expect(frame.event.payload.messageId).toBe(message.id)
          seen = true
        }
        expect(seen).toBe(true)
        yield* Effect.promise(socket.close)
      })
    )

    it.effect(
      'companies.update is admin+ and emits company.updated; delete is Forbidden in single-company mode',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const acme = need(state.acme, 'acme')
          const updated = yield* owner.api.companies.update({
            path: { companyId: acme.id },
            payload: { name: 'Acme Inc', avatar: { kind: 'emoji', value: '🏢' } }
          })
          expect(updated).toMatchObject({ id: acme.id, slug: 'acme', name: 'Acme Inc' })
          expect((yield* owner.api.companies.get({ path: { companyId: acme.id } })).name).toBe(
            'Acme Inc'
          )

          // dana (admin via the invite) may update; the outsider gets 404 (no leaking).
          const dana = yield* makeClient
          yield* dana.api.auth.login({
            payload: { email: 'dana@taut.local', password: 'password123' }
          })
          const byDana = yield* dana.api.companies.update({
            path: { companyId: acme.id },
            payload: { name: 'Acme Corp' }
          })
          expect(byDana.name).toBe('Acme Corp')
          const stranger = yield* makeClient
          yield* stranger.api.auth.signup({
            payload: { email: 'x@taut.local', password: 'password123', name: 'X' }
          })
          const hidden = yield* Effect.flip(
            stranger.api.companies.update({ path: { companyId: acme.id }, payload: { name: 'X' } })
          )
          expect(hidden._tag).toBe('NotFound')

          const notOwner = yield* Effect.flip(
            dana.api.companies.delete({ path: { companyId: acme.id } })
          )
          expect(notOwner._tag).toBe('Forbidden')
          const singleCompany = yield* Effect.flip(
            owner.api.companies.delete({ path: { companyId: acme.id } })
          )
          expect(singleCompany._tag).toBe('Forbidden')
          expect(singleCompany.message).toContain('only company')
        })
    )
  })
})
