import * as React from 'react'
import { TagIcon } from '@taut/ui/components/icons'
import type {
  IssueOptions,
  IssueState,
  ProjectId,
  ProjectIssue,
  ProjectPriority
} from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList
} from '@taut/ui/components/command'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import { Input } from '@taut/ui/components/input'
import { Textarea } from '@taut/ui/components/textarea'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import { toast } from '@taut/ui/components/sonner'
import { cn } from '@taut/ui/lib/utils'
import { IssueAvatar } from '@/components/issue-avatar'
import { IssueStateIcon } from '@/components/issue-state-icon'
import { ProjectPriorityIcon } from '@/components/project-priority-icon'
import { useCreateIssue, useIssueOptions } from '@/lib/api'
import { PROJECT_PRIORITY_LABEL } from '@/lib/projects'

/**
 * Linear's "New issue" modal (docs/build-plan-issues.md D1, D16).
 *
 * The shape is Linear's: a borderless 16px title on the first line, a 14px
 * description under it, and a row of 28px property chips along the bottom — not a
 * stack of labelled form fields. A ticket is filed in one gesture, and a form
 * that asks eight questions before it will take a title is a form people leave.
 * Everything on the chip row is optional; Linear defaults what is left alone.
 *
 * Two entry points, and the difference between them is one pre-filled value.
 * The `+` on a group header of the Issues tab opens it with that group's workflow
 * state already chosen — which is what the `+` used to do in Linear, and the
 * reason it no longer sends the reader out of Taut. `Add sub-issue` on a ticket
 * opens it with `parent` set (D16), and then the dialog says so rather than
 * hiding it in a payload the person filing cannot see.
 *
 * The write is write-through like every other one (D2): the row that comes back
 * is the issue Linear answered with, so the list redraws from Linear's truth and
 * not from what was typed here.
 */

