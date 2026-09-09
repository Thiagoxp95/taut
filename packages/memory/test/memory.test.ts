import { it } from '@effect/vitest'
import { DateTime, Effect, Exit, Layer, Scope } from 'effect'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect } from 'vitest'
import { AgentMemory, contextualPrefix, toFtsQuery } from '../src/index.js'
import type { MessageInput } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'taut-memory-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let n = 0
const fresh = () => AgentMemory.layer(join(dir, `mem-${n++}.db`))

const msg = (over: Partial<MessageInput> & { readonly sourceId: string }): MessageInput => ({
  channelId: 'chn_backend',
  channelName: 'backend',
  authorKind: 'user',
  authorId: 'usr_maria',
  authorHandle: 'maria',
  at: '2026-09-01T10:00:00.000Z',
  body: 'hello world',
  ...over
})

describe('helpers', () => {
  it('contextualPrefix follows §10', () => {
    expect(
      contextualPrefix({ kind: 'message', ...msg({ sourceId: 'msg_1', threadId: 'msg_root' }) })
    ).toBe('[#backend] [@maria] [2026-09-01] [thread:msg_root]')
    expect(
      contextualPrefix({ kind: 'note', sourceId: 'n', at: '2026-01-02T00:00:00Z', body: '' })
    ).toBe('[note] [2026-01-02]')
  })

  it('toFtsQuery quotes tokens and keeps prefix stars', () => {
    expect(toFtsQuery('drop legacy_id')).toBe('"drop" "legacy_id"')
    expect(toFtsQuery('sess* OR "x"')).toBe('"sess"* "OR" "x"')
    expect(toFtsQuery('   ')).toBe('')
  })
})

