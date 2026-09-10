import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { parseArgs, runCli } from '../src/cli-core.js'
import { makeRuntime } from '../src/server.js'
import type { TautRuntime } from '../src/server.js'
import { ToolNames } from '../src/tools.js'
import { startFakeTaut } from './_fake.js'
import type { FakeTaut } from './_fake.js'

let fake: FakeTaut
let runtime: TautRuntime

beforeAll(async () => {
  fake = await startFakeTaut()
  runtime = makeRuntime(fake.layer)
})
afterAll(async () => {
  await runtime.dispose()
  await fake.close()
})
beforeEach(() => {
  fake.requests.length = 0
})

const run = (argv: ReadonlyArray<string>, stdin?: string) => runtime.runPromise(runCli(argv, stdin))

describe('parseArgs', () => {
  it('lists teammates or searches their capabilities with a bounded result size', async () => {
    const result = await run(['agents', 'production', 'SQL', '--limit', '5', '--json'])
    expect(result.exitCode).toBe(0)
    expect(JSON.parse(result.stdout)).toMatchObject({ agents: [{ handle: 'database' }] })
    expect(fake.requests.at(-1)).toMatchObject({ body: { query: 'production SQL', limit: 5 } })
    expect(parseArgs(['agents'])).toMatchObject({ tool: 'taut_agent_search', input: {} })
  })
  it('maps every command to a tool + input', () => {
    expect(parseArgs(['send', '@bruno', 'hello', 'there', '--thread', 'msg_1'])).toEqual({
      _tag: 'tool',
      tool: 'taut_send',
      input: { to: '@bruno', text: 'hello there', threadId: 'msg_1' },
      json: false
    })
    expect(parseArgs(['inbox', '--since', '7', '--json'])).toMatchObject({
      tool: 'taut_inbox',
      input: { since: 7 },
      json: true
    })
    expect(parseArgs(['ask', '@maria', 'drop?', '--timeout=10'])).toMatchObject({
      tool: 'taut_ask',
      input: { to: '@maria', text: 'drop?', timeoutSec: 10 }
    })
    expect(parseArgs(['done', 'all', 'good', '--failed', '--files', 'a.ts,b.ts'])).toMatchObject({
      tool: 'taut_done',
      input: { summary: 'all good', outcome: 'failed', filesChanged: ['a.ts', 'b.ts'] }
    })
    expect(parseArgs(['send', '@bruno', 'see', '--attach', 'work/shot.png,work/out.csv'])).toEqual({
      _tag: 'tool',
      tool: 'taut_send',
      input: { to: '@bruno', text: 'see', attachments: ['work/shot.png', 'work/out.csv'] },
      json: false
    })
    expect(parseArgs(['done', 'shipped', '--attach', '/home/agent/work/report.pdf'])).toMatchObject(
      {
        tool: 'taut_done',
        input: { summary: 'shipped', attachments: ['/home/agent/work/report.pdf'] }
      }
    )
    expect(parseArgs(['handoff', '@ana', 'rollback'])).toMatchObject({
      tool: 'taut_handoff',
      input: { to: '@ana', text: 'rollback' }
    })
    expect(
      parseArgs([
        'mem',
        'search',
        'legacy',
        'id',
        '--limit',
        '3',
        '--channel',
        'chn_1',
        '--author',
        'usr_1'
      ])
    ).toMatchObject({
      tool: 'memory_search',
      input: { query: 'legacy id', limit: 3, channelId: 'chn_1', authorId: 'usr_1' }
    })
    expect(parseArgs(['mem', 'grep', 'TAUT-\\d+', '--flags', 'g'])).toMatchObject({
      tool: 'memory_grep',
      input: { pattern: 'TAUT-\\d+', flags: 'g' }
    })
    expect(parseArgs(['mem', 'recall', 'msg_1'])).toMatchObject({
      tool: 'memory_recall_thread',
      input: { threadId: 'msg_1' }
    })
    expect(parseArgs(['mem', 'timeline', 'a', 'b', '--channel', 'c'])).toMatchObject({
      tool: 'memory_timeline',
      input: { from: 'a', to: 'b', channelId: 'c' }
    })
    expect(parseArgs(['mem', 'note', 'remember', 'this', '--tags', 'x,y'])).toMatchObject({
      tool: 'memory_note',
      input: { text: 'remember this', tags: ['x', 'y'] }
    })
    expect(parseArgs(['mem', 'notes'])).toMatchObject({ tool: 'memory_notes_list', input: {} })
    expect(parseArgs(['mem', 'forget', 'note:1'])).toMatchObject({
      tool: 'memory_forget',
      input: { id: 'note:1' }
    })
    expect(parseArgs(['vault', 'list'])).toMatchObject({ tool: 'vault_list', input: {} })
    expect(parseArgs(['vault', 'get', 'vlt_1', '--json'])).toMatchObject({
      tool: 'vault_get',
      input: { vaultItemId: 'vlt_1' },
      json: true
    })
    expect(parseArgs(['vault', 'get'])._tag).toBe('error')
    expect(parseArgs(['vault', 'nope'])._tag).toBe('error')
    expect(parseArgs(['describe', '--json'])).toEqual({ _tag: 'describe', json: true })
    expect(parseArgs([])).toEqual({ _tag: 'help' })
    expect(parseArgs(['nope'])._tag).toBe('error')
    expect(parseArgs(['send', '@x'])._tag).toBe('error')
  })
})

