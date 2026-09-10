/**
 * The Routines tab: every prompt this agent runs on its own (docs/build-plan-routines.md,
 * generalised by docs/build-plan-triggers.md D14).
 *
 * One list holds both kinds, because a routine and a trigger differ in one field. A row is the
 * whole story — what fires it, when that is next, how the last run went — so the dialog is only
 * opened to change something.
 */
import * as React from 'react'
import { Link } from '@tanstack/react-router'
import {
  CalendarClockIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlayIcon,
  PlusIcon,
  TrashIcon
} from '@taut/ui/components/icons'
import {
  describeTrigger,
  type AgentId,
  type Routine,
  type Task,
  type TriggerKind,
  type TriggerNames
} from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import { Button } from '@taut/ui/components/button'
import { Switch } from '@taut/ui/components/switch'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@taut/ui/components/dropdown-menu'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { EmptyState, ReadOnlyNote } from '@/components/page'
import { SettingsSection } from '@/components/settings'
import { RoutineDialog } from '@/components/routine-dialog'
import { useTriggerNames } from '@/components/trigger-picker'
import { useDeleteRoutine, useRoutines, useRunRoutine, useTasks, useUpdateRoutine } from '@/lib/api'
import { formatRelative, formatUntil } from '@/lib/format'

const FILTERS: readonly { readonly value: TriggerKind | 'all'; readonly label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'schedule', label: 'Schedules' },
  { value: 'event', label: 'Triggers' }
]

const RUN_LABEL: Record<NonNullable<Routine['lastStatus']>, string> = {
  fired: 'ran',
  skipped: 'skipped',
  failed: 'failed'
}

/** "ran 3h ago", linked to the thread when the task it produced is still in the list. */
function LastRun({ routine, task }: { routine: Routine; task: Task | undefined }) {
  if (routine.lastStatus === undefined) {
    return <span className="hidden text-xs text-muted-foreground sm:inline">never run</span>
  }
  const label = `${RUN_LABEL[routine.lastStatus]} ${formatRelative(routine.lastRunAt)}`
  const variant = routine.lastStatus === 'failed' ? 'destructive' : 'outline'

  if (task === undefined) {
    return (
      <Badge variant={variant} className="font-normal">
        {label}
      </Badge>
    )
  }
  return (
    <Badge asChild variant={variant} className="font-normal">
      <Link
        to={task.channelKind === 'dm' ? '/dm/$channelId' : '/c/$channelId'}
        params={{ channelId: task.channelId }}
        search={{ thread: task.threadId }}
        title="Open the thread this run replied in"
      >
        {label}
      </Link>
    </Badge>
  )
}

/**
 * The second half of a row's subtitle. A clock knows when it goes off next; an event trigger
 * has no next run at all (D9), so it says it is standing by rather than printing a dash that
 * reads as missing data.
 */
function nextRunLabel(routine: Routine): string {
  if (!routine.enabled) return 'paused'
  if (routine.trigger._tag === 'event') return 'waiting'
  return routine.nextRunAt === undefined
    ? 'never fires again'
    : `next run ${formatUntil(routine.nextRunAt)}`
}

function RoutineRow({
  routine,
  names,
  task,
  canManage,
  onEdit,
  onDelete
}: {
  routine: Routine
  names: TriggerNames
  task: Task | undefined
  canManage: boolean
  onEdit: () => void
  onDelete: () => void
}) {
  const updateRoutine = useUpdateRoutine()
  const runRoutine = useRunRoutine()

  const when = describeTrigger(routine.trigger, names)
  const next = nextRunLabel(routine)

  return (
    <li className="flex flex-wrap items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1 basis-40">
        <p className="truncate text-sm font-medium">{routine.name}</p>
        <p className="truncate text-xs text-muted-foreground">
          {when} · {next}
        </p>
      </div>

      <LastRun routine={routine} task={task} />

      <Switch
        checked={routine.enabled}
        disabled={!canManage || updateRoutine.isPending}
        aria-label={`${routine.enabled ? 'Pause' : 'Resume'} ${routine.name}`}
        onCheckedChange={(enabled) => updateRoutine.mutate({ routineId: routine.id, enabled })}
      />

      {canManage ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={`Actions for ${routine.name}`}>
              <MoreHorizontalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              disabled={runRoutine.isPending}
              onSelect={() => runRoutine.mutate(routine.id)}
            >
              <PlayIcon />
              Run now
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onEdit}>
              <PencilIcon />
              Edit
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem variant="destructive" onSelect={onDelete}>
              <TrashIcon />
              Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </li>
  )
}

