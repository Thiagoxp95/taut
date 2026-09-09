import { describe, expect, it } from '@effect/vitest'
import { DateTime, Either, Schema } from 'effect'

import { Signal, SignalName } from '../src/domain/signal.js'
import { describeTrigger, matchesEvent, type EventTrigger } from '../src/domain/trigger.js'
import type { Event } from '../src/events.js'
import { AgentId, CompanyId, MessageId, SignalId, UserId } from '../src/ids.js'

const at = DateTime.unsafeMake('2026-09-09T15:42:00.000Z')
const companyId = CompanyId.make('cmp_acme')
const nova = AgentId.make('agt_nova')
const bruno = AgentId.make('agt_bruno')
const tedy = UserId.make('usr_tedy')
const watermelon = SignalName.make('remind.watermelon')
const deploy = SignalName.make('deploy-finished')

const name = Schema.decodeUnknownEither(SignalName)

const signal = (fields: {
  readonly name: SignalName
  readonly emittedByKind?: 'user' | 'agent'
  readonly payload?: Record<string, unknown>
}) =>
  new Signal({
    id: SignalId.make('sig_1'),
    companyId,
    name: fields.name,
    payload: fields.payload,
    emittedByKind: fields.emittedByKind ?? 'agent',
    emittedById: fields.emittedByKind === 'user' ? tedy : nova,
    targetAgentId: nova,
    threadId: MessageId.make('msg_root'),
    note: 'buy watermelon',
    deliverAt: at,
    depth: 0,
    status: 'pending',
    createdAt: at,
    updatedAt: at
  })

const emitted = (fields: Parameters<typeof signal>[0]): Event => ({
  seq: 1,
  companyId,
  at,
  type: 'signal.emitted',
  payload: { signal: signal(fields) }
})

describe('SignalName', () => {
  it('accepts the shapes D28 allows', () => {
    for (const ok of ['a', 'deploy-finished', 'remind.watermelon', 'x_9', `a${'b'.repeat(63)}`]) {
      expect(Either.isRight(name(ok)), ok).toBe(true)
    }
  })

  it('rejects everything else', () => {
    // empty, upper case, a leading separator, a space, and one character over 64
    for (const bad of ['', 'Deploy', '.deploy', 'deploy finished', `a${'b'.repeat(64)}`]) {
      expect(Either.isLeft(name(bad)), JSON.stringify(bad)).toBe(true)
    }
  })
})

describe('matchesEvent — SignalTrigger (D17)', () => {
  it('matches on the name, and on nothing that is not `signal.emitted`', () => {
    const trigger: EventTrigger = { _tag: 'signal.emitted', names: [deploy], fromAgentIds: [] }
    expect(matchesEvent(trigger, emitted({ name: deploy }))).toBe(true)
    expect(matchesEvent(trigger, emitted({ name: watermelon }))).toBe(false)
    expect(
      matchesEvent({ ...trigger, names: [deploy, watermelon] }, emitted({ name: watermelon }))
    ).toBe(true)
  })

  it('filters on the emitter, and an empty list means anyone', () => {
    const fromNova: EventTrigger = {
      _tag: 'signal.emitted',
      names: [deploy],
      fromAgentIds: [nova]
    }
    expect(matchesEvent(fromNova, emitted({ name: deploy }))).toBe(true)
    expect(matchesEvent({ ...fromNova, fromAgentIds: [bruno] }, emitted({ name: deploy }))).toBe(
      false
    )
    // a human-emitted signal has no agent to match, so only an "anyone" listener wakes on it
    const byHuman = emitted({ name: deploy, emittedByKind: 'user' })
    expect(matchesEvent(fromNova, byHuman)).toBe(false)
    expect(matchesEvent({ ...fromNova, fromAgentIds: [] }, byHuman)).toBe(true)
  })
})

describe('describeTrigger — SignalTrigger', () => {
  it('says the signal, and who it must come from', () => {
    const say = (event: EventTrigger) =>
      describeTrigger({ _tag: 'event', event }, (id) => (id === nova ? '@nova' : undefined))
    expect(say({ _tag: 'signal.emitted', names: [deploy], fromAgentIds: [] })).toBe(
      'When the signal `deploy-finished` is emitted'
    )
    expect(say({ _tag: 'signal.emitted', names: [deploy, watermelon], fromAgentIds: [nova] })).toBe(
      'When the signal `deploy-finished` and `remind.watermelon` is emitted by @nova'
    )
  })
})

describe('Signal', () => {
  it('round-trips with an absent payload, which decodes to `{}` (D22)', () => {
    const encoded = Schema.encodeSync(Signal)(signal({ name: watermelon }))
    expect(encoded.payload).toEqual({})
    const decoded = Schema.decodeSync(Signal)(encoded)
    expect(decoded).toEqual(signal({ name: watermelon }))
  })

  it('round-trips a nested payload untouched', () => {
    const payload = { order: { id: 7, items: ['watermelon'], paid: false }, tags: [] }
    const decoded = Schema.decodeSync(Signal)(
      Schema.encodeSync(Signal)(signal({ name: watermelon, payload }))
    )
    expect(decoded.payload).toEqual(payload)
  })
})