describe('runCli', () => {
  it('--json output parses and matches the server response', async () => {
    const { stdout, exitCode } = await run(['send', '@bruno', 'hello', '--json'])
    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout)).toEqual({
      posted: true,
      messageId: 'msg_9',
      channelId: 'chn_backend',
      threadId: 'msg_1',
      seq: 42
    })
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/send',
      body: { to: '@bruno', text: 'hello' }
    })
  })

  it('human output is readable text', async () => {
    const inbox = await run(['inbox'])
    expect(inbox.stdout).toContain('@maria')
    expect(inbox.stdout).toContain('keep')
    expect(inbox.stdout).toContain('nextSince 41')
    const search = await run(['mem', 'search', 'legacy'])
    expect(search.stdout).toContain('Drop [legacy_id]')
    const ask = await run(['ask', '@maria', 'drop?', '--timeout', '1'])
    expect(ask.stdout).toContain('parked')
    expect(ask.exitCode).toBe(0)
  })

  it('vault list renders masked rows; vault get prints only the value', async () => {
    const list = await run(['vault', 'list'])
    expect(list.exitCode).toBe(0)
    expect(list.stdout).toContain('vlt_company_1  company')
    expect(list.stdout).toContain('vlt_agent_1  agent')
    expect(list.stdout).toContain('••••wxyz')
    expect(list.stdout).not.toContain('sk_test_SECRET')
    expect(fake.requests[0]).toMatchObject({ method: 'GET', path: '/api/agent-runtime/vault' })
    const get = await run(['vault', 'get', 'vlt_company_1'])
    expect(get.stdout).toBe('sk_test_SECRET_abcd')
    const denied = await run(['vault', 'get', 'vlt_other_agent'])
    expect(denied.exitCode).toBe(1)
    expect(denied.stdout).toContain('forbidden')
  })

  it('describe --json lists every tool with schemas', async () => {
    const { stdout } = await run(['describe', '--json'])
    const described = JSON.parse(stdout) as Array<{ name: string; inputSchema: { type: string } }>
    expect(described.map((t) => t.name).sort()).toEqual([...ToolNames].sort())
    expect(described.every((t) => t.inputSchema.type === 'object')).toBe(true)
  })

  it('opens a pull request through the server, never the GitHub API', async () => {
    const r = await run(['pr', 'octocat/hello-world', 'Fix the parser', '--body', 'why'])
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('pull request #7 — https://github.com/octocat/hello-world/pull/7')
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/github/pull-request',
      body: { repo: 'octocat/hello-world', title: 'Fix the parser', body: 'why' }
    })
  })

  it('git-credential get trades the task token for a repository-scoped one', async () => {
    const block = 'protocol=https\nhost=github.com\npath=octocat/hello-world.git\n\n'
    const r = await run(['git-credential', 'get'], block)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toBe('username=x-access-token\npassword=ghs_TESTTOKEN')
    expect(fake.requests[0]).toMatchObject({
      method: 'POST',
      path: '/api/agent-runtime/git-credential',
      body: { host: 'github.com', path: 'octocat/hello-world.git' }
    })
  })

  it('git-credential says nothing and exits 0 on store, erase and every failure', async () => {
    const block = 'protocol=https\nhost=github.com\npath=octocat/hello-world.git\n\n'
    for (const op of ['store', 'erase', '']) {
      const r = await run(['git-credential', op], block)
      expect(r).toEqual({ stdout: '', exitCode: 0 })
    }
    expect(fake.requests).toHaveLength(0)
    // No repository path in the block (useHttpPath off): nothing to ask for, so nothing is
    // asked and nothing is printed — git falls through to "no credentials", never a prompt.
    const noPath = await run(['git-credential', 'get'], 'protocol=https\nhost=github.com\n\n')
    expect(noPath).toEqual({ stdout: '', exitCode: 0 })
    expect(fake.requests).toHaveLength(0)
    // No grant for this repository (D14) is a 404, and that is silent too.
    const denied = await run(
      ['git-credential', 'get'],
      'protocol=https\nhost=github.com\npath=someone/else.git\n\n'
    )
    expect(denied).toEqual({ stdout: '', exitCode: 0 })
    fake.failNext = { status: 500, body: { error: { code: 'server_error', message: 'boom' } } }
    expect(await run(['git-credential', 'get'], block)).toEqual({ stdout: '', exitCode: 0 })
    // An ssh remote, or a block with no host, never reaches the server at all.
    fake.requests.length = 0
    expect(await run(['git-credential', 'get'], 'protocol=ssh\nhost=github.com\n')).toEqual({
      stdout: '',
      exitCode: 0
    })
    expect(await run(['git-credential', 'get'], '')).toEqual({ stdout: '', exitCode: 0 })
    expect(fake.requests).toHaveLength(0)
  })

  it('errors exit 1 and are JSON with --json', async () => {
    fake.failNext = { status: 429, body: { error: { code: 'rate_limited', message: 'slow down' } } }
    const r = await run(['send', '@bruno', 'x', '--json'])
    expect(r.exitCode).toBe(1)
    expect(JSON.parse(r.stdout)).toMatchObject({ error: { tag: 'TautApiError' } })
    const bad = await run(['send'])
    expect(bad.exitCode).toBe(1)
    expect(bad.stdout).toContain('taut send')
  })
})
