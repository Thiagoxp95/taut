import { describe, expect, it } from 'vitest'

import { claudeCode, parseClaudeLine } from '../src/adapters/claudeCode.js'
import type { AgentEvent } from '../src/adapters/types.js'
import { fixture } from './helpers.js'

const parseAll = (lines: ReadonlyArray<string>): Array<AgentEvent> =>
  lines.flatMap((l) => [...parseClaudeLine(l)])

describe('claude-code parser', () => {
  const events = parseAll(fixture('claude-stream.ndjson'))
  const types = events.map((e) => e.type)

  it('reads session id and model from system.init and ignores hook events', () => {
    expect(events[0]).toEqual({
      type: 'session',
      sessionId: 'd4486ffc-c7f9-4fdc-82b2-a517630e5869',
      model: 'claude-fable-5-1'
    })
    expect(types.filter((t) => t === 'session')).toHaveLength(1)
  })

  it('turns assistant blocks into text_delta / tool_use and Write into file_change', () => {
    expect(events).toContainEqual({ type: 'text_delta', text: 'Let me check the probe.' })
    const bash = events.find((e) => e.type === 'tool_use' && e.name === 'Bash')
    expect(bash).toMatchObject({
      id: 'toolu_01AMME7DyUgrZdSvBov7m3AT',
      input: { command: expect.any(String) }
    })
    expect(events).toContainEqual({
      type: 'file_change',
      path: '/home/agent/work/tsk_1/notes.md',
      kind: 'create'
    })
  })

  it('turns user tool_result blocks (string or block array) into tool_result', () => {
    const results = events.filter((e) => e.type === 'tool_result')
    expect(results).toHaveLength(2)
    expect(results[0]).toMatchObject({
      toolUseId: 'toolu_01AMME7DyUgrZdSvBov7m3AT',
      isError: false
    })
    expect(results[1]).toMatchObject({
      toolUseId: 'toolu_02',
      content: 'File created successfully at: /home/agent/work/tsk_1/notes.md'
    })
  })

  it('emits usage + done from the result line', () => {
    const last = events.at(-1)
    expect(last).toEqual({
      type: 'done',
      ok: true,
      summary: 'taut-probe-ok',
      reason: 'success',
      sessionId: 'd4486ffc-c7f9-4fdc-82b2-a517630e5869',
      numTurns: 3,
      durationMs: 4382,
      costUsd: 0.2689315
    })
    expect(events.at(-2)).toEqual({
      type: 'usage',
      inputTokens: 34,
      outputTokens: 92,
      cacheReadTokens: 39726,
      cacheWriteTokens: 12703,
      costUsd: 0.2689315
    })
  })

  it('falls back to raw for malformed JSON and plain text, skips blank lines and rate-limit pings', () => {
    const raws = events.filter((e) => e.type === 'raw')
    expect(raws).toHaveLength(2)
    expect(raws[0]?.line.startsWith('{"type":"assistant"')).toBe(true)
    expect(raws[1]?.line).toMatch(/^Warning: no stdin/)
    expect(parseClaudeLine('')).toEqual([])
    expect(parseClaudeLine('   ')).toEqual([])
  })

  it('reports an auth failure as error + done{ok:false} even though subtype is "success"', () => {
    const auth = parseAll(fixture('claude-auth-failed.ndjson'))
    expect(auth.map((e) => e.type)).toEqual(['session', 'error', 'usage', 'done'])
    expect(auth[1]).toEqual({
      type: 'error',
      message: 'Not logged in · Please run /login',
      code: 'authentication_failed'
    })
    expect(auth[3]).toMatchObject({ type: 'done', ok: false, reason: 'api_error' })
  })

  it('maps error_* subtypes to ok:false', () => {
    const [done] = parseClaudeLine(
      JSON.stringify({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 50 })
    )
    expect(done).toMatchObject({ type: 'done', ok: false, reason: 'error_max_turns' })
  })
})

