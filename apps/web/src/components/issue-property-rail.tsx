import * as React from 'react'
import {
  DiamondIcon,
  CalendarIcon,
  GaugeIcon,
  SquareKanbanIcon,
  TagIcon,
  XIcon
} from '@taut/ui/components/icons'
import type {
  IssueOptions,
  IssueState,
  Project,
  ProjectIssue,
  ProjectPriority
} from '@taut/contract'
import { ProjectIssue as ProjectIssueClass } from '@taut/contract'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@taut/ui/components/command'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import { cn } from '@taut/ui/lib/utils'
import { IssueAvatar } from '@/components/issue-avatar'
import { IssueStateIcon } from '@/components/issue-state-icon'
import { ProjectPriorityIcon } from '@/components/project-priority-icon'
import type { IssueEdit } from '@/lib/api'
import { PROJECT_PRIORITY_LABEL, formatBoardDate } from '@/lib/projects'

/**
 * The 240px rail down the right of a ticket (docs/build-plan-issues.md D15).
 *
 * This is Linear's issue sidebar, at Linear's measurements — the same discipline
 * `routes/_app.projects.$projectId.tsx` follows on the project overview, and for
 * the same reason: rounding a copy to the nearest Tailwind utility is what makes
 * it look like an imitation. A 240px column; an 11px uppercase section label; a
 * 76px name gutter beside a 28px control that fills the rest; 13px values; 3.5px
 * glyphs. A property with no value keeps the full 28px row and shows Linear's own
 * placeholder word, so the rail has the same rhythm on a bare ticket as on a
 * fully filled one.
 *
 * Every control is a `Popover` + `Command` picker over `useIssueOptions` (D14),
 * and every one of them is optimistic (D3): the chip changes on click, the
 * mutation goes to Linear, and a refusal snaps it back. Which is why each picker
 * hands `onEdit` both halves of the change — the ids Linear wants, and the same
 * change written in the fields this rail draws. The picker is the only thing that
 * knows both: it is holding the option object, and the mirror row carries no
 * table to look a state id's name up in.
 *
 * `canEdit` is D4's member+ gate. A reader below it gets the same rail with the
 * pickers off rather than a different, emptier one — what a ticket says is not a
 * function of who is allowed to change it.
 */

/** Every row of the rail: Linear's 76px name gutter and its 28px control. */
function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2">
      <span className="mt-[7px] w-[76px] shrink-0 text-[12px] leading-[14px] text-muted-foreground">
        {label}
      </span>
      <div className="-ml-1.5 min-w-0 flex-1">{children}</div>
    </div>
  )
}

/**
 * The control itself. A button when it can be clicked, a plain span when it
 * cannot — a disabled button that still looks pressable is a promise the page
 * does not keep.
 */
const CONTROL =
  'flex min-h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-[13px] [&_svg]:shrink-0'

function Value({
  children,
  muted = false,
  interactive
}: {
  children: React.ReactNode
  muted?: boolean
  interactive: boolean
}) {
  return (
    <span
      className={cn(
        CONTROL,
        muted && 'text-muted-foreground',
        interactive &&
          'transition-colors group-hover:bg-accent/60 group-data-[state=open]:bg-accent'
      )}
    >
      {children}
    </span>
  )
}

/**
 * One picker. The trigger is the row's control; the panel is a 240px `Command`
 * that matches the rail's own width, so the list opens exactly over the property
 * it belongs to rather than floating free of it.
 *
 * `children` takes a `close` callback rather than the popover closing itself on
 * every select, because the labels picker is multi-select and must stay open.
 */
