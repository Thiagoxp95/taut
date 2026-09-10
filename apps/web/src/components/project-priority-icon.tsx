import type { ProjectPriority } from '@taut/contract'
import {
  AlertCircleIcon,
  MinusIcon,
  SignalHighIcon,
  SignalMediumIcon,
  SignalLowIcon
} from '@taut/ui/components/icons'
import { cn } from '@taut/ui/lib/utils'
import { PROJECT_PRIORITY_LABEL } from '@/lib/projects'

const PRIORITY_ICONS = {
  0: MinusIcon,
  1: AlertCircleIcon,
  2: SignalHighIcon,
  3: SignalMediumIcon,
  4: SignalLowIcon
} as const

export function ProjectPriorityIcon({
  priority,
  className
}: {
  priority: ProjectPriority
  className?: string
}) {
  const Icon = PRIORITY_ICONS[priority]
  return (
    <Icon
      className={cn(
        'size-3.5 shrink-0',
        priority === 1 ? 'text-amber-500' : 'text-muted-foreground',
        className
      )}
      aria-label={PROJECT_PRIORITY_LABEL[priority]}
      role="img"
    />
  )
}
