import { layer } from '@effect/vitest'
import type { Agent, Channel, Company } from '@taut/contract/domain'
import { Effect } from 'effect'
import { afterAll, describe, expect } from 'vitest'
import { makeClient, type TestClient } from './_client.js'
import { makeTempDir, removeDir, testApp } from './_harness.js'

const dir = makeTempDir()
afterAll(() => removeDir(dir))

const avatar = { kind: 'emoji', value: 'A' } as const

const state: {
  owner?: TestClient
  acme?: Company
  vera?: Agent
  dm?: Channel
} = {}

const need = <A>(value: A | undefined, what: string): A => {
  if (value === undefined) throw new Error(`test state missing: ${what}`)
  return value
}

/**
 * `agents.delete` archives (docs: the agent keeps its row, its home and its history). The
 * conversations it was part of are archived with it rather than deleted, which is what keeps
 * old threads readable instead of turning them into "Unknown member".
 */
describe('archiving an agent', () => {
  layer(testApp(dir), { excludeTestServices: true })((it) => {
    it.effect('setup: owner, company, @vera and a DM with her', () =>
      Effect.gen(function* () {
        const owner = yield* makeClient
        yield* owner.api.auth.signup({
          payload: { email: 'owner@taut.local', password: 'password123', name: 'Owner' }
        })
        const acme = yield* owner.api.companies.create({
          payload: { slug: 'acme', name: 'Acme', avatar }
        })
        const vera = yield* owner.api.agents.create({
          payload: {
            handle: 'vera',
            name: 'Vera',
            avatar,
            role: 'Researcher',
            mandate: 'Answer questions.',
            runtimeKind: 'claude-code',
            permissionMode: 'plan'
          }
        })
        const dm = yield* owner.api.channels.dm({
          payload: { memberKind: 'agent', memberId: vera.id }
        })
        yield* owner.api.messages.create({ payload: { channelId: dm.id, body: 'hello vera' } })
        Object.assign(state, { owner, acme, vera, dm })
      })
    )

    it.effect('delete archives the agent and its DM, and locks the conversation', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const vera = need(state.vera, 'vera')
        const dm = need(state.dm, 'dm')

        yield* owner.api.agents.delete({ path: { agentId: vera.id } })

        const listed = (yield* owner.api.agents.list({ urlParams: {} })).items
        expect(listed.map((a) => a.handle)).toEqual(['vera'])
        expect(need(listed[0], 'agent').archivedAt).toBeDefined()

        const channel = yield* owner.api.channels.get({ path: { channelId: dm.id } })
        expect(channel.archivedAt).toBeDefined()

        // History intact — the point of archiving rather than deleting.
        const messages = yield* owner.api.messages.list({ urlParams: { channelId: dm.id } })
        expect(messages.items.map((m) => m.body)).toContain('hello vera')

        const posting = yield* Effect.flip(
          owner.api.messages.create({ payload: { channelId: dm.id, body: 'anyone?' } })
        )
        expect(posting._tag).toBe('Forbidden')
      })
    )

    it.effect('unarchiving brings the agent and the DM back', () =>
      Effect.gen(function* () {
        const owner = need(state.owner, 'owner')
        const vera = need(state.vera, 'vera')
        const dm = need(state.dm, 'dm')

        const back = yield* owner.api.agents.update({
          path: { agentId: vera.id },
          payload: { archived: false }
        })
        expect(back.archivedAt).toBeUndefined()
        expect(
          (yield* owner.api.channels.get({ path: { channelId: dm.id } })).archivedAt
        ).toBeUndefined()
        const sent = yield* owner.api.messages.create({
          payload: { channelId: dm.id, body: 'welcome back' }
        })
        expect(sent.body).toBe('welcome back')
      })
    )
  })
})
