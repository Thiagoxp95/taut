import { describe, expect, it } from 'vitest'

import { parseClaudeLine } from '../src/adapters/claudeCode.js'
import { parseCodexLine } from '../src/adapters/codex.js'
import { cursor } from '../src/adapters/cursor.js'
import { claudeCode } from '../src/adapters/claudeCode.js'
import { codex } from '../src/adapters/codex.js'
import { opencode, parseOpencodeLine } from '../src/adapters/opencode.js'
import type { AgentEvent } from '../src/adapters/types.js'

/**
 * The context meter's arithmetic (docs/build-plan-context-meter.md D1, D3, D4, D5).
 *
 * Every case here is one the obvious implementation gets wrong, which is the only reason the
 * file exists. The cached-claude case in particular fails against any code that reads
 * `input_tokens` and calls it the context.
 */

const contexts = (
  events: ReadonlyArray<AgentEvent>
): Array<Extract<AgentEvent, { type: 'context' }>> =>
  events.filter((e): e is Extract<AgentEvent, { type: 'context' }> => e.type === 'context')

describe('claude-code context samples', () => {
  /**
   * A real cached turn: 3 fresh input tokens, 90k served from cache. Anything that reports 3
   * here has confused "tokens I was charged fresh for" with "tokens in the window".
   */
  const cachedAssistant = JSON.stringify({
    type: 'assistant',
    message: {
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      usage: {
        input_tokens: 3,
        cache_read_input_tokens: 90_000,
        cache_creation_input_tokens: 1_200,
        output_tokens: 450
      }
    }
  })

  it('counts the whole prompt, cache included, not just the uncached remainder', () => {
    const [sample] = contexts([...parseClaudeLine(cachedAssistant)])
    expect(sample).toMatchObject({
      usedTokens: 3 + 90_000 + 1_200 + 450,
      inputTokens: 3,
      cacheReadTokens: 90_000,
      cacheWriteTokens: 1_200,
      outputTokens: 450,
      model: 'claude-sonnet-4-5'
    })
  })

  it('samples every assistant message, so the ring moves during a long turn', () => {
    const second = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'more' }],
        usage: { input_tokens: 2, cache_read_input_tokens: 95_000, output_tokens: 300 }
      }
    })
    const samples = contexts([...parseClaudeLine(cachedAssistant), ...parseClaudeLine(second)])
    expect(samples).toHaveLength(2)
    // Ordered, so a reader that keeps the last one keeps the newest (D2).
    expect(samples[1]!.usedTokens).toBeGreaterThan(samples[0]!.usedTokens)
  })

  it('leaves the result line as billing only, never as an occupancy sample', () => {
    const result = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      session_id: 's1',
      usage: { input_tokens: 12, output_tokens: 4_000, cache_read_input_tokens: 900_000 }
    })
    const events = [...parseClaudeLine(result)]
    expect(events.map((e) => e.type)).toEqual(['usage', 'done'])
    expect(contexts(events)).toHaveLength(0)
  })

  it('says nothing when the message carries no usage at all', () => {
    const line = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }] }
    })
    expect(contexts([...parseClaudeLine(line)])).toHaveLength(0)
  })
})

describe('codex context samples', () => {
  it('takes the last turn and the window codex states itself', () => {
    const line = JSON.stringify({
      type: 'token_count',
      info: {
        model: 'gpt-5-codex',
        model_context_window: 400_000,
        total_token_usage: { total_tokens: 812_000 },
        last_token_usage: {
          input_tokens: 120_000,
          cached_input_tokens: 118_000,
          output_tokens: 2_400,
          total_tokens: 122_400
        }
      }
    })
    expect(contexts([...parseCodexLine(line)])[0]).toMatchObject({
      usedTokens: 122_400,
      maxTokens: 400_000,
      model: 'gpt-5-codex'
    })
  })

  it('falls back to turn.completed on builds that send no token_count', () => {
    const line = JSON.stringify({
      type: 'turn.completed',
      usage: { input_tokens: 40_000, cached_input_tokens: 38_000, output_tokens: 900 }
    })
    const events = [...parseCodexLine(line)]
    expect(events.map((e) => e.type)).toEqual(['usage', 'context', 'done'])
    expect(contexts(events)[0]).toMatchObject({ usedTokens: 40_900 })
  })
})

describe('opencode context samples', () => {
  it('samples per step, cache included', () => {
    const line = JSON.stringify({
      type: 'step_finish',
      part: { tokens: { input: 30_000, output: 500, cache: { read: 28_000, write: 100 } } }
    })
    const events = [...parseOpencodeLine(line)]
    expect(contexts(events)[0]).toMatchObject({ usedTokens: 30_000 + 500 + 28_000 + 100 })
  })
})

describe('runtime descriptors', () => {
  it('marks cursor as reporting nothing, so the meter can say so instead of guessing', () => {
    expect(cursor.contextReported).toBe(false)
    expect(cursor.compactsAutomatically).toBe(false)
  })

  it('marks the three runtimes that do report', () => {
    for (const adapter of [claudeCode, codex, opencode]) {
      expect(adapter.contextReported).toBe(true)
      expect(adapter.compactsAutomatically).toBe(true)
    }
  })
})
