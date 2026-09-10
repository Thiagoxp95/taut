import type { ProjectMilestoneStatus } from '@taut/contract'
import {
  CircleCheckIcon,
  CircleDotIcon,
  DiamondIcon,
  AlertCircleIcon
} from '@taut/ui/components/icons'
import { cn } from '@taut/ui/lib/utils'

export function ProjectMilestoneIcon({
  status,
  className
}: {
  status: ProjectMilestoneStatus | undefined
  className?: string
}) {
  const Icon =
    status === 'done'
      ? CircleCheckIcon
      : status === 'overdue'
        ? AlertCircleIcon
        : status === 'next'
          ? CircleDotIcon
          : DiamondIcon
  const tone =
    status === 'done' || status === 'next'
      ? 'text-violet-400'
      : status === 'overdue'
        ? 'text-red-500'
        : 'text-muted-foreground'
  return <Icon className={cn('size-3.5 shrink-0', tone, className)} />
}
