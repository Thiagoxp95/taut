/**
 * Create or edit one routine (docs/build-plan-routines.md, generalised by
 * docs/build-plan-triggers.md D14).
 *
 * One dialog for both kinds: a routine and a trigger differ in one field, so the segmented
 * *Schedule · Trigger* row swaps which picker owns that field and nothing else moves. The
 * dialog holds one `Trigger`; Save is refused while `validateTrigger` has anything to say, so a
 * routine that could never fire cannot be written in the first place.
 */
import * as React from 'react'
import { useQueries } from '@tanstack/react-query'
import type { AgentId, Channel, ChannelMember, Routine, Trigger, TriggerKind } from '@taut/contract'
import { validateTrigger } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Input } from '@taut/ui/components/input'
import { Textarea } from '@taut/ui/components/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@taut/ui/components/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { Tabs, TabsList, TabsTrigger } from '@taut/ui/components/tabs'
import { Field } from '@/components/page'
import { defaultSchedule, SchedulePicker } from '@/components/schedule-picker'
import {
  defaultEventTrigger,
  eventTrigger,
  TriggerPicker,
  useTriggerNames
} from '@/components/trigger-picker'
import { useChannelGroups } from '@/hooks/use-directory'
import { call } from '@/lib/api-client'
import { useCreateRoutine, useUpdateRoutine, type PageOf } from '@/lib/api'
import { parseChannelId } from '@/lib/ids'
import { qk } from '@/lib/query-keys'
import { runEffect } from '@/lib/runtime'

const DM = 'dm'

const KINDS: readonly { readonly kind: TriggerKind; readonly label: string }[] = [
  { kind: 'schedule', label: 'Schedule' },
  { kind: 'event', label: 'Trigger' }
]

const browserTimezone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone

/** What a brand-new routine starts as: a daily clock, still the shape most people want. */
const blankTrigger = (kind: TriggerKind): Trigger => {
  if (kind === 'event') return eventTrigger(defaultEventTrigger())
  const timezone = browserTimezone()
  return { _tag: 'schedule', schedule: defaultSchedule(timezone), timezone }
}

/**
 * The channels the routine may post into: the ones the viewer can see that the agent is also
 * in. One small membership query per channel, the same shape `useDmPartners` uses, and only
 * while the dialog is open.
 */
function useAgentChannels(agentId: AgentId): readonly Channel[] {
  const { company, byDepartment } = useChannelGroups()
  const candidates = React.useMemo(
    () =>
      [...company, ...[...byDepartment.values()].flat()].sort((a, b) =>
        a.name.localeCompare(b.name)
      ),
    [company, byDepartment]
  )

  const results = useQueries({
    queries: candidates.map((channel) => ({
      queryKey: qk.channelMembers(channel.id),
      queryFn: () =>
        runEffect(
          call((api) =>
            api.channels.members({ path: { channelId: channel.id }, urlParams: { limit: 200 } })
          )
        ),
      staleTime: 5 * 60_000
    }))
  })

  const joined = candidates.filter((channel, index) => {
    const page: PageOf<ChannelMember> | undefined = results[index]?.data
    return page?.items.some(
      (member) => member.memberKind === 'agent' && member.memberId === agentId
    )
  })
  const signature = joined.map((channel) => channel.id).join(',')

  // `joined` is rebuilt every render; `signature` is what actually changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return React.useMemo(() => joined, [signature])
}

