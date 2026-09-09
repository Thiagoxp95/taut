import { cn } from '@taut/ui/lib/utils'
import type { Presence } from '@/lib/live'

const RING = 'ring-2 ring-sidebar'

const STYLES: Record<Presence, string> = {
  online: 'bg-emerald-500',
  working: 'bg-amber-500',
  idle: 'bg-transparent border border-muted-foreground/60',
  away: 'bg-transparent border border-muted-foreground/60',
  offline: 'bg-transparent border border-muted-foreground/40'
}

const LABELS: Record<Presence, string> = {
  online: 'Online',
  working: 'Working',
  idle: 'Idle',
  away: 'Away',
  offline: 'Offline'
}

export function PresenceDot({
  presence,
  className,
  ringed = false
}: {
  presence: Presence
  className?: string
  ringed?: boolean
}) {
  return (
    <span
      role="img"
      aria-label={LABELS[presence]}
      title={LABELS[presence]}
      className={cn('block size-2.5 rounded-full', STYLES[presence], ringed && RING, className)}
    />
  )
}

export function presenceLabel(presence: Presence): string {
  return LABELS[presence]
}
