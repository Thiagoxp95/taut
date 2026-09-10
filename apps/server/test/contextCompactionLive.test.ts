import { SqlClient } from '@effect/sql'
import { layer } from '@effect/vitest'
import { Effect, Redacted } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { baseUrl, connect, eventFrame, makeClient } from './_client.js'
import { makeFakeRuntime } from './_fakeRuntime.js'
import { makeTempDir, removeDir, testAppWith } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const
const fake = makeFakeRuntime({
  exec: (options) => {
    if (options.cmd[0] !== 'claude' || !options.cmd.includes('-p')) return undefined
    const interrupted = options.stdin?.includes('interrupted compaction') ?? false
    const sample = (used: number) => ({
      type: 'assistant',
      message: { model: 'claude-sonnet-4-5', content: [], usage: { input_tokens: used } }
    })
    return [
      { type: 'system', subtype: 'init', session_id: 'compaction-test' },
      sample(180_000),
      { type: 'system', subtype: 'status', status: 'compacting' },
      ...(interrupted ? [] : [{ type: 'system', subtype: 'compact_boundary' }, sample(30_000)]),
      {
        type: 'result',
        subtype: interrupted ? 'error_during_execution' : 'success',
        is_error: interrupted
      }
    ].map((line) => JSON.stringify(line))
  }
})

describe('context compaction over the socket', () => {
  layer(testAppWith(dir, fake.layer), { excludeTestServices: true })((it) => {
    it.effect('broadcasts live compaction and clears it after success or runtime failure', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        const me = yield* owner.api.auth.signup({
          payload: { email: 'context@taut.local', password: 'password123', name: 'Owner' }
        })
        yield* owner.api.companies.create({
          payload: { slug: 'context', name: 'Context', avatar }
        })
        const department = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const credential = yield* owner.api.vault.add({
          payload: {
            kind: 'anthropic.api_key',
            label: 'test',
            secret: Redacted.make('sk-ant-context-test')
          }
        })
        const seat = yield* owner.api.subscriptions.add({
          payload: { runtime: 'claude-code', label: 'Seat', credentialId: credential.id }
        })
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE subscriptions SET status = 'ok' WHERE id = ${seat.id}`
        const agent = yield* owner.api.agents.create({
          payload: {
            handle: 'context',
            name: 'Context',
            avatar,
            role: 'Engineer',
            mandate: 'Be brief.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: department.id
          }
        })
        const channels = yield* owner.api.channels.list({ urlParams: {} })
        const channel = channels.items.find((c) => c.name === 'engineering')!
        const { ws } = yield* baseUrl
        const socket = yield* connect(`${ws}/ws`, yield* owner.cookieHeader)
        for (const interrupted of [false, true]) {
          const trigger = yield* owner.api.messages.create({
            payload: {
              channelId: channel.id,
              body: `@context ${interrupted ? 'interrupted compaction' : 'compact context'}`
            }
          })
          const seen: Array<{ compacting?: boolean; usedTokens: number }> = []
          yield* Effect.promise(async () => {
            for (let i = 0; i < 80; i += 1) {
              const frame = await socket.next()
              if (frame.type !== 'event') continue
              const event = eventFrame(frame)
              if (event.type === 'agent.context.updated') seen.push(event.payload)
              if (event.type === 'agent.task.done' || event.type === 'agent.task.failed') return
            }
          })
          expect(seen.some((c) => c.compacting && c.usedTokens === 180_000)).toBe(true)
          expect(seen.at(-1)).toMatchObject({
            compacting: false,
            usedTokens: interrupted ? 180_000 : 30_000
          })
          const contexts = yield* owner.api.channels.context({ path: { channelId: channel.id } })
          expect(
            contexts.find((c) => c.agentId === agent.id && c.threadId === trigger.id)?.compacting
          ).toBe(false)
        }
        yield* Effect.promise(() => socket.close())
      })
    )
  })
})
