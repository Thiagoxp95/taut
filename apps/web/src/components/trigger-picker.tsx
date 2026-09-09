/**
 * The event editor behind an event-fired routine (docs/build-plan-triggers.md).
 *
 * The twin of `SchedulePicker`: controlled on one `EventTrigger`, owning nothing but the chips,
 * and previewing through the very functions the server fires on. `describeTrigger` and
 * `validateTrigger` come from `@taut/contract`, so the sentence a human approves here and the
 * behaviour the runner gives them cannot drift (D3).
 *
 * Top to bottom: which event, then only that variant's filters, then the sentence.
 */
import * as React from 'react'
import { PlusIcon, TriangleAlertIcon, XIcon } from 'lucide-react'
import {
  describeTrigger,
  SignalName,
  validateTrigger,
  type AgentId,
  type Channel,
  type EventTrigger,
  type MemberKind,
  type ProjectId,
  type ChannelId,
  type Trigger,
  type TriggerEventType,
  type TriggerNames
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
import { Input } from '@taut/ui/components/input'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { Switch } from '@taut/ui/components/switch'
import { cn } from '@taut/ui/lib/utils'
import { Field } from '@/components/page'
import { useChannelGroups, useDirectoryAgents, useLookupMember } from '@/hooks/use-directory'
import { useProjects } from '@/lib/api'

// --- values ---------------------------------------------------------------

/** Sentence fragments, because the preview reads "When " + this (D4, D17). */
const EVENTS: readonly { readonly type: TriggerEventType; readonly label: string }[] = [
  { type: 'call.ended', label: 'A huddle ends' },
  { type: 'call.started', label: 'A huddle starts' },
  { type: 'message.created', label: 'Someone posts a message' },
  { type: 'agent.task.failed', label: "An agent's run fails" },
  { type: 'project.issue.created', label: 'An issue is filed in a project' },
  { type: 'signal.emitted', label: 'A signal is emitted' }
]

const AUTHOR_KINDS: readonly { readonly kind: MemberKind; readonly label: string }[] = [
  { kind: 'user', label: 'People' },
  { kind: 'agent', label: 'Agents' }
]

/** The D7 cap, said plainly where it can actually bite (a busy channel). */
const RATE_CAP_NOTE = 'Triggers fire at most 20 times an hour.'

/**
 * A required list may go empty for a moment — clearing the last channel, emptying the signal
 * name — and `validateTrigger` is what refuses to save it. `Schema.NonEmptyArray` cannot say
 * that, so the widening lives here once instead of at every call site, exactly as
 * `SchedulePicker` does for its times.
 */
const maybeEmpty = <A,>(values: readonly A[]): readonly [A, ...A[]] =>
  values as readonly [A, ...A[]]

/**
 * A half-typed signal name is not a `SignalName` yet, and branding it would throw mid-keystroke.
 * `validateTrigger` re-checks the same pattern (it exists so the editor can say so), so the value
 * is allowed to be wrong here and Save is what refuses it.
 */
const asSignalName = (raw: string): SignalName => SignalName.make(raw, { disableValidation: true })

/** What a brand-new trigger starts as: the huddle notifier, the case the whole plan opens with. */
export const defaultEventTrigger = (): EventTrigger => ({
  _tag: 'call.ended',
  channelIds: [],
  minSeconds: 60
})

/** Wraps an event in the arm of `Trigger` it belongs to, so the dialog holds one value. */
export const eventTrigger = (event: EventTrigger): Trigger => ({ _tag: 'event', event })

/** Switching events keeps nothing: each variant carries only the filters that make sense (D3). */
function blankEvent(type: TriggerEventType): EventTrigger {
  switch (type) {
    case 'call.ended':
      return defaultEventTrigger()
    case 'call.started':
      return { _tag: 'call.started', channelIds: [] }
    case 'message.created':
      return {
        _tag: 'message.created',
        channelIds: maybeEmpty<ChannelId>([]),
        authorKinds: ['user'],
        containing: undefined,
        includeThreadReplies: false
      }
    case 'agent.task.failed':
      return { _tag: 'agent.task.failed', agentIds: [] }
    case 'project.issue.created':
      return { _tag: 'project.issue.created', projectIds: [] }
    case 'signal.emitted':
      return { _tag: 'signal.emitted', names: maybeEmpty<SignalName>([]), fromAgentIds: [] }
  }
}

/**
 * What a human calls an id — `#design`, `@nova`, `Taut v2` — so the preview and every list row
 * read like the app rather than like the database. The same lookup serves both (D14).
 */
export function useTriggerNames(): TriggerNames {
  const { all: channels } = useChannelGroups()
  const lookup = useLookupMember()
  const projects = useProjects().data?.items
  return React.useCallback(
    (id: string) => {
      const channel = channels.find((entry) => entry.id === id)
      if (channel !== undefined) return `#${channel.name}`
      const member = lookup(id)
      if (member !== undefined) return `@${member.handle}`
      return projects?.find((project) => project.id === id)?.name
    },
    [channels, lookup, projects]
  )
}

// --- chips ----------------------------------------------------------------

const CHIP_BASE =
  'flex h-9 items-center justify-center px-3.5 text-sm font-medium transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50'

function Toggle({
  selected,
  className,
  ...props
}: React.ComponentProps<'button'> & { selected: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      className={cn(
        CHIP_BASE,
        'rounded-full',
        selected
          ? 'bg-primary text-primary-foreground hover:bg-primary/90'
          : 'bg-muted text-foreground hover:bg-accent',
        className
      )}
      {...props}
    />
  )
}

/** One tab stop, arrows walk the group, Home/End jump to the ends — as the chip grids do. */
function useRovingFocus(count: number) {
  const [active, setActive] = React.useState(0)
  const refs = React.useRef<(HTMLButtonElement | null)[]>([])

  const focus = (index: number): void => {
    const clamped = Math.max(0, Math.min(count - 1, index))
    setActive(clamped)
    refs.current[clamped]?.focus()
  }

  const onKeyDown = (event: React.KeyboardEvent, index: number): void => {
    const step =
      event.key === 'ArrowLeft' || event.key === 'ArrowUp'
        ? -1
        : event.key === 'ArrowRight' || event.key === 'ArrowDown'
          ? 1
          : undefined
    if (step !== undefined) {
      event.preventDefault()
      focus(index + step)
      return
    }
    if (event.key === 'Home') {
      event.preventDefault()
      focus(0)
    } else if (event.key === 'End') {
      event.preventDefault()
      focus(count - 1)
    }
  }

  return (index: number) => ({
    ref: (node: HTMLButtonElement | null) => {
      refs.current[index] = node
    },
    tabIndex: index === Math.min(active, count - 1) ? 0 : -1,
    onKeyDown: (event: React.KeyboardEvent) => onKeyDown(event, index),
    onFocus: () => setActive(index)
  })
}

export interface ChipOption<Id extends string> {
  readonly id: Id
  readonly label: string
}

/**
 * The chip-and-popover multi-select the rest of the app already uses: removable chips in the
 * row (`TimesRow`), a `Command` list behind a `+ Add` button (`MemberPicker`). Every chip is a
 * real `<button>`, so the whole control works from the keyboard without a roving grid.
 */
function ChipSelect<Id extends string>({
  label,
  hint,
  options,
  value,
  onChange,
  empty,
  add,
  search,
  invalid = false
}: {
  label: string
  hint?: string
  options: readonly ChipOption<Id>[]
  value: readonly Id[]
  onChange: (next: readonly Id[]) => void
  /** What an empty list means, said in words: "any channel", "any agent". */
  empty: string
  add: string
  search: string
  invalid?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const chosen = new Set<string>(value)
  const left = options.filter((option) => !chosen.has(option.id))
  const labelOf = (id: Id): string => options.find((option) => option.id === id)?.label ?? id

  return (
    <Field label={label} hint={hint}>
      <div
        role="group"
        aria-label={label}
        aria-invalid={invalid || undefined}
        className="flex flex-wrap items-center gap-1.5"
      >
        {value.map((id) => (
          <span
            key={id}
            className="inline-flex h-9 items-center gap-1 rounded-full bg-muted pr-1 pl-3 text-sm"
          >
            <span className="max-w-44 truncate">{labelOf(id)}</span>
            <button
              type="button"
              aria-label={`Remove ${labelOf(id)}`}
              onClick={() => onChange(value.filter((current) => current !== id))}
              className="flex size-6 items-center justify-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-background hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
              <XIcon className="size-3.5" />
            </button>
          </span>
        ))}

        {value.length === 0 ? (
          <span className={cn('text-sm', invalid ? 'text-destructive' : 'text-muted-foreground')}>
            {empty}
          </span>
        ) : null}

        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="outline" disabled={left.length === 0}>
              <PlusIcon />
              {add}
            </Button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-0">
            <Command>
              <CommandInput placeholder={search} />
              <CommandList>
                <CommandEmpty>Nothing left to add.</CommandEmpty>
                <CommandGroup>
                  {left.map((option) => (
                    <CommandItem
                      key={option.id}
                      value={option.label}
                      onSelect={() => {
                        onChange([...value, option.id])
                        setOpen(false)
                      }}
                    >
                      {option.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
          </PopoverContent>
        </Popover>
      </div>
    </Field>
  )
}

// --- option sources -------------------------------------------------------

function useAgentOptions(): readonly ChipOption<AgentId>[] {
  const { agents } = useDirectoryAgents()
  return React.useMemo(
    () =>
      agents
        .filter((agent) => !agent.archived)
        .map((agent) => ({ id: agent.id, label: `@${agent.handle}` })),
    [agents]
  )
}

function useProjectOptions(): readonly ChipOption<ProjectId>[] {
  const projects = useProjects().data?.items
  return React.useMemo(
    () => (projects ?? []).map((project) => ({ id: project.id, label: project.name })),
    [projects]
  )
}

// --- variant bodies -------------------------------------------------------

function MinutesRow({
  minSeconds,
  onChange,
  id
}: {
  minSeconds: number
  onChange: (minSeconds: number) => void
  id: string
}) {
  const minutes = Math.round(minSeconds / 60)
  return (
    <div className="grid gap-2">
      <div className="flex items-center gap-2">
        <label htmlFor={id} className="text-sm select-none">
          Ignore huddles under
        </label>
        <Input
          id={id}
          type="number"
          inputMode="numeric"
          min={0}
          max={60}
          value={minutes}
          className="w-20"
          onChange={(event) => {
            const next = Number(event.target.value)
            if (!Number.isFinite(next)) return
            onChange(Math.min(3600, Math.max(0, Math.round(next) * 60)))
          }}
        />
        <span className="text-sm">{minutes === 1 ? 'minute' : 'minutes'}</span>
      </div>
      <p className="text-xs text-muted-foreground">
        {minutes === 0
          ? 'Every huddle counts, however short.'
          : 'A misclick is not a meeting — anything shorter is ignored.'}
      </p>
    </div>
  )
}

function AuthorKinds({
  kinds,
  onChange
}: {
  kinds: readonly MemberKind[]
  onChange: (kinds: readonly MemberKind[]) => void
}) {
  const roving = useRovingFocus(AUTHOR_KINDS.length)
  const selected = new Set<MemberKind>(kinds)

  return (
    <Field label="Posted by" hint="An agent never fires its own trigger, whichever you pick.">
      <div className="flex gap-1.5" role="group" aria-label="Posted by">
        {AUTHOR_KINDS.map((entry, index) => (
          <Toggle
            key={entry.kind}
            selected={selected.has(entry.kind)}
            onClick={() =>
              onChange(
                selected.has(entry.kind)
                  ? kinds.filter((current) => current !== entry.kind)
                  : [...kinds, entry.kind]
              )
            }
            {...roving(index)}
          >
            {entry.label}
          </Toggle>
        ))}
      </div>
    </Field>
  )
}

function ThreadRepliesRow({
  includeThreadReplies,
  onChange,
  id
}: {
  includeThreadReplies: boolean
  onChange: (includeThreadReplies: boolean) => void
  id: string
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <label htmlFor={id} className="text-sm leading-none font-medium select-none">
        Include thread replies
      </label>
      <Switch id={id} checked={includeThreadReplies} onCheckedChange={onChange} />
    </div>
  )
}

// --- the picker -----------------------------------------------------------

export function TriggerPicker({
  value,
  onChange,
  channels,
  names
}: {
  value: EventTrigger
  onChange: (event: EventTrigger) => void
  /** The channels the agent is a member of — the only ones it could ever see an event in. */
  channels: readonly Channel[]
  names: TriggerNames
}) {
  const id = React.useId()
  const agents = useAgentOptions()
  const projects = useProjectOptions()
  const channelOptions = React.useMemo<readonly ChipOption<ChannelId>[]>(
    () => channels.map((channel) => ({ id: channel.id, label: `#${channel.name}` })),
    [channels]
  )

  // Switching away and back should not lose what was already picked.
  const drafts = React.useRef<Partial<Record<TriggerEventType, EventTrigger>>>({})
  React.useEffect(() => {
    drafts.current[value._tag] = value
  }, [value])

  const trigger = eventTrigger(value)
  const issues = validateTrigger(trigger)
  const issueAt = (field: string): string | undefined =>
    issues.find((issue) => issue.path[1] === field)?.message

  return (
    <div className="grid gap-4">
      <Field label="Event" htmlFor={`${id}-event`} hint="What wakes the agent.">
        <Select
          value={value._tag}
          onValueChange={(next) => {
            const type = EVENTS.find((entry) => entry.type === next)?.type
            if (type === undefined) return
            onChange(drafts.current[type] ?? blankEvent(type))
          }}
        >
          <SelectTrigger id={`${id}-event`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EVENTS.map((entry) => (
              <SelectItem key={entry.type} value={entry.type}>
                {entry.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      {/* A floor under every variant, so the short ones do not move the preview. */}
      <div className="grid min-h-48 content-start gap-4">
        {value._tag === 'call.ended' ? (
          <>
            <ChipSelect
              label="Where"
              options={channelOptions}
              value={value.channelIds}
              onChange={(channelIds) => onChange({ ...value, channelIds })}
              empty="Any channel the agent can see"
              add="Add channel"
              search="Search channels…"
            />
            <MinutesRow
              id={`${id}-min-seconds`}
              minSeconds={value.minSeconds}
              onChange={(minSeconds) => onChange({ ...value, minSeconds })}
            />
          </>
        ) : null}

        {value._tag === 'call.started' ? (
          <ChipSelect
            label="Where"
            options={channelOptions}
            value={value.channelIds}
            onChange={(channelIds) => onChange({ ...value, channelIds })}
            empty="Any channel the agent can see"
            add="Add channel"
            search="Search channels…"
          />
        ) : null}

        {value._tag === 'message.created' ? (
          <>
            <ChipSelect
              label="Where"
              hint="A message trigger has to name its channels — this one is loud by nature."
              options={channelOptions}
              value={value.channelIds}
              onChange={(channelIds) => onChange({ ...value, channelIds: maybeEmpty(channelIds) })}
              empty="Pick at least one channel"
              add="Add channel"
              search="Search channels…"
              invalid={issueAt('channelIds') !== undefined}
            />
            <AuthorKinds
              kinds={value.authorKinds}
              onChange={(authorKinds) =>
                onChange({ ...value, authorKinds: maybeEmpty(authorKinds) })
              }
            />
            <Field
              label="Containing"
              htmlFor={`${id}-containing`}
              hint="Case-insensitive. Leave it empty to fire on every message."
            >
              <Input
                id={`${id}-containing`}
                value={value.containing ?? ''}
                maxLength={200}
                autoComplete="off"
                aria-invalid={issueAt('containing') !== undefined}
                placeholder="deploy"
                onChange={(event) =>
                  onChange({
                    ...value,
                    containing: event.target.value === '' ? undefined : event.target.value
                  })
                }
              />
            </Field>
            <ThreadRepliesRow
              id={`${id}-thread-replies`}
              includeThreadReplies={value.includeThreadReplies}
              onChange={(includeThreadReplies) => onChange({ ...value, includeThreadReplies })}
            />
          </>
        ) : null}

        {value._tag === 'agent.task.failed' ? (
          <ChipSelect
            label="Whose runs"
            hint="Watching itself is allowed here: a failed run has no actor to self-trigger on."
            options={agents}
            value={value.agentIds}
            onChange={(agentIds) => onChange({ ...value, agentIds })}
            empty="Any agent in the company"
            add="Add agent"
            search="Search agents…"
          />
        ) : null}

        {value._tag === 'project.issue.created' ? (
          <ChipSelect
            label="Which projects"
            options={projects}
            value={value.projectIds}
            onChange={(projectIds) => onChange({ ...value, projectIds })}
            empty="Any project in the mirror"
            add="Add project"
            search="Search projects…"
          />
        ) : null}

        {value._tag === 'signal.emitted' ? (
          <>
            <Field
              label="Signal name"
              htmlFor={`${id}-signal-name`}
              hint="Lower-case letters, digits, dots, dashes and underscores. Names are shared company-wide."
            >
              <Input
                id={`${id}-signal-name`}
                value={value.names[0] ?? ''}
                spellCheck={false}
                autoComplete="off"
                className="font-mono"
                aria-invalid={issueAt('names') !== undefined}
                placeholder="deploy-finished"
                onChange={(event) =>
                  onChange({
                    ...value,
                    names:
                      event.target.value === ''
                        ? maybeEmpty<SignalName>([])
                        : [asSignalName(event.target.value)]
                  })
                }
              />
            </Field>
            <ChipSelect
              label="Emitted by"
              options={agents}
              value={value.fromAgentIds}
              onChange={(fromAgentIds) => onChange({ ...value, fromAgentIds })}
              empty="Anyone"
              add="Add agent"
              search="Search agents…"
            />
          </>
        ) : null}
      </div>

      <TriggerPreview trigger={trigger} names={names} issue={issues[0]?.message} />
    </div>
  )
}

function TriggerPreview({
  trigger,
  names,
  issue
}: {
  trigger: Trigger
  names: TriggerNames
  issue: string | undefined
}) {
  if (issue !== undefined) {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-dashed px-3 py-2.5">
        <TriangleAlertIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">{issue}</p>
      </div>
    )
  }

  const noisy = trigger._tag === 'event' && trigger.event._tag === 'message.created'

  return (
    <div className="rounded-lg border bg-muted/40 px-3 py-2.5">
      <p className="text-sm font-medium">{describeTrigger(trigger, names)}</p>
      {noisy ? <p className="mt-1 text-xs text-muted-foreground">{RATE_CAP_NOTE}</p> : null}
    </div>
  )
}