export function AgentRoutinesTab({
  agentId,
  agentHandle,
  canManage
}: {
  agentId: AgentId
  agentHandle: string
  /** Company admin+ or the head of a department the agent is in. */
  canManage: boolean
}) {
  const routines = useRoutines(agentId)
  // Already in the cache from the Runtime tab: the same key, the same filter.
  const tasks = useTasks({ agentId })
  const deleteRoutine = useDeleteRoutine()
  const names = useTriggerNames()

  const [dialogOpen, setDialogOpen] = React.useState(false)
  const [editing, setEditing] = React.useState<Routine | null>(null)
  const [deleting, setDeleting] = React.useState<Routine | null>(null)
  const [filter, setFilter] = React.useState<TriggerKind | 'all'>('all')

  const all = routines.data?.items ?? []
  /*
   * The chip row is only worth its space once both kinds are actually here (D14). Until then
   * there is exactly one thing to filter to, and offering it would be a control that does
   * nothing.
   */
  const mixed =
    all.some((routine) => routine.trigger._tag === 'schedule') &&
    all.some((routine) => routine.trigger._tag === 'event')
  const rows = mixed && filter !== 'all' ? all.filter((r) => r.trigger._tag === filter) : all

  const tasksById = React.useMemo(() => {
    const index = new Map<string, Task>()
    for (const task of tasks.data?.items ?? []) index.set(task.id, task)
    return index
  }, [tasks.data])

  const openNew = (): void => {
    setEditing(null)
    setDialogOpen(true)
  }

  return (
    <>
      <SettingsSection
        title="Routines"
        description="Prompts this agent runs on its own, on a schedule or the moment something happens. Each one posts as you, so the run reads like a mention you typed yourself."
        action={
          canManage ? (
            <Button size="sm" variant="outline" onClick={openNew}>
              <PlusIcon />
              New routine
            </Button>
          ) : undefined
        }
      >
        {mixed ? (
          <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter routines">
            {FILTERS.map((entry) => (
              <Button
                key={entry.value}
                type="button"
                size="xs"
                variant={filter === entry.value ? 'default' : 'outline'}
                aria-pressed={filter === entry.value}
                onClick={() => setFilter(entry.value)}
              >
                {entry.label}
              </Button>
            ))}
          </div>
        ) : null}

        {routines.isPending ? null : rows.length === 0 ? (
          <EmptyState
            icon={<CalendarClockIcon className="size-5" />}
            title={all.length === 0 ? 'No routines yet' : 'Nothing of that kind'}
            description={
              all.length === 0
                ? 'Anything you ask this agent on the same rhythm, or every time something happens, can run without you being there to type it.'
                : 'This agent has routines, but none that fire this way.'
            }
            action={
              canManage && all.length === 0 ? (
                <Button onClick={openNew}>Add the first routine</Button>
              ) : undefined
            }
          />
        ) : (
          <ul className="divide-y rounded-lg border">
            {rows.map((routine) => (
              <RoutineRow
                key={routine.id}
                routine={routine}
                names={names}
                task={
                  routine.lastTaskId === undefined ? undefined : tasksById.get(routine.lastTaskId)
                }
                canManage={canManage}
                onEdit={() => {
                  setEditing(routine)
                  setDialogOpen(true)
                }}
                onDelete={() => setDeleting(routine)}
              />
            ))}
          </ul>
        )}

        {canManage ? null : (
          <div className="mt-3">
            <ReadOnlyNote />
          </div>
        )}
      </SettingsSection>

      {canManage ? (
        <RoutineDialog
          agentId={agentId}
          agentHandle={agentHandle}
          editing={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
        />
      ) : null}

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(next) => {
          if (!next) setDeleting(null)
        }}
        title={`Delete the ${deleting?.name ?? ''} routine?`}
        confirmLabel="Delete routine"
        pending={deleteRoutine.isPending}
        description={
          <p>
            It stops firing straight away. The runs it already did stay in their threads and in the
            task history.
          </p>
        }
        onConfirm={() => {
          if (deleting === null) return
          deleteRoutine.mutate(deleting.id, { onSuccess: () => setDeleting(null) })
        }}
      />
    </>
  )
}
