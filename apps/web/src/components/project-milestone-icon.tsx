import type { ProjectMilestoneStatus } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'

/**
 * Linear's milestone glyph: a diamond, filled in proportion to how far the
 * milestone has got. Outline for one nobody has started, half for the one being
 * worked towards, solid with a mark for a finished one, and red for a target
 * date that has passed.
 *
 * Drawn rather than borrowed for the same reason as the status ring: the *fill*
 * is the meaning, and lucide's diamond is a single outline at every state.
 */
export function ProjectMilestoneIcon({
  status,
  className
}: {
  status: ProjectMilestoneStatus | undefined
  className?: string
}) {
  const tone =
    status === 'done'
      ? 'text-violet-400'
      : status === 'overdue'
        ? 'text-red-500'
        : status === 'next'
          ? 'text-violet-400'
          : 'text-muted-foreground'

  return (
    <svg
      viewBox="0 0 14 14"
      className={cn('size-3.5 shrink-0', tone, className)}
      aria-hidden
      focusable="false"
    >
      {status === 'done' ? (
        <>
          <path d="M7 1.1 12.9 7 7 12.9 1.1 7Z" fill="currentColor" />
          <path
            d="M4.7 7.1 6.3 8.7 9.4 5.4"
            fill="none"
            stroke="var(--color-background)"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      ) : (
        <>
          <path
            d="M7 1.6 12.4 7 7 12.4 1.6 7Z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          {/* The one in flight is the only diamond Linear fills without closing. */}
          {status === 'next' ? <path d="M7 1.6 12.4 7 7 12.4Z" fill="currentColor" /> : null}
        </>
      )}
    </svg>
  )
}
