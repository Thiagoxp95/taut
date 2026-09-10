import { describe, expect, it } from 'vitest'

import {
  describeTool,
  isBrowserTool,
  makeActivitySummary,
  oneLine
} from '../src/agents/activity.js'

/**
 * The phrasing half of the running commentary (docs/build-plan-activity.md D3).
 *
 * What is under test is that the line stays a line — one row, never wrapped twice, never a
 * whole file path or a hundred-character shell command — and that a tool nobody has taught
 * it about still produces something a reader can act on rather than nothing.
 */
describe('agent activity', () => {
  it('recognizes browser tools across runtime naming conventions, but not web search or shell', () => {
    for (const name of [
      'mcp__browser__browser_navigate',
      'mcp__browser__click',
      'browser_snapshot',
      'browser.browser_tabs',
      'mcp__playwright__browser_click'
    ])
      expect(isBrowserTool(name)).toBe(true)
    for (const name of ['WebSearch', 'web_search', 'WebFetch', 'Bash', 'Read', 'browserAccess']) {
      expect(isBrowserTool(name)).toBe(false)
    }
  })

  it('phrases the file tools with a short path', () => {
    expect(describeTool('Read', { file_path: '/home/agent/work/apps/web/src/lib/live.ts' })).toBe(
      'Reading lib/live.ts'
    )
    expect(describeTool('Edit', { file_path: 'apps/server/src/agents/runTask.ts' })).toBe(
      'Editing agents/runTask.ts'
    )
    expect(describeTool('Write', {})).toBe('Writing a file')
  })

  it('phrases shell, search and web tools', () => {
    expect(describeTool('Bash', { command: 'pnpm test' })).toBe('Running pnpm test')
    expect(describeTool('command_execution', { command: ['pnpm', 'lint'] })).toBe(
      'Running pnpm lint'
    )
    expect(describeTool('Grep', { pattern: 'AgentEvent' })).toBe('Searching for AgentEvent')
    expect(describeTool('WebSearch', { query: 'effect schema union' })).toBe(
      'Searching the web for effect schema union'
    )
  })

  it('names Taut and the browser rather than their raw MCP tool names', () => {
    expect(describeTool('mcp__taut__post_message', {})).toBe('Using Taut · post message')
    expect(describeTool('mcp__browser__browser_navigate', { url: 'https://example.com' })).toBe(
      'Opening https://example.com'
    )
  })

  it('falls back to the tool name for anything it has never seen', () => {
    expect(describeTool('SomeNewTool', {})).toBe('Using somenewtool')
    expect(describeTool('mcp__linear__create_issue', {})).toBe('Using create issue')
  })

  it('never lets a command run past one line', () => {
    const long = `git log ${'--pretty=oneline '.repeat(20)}`
    const said = describeTool('Bash', { command: long })
    expect(said.length).toBeLessThanOrEqual(81)
    expect(said.endsWith('…')).toBe(true)
    expect(said).not.toContain('\n')
  })

  it('emits only complete summaries, including when tags arrive in chunks', () => {
    const summary = makeActivitySummary()
    expect(summary({ type: 'thinking', text: 'Private reasoning.' })).toBeUndefined()
    expect(summary({ type: 'text_delta', text: 'An ordinary answer.' })).toBeUndefined()
    summary({ type: 'tool_use', id: 't', name: 'Read', input: {} })
    expect(summary({ type: 'text_delta', text: '<taut-sta' })).toBeUndefined()
    expect(
      summary({ type: 'text_delta', text: 'tus>Comparing\n color options</taut-status>' })
    ).toBe('Comparing color options')
    expect(summary({ type: 'text_delta', text: 'The answer is teal.' })).toBeUndefined()
  })

  it('resets incomplete summaries across tools, snapshots, and message boundaries', () => {
    for (const boundary of [
      { type: 'tool_use', id: 't', name: 'Read', input: {} } as const,
      { type: 'text_delta', text: '', snapshot: true } as const,
      { type: 'text_delta', text: '', messageId: 'next' } as const
    ]) {
      const summary = makeActivitySummary()
      summary({ type: 'text_delta', text: '<taut-status>Incomplete', messageId: 'first' })
      summary(boundary)
      expect(summary({ type: 'text_delta', text: '</taut-status>' })).toBeUndefined()
    }
  })

  it('rejects empty or paragraph-length status blocks instead of showing fragments', () => {
    const summary = makeActivitySummary()
    expect(summary({ type: 'text_delta', text: '<taut-status>  </taut-status>' })).toBeUndefined()
    expect(
      summary({
        type: 'text_delta',
        text: `<taut-status>${'reasoning '.repeat(100)}</taut-status>`
      })
    ).toBeUndefined()
  })

  it('cuts on a word boundary rather than mid-word', () => {
    expect(oneLine('alpha beta gamma delta', 14)).toBe('alpha beta…')
  })
})
