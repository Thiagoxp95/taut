import type { ThreadContext } from '@taut/contract'
import { Tooltip, TooltipContent, TooltipTrigger } from '@taut/ui/components/tooltip'
import { cn } from '@taut/ui/lib/utils'

import {
  compactionLine,
  formatAgo,
  formatPercentage,
  formatTokens,
  readContext,
  type ContextLevel
} from '@/lib/context-window'

/**
 * The context meter (docs/build-plan-context-meter.md).
 *
 * A ring around an agent's avatar saying how full that copy's window is, and a card on hover
 * saying what the ring means. It is drawn only where the avatar stands inside a thread (D11),
 * because a thread is a session and a session is the window — an agent seen in a sidebar has
 * one window per live thread and no single honest number.
 *
 * The card holds no controls (D13). Taut drives agents by talking to them; a compact button
 * here would be a second, mute way to give an order.
 */

const STROKE: Record<ContextLevel, string> = {
  calm: 'stroke-muted-foreground/70',
  filling: 'stroke-amber-500',
  overloaded: 'stroke-destructive'
}

const FILL: Record<ContextLevel, string> = {
  calm: 'bg-muted-foreground/70',
  filling: 'bg-amber-500',
  overloaded: 'bg-destructive'
}

/** Geometry of the ring. `r` leaves room for the stroke inside a 24-unit box. */
const RADIUS = 10.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS

/**
 * The ring itself, laid over whatever the avatar is drawing. It never touches the agent
 * figure's canvas, so the face/orb morph runs underneath it untouched.
 */
export function ContextRing({
  context,
  className
}: {
  context: ThreadContext
  className?: string
}) {
  const reading = readContext(context)
  // With no known window there is no fraction to draw. Showing a full ring, or an empty one,
  // would both be claims we cannot make (D6).
  if (reading.usedPercentage === undefined) return null
  const percentage = reading.usedPercentage
  return (
    <svg
      viewBox="0 0 24 24"
      aria-hidden
      className={cn('pointer-events-none absolute -inset-[3px] size-auto -rotate-90', className)}
    >
      <circle
        cx="12"
        cy="12"
        r={RADIUS}
        fill="none"
        strokeWidth="1.5"
        className="stroke-muted-foreground/20"
      />
      <circle
        cx="12"
        cy="12"
        r={RADIUS}
        fill="none"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - percentage / 100)}
        className={cn(
          'transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none',
          STROKE[reading.level]
        )}
      />
    </svg>
  )
}

/**
 * Wraps an avatar so the ring is drawn over it and hovering either explains it.
 *
 * Renders `children` untouched when nothing is known about this window, which is the state
 * before an agent's first turn and the permanent state on a runtime that reports no usage.
 */
export function ContextMeter({
  context,
  children
}: {
  context: ThreadContext | undefined
  children: React.ReactNode
}) {
  if (context === undefined) return <>{children}</>
  const reading = readContext(context)
  const percentage = formatPercentage(reading.usedPercentage)
  const label =
    percentage === undefined
      ? `Context window: ${formatTokens(reading.usedTokens)} tokens used`
      : `Context window ${percentage} used`
  const compactedAgo =
    context.compactedAt === undefined ? undefined : formatAgo(context.compactedAt)

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="relative inline-flex shrink-0" aria-label={label}>
          {children}
          <ContextRing context={context} />
        </span>
      </TooltipTrigger>
      <TooltipContent
        side="right"
        className="w-56 border border-border bg-popover p-2.5 text-popover-foreground"
      >
        <div className="flex flex-col gap-2">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-medium text-[11px] text-muted-foreground">Context window</span>
            <span className="text-[11px] tabular-nums">
              {percentage === undefined ? (
                formatTokens(reading.usedTokens)
              ) : (
                <>
                  {percentage}
                  <span className="mx-1 text-muted-foreground">·</span>
                  {formatTokens(reading.usedTokens)}/{formatTokens(reading.maxTokens)}
                </>
              )}
            </span>
          </div>
          {reading.usedPercentage === undefined ? null : (
            <div
              className="h-1 w-full overflow-hidden rounded-full bg-muted-foreground/20"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(reading.usedPercentage)}
            >
              <div
                className={cn(
                  'h-full rounded-full transition-[width] duration-500 ease-out motion-reduce:transition-none',
                  FILL[reading.level]
                )}
                style={{ width: `${reading.usedPercentage}%` }}
              />
            </div>
          )}
          {/*
            Resident tokens and billed tokens are different quantities, and on a long cached
            thread the second is many times the first. Showing them together is the only way
            a reader learns that the ring is not a bill.
          */}
          {reading.totalTokens === undefined || reading.totalTokens <= reading.usedTokens ? null : (
            <div className="flex items-baseline justify-between gap-3 text-[11px]">
              <span className="text-muted-foreground">Processed in this thread</span>
              <span className="tabular-nums">{formatTokens(reading.totalTokens)}</span>
            </div>
          )}
          <p className="text-pretty text-[11px] text-muted-foreground">
            {compactionLine(
              context.runtime,
              context.compactsAutomatically,
              context.autoCompactThreshold,
              context.model
            )}
            {compactedAgo === undefined ? null : ` Last compacted ${compactedAgo}.`}
          </p>
        </div>
      </TooltipContent>
    </Tooltip>
  )
}
