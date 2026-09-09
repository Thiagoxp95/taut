import { it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { Event } from '@taut/contract/events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect } from 'vitest'
import { AgentMemory, cursorName, eventToMemoryOps } from '../src/index.js'

const dir = mkdtempSync(join(tmpdir(), 'taut-memory-ingest-'))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const decode = Schema.decodeUnknownSync(Event)

const message = (over: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  companyId: 'cmp_1',
  channelId: 'chn_backend',
  authorKind: 'user',
  authorId: 'usr_maria',
  body: 'Migrate the sessions table',
  status: 'sent',
  seq: 1,
  createdAt: '2026-09-01T10:00:00.000Z',
  ...over
})

const created = decode({
  seq: 1,
  companyId: 'cmp_1',
  at: '2026-09-01T10:00:00.000Z',
  type: 'message.created',
  payload: { message: message() }
})
const updated = decode({
  seq: 2,
  companyId: 'cmp_1',
  at: '2026-09-01T10:01:00.000Z',
  type: 'message.updated',
  payload: {
    message: message({
      body: 'Migrate the sessions table (keep legacy_id)',
      editedAt: '2026-09-01T10:01:00.000Z'
    })
  }
})
const deleted = decode({
  seq: 3,
  companyId: 'cmp_1',
  at: '2026-09-01T10:02:00.000Z',
  type: 'message.deleted',
  payload: { messageId: 'msg_1', channelId: 'chn_backend' }
})
const taskDone = decode({
  seq: 4,
  companyId: 'cmp_1',
  at: '2026-09-01T11:00:00.000Z',
  type: 'agent.task.done',
  payload: {
    task: {
      id: 'tsk_91',
      companyId: 'cmp_1',
      agentId: 'agt_bruno',
      channelId: 'chn_backend',
      threadId: 'msg_1',
      messageId: 'msg_2',
      status: 'done',
      startedAt: '2026-09-01T10:05:00.000Z',
      endedAt: '2026-09-01T11:00:00.000Z'
    },
    message: message({
      id: 'msg_2',
      threadId: 'msg_1',
      authorKind: 'agent',
      authorId: 'agt_bruno',
      body: 'Done: migration written.'
    })
  }
})
const typing = decode({
  seq: 5,
  companyId: 'cmp_1',
  at: '2026-09-01T11:00:00.000Z',
  type: 'typing',
  payload: { channelId: 'chn_backend', userId: 'usr_maria' }
})

describe('eventToMemoryOps', () => {
  it('maps message lifecycle and task.done; ignores the rest', () => {
    const visible = () => true
    const names = { channel: () => 'backend', member: (_k: string, id: string) => id.split('_')[1] }
    expect(eventToMemoryOps(created, visible, names)).toEqual([
      {
        _tag: 'upsert',
        item: {
          kind: 'message',
          sourceId: 'msg_1',
          channelId: 'chn_backend',
          channelName: 'backend',
          threadId: undefined,
          authorKind: 'user',
          authorId: 'usr_maria',
          authorHandle: 'maria',
          at: '2026-09-01T10:00:00.000Z',
          body: 'Migrate the sessions table',
          meta: { status: 'sent' }
        }
      }
    ])
    expect(eventToMemoryOps(updated, visible)[0]?._tag).toBe('upsert')
    expect(eventToMemoryOps(deleted, visible)).toEqual([
      { _tag: 'delete', kind: 'message', sourceId: 'msg_1' }
    ])
    const done = eventToMemoryOps(taskDone, visible)
    expect(
      done.map((o) => (o._tag === 'upsert' ? `${o.item.kind}:${o.item.sourceId}` : o._tag))
    ).toEqual(['message:msg_2', 'task:tsk_91'])
    expect(eventToMemoryOps(typing, visible)).toEqual([])
  })

  it('respects visibility, but deletes regardless', () => {
    const hidden = () => false
    expect(eventToMemoryOps(created, hidden)).toEqual([])
    expect(eventToMemoryOps(taskDone, hidden)).toEqual([])
    expect(eventToMemoryOps(deleted, hidden)).toHaveLength(1)
  })

  it.effect('an ingest loop applies ops and commits the cursor together', () =>
    Effect.gen(function* () {
      const mem = yield* AgentMemory
      const name = cursorName('agt_bruno')
      for (const ev of [created, updated, taskDone, typing]) {
        yield* mem.apply(
          eventToMemoryOps(ev, () => true),
          { name, seq: ev.seq }
        )
      }
      expect(yield* mem.getCursor(name)).toBe(5)
      expect((yield* mem.search('legacy_id')).map((h) => h.sourceId)).toEqual(['msg_1'])
      expect((yield* mem.recallThread('msg_1')).map((i) => `${i.kind}:${i.sourceId}`)).toEqual([
        'message:msg_1',
        'message:msg_2',
        'task:tsk_91'
      ])
      yield* mem.apply(
        eventToMemoryOps(deleted, () => true),
        { name, seq: 6 }
      )
      expect(yield* mem.search('sessions')).toEqual([])
    }).pipe(Effect.provide(AgentMemory.layer(join(dir, 'ingest.db'))))
  )
})
