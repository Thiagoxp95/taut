import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Channel, Message, User } from '@taut/contract/domain'
import { MessageId } from '@taut/contract/ids'
import { Effect, Schema } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Reactions, isValidEmoji } from '../src/services/reactions.js'
import { baseUrl, connect, eventFrame, makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

/**
 * Emoji reactions (docs/build-plan-message-actions.md D1–D4): `PUT`/`DELETE
 * /api/messages/:id/reactions/:emoji`, the hydrated `Message.reactions`, the `message.updated`
 * frame, and the cascade from `messages`.
 */

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
  atlas?: Channel
  message?: Message
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const Count = Schema.Struct({ n: Schema.Number })

/** `SELECT COUNT(*)` on the table itself — the cascade assertion must not go through the service. */
const rowsFor = (messageId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows =
      yield* sql`SELECT COUNT(*) AS n FROM message_reactions WHERE message_id = ${messageId}`.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Tuple(Count)))
      )
    return rows[0].n
  })

/**
 * The raw wire form of D3: `:emoji` percent-encoded in the path, no typed client in between —
 * for the inputs the typed client cannot even send (a bare space is stripped by the URL parser).
 */
const rawReact = (client: TestClient, messageId: string, emoji: string, method: 'PUT' | 'DELETE') =>
  Effect.gen(function* () {
    const { http } = yield* baseUrl
    const cookie = yield* client.cookieHeader
    return yield* Effect.promise(() =>
      fetch(`${http}/api/messages/${messageId}/reactions/${encodeURIComponent(emoji)}`, {
        method,
        headers: { cookie }
      })
    )
  })

const TestLive = testApp(dir)

describe('isValidEmoji', () => {
  layer(TestLive, { excludeTestServices: true })((it) => {
    it.effect(
      'accepts 1–8 code points and rejects letters, digits, whitespace and the empty string',
      () =>
        Effect.sync(() => {
          expect(isValidEmoji('👍')).toBe(true)
          expect(isValidEmoji('👍🏽')).toBe(true)
          expect(isValidEmoji('👩‍💻')).toBe(true)
          expect(isValidEmoji('✅')).toBe(true)
          expect(isValidEmoji('a')).toBe(false)
          expect(isValidEmoji('ab')).toBe(false)
          expect(isValidEmoji(' ')).toBe(false)
          expect(isValidEmoji('👍 ')).toBe(false)
          expect(isValidEmoji('😀😀😀😀😀😀😀😀😀')).toBe(false)
          expect(isValidEmoji('')).toBe(false)
        })
    )
  })
})

