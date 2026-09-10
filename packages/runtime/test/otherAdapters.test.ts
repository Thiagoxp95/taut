import { describe, expect, it } from 'vitest'

import { adapterFor, adapters } from '../src/adapters/index.js'
import { codex, parseCodexLine } from '../src/adapters/codex.js'
import { cursor, parseCursorLine } from '../src/adapters/cursor.js'
import { opencode, opencodePermission, parseOpencodeLine } from '../src/adapters/opencode.js'
import { fixture } from './helpers.js'

const base = {
  prompt: 'hello',
  cwd: '/home/agent/work/tsk_1',
  home: '/home/agent',
  permissionMode: 'auto-edit' as const
}

describe('adapter registry', () => {
  it('has one adapter per runtime kind', () => {
    expect(Object.keys(adapters).sort()).toEqual(['claude-code', 'codex', 'cursor', 'opencode'])
    expect(adapterFor('codex').binary).toBe('codex')
  })
})

describe('codex (untested beyond detect)', () => {
  it('builds codex exec --json with prompt on stdin and CODEX_HOME in the agent home', () => {
    const built = codex.buildCommand({
      ...base,
      model: 'gpt-5-codex',
      credential: { kind: 'openai.api_key', secret: 'sk-openai' }
    })
    expect(built.cmd).toEqual([
      'codex',
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--sandbox',
      'workspace-write',
      '-C',
      '/home/agent/work/tsk_1',
      '-m',
      'gpt-5-codex',
      '-'
    ])
    expect(built.stdin).toBe('hello')
    expect(built.env).toEqual({
      CODEX_HOME: '/home/agent/.taut/codex',
      CODEX_API_KEY: 'sk-openai',
      OPENAI_API_KEY: 'sk-openai'
    })
  })

  it('uses read-only sandbox for plan, resume subcommand, and writes auth.json for oauth', () => {
    const plan = codex.buildCommand({ ...base, permissionMode: 'plan' })
    expect(plan.cmd).toContain('read-only')
    const resumed = codex.buildCommand({
      ...base,
      resumeSessionId: 'thr_1',
      credential: { kind: 'openai.oauth', secret: '{"tokens":{}}' }
    })
    expect(resumed.cmd.slice(0, 4)).toEqual(['codex', 'exec', 'resume', 'thr_1'])
    expect(resumed.cmd).not.toContain('--sandbox')
    expect(resumed.files).toEqual([
      { path: '/home/agent/.taut/codex/auth.json', content: '{"tokens":{}}', mode: 0o600 }
    ])
  })

  it('parses the documented JSONL events best-effort', () => {
    const events = fixture('codex-stream.ndjson').flatMap((l) => [...parseCodexLine(l)])
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'tool_use',
      'tool_result',
      // Reasoning is its own event, never part of the reply (docs/build-plan-activity.md D4).
      'thinking',
      'file_change',
      'file_change',
      'text_delta',
      'usage',
      // The turn's counters are also one reading of the window
      // (docs/build-plan-context-meter.md D4).
      'context',
      'done',
      'raw'
    ])
    expect(events[0]).toEqual({
      type: 'session',
      sessionId: '0199a1b2-1111-7000-8000-abcdefabcdef'
    })
    expect(events[2]).toEqual({
      type: 'tool_result',
      toolUseId: 'item_0',
      content: 'hi\n',
      isError: false
    })
    expect(events[3]).toEqual({ type: 'thinking', text: 'thinking' })
    expect(events[4]).toEqual({ type: 'file_change', path: 'src/a.ts', kind: 'create' })
    expect(events[7]).toEqual({
      type: 'usage',
      inputTokens: 1200,
      outputTokens: 90,
      cacheReadTokens: 800
    })
    expect(events[8]).toMatchObject({ type: 'context', usedTokens: 1290 })
    expect(events[9]).toMatchObject({ type: 'done', ok: true })
  })
})

