import { SmilePlusIcon } from 'lucide-react'
import type { Message } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { ReactionPicker } from '@/components/reaction-picker'
import { useLookupMember } from '@/hooks/use-directory'
import { useMe } from '@/lib/api'
import { reactedByMe } from '@/lib/message-actions'

/** How many names the title spells out before it starts counting. */
const NAMES = 2

function listNames(names: readonly string[]): string {
  const shown = names.slice(0, NAMES)
  const rest = names.length - shown.length
  if (rest > 0) return `${shown.join(', ')} and ${rest} ${rest === 1 ? 'other' : 'others'}`
  return names.length === 0 ? 'Nobody' : shown.join(' and ')
}

/**
 * The chips under a message (D8): one per emoji, highlighted when the viewer is
 * in it, and a trailing `+` that opens the picker.
 */
export function ReactionChips({
  message,
  onToggle,
  onAdd
}: {
  message: Message
  onToggle: (emoji: string, on: boolean) => void
  onAdd: (emoji: string) => void
}) {
  const me = useMe().data
  const lookup = useLookupMember()

  if (message.reactions.length === 0) return null

  return (
    <ul className="mt-1.5 flex flex-wrap items-center gap-1">
      {message.reactions.map((reaction) => {
        const mine = reactedByMe(reaction, me?.user.id)
        const names = reaction.members.map((member) =>
          member.kind === 'user' && member.id === me?.user.id
            ? 'You'
            : (lookup(member.id)?.name ?? 'Unknown member')
        )
        const label = `${listNames(names)} reacted with ${reaction.emoji}`

        return (
          <li key={reaction.emoji}>
            <button
              type="button"
              aria-pressed={mine}
              aria-label={label}
              title={label}
              onClick={() => onToggle(reaction.emoji, !mine)}
              className={cn(
                'flex h-6 items-center gap-1 rounded-full border px-2 text-xs transition-colors outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                mine
                  ? 'border-sidebar-primary/40 bg-sidebar-primary/10 font-medium text-sidebar-primary dark:text-sidebar-primary-foreground'
                  : 'bg-background text-muted-foreground hover:bg-accent'
              )}
            >
              <span aria-hidden className="text-sm leading-none">
                {reaction.emoji}
              </span>
              <span className="tabular-nums">{reaction.count}</span>
            </button>
          </li>
        )
      })}

      <li>
        <ReactionPicker onPick={onAdd}>
          <button
            type="button"
            aria-label="Add reaction"
            title="Add reaction"
            className="flex h-6 items-center rounded-full border border-dashed px-2 text-muted-foreground transition-colors outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
          >
            <SmilePlusIcon className="size-3.5" />
          </button>
        </ReactionPicker>
      </li>
    </ul>
  )
}