describe('claude-code buildCommand', () => {
  const base = {
    prompt: 'reply with exactly: pong',
    cwd: '/home/agent/work/tsk_1',
    home: '/home/agent',
    permissionMode: 'auto-edit' as const
  }

  it('builds the headless command with the prompt on stdin', () => {
    const built = claudeCode.buildCommand({
      ...base,
      credential: { kind: 'anthropic.api_key', secret: 'sk-ant-test' }
    })
    expect(built.cmd).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits'
    ])
    expect(built.stdin).toBe('reply with exactly: pong')
    expect(built.env).toEqual({
      DISABLE_AUTOUPDATER: '1',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      CLAUDE_CONFIG_DIR: '/home/agent/.taut/claude',
      ANTHROPIC_API_KEY: 'sk-ant-test'
    })
    expect(built.cmd).not.toContain('--bare')
    expect(built.cmd).not.toContain('--dangerously-skip-permissions')
  })

  it('adds resume, model, mcp, system prompt file, add-dir and budget flags', () => {
    const built = claudeCode.buildCommand({
      ...base,
      permissionMode: 'plan',
      model: 'sonnet',
      resumeSessionId: 'sid-1',
      mcp: { configPath: '/home/agent/.taut/mcp.json' },
      systemPromptFile: '/home/agent/.taut/system.md',
      addDirs: ['/srv/shared'],
      maxBudgetUsd: 2.5,
      credential: { kind: 'claude.oauth', secret: 'sk-ant-oat01-xyz' }
    })
    expect(built.cmd).toEqual([
      'claude',
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--resume',
      'sid-1',
      '--model',
      'sonnet',
      '--permission-mode',
      'default',
      '--mcp-config',
      '/home/agent/.taut/mcp.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__taut__*',
      'Read',
      'Glob',
      'Grep',
      '--append-system-prompt-file',
      '/home/agent/.taut/system.md',
      '--add-dir',
      '/srv/shared',
      '--max-budget-usd',
      '2.5'
    ])
    expect(built.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-xyz')
    expect(built.env['ANTHROPIC_API_KEY']).toBeUndefined()
    expect(claudeCode.resumeArgs('abc')).toEqual(['--resume', 'abc'])
  })

  it('lifts the access token out of a claude.login record', () => {
    const login = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-from-login',
        refreshToken: 'sk-ant-ort01-refresh',
        expiresAt: Date.now() + 3_600_000,
        scopes: ['user:inference', 'user:profile']
      }
    })
    const built = claudeCode.buildCommand({
      ...base,
      credential: { kind: 'claude.login', secret: login }
    })
    expect(built.env['CLAUDE_CODE_OAUTH_TOKEN']).toBe('sk-ant-oat01-from-login')
    expect(built.env['ANTHROPIC_API_KEY']).toBeUndefined()
  })

  it('sets no token when a claude.login record is unreadable', () => {
    const built = claudeCode.buildCommand({
      ...base,
      credential: { kind: 'claude.login', secret: 'not json' }
    })
    expect(built.env['CLAUDE_CODE_OAUTH_TOKEN']).toBeUndefined()
  })

  it("emits the caller's MCP allow-list verbatim (taut + browser)", () => {
    const built = claudeCode.buildCommand({
      ...base,
      mcp: {
        configPath: '/home/agent/work/tsk_1/.taut/mcp.json',
        allowedTools: ['mcp__taut__*', 'mcp__browser__*']
      }
    })
    const at = built.cmd.indexOf('--allowedTools')
    expect(at).toBeGreaterThan(0)
    expect(built.cmd.slice(at, at + 3)).toEqual([
      '--allowedTools',
      'mcp__taut__*',
      'mcp__browser__*'
    ])
    expect(built.cmd.slice(at - 3, at)).toEqual([
      '--mcp-config',
      '/home/agent/work/tsk_1/.taut/mcp.json',
      '--strict-mcp-config'
    ])
  })

  it('emits every mcp.allowedTools pattern (taut + browser) after --allowedTools', () => {
    const built = claudeCode.buildCommand({
      ...base,
      mcp: {
        configPath: '/home/agent/work/tsk_1/.taut/mcp.json',
        allowedTools: ['mcp__taut__*', 'mcp__browser__*']
      }
    })
    const i = built.cmd.indexOf('--allowedTools')
    expect(i).toBeGreaterThan(0)
    expect(built.cmd.slice(i - 3, i + 3)).toEqual([
      '--mcp-config',
      '/home/agent/work/tsk_1/.taut/mcp.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__taut__*',
      'mcp__browser__*'
    ])
  })

  it('puts the prompt right after -p in argv mode and sets no config dir for host-login', () => {
    const built = claudeCode.buildCommand({
      ...base,
      promptVia: 'argv',
      credential: { kind: 'host-login' }
    })
    expect(built.cmd.slice(0, 3)).toEqual(['claude', '-p', 'reply with exactly: pong'])
    expect(built.stdin).toBeUndefined()
    expect(built.env['CLAUDE_CONFIG_DIR']).toBeUndefined()
  })
})
