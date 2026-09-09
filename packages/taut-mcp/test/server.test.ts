import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { Ajv } from 'ajv'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createTautServer, makeRuntime } from '../src/server.js'
import type { TautRuntime } from '../src/server.js'
import { ToolNames } from '../src/tools.js'
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
  client = new Client({ name: 'test-runtime', version: '0.0.0' })
  await client.connect(clientTransport)
})

afterAll(async () => {
  await client.close()
  await runtime.dispose()
  await fake.close()
})

beforeEach(() => {
  fake.requests.length = 0
  fake.answerAsks = false
  fake.failNext = undefined
})

const last = () => {
  const r = fake.requests.at(-1)
  if (r === undefined) throw new Error('no request recorded')
  return r
}

const call = async (name: string, args: Record<string, unknown>) => {
  const result = await client.callTool({ name, arguments: args })
  return result as {
    isError?: boolean
    structuredContent?: Record<string, unknown>
    content: Array<{ type: string; text?: string }>
  }
}

describe('MCP server', () => {
  it('lists every tool with a valid JSON-schema object input', async () => {
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).sort()).toEqual([...ToolNames].sort())
    const ajv = new Ajv({ strict: false })
    for (const t of tools) {
      expect(t.description?.length ?? 0).toBeGreaterThan(80)
      expect(t.inputSchema.type).toBe('object')
      expect(ajv.validateSchema(t.inputSchema)).toBe(true)
    }
    const ask = tools.find((t) => t.name === 'taut_ask')
    const props = ask?.inputSchema.properties as Record<string, { maximum?: number }>
    expect(props['timeoutSec']?.maximum).toBe(45)
    expect(ask?.inputSchema.required).toEqual(['to', 'text'])
  })

  it('taut_send and taut_done accept up to 10 `attachments` paths and say so', async () => {
    const { tools } = await client.listTools()
    for (const name of ['taut_send', 'taut_done'] as const) {
      const tool = tools.find((t) => t.name === name)
      const props = tool?.inputSchema.properties as Record<
        string,
        { type?: string; maxItems?: number; items?: { type?: string; maxLength?: number } }
      >
      expect(props['attachments']?.type).toBe('array')
      expect(props['attachments']?.maxItems).toBe(10)
      expect(props['attachments']?.items?.type).toBe('string')
      expect(props['attachments']?.items?.maxLength).toBe(1024)
      expect(tool?.inputSchema.required).not.toContain('attachments')
      expect(tool?.description).toContain('attachments: ["<path inside your home>"]')
    }
    const inbox = tools.find((t) => t.name === 'taut_inbox')
    expect(inbox?.description).toContain('attachments')
  })

  it('taut_send passes `attachments` through to POST /send', async () => {
    const r = await call('taut_send', { to: '@bruno', text: 'shot', attachments: ['work/a.png'] })
    expect(r.isError).toBeFalsy()
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/send',
      body: { to: '@bruno', text: 'shot', attachments: ['work/a.png'] }
    })
  })

  it('taut_send → POST /send with bearer auth and the body', async () => {
    const r = await call('taut_send', { to: '@bruno', text: 'hello', threadId: 'msg_1' })
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toEqual({
      posted: true,
      messageId: 'msg_9',
      channelId: 'chn_backend',
      threadId: 'msg_1',
      seq: 42
    })
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/send',
      authorization: `Bearer ${fake.token}`,
      body: { to: '@bruno', text: 'hello', threadId: 'msg_1' }
    })
  })

  /** docs/build-plan-steering-reactions.md D1, D6. */
  it('taut_react → POST /react, and `steer` survives decoding onto the result', async () => {
    const r = await call('taut_react', { messageId: 'msg_teal', emoji: '\u{1F44D}' })
    expect(r.isError).toBeFalsy()
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/react',
      body: { messageId: 'msg_teal', emoji: '\u{1F44D}' }
    })
    expect(r.structuredContent?.['on']).toBe(true)
    expect(r.structuredContent?.['reactions']).toEqual([{ emoji: '\u{1F44D}', count: 1 }])
    // The steer list is not on `ReactResponse`; it is merged in by the client on purpose, and
    // dropping it here would mean an agent never learns what landed while it worked.
    const steer = r.structuredContent?.['steer'] as ReadonlyArray<Record<string, unknown>>
    expect(steer).toHaveLength(1)
    expect(steer[0]?.['text']).toBe('We agreed: teal.')
  })

  it('taut_inbox → GET /inbox?since=', async () => {
    const r = await call('taut_inbox', { since: 40 })
    expect(last()).toMatchObject({
      method: 'GET',
      path: '/api/agent-runtime/inbox',
      query: { since: '40' }
    })
    expect(r.structuredContent?.['nextSince']).toBe(41)
    await call('taut_inbox', {})
    expect(last().query).toEqual({})
  })

  it('taut_ask parks after the timeout when nobody answers', async () => {
    const t0 = Date.now()
    const r = await call('taut_ask', { to: '@maria', text: 'drop or keep?', timeoutSec: 1 })
    const elapsed = Date.now() - t0
    expect(r.isError).toBeFalsy()
    expect(r.structuredContent).toMatchObject({ parked: true, askId: 'ask_1' })
    expect(elapsed).toBeGreaterThanOrEqual(900)
    expect(elapsed).toBeLessThan(5000)
    const [post, ...polls] = fake.requests
    expect(post).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/ask',
      body: { to: '@maria', text: 'drop or keep?', timeoutSec: 1 }
    })
    expect(polls.length).toBeGreaterThan(0)
    for (const p of polls) {
      expect(p.method).toBe('GET')
      expect(p.path).toBe('/api/agent-runtime/ask/ask_1')
      expect(Number(p.query['wait'])).toBeLessThanOrEqual(1000)
    }
  })

  it('taut_ask returns the answer when it arrives', async () => {
    fake.answerAsks = true
    const r = await call('taut_ask', { to: '@maria', text: 'drop or keep?', timeoutSec: 5 })
    expect(r.structuredContent).toMatchObject({
      answered: true,
      askId: 'ask_1',
      answer: { text: 'keep' }
    })
    expect(fake.requests).toHaveLength(2)
  })

  it('taut_ask rejects timeoutSec > 45 at the schema', async () => {
    const r = await call('taut_ask', { to: '@maria', text: 'x', timeoutSec: 90 })
    expect(r.isError).toBe(true)
    expect(fake.requests).toHaveLength(0)
  })

  it('taut_done / taut_handoff', async () => {
    const d = await call('taut_done', { summary: 'migrated', filesChanged: ['db/0002.sql'] })
    expect(d.structuredContent).toEqual({ posted: true, taskId: 'tsk_91', status: 'done' })
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/done',
      body: { summary: 'migrated', filesChanged: ['db/0002.sql'] }
    })
    const h = await call('taut_handoff', { to: '@ana', text: 'write the rollback' })
    expect(h.structuredContent).toMatchObject({ taskId: 'tsk_92' })
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/handoff',
      body: { to: '@ana', text: 'write the rollback' }
    })
  })

  it('memory_* tools hit their routes', async () => {
    const cases: Array<[string, Record<string, unknown>, string, string]> = [
      [
        'memory_search',
        { query: 'legacy', limit: 5, channelId: 'chn_backend' },
        'POST',
        '/memory/search'
      ],
      ['memory_grep', { pattern: 'TAUT-\\d+' }, 'POST', '/memory/grep'],
      ['memory_recall_thread', { threadId: 'msg_1' }, 'POST', '/memory/recall-thread'],
      [
        'memory_timeline',
        { from: '2026-09-01T00:00:00Z', to: '2026-09-02T00:00:00Z' },
        'POST',
        '/memory/timeline'
      ],
      ['memory_note', { text: 'Maria prefers nullable', tags: ['maria'] }, 'POST', '/memory/note'],
      ['memory_notes_list', { limit: 3 }, 'GET', '/memory/notes'],
      ['memory_forget', { id: 'note:note_1' }, 'POST', '/memory/forget']
    ]
    for (const [name, args, method, path] of cases) {
      const r = await call(name, args)
      expect(r.isError, name).toBeFalsy()
      const req = last()
      expect(req.method, name).toBe(method)
      expect(req.path, name).toBe(`/api/agent-runtime${path}`)
      expect(req.authorization).toBe(`Bearer ${fake.token}`)
      if (method === 'POST') expect(req.body, name).toEqual(args)
      else
        expect(req.query, name).toEqual(
          Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v)]))
        )
    }
    const s = await call('memory_search', { query: 'legacy' })
    const items = s.structuredContent?.['items'] as Array<Record<string, unknown>>
    expect(items[0]).toMatchObject({
      body: 'Drop legacy_id or keep nullable?',
      snippet: 'Drop [legacy_id]'
    })
  })

  it('vault_list → GET /vault (no args); vault_get → POST /vault/get; errors are readable', async () => {
    const list = await call('vault_list', {})
    expect(list.isError).toBeFalsy()
    expect(last()).toMatchObject({
      method: 'GET',
      path: '/api/agent-runtime/vault',
      query: {},
      authorization: `Bearer ${fake.token}`
    })
    const items = list.structuredContent?.['items'] as Array<Record<string, unknown>>
    expect(items.map((i) => i['scope'])).toEqual(['company', 'agent'])
    expect(JSON.stringify(items)).not.toContain('sk_test_SECRET')

    const got = await call('vault_get', { vaultItemId: 'vlt_agent_1' })
    expect(got.isError).toBeFalsy()
    expect(got.structuredContent).toEqual({
      id: 'vlt_agent_1',
      kind: 'generic.secret',
      label: 'Stripe test key',
      secret: 'sk_test_SECRET_abcd'
    })
    expect(last()).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/vault/get',
      authorization: `Bearer ${fake.token}`,
      body: { vaultItemId: 'vlt_agent_1' }
    })

    const forbidden = await call('vault_get', { vaultItemId: 'vlt_other_agent' })
    expect(forbidden.isError).toBe(true)
    expect(forbidden.content[0]?.text).toContain('forbidden')
    const missing = await call('vault_get', { vaultItemId: 'vlt_nope' })
    expect(missing.isError).toBe(true)
    expect(missing.content[0]?.text).toContain('not_found')
    const empty = await call('vault_get', { vaultItemId: '' })
    expect(empty.isError).toBe(true)

    const { tools } = await client.listTools()
    const get = tools.find((t) => t.name === 'vault_get')
    expect(get?.inputSchema.required).toEqual(['vaultItemId'])
    expect(get?.description).toMatch(/never paste/i)
    const ls = tools.find((t) => t.name === 'vault_list')
    expect(ls?.inputSchema.required ?? []).toEqual([])
    expect(ls?.description).toMatch(/shared/i)
    expect(ls?.description).toMatch(/private/i)
  })

  it('server errors become isError results the agent can read; needs_gate is explained', async () => {
    fake.failNext = {
      status: 403,
      body: { error: { code: 'needs_gate', message: 'cross-department.', gateId: 'msg_gate' } }
    }
    const r = await call('taut_send', { to: '@someone', text: 'hi' })
    expect(r.isError).toBe(true)
    expect(r.content[0]?.text).toContain('needs_gate')
    expect(r.content[0]?.text).toContain('msg_gate')

    fake.failNext = { status: 500, body: 'boom' }
    const r2 = await call('taut_inbox', {})
    expect(r2.isError).toBe(true)
    expect(r2.content[0]?.text).toContain('HTTP 500')

    const r3 = await call('taut_send', { to: 'bruno', text: 'no sigil' })
    expect(r3.isError).toBe(true)
    expect(r3.content[0]?.text).toContain('@handle')
  })
})
