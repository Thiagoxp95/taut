/**
 * Real cooldowns (docs/build-plan-usage-limits.md).
 *
 * A seat used to be parked for a flat `now + 5h` on any rate-limit, so one that
 * tripped its limit late in a rolling block sat out hours it did not owe. These
 * cover the two halves of the fix: reading the provider's windows, and turning
 * them into the moment the seat actually returns.
 */
import { EXHAUSTED_PCT, type LimitWindow } from '@taut/contract/domain'
import { DateTime, Option } from 'effect'
import { describe, expect, it } from 'vitest'
import {
  REFRESH_SKEW_MS,
  claudeLoginNeedsRefresh,
  fromAnthropic,
  fromOpenAi,
  parseClaudeLogin,
  supports
} from '../src/services/usageProbe.js'

/** The same rule `Subscriptions.blockedUntil` applies, isolated for the table below. */
const blockedUntil = (windows: ReadonlyArray<LimitWindow>): string | undefined => {
  let earliest: DateTime.Utc | undefined
  for (const w of windows) {
    if (w.percentUsed < EXHAUSTED_PCT) continue
    if (w.resetsAt === undefined) continue
    if (earliest === undefined || DateTime.lessThan(w.resetsAt, earliest)) earliest = w.resetsAt
  }
  return earliest === undefined ? undefined : DateTime.formatIso(earliest)
}

const at = (iso: string): DateTime.Utc => Option.getOrThrow(DateTime.make(new Date(iso)))

describe('usage probe: Anthropic payload', () => {
  it('reads session, weekly and both legacy per-model windows', () => {
    const windows = fromAnthropic({
      five_hour: { utilization: 96.5, resets_at: '2026-09-08T21:00:00Z' },
      seven_day: { utilization: 41, resets_at: '2026-09-12T00:00:00Z' },
      seven_day_opus: { utilization: 88, resets_at: '2026-09-12T00:00:00Z' },
      seven_day_sonnet: { utilization: 12, resets_at: '2026-09-12T00:00:00Z' }
    })

    expect(windows.map((w) => [w.label, w.kind, w.percentUsed])).toEqual([
      ['Session', 'session', 96.5],
      ['Weekly', 'weekly', 41],
      ['Opus', 'weekly-model', 88],
      ['Sonnet', 'weekly-model', 12]
    ])
    expect(windows[0]?.resetsAt).toBeDefined()
  })

  it('reads a model-scoped limit out of the generic `limits` array', () => {
    // Fable's weekly cap arrives here rather than as a `seven_day_fable` field.
    const windows = fromAnthropic({
      five_hour: { utilization: 10, resets_at: '2026-09-08T21:00:00Z' },
      limits: [
        { kind: 'session', percent: 10, resets_at: '2026-09-08T21:00:00Z' },
        {
          kind: 'weekly_scoped',
          percent: 73,
          resets_at: '2026-09-12T00:00:00Z',
          scope: { model: { display_name: 'Fable 5' } }
        }
      ]
    })

    expect(windows.map((w) => w.label)).toEqual(['Session', 'Fable 5'])
    expect(windows[1]).toMatchObject({ kind: 'weekly-model', percentUsed: 73 })
  })

  it('does not report a model twice when a legacy field and `limits` both name it', () => {
    const windows = fromAnthropic({
      seven_day_opus: { utilization: 88, resets_at: '2026-09-12T00:00:00Z' },
      limits: [
        {
          kind: 'weekly_scoped',
          percent: 88,
          resets_at: '2026-09-12T00:00:00Z',
          scope: { model: { display_name: 'Opus' } }
        }
      ]
    })

    expect(windows.map((w) => w.label)).toEqual(['Opus'])
  })

  it('skips windows a plan does not have instead of reporting them as empty', () => {
    expect(fromAnthropic({ five_hour: null, seven_day: { utilization: null } })).toEqual([])
  })
})

