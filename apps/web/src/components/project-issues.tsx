import * as React from 'react'
import { ChevronDownIcon, PlusIcon } from 'lucide-react'
import type { IssueStateType, ProjectIssue } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { ProjectPriorityIcon } from '@/components/project-priority-icon'
import { formatBoardDate } from '@/lib/projects'

/**
 * A project's issues, grouped the way Linear groups them
 * (docs/build-plan-projects.md D19): one section per workflow state, in the
 * state's own order, with the count beside its name.
 *
 * The measurements are Linear's, like the overview's and the board's: a 36px
 * group header on a raised strip, 44px rows, 13px text, and a leading column of
 * priority glyph then identifier then state glyph that lines up down the page
 * whatever any single row is missing.
 *
 * Nothing here writes. The `+` on a group header and a click on a row both go to
 * Linear, because that is where an issue can actually be changed (D1) — an agent
 * is the only thing in Taut that files one, and it does that through a tool with
 * its own gate (D21), not through this page.
 */

/** Linear's issue-state glyph: the same ring as a project's, on a smaller grid. */
function IssueStateIcon({
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

  if (type === 'completed' || type === 'canceled') {
    return (
      <svg viewBox="0 0 14 14" className={shared} style={style} aria-hidden focusable="false">
        <circle cx="7" cy="7" r="6" fill="currentColor" />
        {type === 'completed' ? (
          <path
            d="M4.4 7.1 6.2 8.9 9.6 5.3"
            fill="none"
            stroke="var(--color-background)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ) : (
          <path
            d="M5 5l4 4M9 5l-4 4"
            fill="none"
            stroke="var(--color-background)"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        )}
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 14 14" className={shared} style={style} aria-hidden focusable="false">
      <circle
        cx="7"
        cy="7"
        r="5.4"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.4"
        // Backlog and triage are the rings Linear leaves open, drawn dotted.
        strokeDasharray={type === 'backlog' || type === 'triage' ? '1.6 2.1' : undefined}
        strokeLinecap="round"
      />
      {type === 'started' ? <path d="M7 3.2A3.8 3.8 0 0 1 7 10.8Z" fill="currentColor" /> : null}
    </svg>
  )
}

/**
 * The assignee, 20px round — or Linear's empty silhouette when nobody has it.
 * The placeholder is drawn rather than left out so a column of rows keeps one
 * straight edge, exactly as the priority glyph does.
 */
function Assignee({ assignee }: { assignee: ProjectIssue['assignee'] }) {
  const [broken, setBroken] = React.useState(false)

  if (assignee === undefined) {
    return (
      <span
        title="Unassigned"
        className="flex size-5 shrink-0 items-center justify-center rounded-full border border-dashed border-muted-foreground/40 text-muted-foreground/60"
      >
        <svg viewBox="0 0 16 16" className="size-3" fill="currentColor" aria-hidden>
          <circle cx="8" cy="5.6" r="2.6" />
          <path d="M2.9 14a5.1 5.1 0 0 1 10.2 0Z" />
        </svg>
      </span>
    )
  }

  if (assignee.avatarUrl !== undefined && !broken) {
    return (
      <img
        src={assignee.avatarUrl}
        alt={assignee.name}
        title={assignee.name}
        loading="lazy"
        onError={() => setBroken(true)}
        className="size-5 shrink-0 rounded-full object-cover"
      />
    )
  }

  const initials = assignee.name
    .split(/[\s@.]+/)
    .filter((part) => part.length > 0)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('')

  return (
    <span
      title={assignee.name}
      className="flex size-5 shrink-0 items-center justify-center rounded-full bg-rose-400/80 text-[9px] font-medium text-background"
    >
      {initials}
    </span>
  )
}

/** One label chip: Linear's dot in the label's own colour, then its name. */
function LabelChip({ label }: { label: ProjectIssue['labels'][number] }) {
  return (
    <span className="flex h-6 shrink-0 items-center gap-1.5 rounded-full border px-2 text-[12px] text-muted-foreground">
      <span
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: label.color ?? 'currentColor' }}
      />
      {label.name}
    </span>
  )
}

function IssueRow({ issue }: { issue: ProjectIssue }) {
  const date = formatBoardDate(
    issue.dueDate ?? issue.createdAt?.toString().slice(0, 10) ?? undefined
  )

  return (
    <li>
      <a
        href={issue.url}
        target="_blank"
        rel="noreferrer"
        className="flex h-11 items-center gap-3 border-b px-4 transition-colors last:border-b-0 hover:bg-accent/40"
      >
        <ProjectPriorityIcon priority={issue.priority} />
        <span className="w-[86px] shrink-0 truncate text-[13px] text-muted-foreground tabular-nums">
          {issue.identifier}
        </span>
        <IssueStateIcon type={issue.state.type} color={issue.state.color} />
        <span className="min-w-0 flex-1 truncate text-[13px]">{issue.title}</span>
        <span className="hidden shrink-0 items-center gap-2 sm:flex">
          {issue.labels.slice(0, 2).map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
        </span>
        <Assignee assignee={issue.assignee} />
        <span className="w-[52px] shrink-0 text-right text-[13px] whitespace-nowrap text-muted-foreground">
          {date ?? ''}
        </span>
      </a>
    </li>
  )
}

/** One workflow state and the issues sitting in it. Collapsible, as Linear's are. */
function Group({
  state,
  issues,
  url
}: {
  state: ProjectIssue['state']
  issues: ReadonlyArray<ProjectIssue>
  url: string
}) {
  const [open, setOpen] = React.useState(true)

  return (
    <section className="mb-2">
      <header className="flex h-9 items-center gap-2 rounded-md bg-accent/50 px-4">
        <button
          type="button"
          onClick={() => setOpen((current) => !current)}
          aria-expanded={open}
          className="-ml-1 flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <ChevronDownIcon className={cn('size-3.5 transition-transform', !open && '-rotate-90')} />
        </button>
        <IssueStateIcon type={state.type} color={state.color} />
        <h3 className="text-[13px] font-medium">{state.name}</h3>
        <span className="text-[13px] text-muted-foreground tabular-nums">{issues.length}</span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          title={`Add an issue to ${state.name} in Linear`}
          className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
        </a>
      </header>
      {open ? (
        <ul>
          {issues.map((issue) => (
            <IssueRow key={issue.id} issue={issue} />
          ))}
        </ul>
      ) : null}
    </section>
  )
}

/**
 * The rows arrive already ordered by state position then Linear's own tie-break
 * (D19), so grouping is a single pass that starts a new section whenever the
 * state id changes. No sort here: re-sorting a list the server ordered is how two
 * screens of the same data end up disagreeing.
 */
const group = (
  issues: ReadonlyArray<ProjectIssue>
): ReadonlyArray<{ state: ProjectIssue['state']; issues: ReadonlyArray<ProjectIssue> }> => {
  const out: Array<{ state: ProjectIssue['state']; issues: Array<ProjectIssue> }> = []
  for (const issue of issues) {
    const last = out[out.length - 1]
    if (last !== undefined && last.state.id === issue.state.id) last.issues.push(issue)
    else out.push({ state: issue.state, issues: [issue] })
  }
  return out
}

export function ProjectIssues({
  issues,
  url
}: {
  issues: ReadonlyArray<ProjectIssue>
  url: string
}) {
  const groups = React.useMemo(() => group(issues), [issues])
  return (
    <div>
      {groups.map((section) => (
        <Group key={section.state.id} state={section.state} issues={section.issues} url={url} />
      ))}
    </div>
  )
}
