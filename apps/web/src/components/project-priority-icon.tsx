import type { ProjectPriority } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { PROJECT_PRIORITY_LABEL } from '@/lib/projects'

/**
 * Linear's priority glyph (docs/build-plan-projects.md D14): three bars, as many
 * of them lit as the level is high; three dashes when nobody has set one; a
 * filled block for urgent.
 *
 * The unlit bars stay drawn at low opacity rather than being left out, so the
 * icon occupies the same width at every level and a column of cards keeps one
 * straight edge down its right-hand side.
 */
export function ProjectPriorityIcon({
  priority,
  className
}: {
  priority: ProjectPriority
  className?: string
}) {
  const shared = cn('size-3.5 shrink-0 text-muted-foreground', className)
  const label = PROJECT_PRIORITY_LABEL[priority]

  if (priority === 0) {
    return (
      <svg viewBox="0 0 14 14" className={shared} aria-label={label} role="img">
        <rect x="1" y="6.4" width="3" height="1.4" rx="0.7" fill="currentColor" opacity="0.5" />
        <rect x="5.5" y="6.4" width="3" height="1.4" rx="0.7" fill="currentColor" opacity="0.5" />
        <rect x="10" y="6.4" width="3" height="1.4" rx="0.7" fill="currentColor" opacity="0.5" />
      </svg>
    )
  }

  if (priority === 1) {
    return (
      <svg
        viewBox="0 0 14 14"
        className={cn('size-3.5 shrink-0 text-amber-500', className)}
        aria-label={label}
        role="img"
      >
        <rect x="1" y="1" width="12" height="12" rx="3" fill="currentColor" />
        <rect x="6.3" y="3.4" width="1.4" height="4.6" rx="0.7" fill="var(--color-background)" />
        <rect x="6.3" y="9.2" width="1.4" height="1.4" rx="0.7" fill="var(--color-background)" />
      </svg>
    )
  }

  // 2 high → three bars, 3 medium → two, 4 low → one.
  const lit = 5 - priority
  return (
    <svg viewBox="0 0 14 14" className={shared} aria-label={label} role="img">
      {[
        { x: 1, y: 8, h: 5 },
        { x: 5.5, y: 5.5, h: 7.5 },
        { x: 10, y: 3, h: 10 }
      ].map((bar, index) => (
        <rect
          key={bar.x}
          x={bar.x}
          y={bar.y}
          width="3"
          height={bar.h}
          rx="1"
          fill="currentColor"
          opacity={index < lit ? 1 : 0.28}
        />
      ))}
    </svg>
  )
}