describe('cursor (untested beyond detect)', () => {
  it('builds cursor-agent -p stream-json with the prompt in argv', () => {
    const built = cursor.buildCommand({
      ...base,
      credential: { kind: 'cursor.api_key', secret: 'cur-key' },
      resumeSessionId: 'chat_1'
    })
    expect(built.cmd).toEqual([
      'cursor-agent',
      '-p',
      '--output-format',
      'stream-json',
      '--trust',
      '--workspace',
      '/home/agent/work/tsk_1',
      '--force',
      '--resume',
      'chat_1',
      'hello'
    ])
    expect(built.env).toEqual({ CURSOR_API_KEY: 'cur-key' })
    expect(cursor.buildCommand({ ...base, permissionMode: 'plan' }).cmd).toContain('plan')
    expect(built.cmd).not.toContain('--approve-mcps')
  })

  it('adds --approve-mcps when MCP servers are configured (allow-list lives in .cursor/cli.json)', () => {
    const built = cursor.buildCommand({
      ...base,
      mcp: { configPath: '/ignored', allowedTools: ['mcp__taut__*', 'mcp__browser__*'] }
    })
    expect(built.cmd.slice(-2)).toEqual(['--approve-mcps', 'hello'])
    expect(built.cmd).not.toContain('/ignored')
  })

  it('adds --approve-mcps only when MCP is configured (servers come from .cursor/mcp.json)', () => {
    expect(cursor.buildCommand(base).cmd).not.toContain('--approve-mcps')
    const withMcp = cursor.buildCommand({
      ...base,
      mcp: { configPath: '/ignored', allowedTools: ['mcp__taut__*', 'mcp__browser__*'] }
    })
    expect(withMcp.cmd.slice(-2)).toEqual(['--approve-mcps', 'hello'])
    expect(withMcp.cmd).not.toContain('/ignored')
  })

  it('parses stream-json best-effort', () => {
    const events = fixture('cursor-stream.ndjson').flatMap((l) => [...parseCursorLine(l)])
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'text_delta',
      'tool_use',
      'tool_result',
      'done'
    ])
    expect(events[2]).toMatchObject({
      id: 'c1',
      name: 'readToolCall',
      input: { path: 'README.md' }
    })
    expect(events[4]).toMatchObject({ ok: true, summary: 'Hello from cursor', durationMs: 1234 })
  })
})

describe('opencode (untested beyond detect)', () => {
  it('builds opencode run --format json', () => {
    const built = opencode.buildCommand({
      ...base,
      permissionMode: 'plan',
      model: 'anthropic/claude-sonnet-4',
      resumeSessionId: 'ses_1',
      credential: { kind: 'anthropic.api_key', secret: 'sk-ant' }
    })
    expect(built.cmd).toEqual([
      'opencode',
      'run',
      '--format',
      'json',
      '--model',
      'anthropic/claude-sonnet-4',
      '--agent',
      'plan',
      '--session',
      'ses_1',
      'hello'
    ])
    expect(built.env).toEqual({ ANTHROPIC_API_KEY: 'sk-ant' })
    // no CLI allow-list on opencode/codex: `mcp` must not leak into argv
    const withMcp = opencode.buildCommand({ ...base, mcp: { configPath: '/ignored' } })
    expect(withMcp.cmd).toEqual(opencode.buildCommand(base).cmd)
    expect(codex.buildCommand({ ...base, mcp: { configPath: '/ignored' } }).cmd).toEqual(
      codex.buildCommand(base).cmd
    )
  })

  it('turns file grants into an opencode.json permission block (ro denies edit)', () => {
    expect(opencodePermission([])).toBeUndefined()
    expect(opencodePermission([{ path: '/srv/scratch', mode: 'rw' }])).toEqual({
      external_directory: { '/srv/scratch': 'allow', '/srv/scratch/**': 'allow' }
    })
    expect(
      opencodePermission([
        { path: '/srv/shared', mode: 'ro' },
        { path: '/srv/scratch', mode: 'rw' }
      ])
    ).toEqual({
      external_directory: {
        '/srv/shared': 'allow',
        '/srv/shared/**': 'allow',
        '/srv/scratch': 'allow',
        '/srv/scratch/**': 'allow'
      },
      edit: { '/srv/shared': 'deny', '/srv/shared/**': 'deny' }
    })
    // buildCommand has no flag for them: addDirs is ignored on opencode and cursor.
    expect(opencode.buildCommand({ ...base, addDirs: ['/srv/shared'] }).cmd).toEqual(
      opencode.buildCommand(base).cmd
    )
    expect(cursor.buildCommand({ ...base, addDirs: ['/srv/shared'] }).cmd).toEqual(
      cursor.buildCommand(base).cmd
    )
  })

  it('parses the JSON event stream best-effort', () => {
    const events = fixture('opencode-stream.ndjson').flatMap((l) => [...parseOpencodeLine(l)])
    expect(events.map((e) => e.type)).toEqual([
      'session',
      'tool_use',
      'tool_result',
      'session',
      'text_delta',
      'usage',
      // One step's counters, sampled for the context meter (D4).
      'context',
      'error'
    ])
    expect(events[5]).toEqual({
      type: 'usage',
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 50,
      cacheWriteTokens: 10,
      costUsd: 0.01
    })
    expect(events[6]).toMatchObject({ type: 'context', usedTokens: 180 })
    expect(events[7]).toEqual({
      type: 'error',
      message: 'invalid api key',
      code: 'ProviderAuthError'
    })
  })
})
