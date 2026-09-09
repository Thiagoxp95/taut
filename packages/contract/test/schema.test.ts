import { describe, expect, it } from '@effect/vitest'
import { DateTime, Effect, Either, Redacted, Schema } from 'effect'

import { CreateMessagePayload } from '../src/api/messages.js'
import { AddVaultItemPayload } from '../src/api/vault.js'
import { Agent, Attachment, Avatar, Message, User } from '../src/domain/index.js'
import { Conflict, NotFound, TautError } from '../src/errors.js'
import { Event, EventType, type EventBody, type EventEncoded } from '../src/events.js'
import {
  AgentId,
  AttachmentId,
  ChannelId,
  CompanyId,
  MessageId,
  TaskId,
  UserId,
  makeId,
  newAttachmentId,
  newCompanyId,
  newMessageId
} from '../src/ids.js'

const now = DateTime.unsafeMake('2026-09-08T12:00:00.000Z')
const companyId = CompanyId.make('cmp_acme')
const channelId = ChannelId.make('chn_general')
const userId = UserId.make('usr_thiago')
const agentId = AgentId.make('agt_bruno')

describe('ids', () => {
  it('makeId prefixes a uuid', () => {
    expect(makeId('cmp')).toMatch(/^cmp_[0-9a-f-]{36}$/)
    expect(newCompanyId()).toMatch(/^cmp_/)
    expect(newMessageId()).toMatch(/^msg_/)
    expect(newAttachmentId()).toMatch(/^att_/)
  })

  it('rejects ids with the wrong prefix', () => {
    const decode = Schema.decodeUnknownEither(CompanyId)
    expect(Either.isRight(decode('cmp_123'))).toBe(true)
    expect(Either.isLeft(decode('usr_123'))).toBe(true)
    expect(Either.isLeft(decode('cmp_'))).toBe(true)
  })
})

describe('domain round-trips', () => {
  it.effect('User encodes dates as ISO strings and decodes back', () =>
    Effect.gen(function* () {
      const user = new User({
        id: userId,
        email: 'thiago@example.com',
        name: 'Thiago',
        avatar: { kind: 'emoji', value: '🦫' },
        createdAt: now
      })
      const encoded = yield* Schema.encode(User)(user)
      expect(encoded.createdAt).toBe('2026-09-08T12:00:00.000Z')
      const decoded = yield* Schema.decodeUnknown(User)(JSON.parse(JSON.stringify(encoded)))
      expect(decoded).toStrictEqual(user)
      expect(DateTime.Equivalence(decoded.createdAt, now)).toBe(true)
    })
  )

  it.effect('Message with an agent author and optional fields omitted', () =>
    Effect.gen(function* () {
      const message = new Message({
        id: MessageId.make('msg_1'),
        companyId,
        channelId,
        authorKind: 'agent',
        authorId: agentId,
        body: 'hello',
        status: 'streaming',
        seq: 7,
        createdAt: now
      })
      const json = JSON.parse(JSON.stringify(yield* Schema.encode(Message)(message)))
      expect(json).not.toHaveProperty('threadId')
      expect(json).not.toHaveProperty('editedAt')
      const decoded = yield* Schema.decodeUnknown(Message)(json)
      expect(decoded.authorId).toBe('agt_bruno')
      expect(decoded.editedAt).toBeUndefined()
    })
  )

  it.effect('Attachment round-trips; messageId is absent while it is an orphan', () =>
    Effect.gen(function* () {
      const attachment = new Attachment({
        id: AttachmentId.make('att_1'),
        companyId,
        channelId,
        uploaderKind: 'user',
        uploaderId: userId,
        name: 'shot.png',
        mimeType: 'image/png',
        size: 1234,
        createdAt: now
      })
      const json = JSON.parse(JSON.stringify(yield* Schema.encode(Attachment)(attachment)))
      expect(json).not.toHaveProperty('messageId')
      expect(json.createdAt).toBe('2026-09-08T12:00:00.000Z')
      const decoded = yield* Schema.decodeUnknown(Attachment)(json)
      expect(decoded).toStrictEqual(attachment)
      const sent = yield* Schema.decodeUnknown(Attachment)({ ...json, messageId: 'msg_1' })
      expect(sent.messageId).toBe('msg_1')
      expect(Either.isLeft(Schema.decodeUnknownEither(Attachment)({ ...json, size: -1 }))).toBe(
        true
      )
    })
  )

  it.effect('Message without `attachments` on the wire decodes to []', () =>
    Effect.gen(function* () {
      const wire = {
        id: 'msg_1',
        companyId: 'cmp_acme',
        channelId: 'chn_general',
        authorKind: 'user',
        authorId: 'usr_thiago',
        body: '',
        status: 'sent',
        seq: 1,
        createdAt: '2026-09-08T12:00:00.000Z'
      }
      const decoded = yield* Schema.decodeUnknown(Message)(wire)
      expect(decoded.attachments).toStrictEqual([])
      expect(decoded.reactions).toStrictEqual([])
      const withOne = yield* Schema.decodeUnknown(Message)({
        ...wire,
        attachments: [
          {
            id: 'att_1',
            companyId: 'cmp_acme',
            channelId: 'chn_general',
            messageId: 'msg_1',
            uploaderKind: 'user',
            uploaderId: 'usr_thiago',
            name: 'shot.png',
            mimeType: 'image/png',
            size: 1234,
            createdAt: '2026-09-08T12:00:00.000Z'
          }
        ]
      })
      expect(withOne.attachments).toHaveLength(1)
      expect(withOne.attachments[0]).toBeInstanceOf(Attachment)
      expect(withOne.attachments[0]?.name).toBe('shot.png')
    })
  )

  it('CreateMessagePayload accepts an empty body and caps attachmentIds at 10', () => {
    const decode = Schema.decodeUnknownEither(CreateMessagePayload)
    expect(Either.isRight(decode({ channelId: 'chn_general', body: '' }))).toBe(true)
    expect(
      Either.isRight(decode({ channelId: 'chn_general', body: '', attachmentIds: ['att_1'] }))
    ).toBe(true)
    expect(
      Either.isLeft(decode({ channelId: 'chn_general', body: '', attachmentIds: ['msg_1'] }))
    ).toBe(true)
    const eleven = Array.from({ length: 11 }, (_, i) => `att_${i}`)
    expect(
      Either.isLeft(decode({ channelId: 'chn_general', body: 'x', attachmentIds: eleven }))
    ).toBe(true)
  })

  it('Agent rejects an invalid handle and permission mode', () => {
    const base = {
      id: 'agt_1',
      companyId: 'cmp_acme',
      handle: 'bruno',
      name: 'Bruno',
      avatar: { kind: 'image', assetId: 'ast_1' },
      role: 'Backend engineer',
      mandate: '# Do good work',
      runtimeKind: 'claude-code',
      permissionMode: 'plan',
      status: 'active',
      createdAt: '2026-09-08T12:00:00.000Z',
      updatedAt: '2026-09-08T12:00:00.000Z'
    }
    const decode = Schema.decodeUnknownEither(Agent)
    expect(Either.isRight(decode(base))).toBe(true)
    expect(Either.isLeft(decode({ ...base, handle: 'Bruno!' }))).toBe(true)
    expect(Either.isLeft(decode({ ...base, permissionMode: 'full-auto' }))).toBe(true)
  })

  it('Avatar is a discriminated union', () => {
    const decode = Schema.decodeUnknownEither(Avatar)
    expect(Either.isRight(decode({ kind: 'emoji', value: '🐝' }))).toBe(true)
    expect(Either.isLeft(decode({ kind: 'emoji', assetId: 'x' }))).toBe(true)
  })

  it('vault secrets decode to Redacted and never print', () => {
    const payload = Schema.decodeUnknownSync(AddVaultItemPayload)({
      kind: 'anthropic.api_key',
      label: 'Acme key',
      secret: 'sk-ant-secret'
    })
    expect(Redacted.value(payload.secret)).toBe('sk-ant-secret')
    expect(String(payload.secret)).not.toContain('sk-ant')
  })
})

