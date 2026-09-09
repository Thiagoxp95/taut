import type { ProjectState } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { PROJECT_STATE_COLOR } from '@/lib/projects'

/**
 * Linear's project-status glyph (docs/build-plan-projects.md D14): the ring whose
 * fill says how far along a status is — dashed for a backlog, empty for planned,
 * half for started, solid with a mark for completed and canceled.
 *
 * Drawn rather than borrowed from an icon set because the shape *is* the roll-up:
 * two workspace statuses called different things but typed the same have to look
 * the same, which no single-glyph icon name gives you. It takes the status colour
 * the workspace chose and falls back to the state's own colour when Linear
 * reported none.
 */
export function ProjectStatusIcon({
  type,
  color,
  className
}: {
  type: ProjectState
  color?: string | undefined
  className?: string
}) {
  const style = color === undefined ? undefined : { color }
  const shared = cn(
    'size-3.5 shrink-0',
    color === undefined && PROJECT_STATE_COLOR[type],
    className
  )

  if (type === 'completed' || type === 'canceled') {
    return (
      <svg viewBox="0 0 14 14" className={shared} style={style} aria-hidden focusable="false">
        <circle cx="7" cy="7" r="6" fill="currentColor" />
        {type === 'completed' ? (
          <path
            d="M4.4 7.1 6.2 8.9 9.6 5.3"
            fill="none"
            stroke="var(--color-background)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M5 5l4 4M9 5l-4 4"
            fill="none"
            stroke="var(--color-background)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        )}
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 14 14" className={shared} style={style} aria-hidden focusable="false">
      <circle
        cx="7"
        cy="7"
        r="5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        // A backlog status is the one Linear leaves open: same ring, drawn dotted.
        strokeDasharray={type === 'backlog' || type === 'paused' ? '1.6 2.1' : undefined}
        strokeLinecap="round"
      />
      {type === 'started' ? (
        // Half the pie: "started" is the only ring Linear fills without finishing.
        <path d="M7 3.2A3.8 3.8 0 0 1 7 10.8Z" fill="currentColor" />
      ) : null}
    </svg>
  )
}
