import * as React from 'react'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { CircleSlashIcon, HashIcon, ListChecksIcon } from 'lucide-react'
import type { Task, TaskStatus } from '@taut/contract'

import { Button } from '@taut/ui/components/button'
import { Skeleton } from '@taut/ui/components/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { EmptyState, PageBody, PageHeader } from '@/components/page'
import { EntityAvatar } from '@/components/entity-avatar'
import { TASK_STATUSES, TaskStatusBadge, isLiveTask } from '@/components/task-status'
import { useTicker } from '@/hooks/use-ticker'
import { useChannelGroups, useDirectoryIndex } from '@/hooks/use-directory'
import { useCancelTask, useTasks } from '@/lib/api'
import { formatDuration, formatRelative, toMillis } from '@/lib/format'

function isTaskStatus(value: string): value is TaskStatus {
  return TASK_STATUSES.some((status) => status === value)
}

function TaskRow({ task, now }: { task: Task; now: number }) {
  const navigate = useNavigate()
  const directory = useDirectoryIndex()
  const { all } = useChannelGroups()
  const cancelTask = useCancelTask()

  const agent = directory.get(task.agentId)
  const isDm = task.channelKind === 'dm'
  const channel = isDm ? undefined : all.find((entry) => entry.id === task.channelId)
  const live = isLiveTask(task.status)

  const endedMillis = task.endedAt === undefined ? undefined : toMillis(task.endedAt)
  const duration = formatDuration(toMillis(task.startedAt), endedMillis ?? now)

  const open = (): void => {
    void navigate(
      isDm
        ? {
            to: '/dm/$channelId',
            params: { channelId: task.channelId },
            search: { thread: task.threadId }
          }
        : {
            to: '/c/$channelId',
            params: { channelId: task.channelId },
            search: { thread: task.threadId }
          }
    )
  }

  return (
    <tr
      role="link"
      tabIndex={0}
      aria-label={`Open the thread for ${agent?.name ?? 'this task'}`}
      onClick={open}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          open()
        }
      }}
      className="cursor-pointer transition-colors outline-none hover:bg-muted/40 focus-visible:bg-muted/60"
    >
      <td className="px-4 py-3">
        <div className="flex items-center gap-2.5">
          <EntityAvatar
            avatar={agent?.avatar ?? { kind: 'emoji', value: '🤖' }}
            kind="agent"
            face={agent?.face}
            name={agent?.name ?? ''}
            size="sm"
          />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium">
              {agent?.name ?? 'Unknown agent'}
            </span>
            <span className="block truncate text-xs text-muted-foreground">
              @{agent?.handle ?? task.agentId}
            </span>
          </span>
        </div>
      </td>
      <td className="px-4 py-3 text-sm">
        {isDm ? (
          <span className="text-muted-foreground">Direct message</span>
        ) : (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <HashIcon className="size-3.5" />
            {channel?.name ?? 'channel'}
          </span>
        )}
      </td>
      <td className="px-4 py-3">
        <TaskStatusBadge status={task.status} />
      </td>
      <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground">
        {formatRelative(task.startedAt)}
      </td>
      <td className="px-4 py-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
        {duration}
        {live ? '…' : ''}
      </td>
      <td className="px-4 py-3 text-right">
        {live ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={cancelTask.isPending}
            onClick={(event) => {
              event.stopPropagation()
              cancelTask.mutate(task.id)
            }}
          >
            <CircleSlashIcon />
            Cancel
          </Button>
        ) : task.error === undefined ? null : (
          <span className="line-clamp-1 max-w-[16rem] text-xs text-destructive" title={task.error}>
            {task.error}
          </span>
        )}
      </td>
    </tr>
  )
}

function TasksRoute() {
  const [status, setStatus] = React.useState<TaskStatus | 'all'>('all')
  const query = useTasks(status === 'all' ? {} : { status })
  const tasks = query.data?.items ?? []

  const anyLive = tasks.some((task) => isLiveTask(task.status))
  const now = useTicker(1000, anyLive)

  return (
    <>
      <PageHeader
        title="Tasks"
        description="Every agent run in this company. A row opens the thread it is writing into."
        icon={<ListChecksIcon className="size-4" />}
        actions={
          <Select
            value={status}
            onValueChange={(next) =>
              setStatus(next === 'all' || !isTaskStatus(next) ? 'all' : next)
            }
          >
            <SelectTrigger size="sm" className="w-40" aria-label="Filter by status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {TASK_STATUSES.map((entry) => (
                <SelectItem key={entry} value={entry}>
                  {entry}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <PageBody>
        {query.isPending ? (
          <Skeleton className="h-64 rounded-lg" />
        ) : tasks.length === 0 ? (
          <EmptyState
            icon={<ListChecksIcon className="size-5" />}
            title={status === 'all' ? 'No tasks yet' : `No ${status} tasks`}
            description="A task starts the moment somebody @mentions an agent in a channel or a DM. It streams its reply into that thread."
          />
        ) : (
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-xs text-muted-foreground">
                <tr>
                  <th className="px-4 py-2.5 text-left font-medium">Agent</th>
                  <th className="px-4 py-2.5 text-left font-medium">Where</th>
                  <th className="px-4 py-2.5 text-left font-medium">Status</th>
                  <th className="px-4 py-2.5 text-left font-medium">Started</th>
                  <th className="px-4 py-2.5 text-left font-medium">Took</th>
                  <th className="px-4 py-2.5" />
                </tr>
              </thead>
              <tbody className="divide-y">
                {tasks.map((task) => (
                  <TaskRow key={task.id} task={task} now={now} />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </PageBody>
    </>
  )
}

export const Route = createFileRoute('/_app/tasks')({
  component: TasksRoute
})
