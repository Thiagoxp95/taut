import { Schema } from 'effect'
import { RunOverride } from '@taut/contract'
import { describe, expect, it } from 'vitest'

import { buildCodexCommand } from '../src/adapters/codex.js'

const input = {
  prompt: 'hello',
  cwd: '/work/task',
  home: '/home/agent',
  permissionMode: 'plan' as const
}

describe('Codex fast mode', () => {
  it.each([true, false])(
    'preserves the explicit speed choice %s across the message contract',
    (fastMode) => {
      const decoded = Schema.decodeUnknownSync(RunOverride)({ fastMode })
      expect(Schema.encodeSync(RunOverride)(decoded)).toEqual({ fastMode })
    }
  )

  it.each([undefined, 'session-1'])(
    'requests fast processing for new and resumed runs (%s)',
    (resumeSessionId) => {
      const override = Schema.decodeUnknownSync(RunOverride)({ fastMode: true })
      const { cmd } = buildCodexCommand({
        ...input,
        ...override,
        ...(resumeSessionId === undefined ? {} : { resumeSessionId })
      })
      expect(cmd).toContain('service_tier="fast"')
      expect(cmd).toContain('features.fast_mode=true')
    }
  )

  it('can explicitly turn off a seat’s fast default', () => {
    const override = Schema.decodeUnknownSync(RunOverride)({ fastMode: false })
    expect(buildCodexCommand({ ...input, ...override }).cmd).toContain('service_tier="default"')
  })

  it('leaves the seat speed unchanged when no override is requested', () => {
    expect(buildCodexCommand(input).cmd.some((arg) => arg.startsWith('service_tier='))).toBe(false)
  })
})
