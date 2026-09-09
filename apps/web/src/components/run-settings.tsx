import * as React from 'react'
import { RotateCcwIcon, Settings2Icon } from 'lucide-react'
import type { Agent, RunOverride, RuntimeKind, SubscriptionId } from '@taut/contract'
import { Button } from '@taut/ui/components/button'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { ModelSelect } from '@/components/model-select'
import { useModelCatalog, useSubscriptions } from '@/lib/api'
import {
  REASONING_BLURB,
  REASONING_LABELS,
  RUNTIME_LABELS,
  RUNTIME_ORDER
} from '@/lib/runtime-meta'
import type { RunOverrideState } from '@/hooks/use-run-override'
import { overrideCount } from '@/hooks/use-run-override'

/**
 * The composer's run settings (docs/build-plan-run-overrides.md D3).
 *
 * Four rows — runtime, seat, model, reasoning — each of which can say "whatever
 * the agent is set to". That empty choice names the agent's actual setting
 * rather than the word "default", so nobody has to open another page to find
 * out what they are overriding.
 *
 * The button only exists when an agent will read the message; the composer
 * decides that, and passes the agent here.
 */
const NONE = '__none__'

export interface RunSettingsProps {
  /** The agent this message will wake. */
  readonly agent: Agent
  readonly state: RunOverrideState
  readonly disabled?: boolean
}

export function RunSettings({ agent, state, disabled = false }: RunSettingsProps) {
  const [open, setOpen] = React.useState(false)
  const override: RunOverride | undefined = state.override
  const runtime: RuntimeKind = override?.runtimeKind ?? agent.runtimeKind
  const seatId = override?.subscriptionId ?? agent.pinnedSubscriptionId
  const count = overrideCount(override)

  const subscriptions = useSubscriptions({ enabled: open })
  const seats = (subscriptions.data?.items ?? []).filter((seat) => seat.runtime === runtime)
  const catalog = useModelCatalog(runtime, seatId, { enabled: open })
  const efforts = catalog.data?.reasoningEfforts ?? []

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Run settings for @${agent.handle}`}
          title={`Run settings for @${agent.handle}`}
          disabled={disabled}
          onMouseDown={(event) => event.preventDefault()}
          className="relative shrink-0"
        >
          <Settings2Icon />
          {count === 0 ? null : (
            <span
              aria-hidden
              className="absolute top-0.5 right-0.5 size-1.5 rounded-full bg-sidebar-primary"
            />
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent align="end" side="top" sideOffset={8} className="w-80 p-0">
        <div className="flex items-center justify-between gap-2 border-b px-3 py-2">
          <p className="text-sm font-medium">This message to @{agent.handle}</p>
          <Button
            variant="ghost"
            size="sm"
            disabled={count === 0}
            onClick={state.clear}
            className="-mr-1 h-7 px-2 text-xs"
          >
            <RotateCcwIcon className="size-3" />
            Reset
          </Button>
        </div>

        <div className="flex flex-col gap-3 px-3 py-3">
          <Row label="Runtime" htmlFor="run-runtime">
            <Select
              value={override?.runtimeKind ?? NONE}
              onValueChange={(next) => {
                const picked = next === NONE ? undefined : (next as RuntimeKind)
                state.set('runtimeKind', picked)
                // A seat, a model and an effort all belong to one runtime; keeping
                // them across a switch would send the next message a model the new
                // runtime has never heard of.
                state.set('subscriptionId', undefined)
                state.set('model', undefined)
                state.set('reasoningEffort', undefined)
              }}
            >
              <SelectTrigger id="run-runtime" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  Agent default · {RUNTIME_LABELS[agent.runtimeKind]}
                </SelectItem>
                {RUNTIME_ORDER.map((kind) => (
                  <SelectItem key={kind} value={kind}>
                    {RUNTIME_LABELS[kind]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row label="Seat" htmlFor="run-seat">
            <Select
              value={override?.subscriptionId ?? NONE}
              onValueChange={(next) =>
                state.set('subscriptionId', next === NONE ? undefined : (next as SubscriptionId))
              }
            >
              <SelectTrigger id="run-seat" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>
                  {agent.pinnedSubscriptionId === undefined
                    ? 'Rotate across the pool'
                    : 'Agent default'}
                </SelectItem>
                {seats.map((seat) => (
                  <SelectItem key={seat.id} value={seat.id}>
                    {seat.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Row>

          <Row label="Model" htmlFor="run-model">
            <ModelSelect
              id="run-model"
              runtime={runtime}
              subscriptionId={seatId}
              value={override?.model}
              onValueChange={(next) => state.set('model', next)}
              emptyLabel={
                agent.model === undefined ? 'Seat default' : `Agent default · ${agent.model}`
              }
            />
          </Row>

          {efforts.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {RUNTIME_LABELS[runtime]} has no reasoning control to set.
            </p>
          ) : (
            <Row
              label="Reasoning"
              htmlFor="run-reasoning"
              hint={
                override?.reasoningEffort === undefined
                  ? undefined
                  : REASONING_BLURB[override.reasoningEffort]
              }
            >
              <Select
                value={override?.reasoningEffort ?? NONE}
                onValueChange={(next) =>
                  state.set(
                    'reasoningEffort',
                    next === NONE ? undefined : (next as (typeof efforts)[number])
                  )
                }
              >
                <SelectTrigger id="run-reasoning" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>Runtime default</SelectItem>
                  {efforts.map((effort) => (
                    <SelectItem key={effort} value={effort}>
                      {REASONING_LABELS[effort]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Row>
          )}
        </div>

        <p className="border-t px-3 py-2 text-xs text-muted-foreground">
          Applies to this conversation until you change it. The agent&rsquo;s own settings are not
          touched.
        </p>
      </PopoverContent>
    </Popover>
  )
}

function Row({
  label,
  htmlFor,
  hint,
  children
}: {
  readonly label: string
  readonly htmlFor: string
  readonly hint?: string
  readonly children: React.ReactNode
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={htmlFor} className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      {children}
      {hint === undefined ? null : <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  )
}
