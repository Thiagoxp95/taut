import type { ProjectState } from '@taut/contract'
import {
  CircleIcon,
  CircleDashedIcon,
  CircleDotIcon,
  CircleCheckIcon,
  CircleXIcon,
  CirclePauseIcon
} from '@taut/ui/components/icons'
import { cn } from '@taut/ui/lib/utils'
import { PROJECT_STATE_COLOR } from '@/lib/projects'

const STATE_ICONS = {
  backlog: CircleDashedIcon,
  planned: CircleIcon,
  started: CircleDotIcon,
  paused: CirclePauseIcon,
  completed: CircleCheckIcon,
  canceled: CircleXIcon,
  unknown: CircleIcon
} satisfies Record<ProjectState, typeof CircleIcon>

/** Workspace status colors with a distinct Hugeicons glyph for each workflow state. */
export function ProjectStatusIcon({
  type,
  color,
  className
}: {
  type: ProjectState
  color?: string | undefined
  className?: string
}) {
  const Icon = STATE_ICONS[type]
  return (
    <Icon
      className={cn(
        'size-3.5 shrink-0',
        color === undefined && PROJECT_STATE_COLOR[type],
        className
      )}
      style={color === undefined ? undefined : { color }}
    />
  )
}
