import * as React from 'react'
import { Loader2Icon } from '@taut/ui/components/icons'
import type { ModelOption, RuntimeKind, SubscriptionId } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue
} from '@taut/ui/components/select'
import { useModelCatalog } from '@/lib/api'

/**
 * The model dropdown (docs/build-plan-run-overrides.md D6, D8).
 *
 * The list is the provider's, read through the seat that will run the task, so
 * what it offers is what that seat can actually call. When the provider cannot
 * be asked the endpoint answers a short built-in list and one line saying why —
 * which this renders under the field rather than swallowing, because a stale
 * list you know is stale is useful and a stale list you think is live is not.
 *
 * The empty choice is a real choice: it means "whatever is configured one level
 * up", and it is what a field with no override shows.
 */
const NONE = '__none__'

export interface ModelSelectProps {
  readonly id?: string
  readonly runtime: RuntimeKind
  /** The seat whose credential asks the provider; rotation's pick when absent. */
  readonly subscriptionId?: SubscriptionId
  /** `undefined` selects the empty choice. */
  readonly value: string | undefined
  readonly onValueChange: (next: string | undefined) => void
  /** Wording of the empty choice — "Subscription default", "Agent default", … */
  readonly emptyLabel: string
  readonly disabled?: boolean
  readonly className?: string
  /** Hide the "showing the built-in list" line, for tight popovers. */
  readonly quiet?: boolean
}

export function ModelSelect({
  id,
  runtime,
  subscriptionId,
  value,
  onValueChange,
  emptyLabel,
  disabled = false,
  className,
  quiet = false
}: ModelSelectProps) {
  const catalog = useModelCatalog(runtime, subscriptionId)

  // A model set before this catalogue loaded — or one the provider has since
  // stopped listing — still has to be selectable, or opening the form would
  // quietly clear it.
  const options = React.useMemo<readonly ModelOption[]>(() => {
    const models = catalog.data?.models ?? []
    if (value === undefined || value === '') return models
    return models.some((model) => model.id === value)
      ? models
      : [{ id: value, label: value, group: 'Not listed by the provider' }, ...models]
  }, [catalog.data, value])

  const groups = React.useMemo(() => {
    const byGroup = new Map<string, ModelOption[]>()
    for (const model of options) {
      const key = model.group ?? ''
      const bucket = byGroup.get(key)
      if (bucket === undefined) byGroup.set(key, [model])
      else bucket.push(model)
    }
    return [...byGroup.entries()]
  }, [options])

  return (
    <div className={cn('flex flex-col gap-1', className)}>
      <Select
        value={value === undefined || value === '' ? NONE : value}
        onValueChange={(next) => onValueChange(next === NONE ? undefined : next)}
        disabled={disabled}
      >
        <SelectTrigger id={id} className="w-full">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{emptyLabel}</SelectItem>
          {groups.map(([group, items]) =>
            group === '' ? (
              items.map((model) => (
                <SelectItem key={model.id} value={model.id}>
                  {model.label}
                </SelectItem>
              ))
            ) : (
              <SelectGroup key={group}>
                <SelectLabel>{group}</SelectLabel>
                {items.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    {model.label}
                  </SelectItem>
                ))}
              </SelectGroup>
            )
          )}
        </SelectContent>
      </Select>

      {quiet ? null : catalog.isPending ? (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <Loader2Icon className="size-3 animate-spin" /> Asking the provider…
        </p>
      ) : catalog.data?.source === 'fallback' ? (
        <p className="text-xs text-muted-foreground">
          Built-in list — {catalog.data.note ?? 'the provider could not be reached'}.
        </p>
      ) : null}
    </div>
  )
}
