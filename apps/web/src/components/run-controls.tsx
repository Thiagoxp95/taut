import * as React from 'react'
import { CheckIcon, Loader2Icon, SparklesIcon } from '@taut/ui/components/icons'
import type {
  Agent,
  ReasoningEffort,
  RunOverride,
  RuntimeKind,
  SubscriptionId
} from '@taut/contract'
import { Badge } from '@taut/ui/components/badge'
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList
} from '@taut/ui/components/command'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@taut/ui/components/dropdown-menu'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import { Tooltip, TooltipContent, TooltipTrigger } from '@taut/ui/components/tooltip'
import { ComposerControl, ComposerControlChevron } from '@/components/composer-control'
import { RuntimeIcon } from '@/components/runtime-icon'
import { useModelCatalog, useSubscriptions } from '@/lib/api'
import {
  REASONING_BLURB,
  REASONING_LABELS,
  RUNTIME_LABELS,
  RUNTIME_ORDER
} from '@/lib/runtime-meta'
import type { RunOverrideState } from '@/hooks/use-run-override'

/**
 * The composer's run settings, worn as two resting controls rather than one
 * settings dialog (docs/build-plan-run-overrides.md D3).
 *
 * The old panel hid four dropdowns behind a gear, so the only way to learn
 * which brain would answer was to open it. These two say it on the toolbar:
 * the left one carries the runtime's mark and the model's name, the right one
 * the reasoning effort and the seat. Both are shaped after t3code's composer —
 * an icon rail of runtimes beside a searchable model list, and a radio menu of
 * traits whose current values are the trigger's own label.
 *
 * Nothing about the model changes: an absent field still means "whatever the
 * agent is set to", and the override still lasts for this conversation only.
 */

/** The radio value standing for "no override on this field". */
const NONE = '__none__'

export interface RunControlsProps {
  /** The agent this message will wake. */
  readonly agent: Agent
  readonly state: RunOverrideState
  readonly disabled?: boolean
}

export function RunControls({ agent, state, disabled = false }: RunControlsProps) {
  return (
    <div className="flex min-w-0 shrink items-center gap-0.5">
      <ModelControl agent={agent} state={state} disabled={disabled} />
      <TraitsControl agent={agent} state={state} disabled={disabled} />
    </div>
  )
}

/** What the run will actually ask for, override first, agent underneath. */
function effective(agent: Agent, override: RunOverride | undefined) {
  return {
    runtime: override?.runtimeKind ?? agent.runtimeKind,
    seatId: override?.subscriptionId ?? agent.pinnedSubscriptionId,
    model: override?.model ?? agent.model
  }
}

/**
 * Runtime and model in one control: the rail on the left picks the runtime,
 * the list on the right picks one of the models that runtime can actually
 * reach through the seat that will run the task (D6).
 */
function ModelControl({ agent, state, disabled }: RunControlsProps & { disabled: boolean }) {
  const [open, setOpen] = React.useState(false)
  const searchRef = React.useRef<HTMLInputElement>(null)
  const { runtime, seatId, model } = effective(agent, state.override)

  // The effective catalogue is read even while the popover is shut, because it
  // is what turns `claude-fable-5-1` into "Claude Fable 5.1" on the button.
  const catalog = useModelCatalog(runtime, seatId)
  const label =
    model === undefined
      ? 'Seat default'
      : ((catalog.data?.models ?? []).find((option) => option.id === model)?.label ?? model)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <ComposerControl
          aria-label={`Runtime and model for @${agent.handle}`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          className="min-w-0 shrink justify-between"
        >
          <span className="flex min-w-0 flex-1 items-center gap-1.5">
            <RuntimeIcon runtime={runtime} className="size-4" />
            <span className="min-w-0 flex-1 truncate text-left">{label}</span>
          </span>
          <ComposerControlChevron />
        </ComposerControl>
      </PopoverTrigger>

      <PopoverContent
        align="start"
        side="top"
        sideOffset={8}
        className="w-90 overflow-hidden p-0"
        // Radix would park focus on the panel itself; typing is meant to search.
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <ModelPickerPanel
          agent={agent}
          state={state}
          searchRef={searchRef}
          runtime={runtime}
          seatId={seatId}
          model={model}
          onDone={() => setOpen(false)}
        />
      </PopoverContent>
    </Popover>
  )
}

/**
 * The open picker. It is a component of its own so that every field it holds â
 * which runtime the rail is browsing, what has been typed in the search box â
 * starts fresh each time the popover opens, without an effect to reset it.
 */