/** One property chip on the bottom row: Linear's 28px pill with its own picker. */
function Chip({
  search,
  empty,
  label,
  active,
  children
}: {
  search: string
  empty: string
  label: React.ReactNode
  active: boolean
  children: (close: () => void) => React.ReactNode
}) {
  const [open, setOpen] = React.useState(false)
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className={cn(
          'flex h-7 shrink-0 items-center gap-1.5 rounded-md border px-2 text-[13px] whitespace-nowrap transition-colors hover:bg-accent/60',
          !active && 'text-muted-foreground'
        )}
      >
        {label}
      </PopoverTrigger>
      <PopoverContent align="start" sideOffset={4} className="w-[240px] p-0">
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

const PRIORITIES: readonly ProjectPriority[] = [0, 1, 2, 3, 4]

/**
 * The body is a separate component so closing the dialog unmounts it — the same
 * trick `confirm-dialog.tsx` uses, and for the same reason: a half-typed ticket
 * must not be waiting inside the next one.
 */
function CreateIssueForm({
  projectId,
  options,
  defaultStateId,
  parent,
  onDone
}: {
  projectId: ProjectId
  options: IssueOptions | undefined
  defaultStateId: string | undefined
  parent: ProjectIssue['parent']
  onDone: () => void
}) {
  const create = useCreateIssue()
  const [title, setTitle] = React.useState('')
  const [description, setDescription] = React.useState('')
  const [stateId, setStateId] = React.useState(defaultStateId)
  const [priority, setPriority] = React.useState<ProjectPriority>(0)
  const [assignee, setAssignee] = React.useState<IssueOptions['members'][number] | undefined>()
  const [labelIds, setLabelIds] = React.useState<readonly string[]>([])

  const states = options?.states ?? []
  const members = options?.members ?? []
  const labels = options?.labels ?? []
  const state: IssueState | undefined = states.find((entry) => entry.id === stateId)
  const chosenLabels = labels.filter((label) => labelIds.includes(label.id))

  const submit = (): void => {
    const trimmed = title.trim()
    if (trimmed === '' || create.isPending) return
    create.mutate(
      {
        projectId,
        payload: {
          title: trimmed,
          ...(description.trim() === '' ? {} : { description: description.trim() }),
          ...(stateId === undefined ? {} : { stateId }),
          ...(priority === 0 ? {} : { priority }),
          ...(assignee === undefined ? {} : { assigneeId: assignee.linearId }),
          ...(labelIds.length === 0 ? {} : { labelIds }),
          ...(parent === undefined ? {} : { parentId: parent.linearId })
        }
      },
      {
        onSuccess: (issue) => {
          toast.success(`${issue.identifier} filed in Linear`)
          onDone()
        }
      }
    )
  }

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault()
        submit()
      }}
    >
      <DialogHeader>
        <DialogTitle className="text-[15px]">
          {parent === undefined ? 'New issue' : `New sub-issue of ${parent.identifier}`}
        </DialogTitle>
        <DialogDescription>
          {parent === undefined
            ? 'Filed in Linear, then mirrored back. Everything but the title is optional.'
            : `It will hang under ${parent.identifier} — ${parent.title}.`}
        </DialogDescription>
      </DialogHeader>

      <div className="py-4">
        <label htmlFor="issue-title" className="sr-only">
          Issue title
        </label>
        <Input
          id="issue-title"
          autoFocus
          autoComplete="off"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          placeholder="Issue title"
          className="h-9 border-0 bg-transparent px-0 text-[16px] font-medium shadow-none focus-visible:ring-0 md:text-[16px]"
        />
        <label htmlFor="issue-description" className="sr-only">
          Description
        </label>
        <Textarea
          id="issue-description"
          rows={4}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Add a description…"
          className="mt-1 resize-none border-0 bg-transparent px-0 text-[14px] shadow-none focus-visible:ring-0"
          onKeyDown={(event) => {
            // ⌘↵ files it from the description, the way it does everywhere else
            // a body and a commit share a box.
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault()
              submit()
            }
          }}
        />

        <div className="taut-rail mt-3 flex items-center gap-1.5 overflow-x-auto pb-1">
          <Chip
            search="Set status…"
            empty="No workflow states."
            active={state !== undefined}
            label={
              <>
                {state === undefined ? null : (
                  <IssueStateIcon type={state.type} color={state.color} />
                )}
                {state?.name ?? 'Status'}
              </>
            }
          >
            {(close) =>
              states.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={entry.name}
                  onSelect={() => {
                    setStateId(entry.id)
                    close()
                  }}
                >
                  <IssueStateIcon type={entry.type} color={entry.color} />
                  <span className="truncate">{entry.name}</span>
                </CommandItem>
              ))
            }
          </Chip>

          <Chip
            search="Set priority…"
            empty="No priority levels."
            active={priority !== 0}
            label={
              <>
                <ProjectPriorityIcon priority={priority} />
                {priority === 0 ? 'Priority' : PROJECT_PRIORITY_LABEL[priority]}
              </>
            }
          >
            {(close) =>
              PRIORITIES.map((level) => (
                <CommandItem
                  key={level}
                  value={PROJECT_PRIORITY_LABEL[level]}
                  onSelect={() => {
                    setPriority(level)
                    close()
                  }}
                >
                  <ProjectPriorityIcon priority={level} />
                  <span>{PROJECT_PRIORITY_LABEL[level]}</span>
                </CommandItem>
              ))
            }
          </Chip>

          <Chip
            search="Assign to…"
            empty="Nobody in this Linear team."
            active={assignee !== undefined}
            label={
              <>
                <IssueAvatar person={assignee} px={16} />
                {assignee?.name ?? 'Assignee'}
              </>
            }
          >
            {(close) => (
              <>
                <CommandItem
                  value="Unassigned"
                  onSelect={() => {
                    setAssignee(undefined)
                    close()
                  }}
                >
                  <IssueAvatar person={undefined} px={16} />
                  <span className="text-muted-foreground">Unassigned</span>
                </CommandItem>
                {members.map((member) => (
                  <CommandItem
                    key={member.linearId}
                    value={member.name}
                    onSelect={() => {
                      setAssignee(member)
                      close()
                    }}
                  >
                    <IssueAvatar person={member} px={16} />
                    <span className="truncate">{member.name}</span>
                  </CommandItem>
                ))}
              </>
            )}
          </Chip>

          <Chip
            search="Add a label…"
            empty="No labels on this team."
            active={labelIds.length > 0}
            label={
              <>
                <TagIcon className="size-3.5" />
                {chosenLabels.length === 0
                  ? 'Labels'
                  : chosenLabels.map((label) => label.name).join(', ')}
              </>
            }
          >
            {() =>
              labels.map((label) => (
                <CommandItem
                  key={label.id}
                  value={label.name}
                  onSelect={() =>
                    setLabelIds((current) =>
                      current.includes(label.id)
                        ? current.filter((id) => id !== label.id)
                        : [...current, label.id]
                    )
                  }
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: label.color ?? 'currentColor' }}
                  />
                  <span className="truncate">{label.name}</span>
                  {labelIds.includes(label.id) ? (
                    <span className="ml-auto text-[11px] text-muted-foreground">on</span>
                  ) : null}
                </CommandItem>
              ))
            }
          </Chip>
        </div>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={title.trim() === '' || create.isPending}>
          Create issue
        </Button>
      </DialogFooter>
    </form>
  )
}

export function IssueCreateDialog({
  open,
  onOpenChange,
  projectId,
  defaultStateId,
  parent
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: ProjectId
  /** The group the `+` was clicked on, pre-selected in the status chip. */
  defaultStateId?: string
  /** Set to file this under an existing ticket (D16). */
  parent?: ProjectIssue['parent']
}) {
  // Only read once the dialog is actually open: the pick-lists are a live call to
  // Linear (D14), and a page that never files anything must not make it.
  const options = useIssueOptions(open ? projectId : undefined)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {open ? (
          <CreateIssueForm
            projectId={projectId}
            options={options.data}
            defaultStateId={defaultStateId}
            parent={parent}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
