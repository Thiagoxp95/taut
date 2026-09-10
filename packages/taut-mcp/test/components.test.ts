import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTautServer, makeRuntime } from '../src/server.js'
import type { TautRuntime } from '../src/server.js'
import { startFakeTaut } from './_fake.js'
import type { FakeTaut } from './_fake.js'

let fake: FakeTaut
let runtime: TautRuntime
let client: Client

beforeAll(async () => {
  fake = await startFakeTaut()
  runtime = makeRuntime(fake.layer)
  const server = createTautServer(runtime)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  await server.connect(serverTransport)
  client = new Client({ name: 'canvas-test', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
  await runtime.dispose()
  await fake.close()
})

beforeEach(() => {
  fake.requests.length = 0
  fake.failNext = undefined
})

const call = async (name: string, args: Record<string, unknown>) =>
  client.callTool({ name, arguments: args })

describe('shared component tools', () => {
  it('advertises timer and card arguments through valid MCP object schemas', async () => {
    const list = await client.listTools()
    const render = list.tools.find((t) => t.name === 'render_component')!
    expect(render.inputSchema.type).toBe('object')
    expect(render.inputSchema.properties).toHaveProperty('durationSeconds')
    expect(render.inputSchema.properties).toHaveProperty('body')
    const ask = list.tools.find((t) => t.name === 'ask_user_question')!
    expect(ask.inputSchema.required).toContain('questions')
  })
  it('renders a timer with the task token and validates before requesting', async () => {
    const input = { kind: 'timer', title: 'Focus', durationSeconds: 60, onComplete: 'Check in' }
    fake.failNext = { status: 200, body: { messageId: 'msg_timer' } }
    expect((await call('render_component', input)).isError).toBeFalsy()
    expect(fake.requests[0]).toMatchObject({
      path: '/api/agent-runtime/components/render',
      body: input,
      authorization: `Bearer ${fake.token}`
    })
    fake.requests.length = 0
    expect((await call('render_component', { ...input, durationSeconds: 0 })).isError).toBe(true)
    expect((await call('render_component', { kind: 'timer', title: 'No action' })).isError).toBe(
      true
    )
    expect(fake.requests).toHaveLength(0)
  })
  it.each([300, '300', '300.0'])(
    'starts a five-minute timer when the agent supplies durationSeconds=%j',
    async (durationSeconds) => {
      fake.failNext = {
        status: 200,
        body: {
          messageId: 'msg_timer',
          signalId: 'sig_timer',
          endsAt: '2026-09-10T19:05:00.000Z'
        }
      }
      const result = await call('render_component', {
        kind: 'timer',
        title: 'Five-minute timer',
        durationSeconds,
        onComplete: 'Tell the user the five minutes are up.'
      })
      expect(result.isError, JSON.stringify(result.content)).toBeFalsy()
      expect(result.structuredContent).toMatchObject({
        messageId: 'msg_timer',
        signalId: 'sig_timer',
        endsAt: '2026-09-10T19:05:00.000Z'
      })
      expect(fake.requests).toHaveLength(1)
      expect(fake.requests[0]?.body).toEqual({
        kind: 'timer',
        title: 'Five-minute timer',
        durationSeconds: 300,
        onComplete: 'Tell the user the five minutes are up.'
      })
    }
  )
  it.each([
    '',
    ' ',
    '0',
    '-1',
    '300.5',
    '604801',
    'Infinity',
    'NaN',
    '0x12',
    '300s',
    true,
    null,
    [300]
  ])('rejects invalid timer duration %j without scheduling anything', async (durationSeconds) => {
    const result = await call('render_component', {
      kind: 'timer',
      title: 'Invalid timer',
      durationSeconds,
      onComplete: 'Check in'
    })
    expect(result.isError).toBe(true)
    expect(fake.requests).toHaveLength(0)
  })
  it('posts structured questions and parks through the existing ask protocol', async () => {
    fake.failNext = {
      status: 200,
      body: { askId: 'ask_1', messageId: 'msg_q', threadId: 'msg_1', parked: true }
    }
    const questions = [
      { id: 'color', question: 'Color?', options: [{ label: 'Blue' }, { label: 'Green' }] }
    ]
    const result = await call('ask_user_question', {
      to: '@ted',
      text: 'Choose a color',
      questions
    })
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toMatchObject({ parked: true, askId: 'ask_1' })
    expect(fake.requests[0]?.body).toMatchObject({ questions })
  })
})