function ModelPickerPanel({
  agent,
  state,
  runtime,
  seatId,
  model,
  searchRef,
  onDone
}: {
  readonly agent: Agent
  readonly state: RunOverrideState
  readonly runtime: RuntimeKind
  readonly seatId: SubscriptionId | undefined
  readonly model: string | undefined
  readonly searchRef: React.RefObject<HTMLInputElement | null>
  readonly onDone: () => void
}) {
  // The rail is browsing state, not a choice: it opens on the runtime the
  // message would use, and closing without picking a model changes nothing.
  const [railRuntime, setRailRuntime] = React.useState<RuntimeKind>(runtime)
  const catalog = useModelCatalog(railRuntime, railRuntime === runtime ? seatId : undefined)
  const models = catalog.data?.models ?? []

  const pick = (id: string | undefined) => {
    // A seat, a model and an effort all belong to one runtime; keeping them
    // across a switch would send the next message a model the new runtime has
    // never heard of.
    if (railRuntime !== runtime) {
      state.set('runtimeKind', railRuntime === agent.runtimeKind ? undefined : railRuntime)
      state.set('subscriptionId', undefined)
      state.set('reasoningEffort', undefined)
      state.set('fastMode', undefined)
    }
    state.set('model', id)
    onDone()
  }

  return (
    <div className="flex h-86.5 flex-row">
      <div className="w-11 shrink-0 overflow-y-auto bg-muted/30">
        <div className="relative flex min-h-full flex-col gap-1 p-1">
          {/* An action, not a runtime: the marker below belongs to whichever
              runtime the list is showing. */}
          <RailButton
            label={`Agent default · ${RUNTIME_LABELS[agent.runtimeKind]}`}
            selected={false}
            onClick={() => {
              state.clear()
              setRailRuntime(agent.runtimeKind)
            }}
          >
            <SparklesIcon className="size-5 shrink-0" />
          </RailButton>
          <div aria-hidden className="border-b border-border/70" />
          {RUNTIME_ORDER.map((kind) => (
            <RailButton
              key={kind}
              label={RUNTIME_LABELS[kind]}
              selected={railRuntime === kind}
              onClick={() => setRailRuntime(kind)}
            >
              <RuntimeIcon runtime={kind} className="size-5" />
            </RailButton>
          ))}
        </div>
      </div>

      <Command loop className="flex min-h-0 flex-1 flex-col border-l bg-muted/40">
        <div className="px-2 pt-2">
          <CommandInput
            ref={searchRef}
            placeholder="Search models…"
            className="h-6.5 py-0 text-sm"
            wrapperClassName="h-auto border-0 border-b border-border/70 px-0 pb-2.5 focus-within:border-ring"
          />
        </div>

        <CommandList className="max-h-none min-h-0 flex-1 px-2 py-1.5">
          <CommandEmpty className="py-6 text-xs">No models found</CommandEmpty>

          <CommandItem
            value={`default ${RUNTIME_LABELS[railRuntime]} agent seat`}
            onSelect={() => pick(undefined)}
            className="items-start gap-3 px-2 py-2"
          >
            <div className="min-w-0 flex-1 text-left">
              <div className="truncate text-xs font-medium leading-snug">
                {agent.model === undefined ? 'Seat default' : `Agent default · ${agent.model}`}
              </div>
              <div className="mt-1 truncate text-xs leading-snug text-muted-foreground/70">
                Whatever {RUNTIME_LABELS[railRuntime]} is already set to
              </div>
            </div>
            {model === undefined && railRuntime === runtime ? (
              <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
            ) : null}
          </CommandItem>

          {models.map((option) => (
            <CommandItem
              key={option.id}
              value={`${option.label} ${option.id} ${option.group ?? ''}`}
              onSelect={() => pick(option.id)}
              className="items-start gap-3 px-2 py-2"
            >
              <div className="min-w-0 flex-1 text-left">
                <div className="truncate text-xs font-medium leading-snug">{option.label}</div>
                <div className="mt-1 flex items-center gap-1.5">
                  <RuntimeIcon runtime={railRuntime} className="size-3" />
                  <span className="truncate text-xs leading-snug text-muted-foreground/70">
                    {option.group ?? RUNTIME_LABELS[railRuntime]}
                  </span>
                </div>
              </div>
              {option.id === model && railRuntime === runtime ? (
                <CheckIcon className="mt-0.5 size-3.5 shrink-0 text-foreground" />
              ) : null}
            </CommandItem>
          ))}
        </CommandList>

        <div className="shrink-0 border-t border-border/70 px-3 py-2 text-xs text-muted-foreground">
          {catalog.isPending ? (
            <span className="flex items-center gap-1.5">
              <Loader2Icon className="size-3 animate-spin" /> Asking the provider…
            </span>
          ) : catalog.data?.source === 'fallback' ? (
            <span>Built-in list — {catalog.data.note ?? 'the provider could not be reached'}.</span>
          ) : (
            <span>
              Applies to this conversation. The agent&rsquo;s own settings are not touched.
            </span>
          )}
        </div>
      </Command>
    </div>
  )
}

/** One square in the runtime rail, with the selected marker on its right edge. */
function RailButton({
  label,
  selected,
  onClick,
  children
}: {
  readonly label: string
  readonly selected: boolean
  readonly onClick: () => void
  readonly children: React.ReactNode
}) {
  return (
    <div className="relative w-full">
      {selected ? (
        <span
          aria-hidden
          className="pointer-events-none absolute top-1/2 -right-1 z-10 h-5 w-0.75 -translate-y-1/2 rounded-l-full bg-sidebar-primary"
        />
      ) : null}
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={onClick}
            className="flex aspect-square w-full cursor-pointer items-center justify-center rounded-md transition-colors outline-none hover:bg-accent focus-visible:bg-accent"
          >
            {children}
          </button>
        </TooltipTrigger>
        <TooltipContent side="left" sideOffset={8}>
          {label}
        </TooltipContent>
      </Tooltip>
    </div>
  )
}

