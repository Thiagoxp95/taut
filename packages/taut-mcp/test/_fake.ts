/** A tiny in-test Taut server: records every request and answers with protocol-shaped bodies. */
import { FetchHttpClient } from '@effect/platform'
import { ConfigProvider, Layer } from 'effect'
import type { ConfigError } from 'effect'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { TautClient } from '../src/client.js'
import { AGENT_RUNTIME_PREFIX } from '../src/protocol.js'

export interface Recorded {
  readonly method: string
  readonly path: string
  readonly query: Readonly<Record<string, string>>
  readonly authorization: string | undefined
  readonly body: unknown
}

export interface FakeTaut {
  readonly url: string
  readonly token: string
  readonly requests: Array<Recorded>
  /** Flip to make `GET /ask/:id` answer instead of staying pending. */
  answerAsks: boolean
  /** Force the next response to this status + body. */
  failNext: { status: number; body: unknown } | undefined
  readonly layer: Layer.Layer<TautClient, ConfigError.ConfigError>
  readonly close: () => Promise<void>
}

const item = (over: Record<string, unknown> = {}) => ({
  id: 'message:msg_1',
  kind: 'message',
  sourceId: 'msg_1',
  channelId: 'chn_backend',
  threadId: null,
  authorKind: 'user',
  authorId: 'usr_maria',
  authorHandle: 'maria',
  at: '2026-09-01T10:00:00.000Z',
  body: 'Drop legacy_id or keep nullable?',
  text: '[#backend] [@maria] [2026-09-01]\nDrop legacy_id or keep nullable?',
  meta: {},
  ...over
})

const respond = (
  fake: FakeTaut,
  method: string,
  path: string,
  body: unknown
): { status: number; body: unknown } => {
  if (fake.failNext !== undefined) {
    const f = fake.failNext
    fake.failNext = undefined
    return f
  }
  const key = `${method} ${path}`
  if (key === 'POST /send')
    return {
      status: 200,
      body: {
        posted: true,
        messageId: 'msg_9',
        channelId: 'chn_backend',
        threadId: 'msg_1',
        seq: 42
      }
    }
  if (key === 'GET /inbox') {
    return {
      status: 200,
      body: {
        items: [
          {
            seq: 41,
            messageId: 'msg_8',
            channelId: 'chn_backend',
            channelName: 'backend',
            threadId: 'msg_1',
            from: { kind: 'user', id: 'usr_maria', handle: 'maria' },
            text: 'keep',
            at: '2026-09-01T10:05:00.000Z',
            intent: 'reply'
          }
        ],
        nextSince: 41
      }
    }
  }
  if (key === 'POST /ask')
    return { status: 200, body: { askId: 'ask_1', messageId: 'msg_10', threadId: 'msg_1' } }
  if (method === 'GET' && path.startsWith('/ask/')) {
    const askId = path.slice('/ask/'.length)
    return fake.answerAsks
      ? {
          status: 200,
          body: {
            askId,
            status: 'answered',
            answer: {
              text: 'keep',
              from: { kind: 'user', id: 'usr_maria', handle: 'maria' },
              at: '2026-09-01T10:06:00.000Z',
              messageId: 'msg_11'
            }
          }
        }
      : { status: 200, body: { askId, status: 'pending' } }
  }
  if (key === 'POST /react')
    return {
      status: 200,
      body: {
        messageId: 'msg_teal',
        emoji: '\u{1F44D}',
        on: true,
        reactions: [{ emoji: '\u{1F44D}', count: 1 }],
        // D6: `steer` rides on any response and must survive the client's decoding.
        steer: [
          {
            messageId: 'msg_teal',
            channelId: 'chn_backend',
            from: { kind: 'agent', id: 'agt_2', handle: 'dumb' },
            text: 'We agreed: teal.',
            at: '2026-09-09T16:13:00.000Z'
          }
        ]
      }
    }
  if (key === 'POST /done')
    return { status: 200, body: { posted: true, taskId: 'tsk_91', status: 'done' } }
  if (key === 'POST /handoff')
    return { status: 200, body: { taskId: 'tsk_92', threadId: 'msg_12', messageId: 'msg_12' } }
  if (key === 'POST /memory/search')
    return {
      status: 200,
      body: { items: [{ ...item(), snippet: 'Drop [legacy_id]', score: 1.2 }] }
    }
  if (key === 'POST /memory/grep') return { status: 200, body: { items: [item()] } }
  if (key === 'POST /memory/recall-thread')
    return {
      status: 200,
      body: { items: [item(), item({ id: 'message:msg_2', sourceId: 'msg_2', threadId: 'msg_1' })] }
    }
  if (key === 'POST /memory/timeline') return { status: 200, body: { items: [item()] } }
  if (key === 'POST /memory/note')
    return {
      status: 200,
      body: {
        item: item({ id: 'note:note_1', kind: 'note', sourceId: 'note_1', meta: { tags: ['x'] } })
      }
    }
  if (key === 'GET /memory/notes')
    return {
      status: 200,
      body: { items: [item({ id: 'note:note_1', kind: 'note', sourceId: 'note_1' })] }
    }
  if (key === 'POST /memory/forget') return { status: 200, body: { deleted: true } }
  if (key === 'GET /vault')
    return {
      status: 200,
      body: {
        items: [
          {
            id: 'vlt_company_1',
            kind: 'generic.secret',
            label: 'Stripe test key',
            hint: '••••abcd',
            scope: 'company',
            lastUsedAt: '2026-09-01T10:00:00.000Z'
          },
          {
            id: 'vlt_agent_1',
            kind: 'generic.secret',
            label: 'Mila GitHub PAT',
            hint: '••••wxyz',
            scope: 'agent'
          }
        ]
      }
    }
  if (key === 'POST /vault/get') {
    const id = (body as { vaultItemId?: string } | undefined)?.vaultItemId
    if (id === 'vlt_other_agent')
      return { status: 403, body: { error: { code: 'forbidden', message: 'not your item' } } }
    if (id !== 'vlt_company_1' && id !== 'vlt_agent_1')
      return { status: 404, body: { error: { code: 'not_found', message: 'no such item' } } }
    return {
      status: 200,
      body: { id, kind: 'generic.secret', label: 'Stripe test key', secret: 'sk_test_SECRET_abcd' }
    }
  }
  if (key === 'POST /git-credential') {
    const path = (body as { path?: string } | undefined)?.path
    if (path !== 'octocat/hello-world.git')
      return { status: 404, body: { error: { code: 'not_found', message: 'no grant' } } }
    return {
      status: 200,
      body: {
        username: 'x-access-token',
        password: 'ghs_TESTTOKEN',
        expiresAt: '2026-09-01T11:00:00.000Z'
      }
    }
  }
  if (key === 'POST /github/pull-request')
    return {
      status: 200,
      body: { url: 'https://github.com/octocat/hello-world/pull/7', number: 7 }
    }
  return { status: 404, body: { error: { code: 'not_found', message: `no route ${key}` } } }
}

