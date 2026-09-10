import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { ActivityIcon, CalendarIcon, CalendarX2Icon, DiamondIcon } from '@taut/ui/components/icons'
import type { Project, ProjectId } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { ProjectLeadAvatar } from '@/components/project-lead-avatar'
import { ProjectPriorityIcon } from '@/components/project-priority-icon'
import { ProjectStatusIcon } from '@/components/project-status-icon'
import { useMoveProject } from '@/lib/api'
import { useEmoji } from '@/lib/emoji'
import {
  PROJECT_HEALTH_COLOR,
  PROJECT_HEALTH_LABEL,
  PROJECT_STATE_LABEL,
  formatBoardDate,
  isOverdue,
  priorityRank
} from '@/lib/projects'

/**
 * The Linear board (docs/build-plan-projects.md D13, D14): one column per project
 * status the workspace defines, cards dragged between them.
 *
 * The columns come from the projects themselves rather than from a list Taut
 * keeps: a status is only real here if something is in it. That costs an empty
 * column — a status nobody uses does not appear until the first project lands in
 * it, which cannot happen from Taut — and buys a board that needs no second
 * source of truth to stay in step with the mirror.
 *
 * D14 is the card itself. The measurements below are Linear's, taken off its own
 * board rather than invented: a 364px column with 12px of gutter, a 340px card
 * with 12px of padding down and 10px across, 13px text on a 16px line, 16px
 * icons, and a 6px gap between cards. They are written as exact pixels on
 * purpose — this is one of the few places in Taut that copies another product's
 * layout, and rounding it to the nearest utility class is what makes a copy look
 * like an imitation.
 *
 * Dragging is HTML5 drag and drop, on purpose: a card is a link, a column is a
 * drop target, and both keep working with no library and no pointer maths.
 */

/** One column: a Linear project status plus the cards sitting in it. */
interface Column {
  readonly id: string
  readonly name: string
  readonly type: Project['state']
  readonly color: string | undefined
  readonly position: number
  readonly projects: ReadonlyArray<Project>
}

/** The column for projects Linear reports with no status at all. */
const NO_STATUS = 'no-status'

/** One meta row under the description: an icon, then a line of text. */
function CardRow({
  icon,
  children,
  className
}: {
  icon: React.ReactNode
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('mt-3 flex items-center gap-1.5 text-[13px] leading-4', className)}>
      {icon}
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
}

function ProjectCard({
  project,
  emoji,
  draggable,
  dragging,
  onDragStart,
  onDragEnd
}: {
  project: Project
  /** Already resolved by the board, which owns the one shortcode table. */
  emoji: string | undefined
  draggable: boolean
  dragging: boolean
  onDragStart: () => void
  onDragEnd: () => void
}) {
  const target = formatBoardDate(project.targetDate)
  const overdue = isOverdue(project.targetDate)
  const milestone = project.nextMilestone

  return (
    <li>
      <Link
        to="/projects/$projectId"
        params={{ projectId: project.id }}
        draggable={draggable}
        onDragStart={(event) => {
          // A link drags its href by default, which the column would never read.
          event.dataTransfer.effectAllowed = 'move'
          event.dataTransfer.setData('text/plain', project.id)
          onDragStart()
        }}
        onDragEnd={onDragEnd}
        className={cn(
          'block rounded-md border bg-card px-2.5 py-3 transition-colors hover:border-foreground/20',
          draggable && 'cursor-grab active:cursor-grabbing',
          dragging && 'opacity-40'
        )}
      >
        <div className="flex items-start gap-2.5">
          {emoji === undefined ? null : (
            <span aria-hidden className="w-5 shrink-0 text-[13px] leading-4">
              {emoji}
            </span>
          )}
          <p className="line-clamp-3 min-w-0 flex-1 text-[13px] leading-4 font-medium">
            {project.name}
          </p>
          <span className="flex shrink-0 items-center gap-2 leading-4">
            {project.health === undefined ? null : (
              <ActivityIcon
                className={cn('size-3.5', PROJECT_HEALTH_COLOR[project.health])}
                aria-label={PROJECT_HEALTH_LABEL[project.health]}
              />
            )}
            <ProjectStatusIcon
              type={project.status?.type ?? project.state}
              color={project.status?.color}
            />
            <ProjectPriorityIcon priority={project.priority} />
            {project.lead === undefined ? null : <ProjectLeadAvatar lead={project.lead} />}
          </span>
        </div>

        {project.description === undefined ? null : (
          <p className="mt-2 line-clamp-2 text-[13px] leading-4 text-muted-foreground">
            {project.description}
          </p>
        )}

        {milestone === undefined ? null : (
          <CardRow
            icon={<DiamondIcon className="size-3.5 shrink-0" />}
            className="text-muted-foreground"
          >
            {milestone.name}
          </CardRow>
        )}

        {target === undefined ? null : (
          <CardRow
            icon={
              overdue ? (
                <CalendarX2Icon className="size-3.5 shrink-0 text-red-500" />
              ) : (
                <CalendarIcon className="size-3.5 shrink-0" />
              )
            }
            className={overdue ? 'text-red-500' : 'text-muted-foreground'}
          >
            {target}
          </CardRow>
        )}

        <p className="mt-3 text-[13px] leading-4 text-muted-foreground">
          {project.issueCount} {project.issueCount === 1 ? 'issue' : 'issues'}
        </p>
      </Link>
    </li>
  )
}