describe('reactions', () => {
  layer(TestLive, { excludeTestServices: true })((it) => {
    it.effect('setup: owner + two members, one channel dana is in and bob is not', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        yield* owner.api.companies.create({ payload: { slug: 'acme', name: 'Acme', avatar } })
        const me = yield* owner.api.auth.me()
        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const atlas = yield* owner.api.channels.create({
          payload: { name: 'atlas', departmentId: engineering.id }
        })

        const join = (email: string, name: string) =>
          Effect.gen(function* () {
            const invite = yield* owner.api.invites.create({ payload: { email, role: 'member' } })
            const client = yield* makeClient
            yield* client.api.invites.accept({
              payload: { token: invite.token, name, password: 'password123' }
            })
            const user = (yield* client.api.auth.me()).user
            return { client, user }
          })
        const dana = yield* join('dana@taut.local', 'Dana')
        const bob = yield* join('bob@taut.local', 'Bob')
        yield* owner.api.channels.addMember({
          path: { channelId: atlas.id },
          payload: { memberKind: 'user', memberId: dana.user.id }
        })

        const message = yield* owner.api.messages.create({
          payload: { channelId: atlas.id, body: 'ship it?' }
        })
        expect(message.reactions).toEqual([])

        state.owner = owner
        state.dana = dana.client
        state.bob = bob.client
        state.ownerUser = me.user
        state.danaUser = dana.user
        state.atlas = atlas
        state.message = message
      })
    )

    it.effect(
      'owner reacts ✅: the message answers with one reaction and listForMessages agrees',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const ownerUser = need(state.ownerUser, 'ownerUser')
          const message = need(state.message, 'message')

          const reacted = yield* owner.api.messages.react({
            path: { messageId: message.id, emoji: '✅' }
          })
          expect(reacted.id).toBe(message.id)
          expect(reacted.body).toBe('ship it?')
          expect(reacted.reactions).toEqual([
            { emoji: '✅', count: 1, members: [{ kind: 'user', id: ownerUser.id }] }
          ])

          const reactions = yield* Reactions
          const byMessage = yield* reactions.listForMessages(message.companyId, [message.id])
          expect(byMessage.get(message.id)).toEqual(reacted.reactions)
          // never a query for an empty page
          expect((yield* reactions.listForMessages(message.companyId, [])).size).toBe(0)
        })
    )

    it.effect('messages.list carries the reactions', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const ownerUser = need(state.ownerUser, 'ownerUser')
        const atlas = need(state.atlas, 'atlas')
        const message = need(state.message, 'message')
        const page = yield* owner.api.messages.list({ urlParams: { channelId: atlas.id } })
        expect(page.items.find((m) => m.id === message.id)?.reactions).toEqual([
          { emoji: '✅', count: 1, members: [{ kind: 'user', id: ownerUser.id }] }
        ])
      })
    )

    it.effect(
      'a second member on the same emoji makes count 2; emoji stay in first-added order',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const dana = need(state.dana, 'dana')
          const ownerUser = need(state.ownerUser, 'ownerUser')
          const danaUser = need(state.danaUser, 'danaUser')
          const message = need(state.message, 'message')

          const two = yield* dana.api.messages.react({
            path: { messageId: message.id, emoji: '✅' }
          })
          expect(two.reactions).toEqual([
            {
              emoji: '✅',
              count: 2,
              members: [
                { kind: 'user', id: ownerUser.id },
                { kind: 'user', id: danaUser.id }
              ]
            }
          ])

          yield* dana.api.messages.react({ path: { messageId: message.id, emoji: '👀' } })
          const three = yield* owner.api.messages.react({
            path: { messageId: message.id, emoji: '🎉' }
          })
          expect(three.reactions.map((r) => [r.emoji, r.count])).toEqual([
            ['✅', 2],
            ['👀', 1],
            ['🎉', 1]
          ])
        })
    )

    it.effect('PUT twice is idempotent', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const message = need(state.message, 'message')
        const again = yield* owner.api.messages.react({
          path: { messageId: message.id, emoji: '✅' }
        })
        expect(again.reactions.map((r) => [r.emoji, r.count])).toEqual([
          ['✅', 2],
          ['👀', 1],
          ['🎉', 1]
        ])
        expect(yield* rowsFor(message.id)).toBe(4)
      })
    )

    it.effect("DELETE removes only the caller's reaction; one that is not there is a no-op", () =>
      Effect.gen(function* () {
        const dana = need(state.dana, 'dana')
        const ownerUser = need(state.ownerUser, 'ownerUser')
        const message = need(state.message, 'message')

        const one = yield* dana.api.messages.unreact({
          path: { messageId: message.id, emoji: '✅' }
        })
        expect(one.reactions[0]).toEqual({
          emoji: '✅',
          count: 1,
          members: [{ kind: 'user', id: ownerUser.id }]
        })

        // dana never reacted 🎉: the owner's stays, and the answer is still the message
        const untouched = yield* dana.api.messages.unreact({
          path: { messageId: message.id, emoji: '🎉' }
        })
        expect(untouched.reactions.map((r) => [r.emoji, r.count])).toEqual([
          ['✅', 1],
          ['👀', 1],
          ['🎉', 1]
        ])
        const repeat = yield* dana.api.messages.unreact({
          path: { messageId: message.id, emoji: '✅' }
        })
        expect(repeat.reactions).toEqual(untouched.reactions)

        // the last member leaving an emoji takes the chip with them
        const gone = yield* dana.api.messages.unreact({
          path: { messageId: message.id, emoji: '👀' }
        })
        expect(gone.reactions.map((r) => r.emoji)).toEqual(['✅', '🎉'])
        expect(yield* rowsFor(message.id)).toBe(2)

        // and the very last reaction on a message leaves `reactions: []`, not the stale list
        const single = yield* dana.api.messages.create({
          payload: { channelId: need(state.atlas, 'atlas').id, body: 'one reaction only' }
        })
        yield* dana.api.messages.react({ path: { messageId: single.id, emoji: '🙌' } })
        const empty = yield* dana.api.messages.unreact({
          path: { messageId: single.id, emoji: '🙌' }
        })
        expect(empty.reactions).toEqual([])
      })
    )

    it.effect('a member who cannot view the channel gets 403; an unknown message 404', () =>
      Effect.gen(function* () {
        const bob = need(state.bob, 'bob')
        const owner = need(state.owner, 'owner')
        const message = need(state.message, 'message')
        const forbidden = yield* Effect.flip(
          bob.api.messages.react({ path: { messageId: message.id, emoji: '✅' } })
        )
        expect(forbidden._tag).toBe('Forbidden')
        const forbiddenRemove = yield* Effect.flip(
          bob.api.messages.unreact({ path: { messageId: message.id, emoji: '✅' } })
        )
        expect(forbiddenRemove._tag).toBe('Forbidden')
        const missing = yield* Effect.flip(
          owner.api.messages.react({ path: { messageId: MessageId.make('msg_nope'), emoji: '✅' } })
        )
        expect(missing._tag).toBe('NotFound')
        expect(yield* rowsFor(message.id)).toBe(2)
      })
    )

    it.effect("'ab' and ' ' get 422; the emoji travels percent-encoded", () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const message = need(state.message, 'message')
        const letters = yield* Effect.flip(
          owner.api.messages.react({ path: { messageId: message.id, emoji: 'ab' } })
        )
        expect(letters._tag).toBe('Validation')
        expect(letters._tag === 'Validation' && letters.issues[0]?.path).toEqual(['emoji'])

        const space = yield* rawReact(owner, message.id, ' ', 'PUT')
        expect(space.status).toBe(422)
        const digits = yield* rawReact(owner, message.id, '42', 'PUT')
        expect(digits.status).toBe(422)

        const encoded = yield* rawReact(owner, message.id, '👍🏽', 'PUT')
        expect(encoded.status).toBe(200)
        const body = (yield* Effect.promise(() => encoded.json())) as Message
        expect(body.reactions.map((r) => r.emoji)).toEqual(['✅', '🎉', '👍🏽'])
        const removed = yield* rawReact(owner, message.id, '👍🏽', 'DELETE')
        expect(removed.status).toBe(200)
        expect(yield* rowsFor(message.id)).toBe(2)
      })
    )

    it.effect('the 21st distinct emoji gets 422; re-adding one of the 20 does not', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const atlas = need(state.atlas, 'atlas')
        const crowded = yield* owner.api.messages.create({
          payload: { channelId: atlas.id, body: 'react to this' }
        })
        const faces = Array.from({ length: 21 }, (_, i) => String.fromCodePoint(0x1f600 + i))
        for (const emoji of faces.slice(0, 20)) {
          yield* owner.api.messages.react({ path: { messageId: crowded.id, emoji } })
        }
        const full = yield* Effect.flip(
          owner.api.messages.react({ path: { messageId: crowded.id, emoji: faces[20]! } })
        )
        expect(full._tag).toBe('Validation')
        const repeat = yield* owner.api.messages.react({
          path: { messageId: crowded.id, emoji: faces[0]! }
        })
        expect(repeat.reactions.length).toBe(20)
        expect(repeat.reactions.map((r) => r.emoji)).toEqual(faces.slice(0, 20))
        // another member joining an existing emoji is not a new one either
        const dana = need(state.dana, 'dana')
        const joined = yield* dana.api.messages.react({
          path: { messageId: crowded.id, emoji: faces[3]! }
        })
        expect(joined.reactions[3]?.count).toBe(2)
      })
    )

    it.effect('message.updated arrives on /ws with the reactions', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const dana = need(state.dana, 'dana')
        const ownerUser = need(state.ownerUser, 'ownerUser')
        const message = need(state.message, 'message')
        const { ws } = yield* baseUrl
        const socket = yield* connect(`${ws}/ws`, yield* dana.cookieHeader)

        yield* owner.api.messages.react({ path: { messageId: message.id, emoji: '🙌' } })
        // No `?since`, so the socket opens at the head: `resync`, then only live frames.
        for (;;) {
          const frame = yield* Effect.promise(socket.next)
          if (frame.type === 'resync') continue
          const event = eventFrame(frame)
          if (event.type !== 'message.updated' || event.payload.message.id !== message.id) continue
          if (!event.payload.message.reactions?.some((r) => r.emoji === '🙌')) continue
          expect(event.payload.message.reactions).toEqual([
            { emoji: '✅', count: 1, members: [{ kind: 'user', id: ownerUser.id }] },
            { emoji: '🎉', count: 1, members: [{ kind: 'user', id: ownerUser.id }] },
            { emoji: '🙌', count: 1, members: [{ kind: 'user', id: ownerUser.id }] }
          ])
          break
        }
        yield* Effect.promise(socket.close)
      })
    )

    it.effect('deleting the message cascades its reaction rows', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const message = need(state.message, 'message')
        expect(yield* rowsFor(message.id)).toBe(3)
        yield* owner.api.messages.delete({ path: { messageId: message.id } })
        expect(yield* rowsFor(message.id)).toBe(0)
        const gone = yield* Effect.flip(
          owner.api.messages.react({ path: { messageId: message.id, emoji: '✅' } })
        )
        expect(gone._tag).toBe('NotFound')
      })
    )
  })
})
