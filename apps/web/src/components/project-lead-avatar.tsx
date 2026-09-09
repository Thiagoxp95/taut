import * as React from 'react'
import type { Project } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'

/**
 * The project lead, round, at whatever size the caller draws it (16px on a board
 * card, 20px in the properties row of the overview).
 *
 * A Linear user, not a Taut member (docs/build-plan-projects.md D1), so there is
 * no avatar service to ask: it is the URL Linear gave, and initials on the
 * workspace's own colour when it gave none or the image will not load.
 */
export function ProjectLeadAvatar({
  lead,
  className,
  textClassName
}: {
  lead: NonNullable<Project['lead']>
  className?: string
  textClassName?: string
}) {
  const [broken, setBroken] = React.useState(false)
  const initials = lead.name
    .split(/[\s@.]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  if (lead.avatarUrl !== undefined && !broken) {
    return (
      <img
        src={lead.avatarUrl}
        alt={lead.name}
        title={lead.name}
        loading="lazy"
        onError={() => setBroken(true)}
        className={cn('size-4 shrink-0 rounded-full object-cover', className)}
      />
    )
  }

  return (
    <span
      title={lead.name}
      aria-label={lead.name}
      className={cn(
        'flex size-4 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-muted-foreground',
        'text-[8px]',
        textClassName,
        className
      )}
    >
      {initials}
    </span>
  )
}
