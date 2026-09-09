import { cn } from '@taut/ui/lib/utils'
import { Tooltip, TooltipContent, TooltipTrigger } from '@taut/ui/components/tooltip'
import type { ConnectionStatus } from '@/lib/ws'

const DISPLAY: Record<ConnectionStatus, { dot: string; label: string; hint: string }> = {
  open: {
    dot: 'bg-emerald-500',
    label: 'Connected',
    hint: 'Live. Events stream in over /ws.'
  },
  connecting: {
    dot: 'bg-amber-500 animate-pulse',
    label: 'Connecting',
    hint: 'Opening the realtime socket.'
  },
  reconnecting: {
    dot: 'bg-amber-500 animate-pulse',
    label: 'Reconnecting',
    hint: 'Lost the socket. Retrying with backoff; missed events replay from lastSeq.'
  },
  offline: {
    dot: 'bg-destructive',
    label: 'Offline',
    hint: 'No realtime connection. Still retrying in the background.'
  }
}

export function ConnectionIndicator({
  status,
  lastSeq,
  className
}: {
  status: ConnectionStatus
  lastSeq: number
  className?: string
}) {
  const display = DISPLAY[status]

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-sidebar-foreground/70 transition-colors outline-none hover:bg-sidebar-accent hover:text-sidebar-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50',
            className
          )}
        >
          <span className={cn('size-2 shrink-0 rounded-full', display.dot)} />
          <span className="truncate font-medium">{display.label}</span>
          <span className="ml-auto shrink-0 tabular-nums opacity-60">seq {lastSeq}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-56">
        {display.hint}
      </TooltipContent>
    </Tooltip>
  )
}
