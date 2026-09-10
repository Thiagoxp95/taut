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
  opencodeToolNames,
  serverKeys
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
const withRemote = {
  ...withBrowser,
  remoteServers: {
    notion: { url: 'https://mcp.example.com/mcp', headers: { Authorization: 'Bearer test-token' } },
    public: { url: 'https://public.example.com/mcp' }
  }
}

describe('inject', () => {
  it('mounts authenticated and public remote connectors in every runtime', () => {
    const all = injectAll(withRemote)
    expect(all.claude.config.mcpServers['notion']).toEqual({
      type: 'http',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer test-token' }
    })
    expect(all.claude.config.mcpServers['public']).toEqual({
      type: 'http',
      url: 'https://public.example.com/mcp'
    })
    expect(all.cursor.mcpJson.mcpServers['notion']).toEqual({
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer test-token' }
    })
    expect(all.cursor.mcpJson.mcpServers['public']).toEqual({
      url: 'https://public.example.com/mcp'
    })
    expect(all.opencode.config.mcp['notion']).toEqual({
      type: 'remote',
      url: 'https://mcp.example.com/mcp',
      headers: { Authorization: 'Bearer test-token' },
      oauth: false,
      enabled: true
    })
    expect(all.opencode.config.mcp['public']).toEqual({
      type: 'remote',
      url: 'https://public.example.com/mcp',
      oauth: false,
      enabled: true
    })
    expect(all.codex.configToml).toContain(
      '[mcp_servers.notion]\nurl = "https://mcp.example.com/mcp"\nrequired = false'
    )
    expect(all.codex.configToml).toContain(
      '[mcp_servers.notion.http_headers]\nAuthorization = "Bearer test-token"'
    )
    expect(all.codex.configToml).toContain(
      '[mcp_servers.public]\nurl = "https://public.example.com/mcp"'
    )
    expect(all.codex.configToml).not.toContain('[mcp_servers.public.http_headers]')
    expect(all.claude.config.mcpServers['browser']).toMatchObject({
      type: 'stdio',
      command: 'playwright-mcp'
    })
  })

  it('grants remote connectors tool access and preserves built-in servers on name collisions', () => {
    const options = {
      ...withRemote,
      remoteServers: {
        ...withRemote.remoteServers,
        taut: { url: 'https://wrong.example.com' },
        browser: { url: 'https://wrong.example.com' }
      }
    }
    const all = injectAll(options)
    expect(serverKeys(options)).toEqual(['taut', 'browser', 'notion', 'public'])
    expect(claudeAllowedToolsFor(options)).toEqual([
      'mcp__browser__*',
      'mcp__notion__*',
      'mcp__public__*'
    ])
    expect(all.claude.allowedTools).toEqual([
      'mcp__taut__*',
      'mcp__browser__*',
      'mcp__notion__*',
      'mcp__public__*'
    ])
    expect(all.cursor.cliJson.permissions.allow).toEqual([
      'Mcp(taut:*)',
      'Mcp(browser:*)',
      'Mcp(notion:*)',
      'Mcp(public:*)'
    ])
    expect(all.claude.args('/m.json')).toContain('mcp__notion__*')
    expect(all.claude.config.mcpServers.taut.command).toBe('node')
    expect(all.claude.config.mcpServers['browser']).toMatchObject({ command: 'playwright-mcp' })
    expect(JSON.stringify(all)).not.toContain('wrong.example.com')
  })

  it('quotes remote connector names and authentication header names and values in TOML', () => {
    const options = {
      ...o,
      remoteServers: {
        'custom.service': { url: 'https://example.com/mcp', headers: { 'X.Auth': 'a"b\\c' } }
      }
    }
    const toml = codexConfigToml(options)
    expect(toml).toContain('[mcp_servers."custom.service"]')
    expect(toml).toContain('[mcp_servers."custom.service".http_headers]\n"X.Auth" = "a\\"b\\\\c"')
  })

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
    expect(local.mcpServers['browser']).toMatchObject({ env: { PLAYWRIGHT_BROWSERS_PATH: '/pw' } })
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
    // Cursor validates both arrays before starting, even when there are no denied tools.
    expect(cursorCliJson).toEqual({ permissions: { allow: ['Mcp(taut:*)'], deny: [] } })
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
      permissions: { allow: ['Mcp(taut:*)', 'Mcp(browser:*)'], deny: [] }
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
