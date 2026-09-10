import { Effect } from 'effect'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { runTool } from '../src/tools.js'
import { parseArgs, runCli } from '../src/cli-core.js'
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

describe('delete own messages', () => {
  it('posts the message id with the task token and returns the deletion result', async () => {
    fake.failNext = { status: 200, body: { deleted: true, messageId: 'msg_old' } }
    expect(
      await Effect.runPromise(
        runTool('taut_delete', { messageId: 'msg_old' }).pipe(Effect.provide(fake.layer))
      )
    ).toEqual({ deleted: true, messageId: 'msg_old' })
    expect(fake.requests.at(-1)).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/delete',
      authorization: `Bearer ${fake.token}`,
      body: { messageId: 'msg_old' }
    })
  })
  it('rejects invalid ids before contacting the server and reports ownership refusals', async () => {
    for (const input of [{}, { messageId: '' }, { messageId: 'not-a-message' }])
      await expect(
        Effect.runPromise(runTool('taut_delete', input).pipe(Effect.provide(fake.layer)))
      ).rejects.toThrow()
    expect(fake.requests).toHaveLength(0)
    fake.failNext = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'You can only delete your own messages' } }
    }
    await expect(
      Effect.runPromise(
        runTool('taut_delete', { messageId: 'msg_other' }).pipe(Effect.provide(fake.layer))
      )
    ).rejects.toThrow('You can only delete your own messages')
  })
  it('exposes deletion through the CLI', async () => {
    expect(parseArgs(['delete'])).toMatchObject({ _tag: 'error' })
    fake.failNext = { status: 200, body: { deleted: true, messageId: 'msg_old' } }
    expect(
      await Effect.runPromise(runCli(['delete', 'msg_old']).pipe(Effect.provide(fake.layer)))
    ).toEqual({ exitCode: 0, stdout: 'deleted msg_old' })
  })
})
