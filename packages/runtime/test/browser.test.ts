import { existsSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'

import {
  BROWSER_CDP_PORT,
  BROWSER_MCP_ALLOWED_TOOL,
  BROWSER_MCP_SERVER_KEY,
  browserCdpEndpoint,
  browserDaemonScript,
  browserMcpCliPath,
  browserMcpSpec,
  browserPromptLine,
  hostPlaywrightBrowsersPath
} from '../src/browser.js'

describe('browserMcpSpec', () => {
  it('supports Chromium inside an explicitly configured shared runtime container', () => {
    vi.stubEnv('TAUT_BROWSER_NO_SANDBOX', 'true')
    try {
      const spec = browserMcpSpec({ provider: 'local', homeDir: '/data/company/agent' })
      expect(spec.args).toContain('--no-sandbox')
      const attached = browserMcpSpec({
        provider: 'local',
        homeDir: '/data/company/agent',
        cdpEndpoint: 'http://127.0.0.1:9333'
      })
      expect(attached.args).not.toContain('--no-sandbox')
    } finally {
      vi.unstubAllEnvs()
    }
  })
  it('docker: global playwright-mcp bin, headless chromium, no sandbox, dirs under the home', () => {
    expect(browserMcpSpec({ provider: 'docker', homeDir: '/home/agent' })).toEqual({
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
    })
  })

  it('docker + cdpEndpoint: attach to the Chromium Taut started, launch flags gone (workspace D11)', () => {
    expect(browserCdpEndpoint()).toBe(`http://127.0.0.1:${BROWSER_CDP_PORT}`)
    expect(
      browserMcpSpec({
        provider: 'docker',
        homeDir: '/home/agent',
        cdpEndpoint: browserCdpEndpoint()
      })
    ).toEqual({
      command: 'playwright-mcp',
      args: [
        '--cdp-endpoint',
        'http://127.0.0.1:9222',
        '--output-dir',
        '/home/agent/.taut/browser/out'
      ]
    })
  })

  it('browserDaemonScript: loopback-only debug port, profile under the home, no exec id (D18, D15)', () => {
    const script = browserDaemonScript({ homeDir: '/home/agent' })
    expect(script).toContain('--remote-debugging-address=127.0.0.1')
    expect(script).toContain('"--remote-debugging-port=$port"')
    expect(script).toContain('port=9222')
    expect(script).toContain('profile="/home/agent/.taut/browser/profile"')
    expect(script).toContain('env -u TAUT_EXEC_ID setsid nohup')
    expect(script).toContain('--headless')
    expect(script).toContain('--no-sandbox')
    expect(script).toContain('/opt/pw-browsers/chromium-*/chrome-linux*/chrome')
    expect(script).not.toContain('0.0.0.0')
    expect(browserDaemonScript({ homeDir: '/home/agent', port: 9333 })).toContain('port=9333')
  })

  it('local: node + the resolved @playwright/mcp cli.js, same flags minus --no-sandbox, host browsers path', () => {
    const spec = browserMcpSpec({ provider: 'local', homeDir: '/data/acme/agents/bruno/home' })
    expect(spec.command).toBe('node')
    const [cli, ...flags] = spec.args
    expect(cli).toBe(browserMcpCliPath())
    expect(cli).toMatch(/@playwright[\\/]mcp[\\/]cli\.js$/)
    expect(existsSync(cli ?? '')).toBe(true)
    expect(flags).toEqual([
      '--headless',
      '--browser',
      'chromium',
      '--user-data-dir',
      '/data/acme/agents/bruno/home/.taut/browser/profile',
      '--output-dir',
      '/data/acme/agents/bruno/home/.taut/browser/out'
    ])
    expect(spec.args).not.toContain('--no-sandbox')
    expect(spec.env).toMatchObject({
      PLAYWRIGHT_BROWSERS_PATH: hostPlaywrightBrowsersPath(),
      TMPDIR: expect.any(String)
    })
  })

  it('hostPlaywrightBrowsersPath mirrors playwright-core defaults and honours the env override', () => {
    expect(hostPlaywrightBrowsersPath({ HOME: '/Users/x' }, 'darwin')).toBe(
      '/Users/x/Library/Caches/ms-playwright'
    )
    expect(hostPlaywrightBrowsersPath({ HOME: '/home/x' }, 'linux')).toBe(
      '/home/x/.cache/ms-playwright'
    )
    expect(hostPlaywrightBrowsersPath({ HOME: '/home/x', XDG_CACHE_HOME: '/c' }, 'linux')).toBe(
      '/c/ms-playwright'
    )
    expect(hostPlaywrightBrowsersPath({ PLAYWRIGHT_BROWSERS_PATH: '/opt/pw' }, 'linux')).toBe(
      '/opt/pw'
    )
  })

  it('constants and prompt line', () => {
    expect(BROWSER_MCP_SERVER_KEY).toBe('browser')
    expect(BROWSER_MCP_ALLOWED_TOOL).toBe('mcp__browser__*')
    const line = browserPromptLine('/home/agent', 'claude-code')
    expect(line).toContain('mcp__browser__*')
    expect(line).toContain('browser_navigate')
    expect(line).toContain('/home/agent/.taut/browser/out')
    expect(line.split('\n')).toHaveLength(1)
  })

  it('tells the agent how it reaches the web, per runtime', () => {
    // claude-code keeps its own web tools (they are in `--allowedTools` with browser access),
    // so the line offers both. Every other runtime has none, and an agent that is not told so
    // reports it cannot look things up instead of opening a search engine itself.
    const claude = browserPromptLine('/home/agent', 'claude-code')
    expect(claude).toContain('WebSearch')
    expect(claude).toContain('WebFetch')
    for (const kind of ['opencode', 'codex', 'cursor'] as const) {
      const line = browserPromptLine('/home/agent', kind)
      expect(line).toContain('only way onto the web')
      expect(line).not.toContain('WebSearch')
      expect(line.split('\n')).toHaveLength(1)
    }
  })

  it('names the browser tools the way each runtime exposes them', () => {
    const opencode = browserPromptLine('/home/agent', 'opencode')
    expect(opencode).toContain('browser_browser_navigate')
    expect(opencode).not.toContain('mcp__browser__')
    for (const kind of ['codex', 'cursor'] as const) {
      const line = browserPromptLine('/home/agent', kind)
      expect(line).toContain('`browser` MCP server')
      expect(line).toContain('browser_navigate')
      expect(line).not.toContain('mcp__browser__')
      expect(line).not.toContain('browser_browser_')
    }
  })
})