describe('AgentMemory', () => {
  it.effect('FTS roundtrip: indexed text has the prefix, result carries the raw body', () =>
    Effect.gen(function* () {
      const mem = yield* AgentMemory
      yield* mem.upsertMessage(msg({ sourceId: 'msg_1', body: 'Drop legacy_id or keep nullable?' }))
      yield* mem.upsertMessage(msg({ sourceId: 'msg_2', body: 'Unrelated lunch plans' }))
      const hits = yield* mem.search('legacy nullable')
      expect(hits).toHaveLength(1)
      expect(hits[0]?.sourceId).toBe('msg_1')
      expect(hits[0]?.body).toBe('Drop legacy_id or keep nullable?')
      expect(hits[0]?.text.startsWith('[#backend] [@maria] [2026-09-01]\n')).toBe(true)
      expect(hits[0]?.snippet).toContain('[legacy]')
      // the prefix is searchable too
      expect(yield* mem.search('maria')).toHaveLength(2)
      expect(yield* mem.search('backend', { limit: 1 })).toHaveLength(1)
    }).pipe(Effect.provide(fresh()))
  )

  it.effect('edit replaces, delete removes', () =>
    Effect.gen(function* () {
      const mem = yield* AgentMemory
      yield* mem.upsertMessage(msg({ sourceId: 'msg_1', body: 'the first draft' }))
      yield* mem.upsertMessage(msg({ sourceId: 'msg_1', body: 'the final version' }))
      expect(yield* mem.search('draft')).toHaveLength(0)
      expect(yield* mem.search('final')).toHaveLength(1)
      expect((yield* mem.stats()).total).toBe(1)

      expect(yield* mem.deleteBySource('message', 'msg_1')).toBe(true)
      expect(yield* mem.deleteBySource('message', 'msg_1')).toBe(false)
      expect(yield* mem.search('final')).toHaveLength(0)
      expect((yield* mem.stats()).total).toBe(0)
    }).pipe(Effect.provide(fresh()))
  )

  it.effect('filters: channel, author, kind, since/until', () =>
    Effect.gen(function* () {
      const mem = yield* AgentMemory
      yield* mem.upsertMessage(
        msg({ sourceId: 'a', body: 'deploy pipeline', at: '2026-09-01T00:00:00Z' })
      )
      yield* mem.upsertMessage(
        msg({
          sourceId: 'b',
          body: 'deploy pipeline',
          channelId: 'chn_design',
          channelName: 'design',
          authorId: 'agt_bruno',
          authorKind: 'agent',
          authorHandle: 'bruno',
          at: '2026-09-03T00:00:00Z'
        })
      )
      yield* mem.note('deploy pipeline checklist', ['ops'])
      expect(yield* mem.search('deploy')).toHaveLength(3)
      expect(yield* mem.search('deploy', { channelId: 'chn_design' })).toHaveLength(1)
      expect(yield* mem.search('deploy', { authorId: 'agt_bruno' })).toHaveLength(1)
      expect(yield* mem.search('deploy', { kind: 'note' })).toHaveLength(1)
      expect(
        yield* mem.search('deploy', { since: '2026-09-02T00:00:00Z', kind: 'message' })
      ).toHaveLength(1)
      expect(yield* mem.search('deploy', { until: '2026-09-02T00:00:00Z' })).toHaveLength(1)
      expect(yield* mem.search('deploy', { kind: 'file' })).toHaveLength(0)
    }).pipe(Effect.provide(fresh()))
  )

  it.effect('recency tiebreak: equal BM25 → newer first', () =>
    Effect.gen(function* () {
      const mem = yield* AgentMemory
      yield* mem.upsertMessage(
        msg({ sourceId: 'old', body: 'rotate the signing key', at: '2025-01-01T00:00:00Z' })
      )
      yield* mem.upsertMessage(
        msg({ sourceId: 'new', body: 'rotate the signing key', at: '2026-09-01T00:00:00Z' })
      )
      yield* mem.upsertMessage(
        msg({ sourceId: 'mid', body: 'rotate the signing key', at: '2026-01-01T00:00:00Z' })
      )
      const hits = yield* mem.search('signing key')
      expect(hits.map((h) => h.sourceId)).toEqual(['new', 'mid', 'old'])
      // relevance still dominates: a much better match beats recency (filler lifts IDF above zero)
      yield* Effect.forEach(['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'], (w) =>
        mem.upsertMessage(
          msg({ sourceId: w, body: `${w} filler text`, at: '2026-09-02T00:00:00Z' })
        )
      )
      yield* mem.upsertMessage(
        msg({
          sourceId: 'exact',
          body: 'signing key signing key signing key',
          at: '2024-01-01T00:00:00Z'
        })
      )
      expect((yield* mem.search('signing key'))[0]?.sourceId).toBe('exact')
    }).pipe(Effect.provide(fresh()))
  )

  it.effect('grep, recallThread, timeline, notes, forget', () =>
    Effect.gen(function* () {
      const mem = yield* AgentMemory
      yield* mem.upsertMessage(
        msg({
          sourceId: 'root',
          body: 'Task: migrate sessions (TAUT-123)',
          at: '2026-09-01T00:00:00Z'
        })
      )
      yield* mem.upsertMessage(
        msg({ sourceId: 'r2', threadId: 'root', body: 'second', at: '2026-09-01T00:02:00Z' })
      )
      yield* mem.upsertMessage(
        msg({
          sourceId: 'r1',
          threadId: 'root',
          body: 'first https://x.io/1',
          at: '2026-09-01T00:01:00Z'
        })
      )
      yield* mem.upsertMessage(
        msg({
          sourceId: 'other',
          body: 'elsewhere',
          channelId: 'chn_x',
          at: '2026-09-02T00:00:00Z'
        })
      )

      expect((yield* mem.grep('TAUT-\\d+')).map((i) => i.sourceId)).toEqual(['root'])
      expect(
        (yield* mem.grep('https?://', { channelId: 'chn_backend' })).map((i) => i.sourceId)
      ).toEqual(['r1'])
      const bad = yield* Effect.exit(mem.grep('('))
      expect(Exit.isFailure(bad)).toBe(true)

      expect((yield* mem.recallThread('root')).map((i) => i.sourceId)).toEqual(['root', 'r1', 'r2'])
      expect(
        (yield* mem.timeline({ from: '2026-09-01T00:00:30Z', to: '2026-09-03T00:00:00Z' })).map(
          (i) => i.sourceId
        )
      ).toEqual(['r1', 'r2', 'other'])
      expect(
        (yield* mem.timeline({
          from: '2026-09-01T00:00:00Z',
          to: '2026-09-03T00:00:00Z',
          channelId: 'chn_x'
        })).map((i) => i.sourceId)
      ).toEqual(['other'])

      const note = yield* mem.note('Maria prefers nullable columns', ['maria', 'schema'])
      expect(note.kind).toBe('note')
      expect(note.meta).toEqual({ tags: ['maria', 'schema'] })
      expect((yield* mem.notes.list()).map((i) => i.id)).toEqual([note.id])
      expect((yield* mem.notes.get(note.id))?.body).toBe('Maria prefers nullable columns')
      expect(yield* mem.search('nullable', { kind: 'note' })).toHaveLength(1)
      // forget only removes notes
      expect(yield* mem.forget('message:root')).toBe(false)
      expect(yield* mem.forget(note.id)).toBe(true)
      expect(yield* mem.notes.list()).toEqual([])
      expect((yield* mem.recallThread('root')).length).toBe(3)
    }).pipe(Effect.provide(fresh()))
  )

  it.effect('cursor persistence survives reopening the same file', () =>
    Effect.gen(function* () {
      const file = join(dir, 'cursor.db')
      const scope1 = yield* Scope.make()
      const a = yield* AgentMemory.open(file).pipe(Scope.extend(scope1))
      expect(yield* a.getCursor('ingest:agt_1')).toBe(0)
      yield* a.apply([{ _tag: 'upsert', item: { kind: 'message', ...msg({ sourceId: 'm' }) } }], {
        name: 'ingest:agt_1',
        seq: 42
      })
      expect(yield* a.getCursor('ingest:agt_1')).toBe(42)
      yield* Scope.close(scope1, Exit.void)

      const b = yield* AgentMemory.open(file)
      expect(yield* b.getCursor('ingest:agt_1')).toBe(42)
      expect((yield* b.stats()).cursors).toEqual({ 'ingest:agt_1': 42 })
      expect((yield* b.stats()).total).toBe(1)
    }).pipe(Effect.scoped)
  )

  it.effect('two DB files are fully isolated', () =>
    Effect.gen(function* () {
      const a = yield* AgentMemory.open(join(dir, 'iso-a.db'))
      const b = yield* AgentMemory.open(join(dir, 'iso-b.db'))
      yield* a.upsertMessage(msg({ sourceId: 'secret', body: 'the vault passphrase rotation' }))
      yield* a.setCursor('ingest:x', 7)
      expect(yield* b.search('passphrase')).toEqual([])
      expect(yield* b.getCursor('ingest:x')).toBe(0)
      expect((yield* b.stats()).total).toBe(0)
      expect((yield* a.stats()).total).toBe(1)
    }).pipe(Effect.scoped)
  )

  it.effect(
    '10k items: search stays under 50ms',
    () =>
      Effect.gen(function* () {
        const mem = yield* AgentMemory
        const words = [
          'deploy',
          'sessions',
          'migration',
          'rollback',
          'nullable',
          'legacy',
          'review',
          'incident',
          'cache',
          'token'
        ]
        const base = DateTime.unsafeMake('2026-01-01T00:00:00Z')
        yield* mem.transaction(
          Effect.forEach(
            Array.from({ length: 10_000 }, (_, i) => i),
            (i) =>
              mem.upsert({
                kind: 'message',
                ...msg({
                  sourceId: `msg_${i}`,
                  channelId: i % 3 === 0 ? 'chn_backend' : 'chn_design',
                  at: DateTime.formatIso(DateTime.add(base, { minutes: i })),
                  body: `${words[i % 10]} ${words[(i * 7) % 10]} item ${i} ${words[(i * 3) % 10]} ${i % 97 === 0 ? 'needle' : ''}`
                })
              }),
            { discard: true }
          )
        )
        expect((yield* mem.stats()).total).toBe(10_000)
        yield* mem.search('needle') // warm
        const t0 = performance.now()
        const hits = yield* mem.search('needle migration', { channelId: 'chn_backend' })
        const t1 = performance.now()
        const hits2 = yield* mem.search('rollback')
        const t2 = performance.now()
        expect(hits.length).toBeGreaterThan(0)
        expect(hits2).toHaveLength(10)
        expect(t1 - t0).toBeLessThan(50)
        expect(t2 - t1).toBeLessThan(50)
      }).pipe(Effect.provide(fresh())),
    30_000
  )

  it.effect(
    'layer works with an explicit Layer.provide chain and reports MemoryError on empty query',
    () =>
      Effect.gen(function* () {
        const mem = yield* AgentMemory
        const exit = yield* Effect.exit(mem.search('  '))
        expect(Exit.isFailure(exit)).toBe(true)
      }).pipe(Effect.provide(Layer.fresh(fresh())))
  )
})
