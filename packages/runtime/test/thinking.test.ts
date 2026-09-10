import { describe, expect, it } from 'vitest'

import { parseClaudeLine } from '../src/adapters/claudeCode.js'
import { parseCodexLine } from '../src/adapters/codex.js'
import { parseOpencodeLine } from '../src/adapters/opencode.js'

/**
 * Reasoning, from the three runtimes that expose any (docs/build-plan-activity.md D4).
 * It is its own event and never a `text_delta`: the one thing that must not happen is a
 * thinking block landing in the reply body, which is what the reader keeps.
 */
describe('thinking events', () => {
  it('claude-code: an assistant thinking block, kept apart from the text block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'The migration runs before the backfill.' },
          { type: 'text', text: 'Here is the plan.' }
        ]
      }
    })
    expect([...parseClaudeLine(line)]).toEqual([
      { type: 'thinking', text: 'The migration runs before the backfill.' },
      { type: 'text_delta', text: 'Here is the plan.' }
    ])
  })

  it('codex: a reasoning item, from `text` or from `summary`', () => {
    const withText = JSON.stringify({
      type: 'item.completed',
      item: { id: 'i1', type: 'reasoning', text: 'Checking the schema first.' }
    })
    expect([...parseCodexLine(withText)]).toEqual([
      { type: 'thinking', text: 'Checking the schema first.' }
    ])

    const withSummary = JSON.stringify({
      type: 'item.completed',
      item: { id: 'i2', type: 'reasoning', summary: 'Reading the failing test.' }
    })
    expect([...parseCodexLine(withSummary)]).toEqual([
      { type: 'thinking', text: 'Reading the failing test.' }
    ])
  })

  it('opencode: a reasoning part', () => {
    const line = JSON.stringify({ type: 'reasoning', part: { text: 'Two files to touch.' } })
    expect([...parseOpencodeLine(line)]).toContainEqual({
      type: 'thinking',
      text: 'Two files to touch.'
    })
  })

  it('an empty reasoning block says nothing at all', () => {
    const claude = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '' }] }
    })
    expect([...parseClaudeLine(claude)]).toEqual([])
    const codex = JSON.stringify({
      type: 'item.completed',
      item: { id: 'i3', type: 'reasoning' }
    })
    expect([...parseCodexLine(codex)]).toEqual([])
  })
})