export const startFakeTaut = (): Promise<FakeTaut> =>
  new Promise((resolve) => {
    const token = 'tok_test_123'
    const requests: Array<Recorded> = []
    let fake: FakeTaut
    const server: Server = createServer((req, res) => {
      const chunks: Array<Buffer> = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const raw = Buffer.concat(chunks).toString('utf8')
        const body: unknown = raw.length === 0 ? undefined : JSON.parse(raw)
        const prefixed = url.pathname.startsWith(AGENT_RUNTIME_PREFIX)
        const path = prefixed ? url.pathname.slice(AGENT_RUNTIME_PREFIX.length) : url.pathname
        requests.push({
          method: req.method ?? '',
          path: url.pathname,
          query: Object.fromEntries(url.searchParams.entries()),
          authorization: req.headers.authorization,
          body
        })
        const out =
          req.headers.authorization !== `Bearer ${token}`
            ? { status: 401, body: { error: { code: 'unauthorized', message: 'bad token' } } }
            : !prefixed
              ? { status: 404, body: { error: { code: 'not_found', message: 'outside prefix' } } }
              : respond(fake, req.method ?? '', path, body)
        res.writeHead(out.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out.body))
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      const url = `http://127.0.0.1:${port}`
      const config = Layer.setConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ['TAUT_URL', `${url}/`],
            ['TAUT_TOKEN', token],
            ['TAUT_TASK_ID', 'tsk_91']
          ])
        )
      )
      fake = {
        url,
        token,
        requests,
        answerAsks: false,
        failNext: undefined,
        layer: TautClient.Default.pipe(Layer.provide(FetchHttpClient.layer), Layer.provide(config)),
        close: () => new Promise<void>((done) => server.close(() => done()))
      }
      resolve(fake)
    })
  })
