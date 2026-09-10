/**
 * The whole human-facing surface signals get (docs/build-plan-triggers.md D26).
 *
 * A signal is an agent's own affair — it arms one, it cancels one, and the wake arrives as an
 * ordinary message. The one thing a human needs is to see that something is still coming and to
 * say "never mind", which is half of what a reminder is for. That is one muted row under the
 * thread composer, not a tab.
 */
import { AlarmClockIcon } from '@taut/ui/components/icons'
import type { MessageId } from '@taut/contract'
import { useCancelSignal, useSignals } from '@/lib/api'
import { formatTime } from '@/lib/format'

export function ThreadSignals({ threadId }: { threadId: MessageId | undefined }) {
  const signals = useSignals(threadId)
  const cancelSignal = useCancelSignal()

  if (signals.length === 0) return null

  return (
    <ul className="shrink-0 space-y-0.5 px-6 pb-4">
      {signals.map((signal) => (
        <li key={signal.id} className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <AlarmClockIcon className="size-3.5 shrink-0" />
          <span className="min-w-0 truncate" title={signal.note}>
            Reminder at {formatTime(signal.deliverAt)}
          </span>
          <span aria-hidden="true">·</span>
          <button
            type="button"
            disabled={cancelSignal.isPending}
            aria-label={`Cancel the reminder at ${formatTime(signal.deliverAt)}`}
            onClick={() => cancelSignal.mutate(signal.id)}
            className="rounded-sm underline-offset-2 transition-colors outline-none hover:text-foreground hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          >
            Cancel
          </button>
        </li>
      ))}
    </ul>
  )
}
