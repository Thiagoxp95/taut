import * as React from 'react'
import {
  CopyIcon,
  EllipsisVerticalIcon,
  ForwardIcon,
  LinkIcon,
  MessageSquareIcon,
  PencilIcon,
  SmilePlusIcon,
  TrashIcon
} from 'lucide-react'
import type { Message } from '@taut/contract'
import { cn } from '@taut/ui/lib/utils'
import { Button } from '@taut/ui/components/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@taut/ui/components/dropdown-menu'
import { toast } from '@taut/ui/components/sonner'
import { ForwardDialog } from '@/components/forward-dialog'
import { ReactionPicker } from '@/components/reaction-picker'
import { useChannel } from '@/hooks/use-directory'
import { useMe } from '@/lib/api'
import { messageLink, reactedByMe } from '@/lib/message-actions'

/** The three Slack puts in front of the toolbar (D7). */
const QUICK = ['✅', '👀', '🙌'] as const

function copy(text: string, what: string): void {
  void navigator.clipboard.writeText(text).then(
    () => toast('Copied'),
    () => toast.error(`Could not copy the ${what}`)
  )
}

/**
 * The hover toolbar (D7). It reads its own channel, so `MessageList` passes
 * nothing new; `has-[[data-state=open]]` keeps it up while a menu is open.
 *
 * TODO(plan): save, mark unread, remind me.
 */
export function MessageActions({
  message,
  own,
  onEdit,
  onDelete,
  onOpenThread,
  onReact
}: {
  message: Message
  own: boolean
  onEdit?: () => void
  onDelete?: () => void
  /** Undefined on a reply: only a root message opens a thread. */
  onOpenThread?: () => void
  onReact: (emoji: string, on: boolean) => void
}) {
  const [forwarding, setForwarding] = React.useState(false)
  const channel = useChannel(message.channelId)
  const me = useMe().data

  const mine = (emoji: string): boolean =>
    message.reactions.some(
      (reaction) => reaction.emoji === emoji && reactedByMe(reaction, me?.user.id)
    )

  return (
    <>
      <div className="pointer-events-none absolute top-0 right-4 z-20 hidden -translate-y-1/2 items-center gap-0.5 rounded-md border bg-background p-0.5 opacity-0 shadow-sm transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 has-[[data-state=open]]:pointer-events-auto has-[[data-state=open]]:opacity-100 sm:flex">
        {QUICK.map((emoji) => {
          const on = !mine(emoji)
          return (
            <Button
              key={emoji}
              variant="ghost"
              size="icon-sm"
              aria-label={`React with ${emoji}`}
              aria-pressed={!on}
              title={`React with ${emoji}`}
              className={cn('text-base', !on && 'bg-accent')}
              onClick={() => onReact(emoji, on)}
            >
              <span aria-hidden>{emoji}</span>
            </Button>
          )
        })}

        <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />

        <ReactionPicker align="end" onPick={(emoji) => onReact(emoji, true)}>
          <Button variant="ghost" size="icon-sm" aria-label="Add reaction" title="Add reaction">
            <SmilePlusIcon />
          </Button>
        </ReactionPicker>

        {onOpenThread === undefined ? null : (
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Reply in thread"
            title="Reply in thread"
            onClick={onOpenThread}
          >
            <MessageSquareIcon />
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          aria-label="Forward message"
          title="Forward message"
          onClick={() => setForwarding(true)}
        >
          <ForwardIcon />
        </Button>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="More actions" title="More actions">
              <EllipsisVerticalIcon />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onSelect={() => copy(message.body, 'message')}>
              <CopyIcon />
              Copy text
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={channel === undefined}
              onSelect={() => {
                if (channel !== undefined) copy(messageLink(channel, message), 'link')
              }}
            >
              <LinkIcon />
              Copy link
            </DropdownMenuItem>
            {own && (onEdit !== undefined || onDelete !== undefined) ? (
              <DropdownMenuSeparator />
            ) : null}
            {own && onEdit !== undefined ? (
              <DropdownMenuItem onSelect={() => onEdit()}>
                <PencilIcon />
                Edit message
              </DropdownMenuItem>
            ) : null}
            {own && onDelete !== undefined ? (
              <DropdownMenuItem variant="destructive" onSelect={() => onDelete()}>
                <TrashIcon />
                Delete message
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <ForwardDialog message={message} open={forwarding} onOpenChange={setForwarding} />
    </>
  )
}
