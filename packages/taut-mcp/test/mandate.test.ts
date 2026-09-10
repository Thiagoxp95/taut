import { Effect } from 'effect'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runTool, ToolNames } from '../src/tools.js'
import { startFakeTaut, type FakeTaut } from './_fake.js'

let fake: FakeTaut
beforeAll(async () => {
  fake = await startFakeTaut()
})
afterAll(async () => {
  await fake.close()
})
beforeEach(() => {
  fake.requests.length = 0
  fake.failNext = undefined
})

const propose = (input: unknown) =>
  Effect.runPromise(runTool('mandate_propose', input).pipe(Effect.provide(fake.layer)))

describe('mandate proposal tool', () => {
  it('sends the complete preview and returns the permission card reference', async () => {
    fake.failNext = {
      status: 200,
      body: { message: { id: 'msg_approval', channelId: 'chn_backend' } }
    }
    expect(await propose({ mandate: '# New mandate\n\nReview accessibility.' })).toEqual({
      message: { id: 'msg_approval', channelId: 'chn_backend' }
    })
    expect(fake.requests).toEqual([
      {
        method: 'POST',
        path: '/api/agent-runtime/mandate/propose',
        query: {},
        authorization: `Bearer ${fake.token}`,
        body: { mandate: '# New mandate\n\nReview accessibility.' }
      }
    ])
    expect(ToolNames.some((name) => /mandate.*(approve|decide)/.test(name))).toBe(false)
  })

  it('surfaces a human-only refusal without a fallback write', async () => {
    fake.failNext = {
      status: 403,
      body: {
        error: { code: 'forbidden', message: 'A human in your department must request the change.' }
      }
    }
    await expect(propose({ mandate: '# Agent request' })).rejects.toThrow(
      'A human in your department'
    )
    expect(fake.requests).toHaveLength(1)
  })

  it('rejects missing or oversized previews before contacting the server', async () => {
    for (const input of [{}, { mandate: '' }, { mandate: 'x'.repeat(100_001) }])
      await expect(propose(input)).rejects.toThrow()
    expect(fake.requests).toHaveLength(0)
  })
})
