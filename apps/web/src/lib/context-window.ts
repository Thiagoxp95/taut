import type { RuntimeKind, ThreadContext } from '@taut/contract'

/**
 * Reading a `ThreadContext` for the meter (docs/build-plan-context-meter.md).
 *
 * Everything derived lives here rather than in the component, because the arithmetic is where
 * this feature can lie and arithmetic is testable. The component only draws.
 */

/** Above this the ring turns red: what is left is no longer enough for a real turn. */
const OVERLOADED = 90
/** Above this it warns. */
const FILLING = 70

export type ContextLevel = 'calm' | 'filling' | 'overloaded'

export interface ContextReading {
  /** `undefined` when no window is known — draw no ring, show the token count (D6). */
  readonly usedPercentage: number | undefined
  readonly level: ContextLevel
  readonly usedTokens: number
  readonly maxTokens: number | undefined
  readonly totalTokens: number | undefined
}

export function readContext(context: ThreadContext): ContextReading {
  const maxTokens = context.maxTokens
  const usedPercentage =
    maxTokens !== undefined && maxTokens > 0
      ? Math.max(0, Math.min(100, (context.usedTokens / maxTokens) * 100))
      : undefined
  return {
    usedPercentage,
    level:
      usedPercentage === undefined || usedPercentage < FILLING
        ? 'calm'
        : usedPercentage < OVERLOADED
          ? 'filling'
          : 'overloaded',
    usedTokens: context.usedTokens,
    maxTokens,
    totalTokens: context.totalTokens
  }
}

/** `842` · `1.2k` · `87k` · `1.4m`. Narrow enough for a tooltip line that also holds a fraction. */
export function formatTokens(value: number | undefined): string {
  if (value === undefined || !Number.isFinite(value)) return '0'
  if (value < 1_000) return String(Math.round(value))
  if (value < 10_000) return `${(value / 1_000).toFixed(1).replace(/\.0$/, '')}k`
  if (value < 1_000_000) return `${Math.round(value / 1_000)}k`
  return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, '')}m`
}

export function formatPercentage(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, '')}%` : `${Math.round(value)}%`
}

/**
 * What this runtime does when the window fills, in one line
 * (docs/build-plan-context-meter.md D9).
 *
 * This is the visible half of "context differs between Claude Code, Codex and the rest". The
 * ring is the same shape everywhere; what is behind it is not, and a user who does not know
 * whether their agent will compact or simply stop has been told nothing useful.
 */
export function compactionLine(
  runtime: RuntimeKind,
  compactsAutomatically: boolean,
  autoCompactThreshold: number | undefined,
  model: string | undefined
): string {
  if (runtime === 'cursor') return 'Cursor does not report context usage.'
  if (!compactsAutomatically) return 'This runtime does not compact on its own.'
  if (autoCompactThreshold !== undefined && autoCompactThreshold > 0) {
    return `Compacts automatically at ${autoCompactThreshold.toLocaleString('en-US')} tokens.`
  }
  if (runtime === 'codex') return 'Codex compacts this thread automatically.'
  return model === undefined
    ? 'Context compacts automatically when needed.'
    : `Context for ${model} compacts automatically when needed.`
}

/** "just now" · "4 min ago" · "2 h ago". Only ever used for the compaction line. */
export function formatAgo(iso: string, now = Date.now()): string | undefined {
  const at = Date.parse(iso)
  if (!Number.isFinite(at)) return undefined
  const minutes = Math.floor((now - at) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  return hours < 24 ? `${hours} h ago` : `${Math.floor(hours / 24)} d ago`
}
