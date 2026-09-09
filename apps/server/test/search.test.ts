import { layer } from '@effect/vitest'
import { SNIPPET_CLOSE, SNIPPET_OPEN } from '@taut/contract/api'
import type { AgentId } from '@taut/contract/ids'
import { Effect, Option } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { MemoryIngest } from '../src/agents/memoryIngest.js'
import { toSearchQuery } from '../src/services/search.js'
import { makeClient, sleep } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

/**
 * `GET /api/search` (the ⌘K "Messages" and "Agent notes" groups): FTS5 over `messages`
 * (migration 0010) scoped to what the caller can see, plus the notes of agents they manage.
 */

const dir = makeTempDir()
afterAll(() => removeDir(dir))
const avatar = { kind: 'emoji', value: 'A' } as const

/** The memory consumer starts on `agent.created`, asynchronously; wait for its handle. */
const memoryOf = (agentId: AgentId) =>
  Effect.gen(function* () {
    const ingest = yield* MemoryIngest
    for (let i = 0; i < 50; i++) {
      const memory = yield* ingest.memoryOf(agentId)
      if (Option.isSome(memory)) return memory.value
      yield* sleep(100)
    }
    throw new Error(`no memory consumer for ${agentId}`)
  })

describe('toSearchQuery', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('quotes every token, and prefixes the last one for the unstemmed index', () =>
      Effect.sync(() => {
        expect(toSearchQuery('semver bump')).toEqual({
          stemmed: '"semver" "bump"',
          prefix: '"semver" "bump"*'
        })
        expect(toSearchQuery('  semver  ')).toEqual({ stemmed: '"semver"', prefix: '"semver"*' })
        expect(toSearchQuery('semver*')).toEqual({ stemmed: '"semver"', prefix: '"semver"*' })
        // one character is too short to prefix-match usefully; raw FTS syntax never passes
        expect(toSearchQuery('a')).toEqual({ stemmed: '"a"', prefix: '"a"' })
        expect(toSearchQuery('"OR" NEAR(')).toEqual({
          stemmed: '"OR" "NEAR("',
          prefix: '"OR" "NEAR("*'
        })
        expect(toSearchQuery('   ')).toEqual({ stemmed: '', prefix: '' })
      })
    )

    it.effect('finds only what the caller can see; edits and deletes follow the index', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const me = yield* owner.api.auth.me()
        const engineering = yield* owner.api.departments.create({
          payload: { name: 'Engineering', slug: 'engineering', headUserId: me.user.id }
        })
        const atlas = yield* owner.api.channels.create({
          payload: { name: 'atlas', departmentId: engineering.id }
        })
        const failing = yield* owner.api.messages.create({
          payload: {
            channelId: atlas.id,
            body: 'Mobile Release Version / Semver bump (pull_request) failing after 15s'
          }
        })
        const lunch = yield* owner.api.messages.create({
          payload: { channelId: atlas.id, body: 'lunch at noon?' }
        })

        // dana: a plain member who is not in #atlas
        const invite = yield* owner.api.invites.create({
          payload: { email: 'dana@taut.local', role: 'member' }
        })
        const dana = yield* makeClient
        yield* dana.api.invites.accept({
          payload: { token: invite.token, name: 'Dana', password: 'password123' }
        })
        const danaMe = yield* dana.api.auth.me()

        // a DM the owner and dana share
        const dm = yield* owner.api.channels.dm({
          payload: { memberKind: 'user', memberId: danaMe.user.id }
        })
        yield* dana.api.messages.create({
          payload: { channelId: dm.id, body: 'the semver script lives in scripts/release.sh' }
        })

        // bruno, an engineering agent with a note in his memory
        const bruno = yield* owner.api.agents.create({
          payload: {
            handle: 'bruno',
            name: 'Bruno',
            avatar,
            role: 'Backend engineer',
            mandate: '# Mandate\n\nAnswer briefly.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan',
            departmentId: engineering.id
          }
        })
        const memory = yield* memoryOf(bruno.id)
        yield* memory.note('Semver bumps need the release label on the PR', ['release'])

        // owner (admin): both #atlas hits, the DM hit, and bruno's note
        const owned = yield* owner.api.search.query({ urlParams: { q: 'semver' } })
        expect(owned.messages.map((h) => h.message.id).sort()).toEqual(
          [failing.id, ...(yield* messageIdsIn(owner, dm.id))].sort()
        )
        const top = owned.messages.find((h) => h.message.id === failing.id)
        expect(top?.channel).toEqual({ id: atlas.id, name: 'atlas', kind: 'channel' })
        expect(top?.snippet).toContain(`${SNIPPET_OPEN}Semver${SNIPPET_CLOSE}`)
        expect(owned.notes.map((n) => n.body)).toEqual([
          'Semver bumps need the release label on the PR'
        ])
        expect(owned.notes[0]?.agentId).toBe(bruno.id)
        expect(owned.notes[0]?.tags).toEqual(['release'])

        // prefix while typing, and a channel filter
        const typing = yield* owner.api.search.query({ urlParams: { q: 'semv' } })
        expect(typing.messages.length).toBe(2)

        // Every prefix of a word finds it, including the ones longer than its porter stem
        // ("failing" indexes as `fail`, so `faili*` only matches through migration 0015),
        // and stemming still answers a different inflection of the same word.
        const hitsFor = (q: string) =>
          owner.api.search
            .query({ urlParams: { q, channelId: atlas.id } })
            .pipe(Effect.map((r) => r.messages.map((h) => h.message.id)))
        for (const q of ['fail', 'faili', 'failin', 'failing', 'failed']) {
          expect(yield* hitsFor(q)).toEqual([failing.id])
        }
        const scoped = yield* owner.api.search.query({
          urlParams: { q: 'semver', channelId: atlas.id }
        })
        expect(scoped.messages.map((h) => h.message.id)).toEqual([failing.id])

        // dana: no #atlas (not a member), her DM yes, no notes (neither admin nor head)
        const hers = yield* dana.api.search.query({ urlParams: { q: 'semver' } })
        expect(hers.messages.map((h) => h.channel.kind)).toEqual(['dm'])
        expect(hers.notes).toEqual([])
        const forbidden = yield* Effect.flip(
          dana.api.search.query({ urlParams: { q: 'semver', channelId: atlas.id } })
        )
        expect(forbidden._tag).toBe('Forbidden')

        // an edit re-indexes, a delete drops the row
        yield* owner.api.messages.edit({
          path: { messageId: lunch.id },
          payload: { body: 'lunch moved: semver release party' }
        })
        const afterEdit = yield* owner.api.search.query({
          urlParams: { q: 'semver', channelId: atlas.id }
        })
        expect(afterEdit.messages.map((h) => h.message.id).sort()).toEqual(
          [failing.id, lunch.id].sort()
        )
        yield* owner.api.messages.delete({ path: { messageId: lunch.id } })
        const afterDelete = yield* owner.api.search.query({
          urlParams: { q: 'semver', channelId: atlas.id }
        })
        expect(afterDelete.messages.map((h) => h.message.id)).toEqual([failing.id])

        // nothing to search for → empty, not an error
        const blank = yield* owner.api.search.query({ urlParams: { q: '*' } })
        expect(blank).toEqual({ messages: [], notes: [] })
      })
    )
  })
})

const messageIdsIn = (
  client: Effect.Effect.Success<typeof makeClient>,
  channelId: Parameters<typeof client.api.messages.list>[0]['urlParams']['channelId']
) =>
  client.api.messages
    .list({ urlParams: { channelId } })
    .pipe(Effect.map((page) => page.items.map((m) => m.id)))
