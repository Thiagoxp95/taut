/**
 * Huddles (docs/build-plan-calls.md), the four properties the design actually rests on:
 *
 * 1. a token is minted for the one room of a channel the caller can view, and for nobody
 *    else (D4);
 * 2. the participant cap is a 422, not a silent overflow (D4);
 * 3. a webhook whose JWT does not match the body it arrived with is a 401 — the signature
 *    is the only authentication that endpoint has (D2);
 * 4. the whole lifecycle — join, the SFU confirming it, a screen share, a leave, the room
 *    finishing — produces exactly one `call.started`, one `call.ended` and one
 *    `call.updated` per real change, with `leave` and `participant_left` silently
 *    idempotent with each other (D2), and exactly one message for the whole huddle:
 *    posted when it opens and edited into the summary when it ends
 *    (docs/build-plan-huddle-window.md D8).
 */
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Channel, Department, User } from '@taut/contract/domain'
import type { CallId, ChannelId, MessageId } from '@taut/contract/ids'
import { Effect, Schema } from 'effect'
import { createHash, createHmac } from 'node:crypto'
import { afterAll, describe, expect } from 'vitest'
import { huddleDuration } from '../src/services/calls.js'
import { baseUrl, makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const

const LIVEKIT_KEY = 'devkey'
const LIVEKIT_SECRET = 'devsecret-devsecret-devsecret'

/** Cap of 2 so the third person in one channel is the cap test rather than a fixture of 31. */
const TestLive = testApp(dir, {
  TAUT_LIVEKIT_URL: 'wss://sfu.taut.test',
  TAUT_LIVEKIT_API_KEY: LIVEKIT_KEY,
  TAUT_LIVEKIT_API_SECRET: LIVEKIT_SECRET,
  TAUT_CALL_MAX_PARTICIPANTS: '2'
})

const state: {
  owner?: TestClient
  dana?: TestClient
  bob?: TestClient
  carol?: TestClient
  ownerUser?: User
  danaUser?: User
  engineering?: Department
  atlas?: Channel
  dm?: Channel
  ghost?: Channel
  callId?: CallId
  messageId?: MessageId
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

const b64url = (value: string): string => Buffer.from(value, 'utf8').toString('base64url')

/**
 * What LiveKit puts in `Authorization`: a JWT signed with the API secret whose `sha256`
 * claim is the digest of the exact body it posted. Built by hand rather than with the SDK
 * so the test proves the server checks the *body*, not merely a valid-looking token.
 */
const signWebhook = (body: string, secret = LIVEKIT_SECRET): string => {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(
    JSON.stringify({
      iss: LIVEKIT_KEY,
      nbf: now - 5,
      exp: now + 300,
      sha256: createHash('sha256').update(body).digest('base64')
    })
  )
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')
  return `${header}.${payload}.${signature}`
}

const postWebhook = (event: Record<string, unknown>, authorization?: string) =>
  Effect.gen(function* () {
    const { http } = yield* baseUrl
    const body = JSON.stringify(event)
    return yield* Effect.promise(() =>
      fetch(`${http}/api/hooks/livekit`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: authorization ?? signWebhook(body)
        },
        body
      })
    )
  })

const Counted = Schema.Struct({ type: Schema.String, n: Schema.Number })

/** Event counts straight from the log; the assertion must not go through the service. */
const callEventCounts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql`
    SELECT type, COUNT(*) AS n FROM events WHERE type LIKE 'call.%' GROUP BY type
  `.pipe(Effect.flatMap(Schema.decodeUnknown(Schema.Array(Counted))))
  return new Map(rows.map((r) => [r.type, r.n] as const))
})

const CallRowShape = Schema.Struct({
  id: Schema.String,
  ended_at: Schema.NullOr(Schema.String),
  summary_message_id: Schema.NullOr(Schema.String)
})

const callRow = (callId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const rows =
      yield* sql`SELECT id, ended_at, summary_message_id FROM calls WHERE id = ${callId}`.pipe(
        Effect.flatMap(Schema.decodeUnknown(Schema.Tuple(CallRowShape)))
      )
    return rows[0]
  })

/**
 * There is no archive endpoint, and archiving is the one thing that makes `postAsUser`
 * refuse a channel its author can still see — which is exactly the D8 "the huddle message
 * could not be posted" case.
 */
