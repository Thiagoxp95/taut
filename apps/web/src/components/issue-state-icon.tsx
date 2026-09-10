import type { IssueStateType } from '@taut/contract'
import {
  CircleIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleCheckIcon,
  CircleXIcon,
  AlertCircleIcon
} from '@taut/ui/components/icons'
import { cn } from '@taut/ui/lib/utils'

const STATE_ICONS = {
  triage: AlertCircleIcon,
  backlog: CircleDashedIcon,
  unstarted: CircleIcon,
  started: CircleDotIcon,
  completed: CircleCheckIcon,
  canceled: CircleXIcon,
  unknown: CircleIcon
} satisfies Record<IssueStateType, typeof CircleIcon>

export function IssueStateIcon({
  type,
  color,
  className
}: {
  type: IssueStateType
  color?: string | undefined
  className?: string
}) {
  const fallback: Record<IssueStateType, string> = {
    triage: 'text-orange-400',
    backlog: 'text-muted-foreground',
    unstarted: 'text-muted-foreground',
    started: 'text-amber-400',
    completed: 'text-indigo-400',
    canceled: 'text-muted-foreground',
    unknown: 'text-muted-foreground'
  }
  const shared = cn('size-3.5 shrink-0', color === undefined && fallback[type], className)
  const style = color === undefined ? undefined : { color }

  const Icon = STATE_ICONS[type]
  return <Icon className={shared} style={style} />
}
