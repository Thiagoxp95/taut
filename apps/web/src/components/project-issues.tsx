import * as React from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronDownIcon, PlusIcon } from '@taut/ui/components/icons'
import type { ProjectId, ProjectIssue } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { IssueAvatar } from '@/components/issue-avatar'
import { IssueCreateDialog } from '@/components/issue-create-dialog'
import { IssueStateIcon } from '@/components/issue-state-icon'
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
 * What changed with docs/build-plan-issues.md: this list used to be a set of
 * links *out*. A row went to `issue.url` and the `+` on a group header sent the
 * reader to Linear, because that was the only place an issue could be changed
 * (docs/build-plan-projects.md D1). Issues are the amendment to that rule
 * (docs/build-plan-issues.md D1), so a row is now a `Link` to `/issues/$issueId`
 * — the ticket's own page, where every field is editable and the conversation
 * about it lives — and the `+` opens the create dialog with that group's workflow
 * state already chosen. `Open in Linear` moved to the issue page's header, which
 * is where an affordance for what Taut does *not* mirror belongs.
 */

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
      {/* The ticket's own page, not Linear's (docs/build-plan-issues.md D15). */}
      <Link
        to="/issues/$issueId"
        params={{ issueId: issue.id }}
        className="flex min-h-11 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-2 sm:px-4 transition-colors last:border-b-0 hover:bg-accent/40"
      >
        <ProjectPriorityIcon priority={issue.priority} />
        <span className="w-[86px] shrink-0 truncate text-[13px] text-muted-foreground tabular-nums">
          {issue.identifier}
        </span>
        <IssueStateIcon type={issue.state.type} color={issue.state.color} />
        <span className="order-first w-full min-w-0 truncate text-[13px] sm:order-none sm:w-auto sm:flex-1">
          {issue.title}
        </span>
        <span className="hidden max-w-56 shrink-0 items-center gap-2 overflow-hidden lg:flex">
          {issue.labels.slice(0, 2).map((label) => (
            <LabelChip key={label.name} label={label} />
          ))}
        </span>
        <IssueAvatar person={issue.assignee} px={20} />
        <span className="w-[52px] shrink-0 text-right text-[13px] whitespace-nowrap text-muted-foreground">
          {date ?? ''}
        </span>
      </Link>
    </li>
  )
}

/** One workflow state and the issues sitting in it. Collapsible, as Linear's are. */
function Group({
  state,
  issues,
  onAdd
}: {
  state: ProjectIssue['state']
  issues: ReadonlyArray<ProjectIssue>
  /** Opens the create dialog with this group's state pre-selected (D1). */
  onAdd: () => void
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
        <button
          type="button"
          onClick={onAdd}
          title={`New issue in ${state.name}`}
          className="ml-auto flex size-5 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
        >
          <PlusIcon className="size-3.5" />
        </button>
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
  projectId
}: {
  issues: ReadonlyArray<ProjectIssue>
  /** Where a `+` files the new ticket. Its team is resolved server-side (D1). */
  projectId: ProjectId
}) {
  const groups = React.useMemo(() => group(issues), [issues])
  /*
   * `undefined` is closed; a string is the workflow state the `+` was clicked on.
   * Held here rather than per group so the dialog is mounted once — and so it
   * unmounts between openings, which is what stops a half-typed ticket from
   * being waiting inside the next one.
   */
  const [adding, setAdding] = React.useState<string | undefined>(undefined)

  return (
    <div>
      {groups.map((section) => (
        <Group
          key={section.state.id}
          state={section.state}
          issues={section.issues}
          onAdd={() => setAdding(section.state.id)}
        />
      ))}
      <IssueCreateDialog
        open={adding !== undefined}
        onOpenChange={(open) => setAdding(open ? adding : undefined)}
        projectId={projectId}
        defaultStateId={adding}
      />
    </div>
  )
}