const setArchived = (channelId: ChannelId, at: string | null) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE channels SET archived_at = ${at} WHERE id = ${channelId}`
  })

/** The `video` grant and `sub` of a minted token, without pulling `jose` into the test. */
const claims = (token: string): { sub?: string; video?: { room?: string } } => {
  const part = token.split('.')[1]
  if (part === undefined) throw new Error('not a JWT')
  return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
}

describe('huddleDuration', () => {
  layer(TestLive, { excludeTestServices: true })((it) => {
    it.effect('rounds to minutes and never rounds a few seconds up to one', () =>
      Effect.sync(() => {
        const start = new Date('2026-09-09T10:00:00.000Z')
        expect(huddleDuration(start, new Date('2026-09-09T10:12:00.000Z'))).toBe('12 min')
        expect(huddleDuration(start, new Date('2026-09-09T10:00:20.000Z'))).toBe('<1 min')
      })
    )
  })
})

describe('calls', () => {
  layer(TestLive, { excludeTestServices: true })((it) => {
    it.effect('setup: three members of #atlas and one company member who is not', () =>
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
        const carol = yield* join('carol@taut.local', 'Carol')
        for (const member of [dana.user, bob.user]) {
          yield* owner.api.channels.addMember({
            path: { channelId: atlas.id },
            payload: { memberKind: 'user', memberId: member.id }
          })
        }

        state.owner = owner
        state.dana = dana.client
        state.bob = bob.client
        state.carol = carol.client
        state.ownerUser = me.user
        state.danaUser = dana.user
        state.engineering = engineering
        state.atlas = atlas
      })
    )

    it.effect('config: huddles are on when the three LiveKit vars are set (D3)', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        expect(yield* owner.api.calls.config()).toEqual({ enabled: true })
      })
    )

    it.effect('a company member who cannot view the channel gets no token (D4)', () =>
      Effect.gen(function* () {
        const carol = need(state.carol, 'carol')
        const atlas = need(state.atlas, 'atlas')
        const result = yield* Effect.either(carol.api.calls.join({ path: { channelId: atlas.id } }))
        expect(result._tag).toBe('Left')
        if (result._tag === 'Left') expect(result.left._tag).toBe('Forbidden')
      })
    )

    it.effect('the first join starts the huddle and mints a token for that room only', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const atlas = need(state.atlas, 'atlas')
        const ownerUser = need(state.ownerUser, 'ownerUser')
        const credentials = yield* owner.api.calls.join({ path: { channelId: atlas.id } })

        expect(credentials.url).toBe('wss://sfu.taut.test')
        expect(credentials.call.room).toBe(`huddle_${atlas.id}`)
        expect(credentials.call.startedById).toBe(ownerUser.id)
        expect(credentials.call.participants.map((p) => p.id)).toEqual([ownerUser.id])
        const grants = claims(credentials.token)
        expect(grants.sub).toBe(`user:${ownerUser.id}`)
        expect(grants.video?.room).toBe(`huddle_${atlas.id}`)

        // D8: one message, posted now by the starter, and the call points at it.
        const page = yield* owner.api.messages.list({ urlParams: { channelId: atlas.id } })
        expect(page.items.map((m) => m.body)).toEqual(['🎧 Huddle in #atlas'])
        expect(page.items[0]?.authorId).toBe(ownerUser.id)
        expect(credentials.call.messageId).toBe(page.items[0]?.id)
        expect((yield* callRow(credentials.call.id)).summary_message_id).toBe(page.items[0]?.id)

        state.callId = credentials.call.id
        state.messageId = credentials.call.messageId
      })
    )

    it.effect('a webhook whose signature does not match the body is a 401 (D2)', () =>
      Effect.gen(function* () {
        const atlas = need(state.atlas, 'atlas')
        const event = {
          event: 'participant_joined',
          room: { name: `huddle_${atlas.id}` },
          participant: { identity: `user:${need(state.danaUser, 'danaUser').id}` }
        }
        // A token signed with the wrong secret, and a good token for a different body.
        const wrongSecret = yield* postWebhook(
          event,
          signWebhook(JSON.stringify(event), 'not-the-secret')
        )
        expect(wrongSecret.status).toBe(401)
        const wrongBody = yield* postWebhook(event, signWebhook('{"event":"room_finished"}'))
        expect(wrongBody.status).toBe(401)
        expect((yield* callRow(need(state.callId, 'callId'))).ended_at).toBeNull()
      })
    )

    it.effect('the SFU confirming a join we already wrote says nothing new (D2)', () =>
      Effect.gen(function* () {
        const atlas = need(state.atlas, 'atlas')
        const ownerUser = need(state.ownerUser, 'ownerUser')
        const before = yield* callEventCounts
        const response = yield* postWebhook({
          event: 'participant_joined',
          room: { name: `huddle_${atlas.id}` },
          participant: { identity: `user:${ownerUser.id}` }
        })
        expect(response.status).toBe(204)
        expect(yield* callEventCounts).toEqual(before)
      })
    )

    it.effect('a second person joins, shares a screen, and the third hits the cap (D4, D15)', () =>
      Effect.gen(function* () {
        const atlas = need(state.atlas, 'atlas')
        const dana = need(state.dana, 'dana')
        const danaUser = need(state.danaUser, 'danaUser')
        const bob = need(state.bob, 'bob')

        const joined = yield* dana.api.calls.join({ path: { channelId: atlas.id } })
        expect(joined.call.id).toBe(need(state.callId, 'callId'))
        // Joining an open huddle posts nothing: the message is the one from the start (D8).
        expect(joined.call.messageId).toBe(need(state.messageId, 'messageId'))
        expect(joined.call.participants.map((p) => p.id)).toContain(danaUser.id)
        expect(joined.call.participants.every((p) => !p.sharing)).toBe(true)

        // The SFU repeats it; the row is already right, so no second event.
        const echo = yield* postWebhook({
          event: 'participant_joined',
          room: { name: `huddle_${atlas.id}` },
          participant: { identity: `user:${danaUser.id}` }
        })
        expect(echo.status).toBe(204)

        const shared = yield* postWebhook({
          event: 'track_published',
          room: { name: `huddle_${atlas.id}` },
          participant: { identity: `user:${danaUser.id}` },
          track: { sid: 'TR_screen', source: 'SCREEN_SHARE' }
        })
        expect(shared.status).toBe(204)

        // Bob can view #atlas; the huddle is simply full.
        const full = yield* Effect.either(bob.api.calls.join({ path: { channelId: atlas.id } }))
        expect(full._tag).toBe('Left')
        if (full._tag === 'Left') {
          expect(full.left._tag).toBe('Validation')
          if (full.left._tag === 'Validation') {
            expect(full.left.issues[0]?.message).toContain('full')
          }
        }

        const active = yield* dana.api.calls.active()
        const call = active.find((c) => c.id === state.callId)
        expect(call?.participants.find((p) => p.id === danaUser.id)?.sharing).toBe(true)
      })
    )

    it.effect('leave and participant_left are idempotent with each other (D2)', () =>
      Effect.gen(function* () {
        const atlas = need(state.atlas, 'atlas')
        const dana = need(state.dana, 'dana')
        const danaUser = need(state.danaUser, 'danaUser')
        const callId = need(state.callId, 'callId')

        const left = yield* dana.api.calls.leave({ path: { callId } })
        expect(left.participants.map((p) => p.id)).not.toContain(danaUser.id)

        const before = yield* callEventCounts
        const confirm = yield* postWebhook({
          event: 'participant_left',
          room: { name: `huddle_${atlas.id}` },
          participant: { identity: `user:${danaUser.id}` }
        })
        expect(confirm.status).toBe(204)
        expect(yield* callEventCounts).toEqual(before)
      })
    )

    it.effect('room_finished ends the call once and edits the huddle message (D8)', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const atlas = need(state.atlas, 'atlas')
        const callId = need(state.callId, 'callId')
        const messageId = need(state.messageId, 'messageId')

        const finished = yield* postWebhook({
          event: 'room_finished',
          room: { name: `huddle_${atlas.id}` }
        })
        expect(finished.status).toBe(204)

        const row = yield* callRow(callId)
        expect(row.ended_at).not.toBeNull()
        expect(row.summary_message_id).toBe(messageId)

        // The same message, rewritten — not a second one under the first.
        const page = yield* owner.api.messages.list({ urlParams: { channelId: atlas.id } })
        expect(page.items.map((m) => m.id)).toEqual([messageId])
        const summary = page.items[0]
        expect(summary?.authorId).toBe(need(state.ownerUser, 'ownerUser').id)
        expect(summary?.body).toBe('🎧 Huddle · <1 min · Owner, Dana')
        expect(summary?.editedAt).toBeDefined()
      })
    )

    it.effect('a retried room_finished changes nothing (D2, D8)', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const atlas = need(state.atlas, 'atlas')
        const messageId = need(state.messageId, 'messageId')
        const before = yield* owner.api.messages.list({ urlParams: { channelId: atlas.id } })

        const again = yield* postWebhook({
          event: 'room_finished',
          room: { name: `huddle_${atlas.id}` }
        })
        expect(again.status).toBe(204)

        const after = yield* owner.api.messages.list({ urlParams: { channelId: atlas.id } })
        expect(after.items.map((m) => m.id)).toEqual([messageId])
        expect(after.items[0]?.body).toBe(before.items[0]?.body)
        expect(after.items[0]?.editedAt).toEqual(before.items[0]?.editedAt)

        const counts = yield* callEventCounts
        expect(counts.get('call.started')).toBe(1)
        expect(counts.get('call.ended')).toBe(1)
        // dana joining, dana sharing, dana leaving — and nothing else.
        expect(counts.get('call.updated')).toBe(3)
        expect(yield* owner.api.calls.active()).toEqual([])
      })
    )

    it.effect(
      'a huddle in a DM notifies the other member, a channel one notifies nobody (D8)',
      () =>
        Effect.gen(function* () {
          const owner = need(state.owner, 'owner')
          const danaUser = need(state.danaUser, 'danaUser')
          const sql = yield* SqlClient.SqlClient

          const dm = yield* owner.api.channels.dm({
            payload: { memberKind: 'user', memberId: danaUser.id }
          })
          yield* owner.api.calls.join({ path: { channelId: dm.id } })

          const Row = Schema.Struct({ user_id: Schema.String })
          const rows = yield* sql`
          SELECT user_id FROM notifications WHERE kind = 'huddle'
        `.pipe(Effect.flatMap(Schema.decodeUnknown(Schema.Array(Row))))
          expect(rows.map((r) => r.user_id)).toEqual([danaUser.id])

          // Bob is in #atlas but not in the DM: the open huddle is invisible to him.
          const bob = need(state.bob, 'bob')
          expect(yield* bob.api.calls.active()).toEqual([])
          expect((yield* owner.api.calls.active()).map((c) => c.channelId)).toEqual([dm.id])

          // A DM has no `#name` to put in the body (D8).
          const page = yield* owner.api.messages.list({ urlParams: { channelId: dm.id } })
          expect(page.items.map((m) => m.body)).toEqual(['🎧 Huddle'])
          state.dm = dm
        })
    )

    it.effect('a huddle whose message cannot be posted still joins, and still ends (D8)', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const ghost = yield* owner.api.channels.create({
          payload: { name: 'ghost', departmentId: need(state.engineering, 'engineering').id }
        })
        // Archived: the owner can still see it — and so still start a huddle in it — but
        // nothing can be posted to it, which is the D8 "no message" case.
        yield* setArchived(ghost.id, new Date().toISOString())

        const credentials = yield* owner.api.calls.join({ path: { channelId: ghost.id } })
        expect(credentials.token).not.toBe('')
        expect(credentials.call.messageId).toBeUndefined()
        expect((yield* callRow(credentials.call.id)).summary_message_id).toBeNull()

        // Un-archived before the room empties: with no message to edit, the end of the
        // huddle falls back to posting one, so history records it anyway.
        yield* setArchived(ghost.id, null)
        const finished = yield* postWebhook({
          event: 'room_finished',
          room: { name: `huddle_${ghost.id}` }
        })
        expect(finished.status).toBe(204)

        const row = yield* callRow(credentials.call.id)
        expect(row.ended_at).not.toBeNull()
        expect(row.summary_message_id).not.toBeNull()
        const page = yield* owner.api.messages.list({ urlParams: { channelId: ghost.id } })
        expect(page.items.map((m) => m.body)).toEqual(['🎧 Huddle · <1 min · Owner'])
        expect(page.items[0]?.id).toBe(row.summary_message_id)
        expect(page.items[0]?.editedAt).toBeUndefined()
        state.ghost = ghost
      })
    )
  })
})