function Picker({
  canEdit,
  search,
  empty,
  trigger,
  children
}: {
  canEdit: boolean
  search: string
  empty: string
  trigger: React.ReactNode
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)

  if (!canEdit) return <>{trigger}</>

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="group block w-full">{trigger}</PopoverTrigger>
      <PopoverContent align="start" sideOffset={2} className="w-[240px] p-0">
        <Command>
          <CommandInput placeholder={search} />
          <CommandList>
            <CommandEmpty>{empty}</CommandEmpty>
            <CommandGroup>{children(() => setOpen(false))}</CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/**
 * Linear's estimate scale is a team setting the mirror does not carry, so the
 * picker offers the whole numeric range every one of Linear's scales is drawn
 * from (exponential 1·2·4·8, Fibonacci 1·2·3·5·8, linear 1–5) rather than
 * guessing which of them this team uses. Linear refuses a value its scale has no
 * room for, and that refusal arrives as a `Validation` like any other (D3).
 */
const ESTIMATES: readonly number[] = [1, 2, 3, 4, 5, 6, 7, 8]

const PRIORITIES: readonly ProjectPriority[] = [0, 1, 2, 3, 4]

export function IssuePropertyRail({
  issue,
  project,
  options,
  canEdit,
  onEdit
}: {
  issue: ProjectIssue
  /** The project it hangs under, so the rail can name it before the options land. */
  project: Project
  /** `undefined` while the live read of Linear is in flight (D14). */
  options: IssueOptions | undefined
  canEdit: boolean
  onEdit: (edit: IssueEdit) => void
}) {
  /** `{ ...issue, … }` rebuilt as the class, the way the message cache does it. */
  const patched = (fields: Partial<ProjectIssue>): ProjectIssue =>
    new ProjectIssueClass({ ...issue, ...fields }, true)

  const states = options?.states ?? []
  const labels = options?.labels ?? []
  const members = options?.members ?? []
  const milestones = options?.milestones ?? []
  const projects = options?.projects ?? []

  const selectedLabels = new Set(issue.labels.map((label) => label.name))
  const dueDate = formatBoardDate(issue.dueDate)

  const setState = (state: IssueState, close: () => void): void => {
    close()
    if (state.id === issue.state.id) return
    onEdit({ patch: { stateId: state.id }, optimistic: () => patched({ state }) })
  }

  const setPriority = (priority: ProjectPriority, close: () => void): void => {
    close()
    if (priority === issue.priority) return
    onEdit({
      patch: { priority },
      optimistic: () => patched({ priority, priorityLabel: PROJECT_PRIORITY_LABEL[priority] })
    })
  }

  const setAssignee = (assignee: ProjectIssue['assignee'], close: () => void): void => {
    close()
    onEdit({
      patch: { assigneeId: assignee?.linearId ?? null },
      optimistic: () => patched({ assignee })
    })
  }

  /**
   * Linear's `labelIds` replaces the set, it does not merge, so a toggle sends
   * the whole set every time — and the optimistic row is built by name, because
   * a mirrored `IssueLabel` has no id to match on.
   */
  const toggleLabel = (label: IssueOptions['labels'][number]): void => {
    const on = selectedLabels.has(label.name)
    const next = on
      ? issue.labels.filter((entry) => entry.name !== label.name)
      : [...issue.labels, { name: label.name, color: label.color }]
    const ids = labels
      .filter((entry) => next.some((chosen) => chosen.name === entry.name))
      .map((entry) => entry.id)
    onEdit({ patch: { labelIds: ids }, optimistic: () => patched({ labels: next }) })
  }

  const setMilestone = (
    milestone: IssueOptions['milestones'][number] | undefined,
    close: () => void
  ): void => {
    close()
    onEdit({
      patch: { milestoneId: milestone?.id ?? null },
      optimistic: () => patched({ milestoneId: milestone?.id, milestoneName: milestone?.name })
    })
  }

  const setProject = (target: IssueOptions['projects'][number], close: () => void): void => {
    close()
    if (target.id === project.linearId) return
    // No optimistic half: the row's `projectId` is Taut's, not Linear's, and the
    // page's breadcrumb is drawn from the project the *detail* read returned.
    // Guessing it here would put the ticket under a project the page cannot draw.
    onEdit({ patch: { projectLinearId: target.id } })
  }

  const setEstimate = (estimate: number | undefined, close: () => void): void => {
    close()
    onEdit({ patch: { estimate: estimate ?? null }, optimistic: () => patched({ estimate }) })
  }

  const setDueDate = (value: string | undefined): void => {
    onEdit({ patch: { dueDate: value ?? null }, optimistic: () => patched({ dueDate: value }) })
  }

  return (
    <aside className="min-w-0">
      <h2 className="mb-2 text-[11px] font-medium tracking-[0.04em] text-muted-foreground uppercase">
        Properties
      </h2>

      <div className="space-y-px">
        <PropertyRow label="Status">
          <Picker
            canEdit={canEdit}
            search="Change status…"
            empty="No workflow states."
            trigger={
              <Value interactive={canEdit}>
                <IssueStateIcon type={issue.state.type} color={issue.state.color} />
                <span className="truncate">{issue.state.name}</span>
              </Value>
            }
          >
            {(close) =>
              states.map((state) => (
                <CommandItem
                  key={state.id}
                  value={state.name}
                  onSelect={() => setState(state, close)}
                >
                  <IssueStateIcon type={state.type} color={state.color} />
                  <span className="truncate">{state.name}</span>
                </CommandItem>
              ))
            }
          </Picker>
        </PropertyRow>

        <PropertyRow label="Priority">
          <Picker
            canEdit={canEdit}
            search="Set priority…"
            empty="No priority levels."
            trigger={
              <Value interactive={canEdit} muted={issue.priority === 0}>
                <ProjectPriorityIcon priority={issue.priority} />
                <span className="truncate">
                  {issue.priorityLabel ?? PROJECT_PRIORITY_LABEL[issue.priority]}
                </span>
              </Value>
            }
          >
            {(close) =>
              PRIORITIES.map((priority) => (
                <CommandItem
                  key={priority}
                  value={PROJECT_PRIORITY_LABEL[priority]}
                  onSelect={() => setPriority(priority, close)}
                >
                  <ProjectPriorityIcon priority={priority} />
                  <span className="truncate">{PROJECT_PRIORITY_LABEL[priority]}</span>
                </CommandItem>
              ))
            }
          </Picker>
        </PropertyRow>

        <PropertyRow label="Assignee">
          <Picker
            canEdit={canEdit}
            search="Assign to…"
            empty="Nobody in this Linear team."
            trigger={
              <Value interactive={canEdit} muted={issue.assignee === undefined}>
                <IssueAvatar person={issue.assignee} px={18} />
                <span className="truncate">{issue.assignee?.name ?? 'Unassigned'}</span>
              </Value>
            }
          >
            {(close) => (
              <>
                <CommandItem value="Unassigned" onSelect={() => setAssignee(undefined, close)}>
                  <IssueAvatar person={undefined} px={18} />
                  <span className="text-muted-foreground">Unassigned</span>
                </CommandItem>
                {members.map((member) => (
                  <CommandItem
                    key={member.linearId}
                    value={member.name}
                    onSelect={() => setAssignee(member, close)}
                  >
                    <IssueAvatar person={member} px={18} />
                    <span className="truncate">{member.name}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </Picker>
        </PropertyRow>

        <PropertyRow label="Labels">
          <Picker
            canEdit={canEdit}
            search="Add a label…"
            empty="No labels on this team."
            trigger={
              <Value interactive={canEdit} muted={issue.labels.length === 0}>
                {issue.labels.length === 0 ? (
                  <>
                    <TagIcon className="size-3.5" />
                    <span>Add label</span>
                  </>
                ) : (
                  <span className="flex min-w-0 flex-wrap items-center gap-1">
                    {issue.labels.map((label) => (
                      <span
                        key={label.name}
                        className="flex h-[22px] min-w-0 max-w-full items-center gap-1.5 rounded-full border px-2 text-[12px] text-muted-foreground"
                      >
                        <span
                          className="size-2 shrink-0 rounded-full"
                          style={{ backgroundColor: label.color ?? 'currentColor' }}
                        />
                        <span className="truncate">{label.name}</span>
                      </span>
                    ))}
                  </span>
                )}
              </Value>
            }
          >
            {() =>
              labels.map((label) => {
                const on = selectedLabels.has(label.name)
                return (
                  <CommandItem
                    key={label.id}
                    value={label.name}
                    onSelect={() => toggleLabel(label)}
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: label.color ?? 'currentColor' }}
                    />
                    <span className="truncate">{label.name}</span>
                    {on ? <XIcon className="ml-auto size-3.5" /> : null}
                  </CommandItem>
                )
              })
            }
          </Picker>
        </PropertyRow>

        <PropertyRow label="Project">
          <Picker
            canEdit={canEdit}
            search="Move to project…"
            empty="No other projects in this workspace."
            trigger={
              <Value interactive={canEdit}>
                <SquareKanbanIcon className="size-3.5 text-muted-foreground" />
                <span className="truncate">{project.name}</span>
              </Value>
            }
          >
            {(close) =>
              projects.map((target) => (
                <CommandItem
                  key={target.id}
                  value={target.name}
                  onSelect={() => setProject(target, close)}
                >
                  <SquareKanbanIcon className="size-3.5" />
                  <span className="truncate">{target.name}</span>
                </CommandItem>
              ))
            }
          </Picker>
        </PropertyRow>

        <PropertyRow label="Milestone">
          <Picker
            canEdit={canEdit}
            search="Set milestone…"
            empty="This project has no milestones."
            trigger={
              <Value interactive={canEdit} muted={issue.milestoneName === undefined}>
                <TargetGlyph />
                <span className="truncate">{issue.milestoneName ?? 'No milestone'}</span>
              </Value>
            }
          >
            {(close) => (
              <>
                <CommandItem value="No milestone" onSelect={() => setMilestone(undefined, close)}>
                  <TargetGlyph />
                  <span className="text-muted-foreground">No milestone</span>
                </CommandItem>
                {milestones.map((milestone) => (
                  <CommandItem
                    key={milestone.id}
                    value={milestone.name}
                    onSelect={() => setMilestone(milestone, close)}
                  >
                    <TargetGlyph />
                    <span className="truncate">{milestone.name}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </Picker>
        </PropertyRow>

        <PropertyRow label="Due date">
          <DueDate value={issue.dueDate} label={dueDate} canEdit={canEdit} onChange={setDueDate} />
        </PropertyRow>

        <PropertyRow label="Estimate">
          <Picker
            canEdit={canEdit}
            search="Set estimate…"
            empty="No estimate scale."
            trigger={
              <Value interactive={canEdit} muted={issue.estimate === undefined}>
                <GaugeIcon className="size-3.5 text-muted-foreground" />
                <span className="truncate tabular-nums">
                  {issue.estimate === undefined ? 'No estimate' : `${issue.estimate}`}
                </span>
              </Value>
            }
          >
            {(close) => (
              <>
                <CommandItem value="No estimate" onSelect={() => setEstimate(undefined, close)}>
                  <GaugeIcon className="size-3.5" />
                  <span className="text-muted-foreground">No estimate</span>
                </CommandItem>
                {ESTIMATES.map((estimate) => (
                  <CommandItem
                    key={estimate}
                    value={`${estimate} points`}
                    onSelect={() => setEstimate(estimate, close)}
                  >
                    <GaugeIcon className="size-3.5" />
                    <span className="tabular-nums">{estimate}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </Picker>
        </PropertyRow>
      </div>
    </aside>
  )
}

function TargetGlyph() {
  return <DiamondIcon className="size-3.5 shrink-0 text-muted-foreground" />
}

/**
 * The one control on the rail that is not a `Command` list.
 *
 * `packages/ui` has no calendar primitive and this pass adds no dependencies, so
 * rather than hand-rolling a month grid that would be a worse calendar than the
 * browser's, the popover holds a native date input — which on every platform Taut
 * ships to is the same calendar the operating system draws elsewhere, keyboard
 * and screen reader included. `color-scheme` is set so its picker is dark, like
 * the rest of the product.
 */
function DueDate({
  value,
  label,
  canEdit,
  onChange
}: {
  value: string | undefined
  label: string | undefined
  canEdit: boolean
  onChange: (next: string | undefined) => void
}) {
  const [open, setOpen] = React.useState(false)

  const trigger = (
    <Value interactive={canEdit} muted={value === undefined}>
      <CalendarIcon className="size-3.5" />
      <span className="truncate">{label ?? 'No due date'}</span>
    </Value>
  )

  if (!canEdit) return trigger

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger className="group block w-full">{trigger}</PopoverTrigger>
      <PopoverContent align="start" sideOffset={2} className="w-[240px] space-y-2 p-2">
        <label htmlFor="issue-due-date" className="sr-only">
          Due date
        </label>
        <input
          id="issue-due-date"
          type="date"
          value={value ?? ''}
          onChange={(event) => {
            const next = event.target.value
            onChange(next === '' ? undefined : next)
          }}
          className="h-8 w-full rounded-md border bg-transparent px-2 text-[13px] outline-none [color-scheme:dark] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <button
          type="button"
          disabled={value === undefined}
          onClick={() => {
            onChange(undefined)
            setOpen(false)
          }}
          className="flex h-7 w-full items-center gap-1.5 rounded-md px-1.5 text-[13px] text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <XIcon className="size-3.5" />
          Clear due date
        </button>
      </PopoverContent>
    </Popover>
  )
}