function RoutineForm({
  agentId,
  agentHandle,
  editing,
  onDone
}: {
  agentId: AgentId
  /** Shown as the prefix the server adds, so nobody types the mention twice. */
  agentHandle: string
  editing: Routine | null
  onDone: () => void
}) {
  const createRoutine = useCreateRoutine()
  const updateRoutine = useUpdateRoutine()
  const channels = useAgentChannels(agentId)
  const names = useTriggerNames()

  const [name, setName] = React.useState(editing?.name ?? '')
  const [prompt, setPrompt] = React.useState(editing?.prompt ?? '')
  const [target, setTarget] = React.useState<string>(editing?.channelId ?? DM)
  const [trigger, setTrigger] = React.useState<Trigger>(
    () => editing?.trigger ?? blankTrigger('schedule')
  )

  // Switching arms and back should not lose what was already set up on the other one.
  const drafts = React.useRef<Partial<Record<TriggerKind, Trigger>>>({})
  React.useEffect(() => {
    drafts.current[trigger._tag] = trigger
  }, [trigger])

  const issues = validateTrigger(trigger)
  const pending = createRoutine.isPending || updateRoutine.isPending
  const ready = name.trim() !== '' && prompt.trim() !== '' && issues.length === 0

  const setKind = (next: string): void => {
    const kind = KINDS.find((entry) => entry.kind === next)?.kind
    if (kind === undefined || kind === trigger._tag) return
    setTrigger(drafts.current[kind] ?? blankTrigger(kind))
  }

  const submit = (event: React.FormEvent): void => {
    event.preventDefault()
    if (!ready || pending) return
    const channelId = target === DM ? undefined : parseChannelId(target)
    if (editing === null) {
      createRoutine.mutate(
        { agentId, name: name.trim(), prompt: prompt.trim(), channelId, trigger },
        { onSuccess: onDone }
      )
    } else {
      updateRoutine.mutate(
        {
          routineId: editing.id,
          name: name.trim(),
          prompt: prompt.trim(),
          channelId: channelId ?? null,
          trigger
        },
        { onSuccess: onDone }
      )
    }
  }

  return (
    <form onSubmit={submit} className="flex min-h-0 flex-1 flex-col">
      <DialogHeader className="shrink-0">
        <DialogTitle>{editing === null ? 'New routine' : `Edit ${editing.name}`}</DialogTitle>
        <DialogDescription>
          A routine posts your prompt to @{agentHandle} as you — on a schedule, or the moment
          something happens. The reply lands in a thread and shows up in the task list like any
          other mention.
        </DialogDescription>
      </DialogHeader>

      <div className="taut-scroll flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto py-4">
        <Field label="Name" htmlFor="routine-name" hint="Only you see this; it labels the row.">
          <Input
            id="routine-name"
            autoFocus={editing === null}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Morning standup"
          />
        </Field>

        <Field
          label="Prompt"
          htmlFor="routine-prompt"
          hint={`Posted as "@${agentHandle} …" — the mention is added for you, so leave it out.`}
        >
          <Textarea
            id="routine-prompt"
            value={prompt}
            rows={4}
            maxLength={4000}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Summarise what changed in the repo since yesterday and flag anything that needs a decision."
          />
        </Field>

        <Field
          label="Deliver to"
          htmlFor="routine-channel"
          hint={
            target === DM
              ? 'Your direct message with the agent — nobody else sees the run.'
              : 'Everyone in the channel sees the prompt and the reply.'
          }
        >
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger id="routine-channel" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DM}>Direct message</SelectItem>
              {channels.map((channel) => (
                <SelectItem key={channel.id} value={channel.id}>
                  #{channel.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        <div className="grid gap-3">
          <span className="text-sm leading-none font-medium select-none">Fires</span>
          {/* One routine, two conditions (D14): the tabs swap the picker and nothing else. */}
          <Tabs value={trigger._tag} onValueChange={setKind}>
            <TabsList className="w-full">
              {KINDS.map((entry) => (
                <TabsTrigger key={entry.kind} value={entry.kind}>
                  {entry.label}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>

          {trigger._tag === 'schedule' ? (
            <SchedulePicker
              value={trigger.schedule}
              onChange={(schedule) => setTrigger({ ...trigger, schedule })}
              timezone={trigger.timezone}
              onTimezoneChange={(timezone) => setTrigger({ ...trigger, timezone })}
            />
          ) : (
            <TriggerPicker
              value={trigger.event}
              onChange={(event) => setTrigger(eventTrigger(event))}
              channels={channels}
              names={names}
            />
          )}
        </div>
      </div>

      <DialogFooter className="shrink-0">
        <Button type="button" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" disabled={!ready || pending}>
          {editing === null ? 'Add routine' : 'Save routine'}
        </Button>
      </DialogFooter>
    </form>
  )
}

export function RoutineDialog({
  agentId,
  agentHandle,
  editing,
  open,
  onOpenChange
}: {
  agentId: AgentId
  agentHandle: string
  /** `null` opens the create form. */
  editing: Routine | null
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] flex-col overflow-hidden sm:max-w-2xl">
        {/* Keyed so a second Edit starts from that routine, not the last one's draft. */}
        <RoutineForm
          key={editing?.id ?? 'new'}
          agentId={agentId}
          agentHandle={agentHandle}
          editing={editing}
          onDone={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  )
}