describe('usage probe: OpenAI payload', () => {
  it('prefers the headers and takes the window length from the body', () => {
    const windows = fromOpenAi(
      {
        rate_limit: {
          primary_window: { used_percent: 10, reset_after_seconds: 1800, window_minutes: 300 },
          secondary_window: { used_percent: 20, reset_at: 1_789_000_000 }
        }
      },
      { 'x-codex-primary-used-percent': '97.2', 'x-codex-secondary-used-percent': '31' },
      new Date('2026-09-08T20:00:00Z')
    )

    expect(windows.map((w) => [w.label, w.percentUsed])).toEqual([
      ['Session', 97.2],
      ['Weekly', 31]
    ])
    expect(windows[0]?.windowSeconds).toBe(18_000)
    // reset_after_seconds is relative, so it has to be anchored to `now`.
    expect(windows[0]?.resetsAt).toEqual(at('2026-09-08T20:30:00Z'))
  })

  it('falls back to the body when the headers are absent', () => {
    const windows = fromOpenAi(
      { rate_limit: { primary_window: { used_percent: 55, reset_at: 1_789_000_000 } } },
      {}
    )
    expect(windows.map((w) => [w.label, w.percentUsed])).toEqual([['Session', 55]])
  })
})

describe('derived cooldown', () => {
  it('parks the seat until the earliest *spent* window resets, not the earliest window', () => {
    // The session window resets first, but it is not the one that is spent —
    // waiting on it would hand the seat back while the weekly cap is still out.
    const until = blockedUntil([
      { kind: 'session', label: 'Session', percentUsed: 12, resetsAt: at('2026-09-08T21:00:00Z') },
      { kind: 'weekly', label: 'Weekly', percentUsed: 99, resetsAt: at('2026-09-12T00:00:00Z') }
    ])
    expect(until).toBe('2026-09-12T00:00:00.000Z')
  })

  it('takes the tightest deadline when several windows are spent', () => {
    const until = blockedUntil([
      { kind: 'session', label: 'Session', percentUsed: 100, resetsAt: at('2026-09-08T21:00:00Z') },
      { kind: 'weekly', label: 'Weekly', percentUsed: 99, resetsAt: at('2026-09-12T00:00:00Z') }
    ])
    expect(until).toBe('2026-09-08T21:00:00.000Z')
  })

  it('releases the seat when nothing is spent — the stale-countdown case', () => {
    // This is the reported bug: the window had rolled over, so there is no
    // deadline left to wait on and the badge must clear.
    const until = blockedUntil([
      { kind: 'session', label: 'Session', percentUsed: 3, resetsAt: at('2026-09-09T02:00:00Z') },
      { kind: 'weekly', label: 'Weekly', percentUsed: 41, resetsAt: at('2026-09-12T00:00:00Z') }
    ])
    expect(until).toBeUndefined()
  })

  it('ignores a spent window the provider gave no reset time for', () => {
    const until = blockedUntil([{ kind: 'weekly-model', label: 'Opus', percentUsed: 100 }])
    expect(until).toBeUndefined()
  })
})

describe('probe applicability', () => {
  it('covers the two credentials whose providers publish usage', () => {
    expect(supports('claude-code', 'claude.login')).toBe(true)
    expect(supports('codex', 'openai.oauth')).toBe(true)
  })

  it('rejects the setup-token a Claude seat runs on — it is inference-only', () => {
    expect(supports('claude-code', 'claude.oauth')).toBe(false)
  })

  it('skips API keys and runtimes with no usage endpoint', () => {
    expect(supports('claude-code', 'anthropic.api_key')).toBe(false)
    expect(supports('cursor', 'cursor.api_key')).toBe(false)
    expect(supports('opencode', 'anthropic.api_key')).toBe(false)
  })
})

describe('claude.login rotation', () => {
  const login = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-live',
        refreshToken: 'sk-ant-ort01-refresh',
        expiresAt: Date.now() + 60 * 60 * 1000,
        ...over
      }
    })

  it('reads back a stored login', () => {
    const parsed = parseClaudeLogin(login())
    expect(Option.isSome(parsed)).toBe(true)
  })

  it('is None for the bare setup-token, which is not JSON at all', () => {
    expect(Option.isNone(parseClaudeLogin('sk-ant-oat01-abc'))).toBe(true)
  })

  it('leaves a token with hours left alone', () => {
    const parsed = Option.getOrThrow(parseClaudeLogin(login()))
    expect(claudeLoginNeedsRefresh(parsed)).toBe(false)
  })

  it('renews inside the skew rather than racing the expiry', () => {
    const parsed = Option.getOrThrow(
      parseClaudeLogin(login({ expiresAt: Date.now() + REFRESH_SKEW_MS / 2 }))
    )
    expect(claudeLoginNeedsRefresh(parsed)).toBe(true)
  })

  it('cannot renew a login with no refresh token', () => {
    const parsed = Option.getOrThrow(parseClaudeLogin(login({ expiresAt: 0, refreshToken: '' })))
    expect(claudeLoginNeedsRefresh(parsed)).toBe(false)
  })
})
