import type { ThreadContext } from '@taut/contract'
import { AvatarContext } from '@/components/avatar-visual'
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
 * An agent's silhouette rounds into a circle as its window fills, with a card on hover
 * explaining the occupancy. It is drawn only where the avatar stands inside a thread (D11),
 * because a thread is a session and a session is the window — an agent seen in a sidebar has
 * one window per live thread and no single honest number.
 *
 * Context details stay read-only inside the shared member profile card.
 */

const FILL: Record<ContextLevel, string> = {
  calm: 'bg-muted-foreground/70',
  filling: 'bg-amber-500',
  overloaded: 'bg-destructive'
}

/** Supplies the avatar's occupancy and the context section of its shared profile card. */
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
  const usageLabel =
    percentage === undefined
      ? `Context window: ${formatTokens(reading.usedTokens)} tokens used`
      : `Context window ${percentage} used`
  const label = context.compacting ? `Compacting context. ${usageLabel}` : usageLabel
  const compactedAgo =
    context.compactedAt === undefined ? undefined : formatAgo(context.compactedAt)

  const details = (
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
          aria-label="Context window used"
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
            a reader learns that occupancy is not a bill.
          */}
      {reading.totalTokens === undefined || reading.totalTokens <= reading.usedTokens ? null : (
        <div className="flex items-baseline justify-between gap-3 text-[11px]">
          <span className="text-muted-foreground">Processed in this thread</span>
          <span className="tabular-nums">{formatTokens(reading.totalTokens)}</span>
        </div>
      )}
      <p className="text-pretty text-[11px] text-muted-foreground">
        {context.compacting ? 'Compacting context. ' : null}
        {compactionLine(
          context.runtime,
          context.compactsAutomatically,
          context.autoCompactThreshold,
          context.model
        )}
        {compactedAgo === undefined ? null : ` Last compacted ${compactedAgo}.`}
      </p>
    </div>
  )
  return (
    <span
      className="relative inline-flex shrink-0"
      aria-label={label}
      aria-busy={context.compacting || undefined}
    >
      <AvatarContext
        value={{
          contextPercentage: reading.usedPercentage,
          compacting: context.compacting,
          details
        }}
      >
        {children}
      </AvatarContext>
    </span>
  )
}
