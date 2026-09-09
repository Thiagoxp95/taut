import type { TaskStatus } from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'

const STATUS_CLASS: Record<TaskStatus, string> = {
  queued: 'border-border bg-muted text-muted-foreground',
  running: 'border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-500',
  done: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400',
  failed: 'border-destructive/40 bg-destructive/10 text-destructive',
  cancelled: 'border-border bg-muted text-muted-foreground'
}

export const TASK_STATUSES: readonly TaskStatus[] = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled'
]

/** A task that has not ended: the only kind that can be cancelled. */
export const isLiveTask = (status: TaskStatus): boolean =>
  status === 'queued' || status === 'running'

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  return (
    <Badge variant="outline" className={STATUS_CLASS[status]}>
      {status}
    </Badge>
  )
}
