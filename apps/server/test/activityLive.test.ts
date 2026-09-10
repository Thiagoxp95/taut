/**
 * The running commentary, end to end (docs/build-plan-activity.md): a real task run against the
 * fake machine provider, a real socket, and the `agent.activity` frames that reach it.
 *
 * What is proven here is the wiring the unit tests cannot reach — that explicit summaries and
 * tool calls become broadcasts on one message, while raw reasoning and candidate answers stay
 * out of the activity feed. None of the progress ends up in the reply. The phrasing itself is `test/activity.test.ts`.
 */
import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import type { Message } from '@taut/contract/domain'
import { Effect, Option, Redacted } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { Messages } from '../src/services/messages.js'
import { baseUrl, connect, eventFrame, makeClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const fake = makeFakeRuntime()
const avatar = { kind: 'emoji', value: 'A' } as const
const SEAT_SECRET = 'sk-ant-api03-activity-seat-00000000000000'

/** The frame as it comes off the wire: encoded, not the decoded `Event`. */
interface ActivityFrame {
  readonly payload: {
    readonly kind: 'thinking' | 'tool'
    readonly messageId: string
    readonly text: string
    readonly browser?: boolean
    readonly channelId?: string
    readonly threadId?: string
  }
}

describe('agent activity over the socket', () => {
  layer(testAppWith(dir, fake.layer), { excludeTestServices: true })((it) => {
    it.effect(
      'a run broadcasts summaries and tools without exposing reasoning or answer text',
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
          const engineering = yield* owner.api.departments.create({
            payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
          })
          const credential = yield* owner.api.vault.add({
            payload: {
              kind: 'anthropic.api_key',
              label: 'seat',
              secret: Redacted.make(SEAT_SECRET)
            }
          })
          const seat = yield* owner.api.subscriptions.add({
            payload: { runtime: 'claude-code', label: 'Seat', credentialId: credential.id }
          })
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${seat.id}`
          yield* owner.api.agents.create({
            payload: {
              handle: 'narrator',
              name: 'Narrator',
              avatar,
              role: 'Says what it is doing',
              mandate: '# Mandate\n\nBe brief.',
              runtimeKind: 'claude-code',
              permissionMode: 'plan',
              departmentId: engineering.id
            }
          })
          const channels = yield* owner.api.channels.list({ urlParams: {} })
          const channel = channels.items.find((c) => c.name === 'engineering')
          expect(channel).toBeDefined()
          if (channel === undefined) return

          const { ws } = yield* baseUrl
          const cookie = yield* owner.cookieHeader
          const socket = yield* connect(`${ws}/ws`, cookie)

          const trigger = yield* owner.api.messages.create({
            payload: { channelId: channel.id, body: '@narrator narrate: what are you up to?' }
          })

          // Frames arrive interleaved with message/task events; read until the run closes.
          const seen: Array<ActivityFrame> = []
          const deltas: Array<string> = []
          let messageId: string | undefined
          yield* Effect.promise(async () => {
            for (let i = 0; i < 60; i += 1) {
              const frame = await socket.next()
              // A fresh socket is handed the head and told to refetch; not an event.
              if (frame.type !== 'event') continue
              const event = eventFrame(frame)
              if (event.type === 'agent.task.started') messageId = event.payload.message.id
              if (event.type === 'agent.activity') seen.push(event)
              if (event.type === 'agent.task.delta') deltas.push(event.payload.delta)
              if (event.type === 'agent.task.done' || event.type === 'agent.task.failed') return
            }
          })
          yield* Effect.promise(() => socket.close())

          const thinking = seen.find((a) => a.payload.kind === 'thinking')
          const tool = seen.find((a) => a.payload.kind === 'tool')
          // Only the deliberately written summary reaches the status line.
          expect(thinking?.payload.text).toBe('Writing a design note')
          // Phrased, not printed (D7).
          expect(tool?.payload.text).toBe('Running pnpm test')
          // Both belong to the streaming reply, so the client knows which row to narrate.
          expect(new Set(seen.map((a) => a.payload.messageId))).toEqual(new Set([messageId]))
          expect(new Set(seen.map((a) => a.payload.channelId))).toEqual(new Set([channel.id]))
          expect(new Set(seen.map((a) => a.payload.threadId))).toEqual(new Set([trigger.id]))
          expect(tool?.payload.browser).toBe(false)
          const browserStart = seen.findIndex((a) => a.payload.browser === true)
          expect(browserStart).toBeGreaterThan(-1)
          expect(seen[browserStart]?.payload.text).toBe('Driving the browser')
          expect(seen[browserStart]?.payload.kind).toBe('tool')
          // Browser follow stays live through public summaries and unrelated tools in this turn.
          expect(seen.slice(browserStart).every((a) => a.payload.browser === true)).toBe(true)
          expect(seen.some((a) => a.payload.text === 'Reading the page')).toBe(true)
          expect(seen.some((a) => a.payload.text === 'Running pnpm lint')).toBe(true)

          // And none of it reached the reply itself, which is the whole point (D2).
          const messages = yield* Messages
          expect(messageId).toBeDefined()
          const reply = yield* messages.byId(acme.id, messageId as Message['id'])
          expect(Option.getOrUndefined(reply)?.body).toBe('done')
          expect(deltas).toEqual([])
          expect(
            seen.filter((a) => a.payload.kind === 'thinking').map((a) => a.payload.text)
          ).toEqual(['Writing a design note', 'Reading the page'])
        })
    )
  })
})
