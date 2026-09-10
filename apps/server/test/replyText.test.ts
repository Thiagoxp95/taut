import { describe, expect, it } from 'vitest'
import { adapterFor, type AgentEvent } from '@taut/runtime'
import { makeReplyText } from '../src/agents/replyText.js'

describe('the completed reply', () => {
  it('removes temporary summaries from both buffered and result answers', () => {
    const reply = makeReplyText()
    reply.observe({
      type: 'text_delta',
      text: '<taut-status>Comparing colors</taut-status>\n\nWe agreed on teal.'
    })
    expect(reply.finish(true)).toBe('We agreed on teal.')
    expect(reply.finish(true, '<taut-status>Finishing up</taut-status>\n\nTeal.')).toBe('Teal.')
    expect(reply.finish(true, '<taut-status>Still working</taut-status>')).toBeUndefined()
  })

  it('keeps only the last Codex message, including when its completion is repeated', () => {
    const reply = makeReplyText()
    for (const [id, text] of [
      ['a', 'I will investigate.'],
      ['b', 'Understood. Writing the note.'],
      ['c', 'The design note is attached.'],
      ['c', 'The design note is attached.']
    ]) {
      for (const event of adapterFor('codex').parseLine(
        JSON.stringify({
          type: 'item.completed',
          item: { id, type: 'agent_message', text }
        })
      ))
        reply.observe(event)
    }
    expect(reply.finish(true)).toBe('The design note is attached.')
  })

  it('uses the successful result as the complete answer, never an appended copy', () => {
    const reply = makeReplyText()
    reply.observe({ type: 'text_delta', text: 'I will investigate.' })
    reply.observe({ type: 'text_delta', text: 'Here is the answer.' })
    expect(reply.finish(true, 'Here is the answer.')).toBe('Here is the answer.')
  })

  it('preserves real chunks after a tool, without keeping its preamble', () => {
    const reply = makeReplyText()
    const events: Array<AgentEvent> = [
      { type: 'text_delta', text: 'Checking the test.' },
      { type: 'tool_use', id: 't', name: 'Bash', input: {} },
      { type: 'tool_result', toolUseId: 't', content: 'ok', isError: false },
      { type: 'text_delta', text: 'The test ' },
      { type: 'text_delta', text: 'passes.' }
    ]
    events.forEach(reply.observe)
    expect(reply.finish(true)).toBe('The test passes.')
  })

  it('groups OpenCode text parts into an answer without keeping the previous message', () => {
    const reply = makeReplyText()
    for (const [messageID, text] of [
      ['progress', 'I will look into it.'],
      ['answer', 'The first finding.\n\n'],
      ['answer', 'The second finding.']
    ]) {
      for (const event of adapterFor('opencode').parseLine(
        JSON.stringify({ type: 'text', part: { messageID, text } })
      ))
        reply.observe(event)
    }
    expect(reply.finish(true)).toBe('The first finding.\n\nThe second finding.')
  })

  it('does not publish incomplete text from a failed attempt or a tool-only run', () => {
    const reply = makeReplyText()
    reply.observe({ type: 'text_delta', text: 'I will check.' })
    expect(reply.finish(false, 'Rate limited')).toBeUndefined()
    reply.observe({ type: 'tool_use', id: 't', name: 'Read', input: {} })
    expect(reply.finish(true)).toBeUndefined()
  })
})
