import { layer } from '@effect/vitest'
import { Effect, Option } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { makeClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'
import { AgentSessions } from '../src/agents/sessions.js'
import { ThreadContexts } from '../src/services/threadContext.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const avatar = { kind: 'emoji', value: 'A' } as const

/**
 * The context meter's storage half (docs/build-plan-context-meter.md D7, D8).
 *
 * The arithmetic is tested in `packages/runtime/test/contextSamples.test.ts`. What is tested
 * here is that a window belongs to a `(agent, thread)` pair and nothing wider, that the
 * channel endpoint hands the client its seed, and that clearing a session empties the window
 * with it — the last of which is the difference between a stale ring and no ring.
 */
describe('context meter', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('one window per agent per thread, seeded by channel, cleared with the session', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        const me = yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const makeAgent = (handle: string, runtimeKind: 'claude-code' | 'codex') =>
          owner.api.agents.create({
            payload: {
              handle,
              name: handle,
              avatar,
              role: 'Engineer',
              mandate: 'Do the work.',
              runtimeKind,
              permissionMode: 'plan',
              departmentId: engineering.id
            }
          })
        const bruno = yield* makeAgent('bruno', 'claude-code')
        const cleo = yield* makeAgent('cleo', 'codex')

        const channel = yield* owner.api.channels.create({
          payload: { name: 'general', departmentId: engineering.id }
        })
        const root = yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: 'who can take this?' }
        })
        const other = yield* owner.api.messages.create({
          payload: { channelId: channel.id, body: 'unrelated' }
        })

        const contexts = yield* ThreadContexts
        // Two agents in one thread: two copies, two windows, two rows.
        yield* contexts.record({
          companyId: acme.id,
          agentId: bruno.id,
          threadId: root.id,
          channelId: channel.id,
          runtime: 'claude-code',
          usedTokens: 91_653,
          maxTokens: 200_000,
          totalTokens: 480_000,
          model: 'claude-sonnet-4-5',
          compactsAutomatically: true
        })
        yield* contexts.record({
          companyId: acme.id,
          agentId: cleo.id,
          threadId: root.id,
          channelId: channel.id,
          runtime: 'codex',
          usedTokens: 12_400,
          maxTokens: 400_000,
          compactsAutomatically: true
        })
        // The same agent in a second thread is a third window, not an update of the first.
        yield* contexts.record({
          companyId: acme.id,
          agentId: bruno.id,
          threadId: other.id,
          channelId: channel.id,
          runtime: 'claude-code',
          usedTokens: 1_200,
          compactsAutomatically: true
        })

        const brunoHere = yield* contexts.get(bruno.id, root.id).pipe(Effect.map(Option.getOrThrow))
        expect(brunoHere.usedTokens).toBe(91_653)
        expect(brunoHere.maxTokens).toBe(200_000)
        // Resident and billed are different quantities and both survive the round trip.
        expect(brunoHere.totalTokens).toBe(480_000)
        expect(brunoHere.model).toBe('claude-sonnet-4-5')

        const brunoThere = yield* contexts
          .get(bruno.id, other.id)
          .pipe(Effect.map(Option.getOrThrow))
        expect(brunoThere.usedTokens).toBe(1_200)
        // No window means no denominator, and no denominator means no ring (D6).
        expect(brunoThere.maxTokens).toBeUndefined()

        // What the client seeds its rings from on boot.
        const seed = yield* owner.api.channels.context({ path: { channelId: channel.id } })
        expect(seed).toHaveLength(3)
        expect(
          seed
            .filter((c) => c.threadId === root.id)
            .map((c) => c.agentId)
            .sort()
        ).toEqual([bruno.id, cleo.id].sort())

        // A later sample replaces the earlier one; occupancy is a value, never a running total.
        yield* contexts.record({
          companyId: acme.id,
          agentId: bruno.id,
          threadId: root.id,
          channelId: channel.id,
          runtime: 'claude-code',
          usedTokens: 30_100,
          maxTokens: 200_000,
          compactsAutomatically: true,
          compactedAt: '2026-09-09T12:00:00.000Z'
        })
        const compacted = yield* contexts.get(bruno.id, root.id).pipe(Effect.map(Option.getOrThrow))
        expect(compacted.usedTokens).toBe(30_100)
        expect(compacted.compactedAt).toBe('2026-09-09T12:00:00.000Z')

        // D8: a cleared session starts cold, so the window it was holding goes with it — and
        // only that one. The same agent's other thread is untouched.
        const sessions = yield* AgentSessions
        yield* sessions.clear(bruno.id, root.id)
        expect(yield* contexts.get(bruno.id, root.id)).toEqual(Option.none())
        expect(Option.isSome(yield* contexts.get(cleo.id, root.id))).toBe(true)
        expect(Option.isSome(yield* contexts.get(bruno.id, other.id))).toBe(true)
      })
    )
  })
})
