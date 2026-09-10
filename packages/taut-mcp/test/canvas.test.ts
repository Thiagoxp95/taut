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

const summary = {
  id: 'cnv_yellow',
  title: 'Yellow sidebar',
  channelId: 'chn_backend',
  threadId: 'msg_1',
  agentId: 'agt_1',
  open: true,
  revision: 1,
  updatedAt: '2026-09-09T16:00:00.000Z'
}
const html = '<!doctype html><html><body style="background:yellow">Sidebar</body></html>'

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    content: Array<{ type: string; text?: string }>
  }

describe('canvas MCP tools', () => {
  it.each([
    ['canvas_create', { title: 'Yellow sidebar', html }, '/canvases/create'],
    ['canvas_create', { title: 'Yellow sidebar', html, open: false }, '/canvases/create'],
    ['canvas_update', { canvasId: 'cnv_yellow', html }, '/canvases/update'],
    ['canvas_update', { canvasId: 'cnv_yellow', title: 'New title' }, '/canvases/update'],
    ['canvas_open', { canvasId: 'cnv_yellow' }, '/canvases/open'],
    ['canvas_close', { canvasId: 'cnv_yellow' }, '/canvases/close']
  ] as const)('%s sends its payload and returns only a summary', async (name, args, path) => {
    fake.failNext = { status: 200, body: { canvas: { ...summary, html } } }
    const result = await call(name, args)
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ canvas: summary })
    expect(fake.requests).toEqual([
      {
        method: 'POST',
        path: `/api/agent-runtime${path}`,
        query: {},
        authorization: `Bearer ${fake.token}`,
        body: args
      }
    ])
    expect(JSON.stringify(result)).not.toContain('<!doctype')
  })

  it('lists summaries in the authenticated context without sending a caller-selected scope', async () => {
    fake.failNext = { status: 200, body: { items: [{ ...summary, html }] } }
    const result = await call('canvas_list', {})
    expect(result.isError).toBeFalsy()
    expect(result.structuredContent).toEqual({ items: [summary] })
    expect(fake.requests).toEqual([
      {
        method: 'GET',
        path: '/api/agent-runtime/canvases',
        query: {},
        authorization: `Bearer ${fake.token}`,
        body: undefined
      }
    ])
  })

  it.each([
    ['canvas_create', { title: '', html }],
    ['canvas_create', { title: 'x'.repeat(201), html }],
    ['canvas_create', { title: 'Preview', html: '' }],
    ['canvas_create', { title: 'Preview', html: 'x'.repeat(1_000_001) }],
    ['canvas_create', { title: 'Preview', html, open: 'true' }],
    ['canvas_update', { canvasId: '', html }],
    ['canvas_update', { canvasId: 'cnv_yellow', title: '' }],
    ['canvas_update', { canvasId: 'cnv_yellow', html: '' }],
    ['canvas_update', { canvasId: 'cnv_yellow', title: 'x'.repeat(201) }],
    ['canvas_update', { canvasId: 'cnv_yellow', html: 'x'.repeat(1_000_001) }],
    ['canvas_open', { canvasId: '' }],
    ['canvas_close', {}]
  ] as const)('rejects invalid %s arguments before making an HTTP request', async (name, args) => {
    const result = await call(name, args)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('invalid arguments')
    expect(fake.requests).toHaveLength(0)
  })

  it('accepts the title and HTML upper bounds', async () => {
    fake.failNext = { status: 200, body: { canvas: summary } }
    const result = await call('canvas_create', {
      title: 'x'.repeat(200),
      html: 'x'.repeat(1_000_000)
    })
    expect(result.isError).toBeFalsy()
    expect(fake.requests).toHaveLength(1)
  })

  it('preserves an ownership refusal as an actionable tool error', async () => {
    fake.failNext = {
      status: 403,
      body: { error: { code: 'forbidden', message: 'Canvas belongs to another agent.' } }
    }
    const result = await call('canvas_close', { canvasId: 'cnv_other' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('forbidden (HTTP 403)')
    expect(result.content[0]?.text).toContain('Canvas belongs to another agent.')
  })

  it('rejects malformed summaries instead of reporting a successful operation', async () => {
    fake.failNext = { status: 200, body: { canvas: { id: 'cnv_yellow' } } }
    const result = await call('canvas_open', { canvasId: 'cnv_yellow' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('unexpected response shape')
  })
})
