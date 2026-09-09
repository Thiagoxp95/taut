import { describe, expect, it } from 'vitest'
import {
  claudeAllowedToolsFor,
  claudeArgs,
  claudeMcpConfig,
  codexConfigToml,
  cursorArgs,
  cursorCliJson,
  cursorCliJsonFor,
  cursorMcpJson,
  injectAll,
  opencodeJson,
  opencodeToolNames
} from '../src/inject.js'
import { ToolNames } from '../src/tools.js'

const o = { url: 'http://taut:3000', token: 'tok_1', taskId: 'tsk_91', threadId: 'msg_1' }
const env = {
  TAUT_URL: 'http://taut:3000',
  TAUT_TOKEN: 'tok_1',
  TAUT_TASK_ID: 'tsk_91',
  TAUT_THREAD_ID: 'msg_1'
}

/** What `@taut/runtime` `browserMcpSpec({ provider: 'docker', homeDir: '/home/agent' })` yields. */
const browser = {
  command: 'playwright-mcp',
  args: [
    '--headless',
    '--browser',
    'chromium',
    '--no-sandbox',
    '--user-data-dir',
    '/home/agent/.taut/browser/profile',
    '--output-dir',
    '/home/agent/.taut/browser/out'
  ]
}
const withBrowser = { ...o, extraServers: { browser } }

describe('inject', () => {
  it('claude: --mcp-config json + strict flags + allowedTools', () => {
    expect(claudeMcpConfig(o)).toEqual({
      mcpServers: { taut: { type: 'stdio', command: 'node', args: ['/opt/taut/mcp.js'], env } }
    })
    expect(claudeArgs('/tmp/mcp.json')).toEqual([
      '--mcp-config',
      '/tmp/mcp.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__taut__*'
    ])
  })

  it('claude: extra servers sit next to taut and get their own allowedTools pattern', () => {
    expect(claudeMcpConfig(withBrowser)).toEqual({
      mcpServers: {
        taut: { type: 'stdio', command: 'node', args: ['/opt/taut/mcp.js'], env },
        browser: { type: 'stdio', command: 'playwright-mcp', args: browser.args }
      }
    })
    expect(claudeAllowedToolsFor(withBrowser)).toEqual(['mcp__browser__*'])
    expect(claudeArgs('/tmp/mcp.json', claudeAllowedToolsFor(withBrowser))).toEqual([
      '--mcp-config',
      '/tmp/mcp.json',
      '--strict-mcp-config',
      '--allowedTools',
      'mcp__taut__*',
      'mcp__browser__*'
    ])
    // env on an extra server is passed through; `taut` cannot be shadowed
    const local = claudeMcpConfig({
      ...o,
      extraServers: {
        browser: { ...browser, env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } },
        taut: { command: 'evil', args: [] }
      }
    })
    expect(local.mcpServers['browser']?.env).toEqual({ PLAYWRIGHT_BROWSERS_PATH: '/pw' })
    expect(local.mcpServers.taut.command).toBe('node')
  })

  it('codex: [mcp_servers.taut] toml with required + auto approval', () => {
    const toml = codexConfigToml({ ...o, command: 'taut-mcp', args: [] })
    expect(toml).toBe(
      [
        '[mcp_servers.taut]',
        'command = "taut-mcp"',
        'args = []',
        'required = true',
        'default_tools_approval_mode = "approve"',
        'startup_timeout_sec = 30',
        'tool_timeout_sec = 60',
        '',
        '[mcp_servers.taut.env]',
        'TAUT_URL = "http://taut:3000"',
        'TAUT_TOKEN = "tok_1"',
        'TAUT_TASK_ID = "tsk_91"',
        'TAUT_THREAD_ID = "msg_1"',
        ''
      ].join('\n')
    )
    // quotes are escaped TOML-style
    expect(codexConfigToml({ url: 'http://x', token: 'a"b' })).toContain('TAUT_TOKEN = "a\\"b"')
  })

  it('codex: extra servers get their own [mcp_servers.<key>] table, not required', () => {
    const toml = codexConfigToml(withBrowser)
    expect(toml.indexOf('[mcp_servers.taut]')).toBeLessThan(toml.indexOf('[mcp_servers.browser]'))
    expect(toml).toContain(
      [
        '[mcp_servers.browser]',
        'command = "playwright-mcp"',
        `args = [${browser.args.map((a) => JSON.stringify(a)).join(', ')}]`,
        'required = false',
        'default_tools_approval_mode = "approve"'
      ].join('\n')
    )
    expect(toml).not.toContain('[mcp_servers.browser.env]')
    const withEnv = codexConfigToml({
      ...o,
      extraServers: { browser: { ...browser, env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } } }
    })
    expect(withEnv).toContain('[mcp_servers.browser.env]\nPLAYWRIGHT_BROWSERS_PATH = "/pw"')
  })

  it('cursor: .cursor/mcp.json + --approve-mcps + Mcp(taut:*) permission', () => {
    expect(cursorMcpJson(o)).toEqual({
      mcpServers: { taut: { command: 'node', args: ['/opt/taut/mcp.js'], env } }
    })
    expect(cursorArgs).toEqual(['--approve-mcps'])
    expect(cursorCliJson).toEqual({ permissions: { allow: ['Mcp(taut:*)'] } })
    expect(cursorCliJsonFor(o)).toEqual(cursorCliJson)
  })

  it('cursor: extra servers land in mcp.json and the cli.json allow list', () => {
    expect(cursorMcpJson(withBrowser)).toEqual({
      mcpServers: {
        taut: { command: 'node', args: ['/opt/taut/mcp.js'], env },
        browser: { command: 'playwright-mcp', args: browser.args }
      }
    })
    expect(cursorCliJsonFor(withBrowser)).toEqual({
      permissions: { allow: ['Mcp(taut:*)', 'Mcp(browser:*)'] }
    })
  })

  it('opencode: opencode.json mcp.taut local + taut_<tool> names', () => {
    expect(opencodeJson(o)).toEqual({
      $schema: 'https://opencode.ai/config.json',
      mcp: {
        taut: {
          type: 'local',
          command: ['node', '/opt/taut/mcp.js'],
          environment: env,
          enabled: true
        }
      }
    })
    expect(opencodeToolNames).toEqual(ToolNames.map((t) => `taut_${t}`))
  })

  it('opencode: extra servers join the mcp map as local servers', () => {
    expect(opencodeJson(withBrowser).mcp['browser']).toEqual({
      type: 'local',
      command: ['playwright-mcp', ...browser.args],
      enabled: true
    })
    expect(
      opencodeJson({ ...o, extraServers: { browser: { ...browser, env: { A: '1' } } } }).mcp[
        'browser'
      ]
    ).toMatchObject({ environment: { A: '1' } })
  })

  it('injectAll bundles everything and omits unset ids', () => {
    const all = injectAll({ url: 'http://x', token: 't' })
    expect(all.env).toEqual({ TAUT_URL: 'http://x', TAUT_TOKEN: 't' })
    expect(Object.keys(all)).toEqual(['env', 'claude', 'codex', 'cursor', 'opencode'])
    expect(all.claude.allowedTools).toEqual(['mcp__taut__*'])
    const b = injectAll(withBrowser)
    expect(b.claude.allowedTools).toEqual(['mcp__taut__*', 'mcp__browser__*'])
    expect(b.claude.args('/m.json').slice(-2)).toEqual(['mcp__taut__*', 'mcp__browser__*'])
    expect(b.cursor.cliJson.permissions.allow).toContain('Mcp(browser:*)')
  })
})