describe('errors', () => {
  it('round-trip through the TautError union and derive messages', () => {
    const encoded = Schema.encodeSync(TautError)(new NotFound({ entity: 'Channel', id: 'chn_x' }))
    expect(encoded).toStrictEqual({ _tag: 'NotFound', entity: 'Channel', id: 'chn_x' })
    const decoded = Schema.decodeUnknownSync(TautError)(encoded)
    expect(decoded._tag).toBe('NotFound')
    expect(decoded.message).toBe('Channel chn_x not found')
    expect(new Conflict({ reason: 'slug taken' }).message).toBe('slug taken')
  })
})

describe('events', () => {
  it.effect('decodes a message.created event and narrows the payload', () =>
    Effect.gen(function* () {
      const wire: EventEncoded = {
        seq: 42,
        companyId: 'cmp_acme',
        at: '2026-09-08T12:00:00.000Z',
        type: 'message.created',
        payload: {
          message: {
            id: 'msg_1',
            companyId: 'cmp_acme',
            channelId: 'chn_general',
            authorKind: 'user',
            authorId: 'usr_thiago',
            body: '@bruno review PR #42',
            status: 'sent',
            seq: 42,
            createdAt: '2026-09-08T12:00:00.000Z',
            attachments: [],
            reactions: []
          }
        }
      }
      const event = yield* Schema.decodeUnknown(Event)(wire)
      expect(event.seq).toBe(42)
      if (event.type === 'message.created') {
        expect(event.payload.message.body).toContain('@bruno')
        expect(event.payload.message).toBeInstanceOf(Message)
      } else {
        throw new Error(`expected message.created, got ${event.type}`)
      }
      const reencoded = yield* Schema.encode(Event)(event)
      expect(reencoded).toStrictEqual(wire)
    })
  )

  it('rejects a payload that does not match its type', () => {
    const decode = Schema.decodeUnknownEither(Event)
    const bad = {
      seq: 1,
      companyId: 'cmp_acme',
      at: '2026-09-08T12:00:00.000Z',
      type: 'agent.task.delta',
      payload: { channelId: 'chn_general' }
    }
    expect(Either.isLeft(decode(bad))).toBe(true)
  })

  it('EventBody is typed per variant and EventType covers the union', () => {
    const body: EventBody = {
      type: 'agent.task.delta',
      payload: { taskId: TaskId.make('tsk_1'), messageId: MessageId.make('msg_1'), delta: 'hel' }
    }
    expect(body.type).toBe('agent.task.delta')
    expect(EventType.literals).toContain('unread.changed')
    expect(EventType.literals).toContain('agent.deleted')
    expect(new Set(EventType.literals).size).toBe(Event.members.length)
  })
})
