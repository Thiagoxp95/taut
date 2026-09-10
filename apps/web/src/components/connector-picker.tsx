import * as React from 'react'
import { ChevronLeftIcon, ChevronRightIcon, PlugIcon, PlusIcon } from '@taut/ui/components/icons'
import { Button } from '@taut/ui/components/button'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
  CommandSeparator
} from '@taut/ui/components/command'
import { CONNECTOR_CATALOG, type ConnectorPreset } from '@/lib/connector-catalog'

export function ConnectorPicker({
  onSelect,
  disabled = false
}: {
  onSelect: (preset: ConnectorPreset) => void
  disabled?: boolean
}) {
  const [open, setOpen] = React.useState(false)
  const [group, setGroup] = React.useState<ConnectorPreset | null>(null)
  const [search, setSearch] = React.useState('')
  const select = (preset: ConnectorPreset) => {
    if (preset.children) {
      setGroup(preset)
      setSearch('')
    } else {
      setOpen(false)
      onSelect(preset)
    }
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        setGroup(null)
        setSearch('')
      }}
    >
      <PopoverTrigger asChild>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={disabled}
          className="rounded-full"
        >
          <PlusIcon /> Add connector
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 overflow-hidden p-0">
        <Command key={group?.name ?? 'all'}>
          <CommandInput
            autoFocus
            aria-label="Search connectors"
            placeholder="Search connectors…"
            value={search}
            onValueChange={setSearch}
          />
          {group ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="m-1 justify-start"
              onClick={() => {
                setGroup(null)
                setSearch('')
              }}
            >
              <ChevronLeftIcon /> All connectors
            </Button>
          ) : null}
          <CommandList className="max-h-[min(28rem,55dvh)]">
            <CommandEmpty>No connectors found.</CommandEmpty>
            <CommandGroup heading={group?.name ?? 'MCPs'}>
              {(group?.children ?? CONNECTOR_CATALOG).map((preset) => (
                <CommandItem
                  key={preset.name}
                  value={`${preset.name} ${preset.url ?? ''}`}
                  onSelect={() => select(preset)}
                  className="gap-3 px-3 py-2.5"
                >
                  <PlugIcon className="size-4" />
                  <span className="shrink-0">{preset.name}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    {preset.children
                      ? `${preset.children.length} connectors`
                      : preset.auth === 'oauth'
                        ? 'OAuth required'
                        : (preset.url?.replace(/^https?:\/\//, '') ?? 'Configure…')}
                  </span>
                  {preset.children ? <ChevronRightIcon className="ml-auto size-3" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
          <CommandSeparator />
          <CommandGroup>
            <CommandItem
              forceMount
              onSelect={() => select({ name: '' })}
              className="gap-3 px-3 py-2.5"
            >
              <PlusIcon /> Custom URL…
            </CommandItem>
          </CommandGroup>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