function BoardColumn({
  column,
  droppable,
  over,
  onOver,
  onLeave,
  onDrop,
  children
}: {
  column: Column
  droppable: boolean
  over: boolean
  onOver: () => void
  onLeave: () => void
  onDrop: () => void
  children: React.ReactNode
}) {
  return (
    <section
      className={cn(
        'flex h-full w-[min(364px,calc(100vw-2rem))] shrink-0 flex-col rounded-lg px-3 transition-colors',
        // Linear's columns have no chrome of their own; the only time one draws a
        // shape is while a card is hovering over it.
        over && 'bg-accent/40'
      )}
      onDragOver={(event) => {
        if (!droppable) return
        // Without this the browser refuses the drop and the card springs back.
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        onOver()
      }}
      onDragLeave={(event) => {
        // Moving over a card fires `dragleave` on the column; only a pointer that
        // actually left the column counts.
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        onLeave()
      }}
      onDrop={(event) => {
        if (!droppable) return
        event.preventDefault()
        onDrop()
      }}
    >
      <header className="flex h-8 shrink-0 items-center gap-2 px-1.5">
        <ProjectStatusIcon type={column.type} color={column.color} />
        <h2 className="min-w-0 flex-1 truncate text-[13px] font-semibold">{column.name}</h2>
        <span className="text-[13px] tabular-nums text-muted-foreground">
          {column.projects.length}
        </span>
      </header>
      <ul className="taut-scroll flex min-h-0 flex-1 flex-col gap-1.5 overflow-y-auto pt-3 pb-2">
        {children}
      </ul>
    </section>
  )
}

export function ProjectBoard({
  projects,
  canMove
}: {
  projects: ReadonlyArray<Project>
  canMove: boolean
}) {
  const move = useMoveProject()
  const emoji = useEmoji()

  /**
   * Where a card is *shown* while Linear is still deciding. The mutation writes
   * the mirror from Linear's answer, so this holds only until the list refetches;
   * a refusal drops the entry and the card is back in its old column.
   */
  const [pending, setPending] = React.useState<Record<string, string>>({})
  const [dragged, setDragged] = React.useState<ProjectId | undefined>(undefined)
  const [over, setOver] = React.useState<string | undefined>(undefined)

  const columns = React.useMemo(() => {
    const byId = new Map<string, { column: Omit<Column, 'projects'>; items: Array<Project> }>()
    const loose: Array<Project> = []

    for (const project of projects) {
      const statusId = pending[project.id] ?? project.status?.id
      if (statusId === undefined) {
        loose.push(project)
        continue
      }
      const existing = byId.get(statusId)
      if (existing !== undefined) {
        existing.items.push(project)
        continue
      }
      // A card shown in a column it has not landed in yet borrows that column's
      // name from whichever project defines it; the status is the same object.
      const source =
        project.status?.id === statusId
          ? project.status
          : projects.find((other) => other.status?.id === statusId)?.status
      byId.set(statusId, {
        column: {
          id: statusId,
          name: source?.name ?? PROJECT_STATE_LABEL[project.state],
          type: source?.type ?? project.state,
          color: source?.color,
          position: source?.position ?? 0
        },
        items: [project]
      })
    }

    const ordered: Array<Column> = [...byId.values()]
      .map((entry) => ({
        ...entry.column,
        // Inside a column Linear reads priority first and its own tie-break
        // second (D14): urgent at the top, unprioritised at the bottom.
        projects: [...entry.items].sort(
          (a, b) =>
            priorityRank(a.priority) - priorityRank(b.priority) ||
            a.prioritySortOrder - b.prioritySortOrder
        )
      }))
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name))

    if (loose.length > 0) {
      ordered.push({
        id: NO_STATUS,
        name: 'No status',
        type: 'unknown',
        color: undefined,
        position: Number.POSITIVE_INFINITY,
        projects: loose
      })
    }
    return ordered
  }, [projects, pending])

  const drop = (statusId: string) => {
    setOver(undefined)
    const projectId = dragged
    setDragged(undefined)
    if (projectId === undefined || statusId === NO_STATUS) return

    const project = projects.find((candidate) => candidate.id === projectId)
    if (project === undefined || (pending[projectId] ?? project.status?.id) === statusId) return

    setPending((current) => ({ ...current, [projectId]: statusId }))
    move.mutate(
      { projectId, statusId },
      {
        // Cleared either way: on success the refetched project already says so,
        // on failure the card belongs where Linear still has it.
        onSettled: () =>
          setPending((current) => {
            const { [projectId]: _moved, ...rest } = current
            return rest
          })
      }
    )
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {move.error === undefined || move.error === null ? null : (
        <p className="mb-3 shrink-0 text-xs text-destructive">
          Linear refused the move, so the card went back. Try again, or move it in Linear.
        </p>
      )}
      <div className="taut-scroll -ml-3 flex min-h-0 min-w-0 flex-1 overflow-x-auto pb-2">
        {columns.map((column) => (
          <BoardColumn
            key={column.id}
            column={column}
            droppable={canMove && column.id !== NO_STATUS}
            over={over === column.id && dragged !== undefined}
            onOver={() => setOver(column.id)}
            onLeave={() => setOver((current) => (current === column.id ? undefined : current))}
            onDrop={() => drop(column.id)}
          >
            {column.projects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                emoji={emoji(project.icon)}
                draggable={canMove}
                dragging={dragged === project.id}
                onDragStart={() => setDragged(project.id)}
                onDragEnd={() => {
                  setDragged(undefined)
                  setOver(undefined)
                }}
              />
            ))}
          </BoardColumn>
        ))}
      </div>
    </div>
  )
}
