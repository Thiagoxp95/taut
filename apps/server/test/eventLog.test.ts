import { SqlClient } from '@effect/sql'
import { it } from '@effect/vitest'
import { ChannelId, CompanyId, DepartmentId, UserId } from '@taut/contract/ids'
import { Chunk, Effect, Layer, Stream } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { EventLog } from '../src/realtime/eventLog.js'
import { makeTempDir, removeDir, testDb } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const TestLayer = EventLog.Default.pipe(Layer.provideMerge(testDb(dir)))

const cmpA = CompanyId.make('cmp_a')
const cmpB = CompanyId.make('cmp_b')
const cmpC = CompanyId.make('cmp_c')
const user = (i: number) => UserId.make(`usr_${i}`)

describe('EventLog', () => {
  it.layer(TestLayer)((it) => {
    it.effect(
      'assigns gap-free per-company seq under 100 concurrent appends across 2 companies',
      () =>
        Effect.gen(function* () {
          const log = yield* EventLog
          const appends = Array.from({ length: 100 }, (_, i) =>
            log.append(i % 2 === 0 ? cmpA : cmpB, {
              type: 'membership.deleted',
              payload: { userId: user(i) }
            })
          )
          const events = yield* Effect.all(appends, { concurrency: 'unbounded' })
          for (const company of [cmpA, cmpB]) {
            const seqs = events
              .filter((e) => e.companyId === company)
              .map((e) => e.seq)
              .sort((a, b) => a - b)
            expect(seqs).toEqual(Array.from({ length: 50 }, (_, i) => i + 1))
            expect(yield* log.latestSeq(company)).toBe(50)
          }
          expect(events.every((e) => e.type === 'membership.deleted')).toBe(true)
        })
    )

    it.effect('since(company, seq) streams only later events of that company, in order', () =>
      Effect.gen(function* () {
        const log = yield* EventLog
        const tail = yield* log.since(cmpA, 45).pipe(Stream.runCollect)
        expect(Chunk.toReadonlyArray(tail).map((e) => e.seq)).toEqual([46, 47, 48, 49, 50])
        expect(Chunk.toReadonlyArray(tail).every((e) => e.companyId === cmpA)).toBe(true)
        const all = yield* log.since(cmpB, 0).pipe(Stream.runCollect)
        expect(Chunk.size(all)).toBe(50)
        const none = yield* log.since(cmpA, 50).pipe(Stream.runCollect)
        expect(Chunk.isEmpty(none)).toBe(true)
        const unknown = yield* log.since(CompanyId.make('cmp_nope'), 0).pipe(Stream.runCollect)
        expect(Chunk.isEmpty(unknown)).toBe(true)
      })
    )

    it.effect('round-trips typed payloads and rolls back inside a failed caller transaction', () =>
      Effect.gen(function* () {
        const log = yield* EventLog
        const sql = yield* SqlClient.SqlClient
        const event = yield* sql.withTransaction(
          log.append(cmpC, {
            type: 'department.deleted',
            payload: { departmentId: DepartmentId.make('dep_x') }
          })
        )
        expect(event.seq).toBe(1)
        expect(event.type).toBe('department.deleted')
        if (event.type === 'department.deleted') expect(event.payload.departmentId).toBe('dep_x')
        const rolledBack = yield* Effect.flip(
          sql.withTransaction(
            log
              .append(cmpC, { type: 'membership.deleted', payload: { userId: user(1) } })
              .pipe(Effect.zipRight(Effect.fail('boom')))
          )
        )
        expect(rolledBack).toBe('boom')
        expect(yield* log.latestSeq(cmpC)).toBe(1)
        const next = yield* log.append(cmpC, {
          type: 'unread.changed',
          payload: { userId: user(2), channelId: ChannelId.make('chn_1'), unread: 3, mentions: 1 }
        })
        expect(next.seq).toBe(2)
        if (next.type === 'unread.changed') expect(next.payload.unread).toBe(3)
      })
    )

    it.effect(
      'since() skips a row that no longer decodes (one warning) and validate() counts it',
      () =>
        Effect.gen(function* () {
          const log = yield* EventLog
          const sql = yield* SqlClient.SqlClient
          const cmpD = CompanyId.make('cmp_d')
          const at = new Date().toISOString()
          const first = yield* log.append(cmpD, {
            type: 'membership.deleted',
            payload: { userId: user(1) }
          })
          expect(first.seq).toBe(1)
          // a `message.created` written by the pre-0004 `Message` schema: no `seq`
          const legacy = {
            message: {
              id: 'msg_legacy',
              companyId: cmpD,
              channelId: 'chn_1',
              authorKind: 'user',
              authorId: 'usr_1',
              body: 'old',
              status: 'sent',
              createdAt: at
            },
            mentions: []
          }
          yield* sql`INSERT INTO events (company_id, seq, at, type, payload_json)
                   VALUES (${cmpD}, 2, ${at}, 'message.created', ${JSON.stringify(legacy)})`
          const last = yield* log.append(cmpD, {
            type: 'membership.deleted',
            payload: { userId: user(2) }
          })
          expect(last.seq).toBe(3)

          const replay = yield* log.since(cmpD, 0).pipe(Stream.runCollect)
          expect(Chunk.toReadonlyArray(replay).map((e) => e.seq)).toEqual([1, 3])

          const report = yield* log.validate()
          expect(report.invalid).toBe(1)
          expect(report.byType).toEqual({ 'message.created': 1 })
          expect(report.total).toBe(105)
        })
    )
  })
})
