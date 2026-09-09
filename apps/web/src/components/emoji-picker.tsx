import * as React from 'react'
import { cn } from '@taut/ui/lib/utils'
import { Popover, PopoverContent, PopoverTrigger } from '@taut/ui/components/popover'

const CHOICES = [
  '🦫',
  '🦉',
  '🦊',
  '🐙',
  '🐝',
  '🦔',
  '🚀',
  '🧭',
  '🧵',
  '📦',
  '🛠️',
  '🔭',
  '🌱',
  '⚡',
  '🌗',
  '🅰️',
  '🌬️',
  '🎯'
] as const

/** Small emoji avatar picker used by the agent and company forms. */
export function EmojiPicker({
  id,
  value,
  onChange,
  className
}: {
  id?: string
  value: string
  onChange: (next: string) => void
  className?: string
}) {
  const [open, setOpen] = React.useState(false)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          id={id}
          type="button"
          aria-label={`Avatar: ${value}. Pick a different emoji`}
          className={cn(
            'flex size-9 items-center justify-center rounded-md border bg-background text-xl shadow-xs transition-colors outline-none hover:bg-accent focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
            className
          )}
        >
          <span aria-hidden>{value}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-2">
        <div className="grid grid-cols-6 gap-1">
          {CHOICES.map((emoji) => (
            <button
              key={emoji}
              type="button"
              aria-label={emoji}
              aria-pressed={emoji === value}
              onClick={() => {
                onChange(emoji)
                setOpen(false)
              }}
              className={cn(
                'flex size-9 items-center justify-center rounded-md text-xl transition-colors outline-none hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50',
                emoji === value && 'bg-accent ring-2 ring-ring/60'
              )}
            >
              <span aria-hidden>{emoji}</span>
            </button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