/**
 * Reasoning and seat in one menu, the way t3code carries a model's traits: the
 * trigger is the current values joined by a dot, and every group's first row is
 * the default that clears the override for that one field.
 */
function TraitsControl({ agent, state, disabled }: RunControlsProps & { disabled: boolean }) {
  const [open, setOpen] = React.useState(false)
  const override = state.override
  const { runtime, seatId } = effective(agent, override)

  const catalog = useModelCatalog(runtime, seatId)
  const efforts = catalog.data?.reasoningEfforts ?? []
  const subscriptions = useSubscriptions({
    enabled: open || override?.subscriptionId !== undefined
  })
  const seats = (subscriptions.data?.items ?? []).filter((seat) => seat.runtime === runtime)

  const effort = override?.reasoningEffort
  const seatLabel =
    override?.subscriptionId === undefined
      ? undefined
      : (seats.find((seat) => seat.id === override.subscriptionId)?.label ?? 'Pinned seat')
  const speedLabel =
    runtime !== 'codex' || override?.fastMode === undefined
      ? undefined
      : override.fastMode
        ? 'Fast'
        : 'Standard'
  const label = [effort === undefined ? 'Auto' : REASONING_LABELS[effort], speedLabel, seatLabel]
    .filter((part): part is string => part !== undefined)
    .join(' · ')

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <ComposerControl
          aria-label={`${runtime === 'codex' ? 'Reasoning, speed and seat' : 'Reasoning and seat'} for @${agent.handle}`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          className="shrink-0"
        >
          <span className="max-w-40 truncate">{label}</span>
          <ComposerControlChevron />
        </ComposerControl>
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" side="top" sideOffset={8} className="w-64">
        <GroupLabel>Reasoning</GroupLabel>
        {efforts.length === 0 ? (
          <p className="px-2 pb-1.5 text-xs text-muted-foreground/80">
            {RUNTIME_LABELS[runtime]} has no reasoning control to set.
          </p>
        ) : (
          <DropdownMenuRadioGroup
            value={effort ?? NONE}
            onValueChange={(next) =>
              state.set('reasoningEffort', next === NONE ? undefined : (next as ReasoningEffort))
            }
          >
            <TraitItem
              value={NONE}
              label="Auto"
              isDefault
              description="Whatever the runtime does on its own."
            />
            {efforts.map((option) => (
              <TraitItem
                key={option}
                value={option}
                label={REASONING_LABELS[option]}
                description={REASONING_BLURB[option]}
              />
            ))}
          </DropdownMenuRadioGroup>
        )}

        <DropdownMenuSeparator />

        {runtime === 'codex' ? (
          <>
            <GroupLabel>Speed</GroupLabel>
            <DropdownMenuRadioGroup
              value={
                override?.fastMode === undefined ? NONE : override.fastMode ? 'fast' : 'standard'
              }
              onValueChange={(next) =>
                state.set('fastMode', next === NONE ? undefined : next === 'fast')
              }
            >
              <TraitItem value={NONE} label="Seat default" isDefault />
              <TraitItem value="standard" label="Standard" />
              <TraitItem
                value="fast"
                label="Fast"
                description="Faster responses with higher usage or cost."
              />
            </DropdownMenuRadioGroup>
            <DropdownMenuSeparator />
          </>
        ) : null}

        <GroupLabel>Seat</GroupLabel>
        <DropdownMenuRadioGroup
          value={override?.subscriptionId ?? NONE}
          onValueChange={(next) =>
            state.set('subscriptionId', next === NONE ? undefined : (next as SubscriptionId))
          }
        >
          <TraitItem
            value={NONE}
            label={
              agent.pinnedSubscriptionId === undefined ? 'Rotate across the pool' : 'Agent default'
            }
            isDefault
          />
          {seats.map((seat) => (
            <TraitItem key={seat.id} value={seat.id} label={seat.label} />
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function GroupLabel({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="px-2 pt-1.5 pb-1 text-xs font-medium text-muted-foreground">{children}</div>
  )
}

function TraitItem({
  value,
  label,
  description,
  isDefault = false
}: {
  readonly value: string
  readonly label: string
  readonly description?: string
  readonly isDefault?: boolean
}) {
  return (
    <DropdownMenuRadioItem value={value} className="items-start">
      <span className="flex w-full min-w-0 flex-col">
        <span className="min-w-0 truncate text-sm">
          {label}
          {isDefault ? (
            <>
              {' '}
              <Badge
                variant="outline"
                className="inline-flex h-4 items-center border-border/70 bg-muted/60 px-1.5 py-0 text-[10px] font-semibold text-muted-foreground"
              >
                Default
              </Badge>
            </>
          ) : null}
        </span>
        {description === undefined ? null : (
          <span className="text-xs text-pretty text-muted-foreground/80">{description}</span>
        )}
      </span>
    </DropdownMenuRadioItem>
  )
}
